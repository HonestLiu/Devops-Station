//! Graphical Git operations for the Local/WSL terminal workspaces.
//!
//! Every command runs `git` as a child process in the given working directory
//! (resolved from the active terminal's cwd, reported over OSC 7). For WSL
//! sessions the cwd arrives as a *unix* path (`/home/user/repo`); we translate
//! it to the `\\wsl.localhost\<distro>` / `\\wsl$\<distro>` UNC share so Git for
//! Windows can operate on it directly — no WSL PTY round-trip needed.
//!
//! Output is returned as plain strings (`Result<_, String>`) rather than the
//! app's `AppError` type: the frontend needs the raw stderr to surface git's
//! own messages (e.g. "Please tell me who you are", auth prompts), and a git
//! non-zero exit is an expected, recoverable event rather than a hard error.

use serde::Serialize;
use std::process::Command;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use crate::ssh::SshManager;
use crate::AppState;

/// Raw git process output, returned to the frontend for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// One file in the working tree, from `git status --porcelain=v1 -b`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    /// The path as reported by git (may be `old -> new` for renames).
    pub path: String,
    /// First porcelain column (index / staged status).
    pub x: String,
    /// Second porcelain column (worktree / unstaged status).
    pub y: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

/// Parsed `git status` output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitFileEntry>,
}

/// Parsed `git branch` / `git branch -r` output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: String,
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
}

/// Raw unified-diff text for a single file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    /// Unified diff body (empty when the file has no textual diff, e.g. binary
    /// or a pure mode change).
    pub text: String,
    /// True when git reports the file as binary (no line diff available).
    pub binary: bool,
}

/// One commit from `git log`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    /// Full 40-char SHA.
    pub hash: String,
    /// Abbreviated SHA (7 chars).
    pub short_hash: String,
    pub author: String,
    /// ISO-ish author date (`--date=short` → YYYY-MM-DD).
    pub date: String,
    /// First line of the message.
    pub subject: String,
    /// Remaining message body (may be empty).
    pub body: String,
}

/// Resolve the on-disk directory git should run in (local sessions only).
///
/// - Local session: `cwd` is already a Windows path (`C:\Users\...`) and is used
///   directly.
/// - WSL session: `cwd` is a *unix* path. We do NOT translate it to a `\\wsl$`
///   UNC share (which only works when the distro is mounted and is brittle);
///   instead `git_exec` runs git *inside* WSL via `wsl.exe -d <distro> git -C
///   <cwd>`, so the unix path is valid natively. `resolve_dir` is therefore only
///   used for local sessions.
fn resolve_dir(cwd: &str) -> String {
    cwd.to_string()
}

/// Spawn `git` with the given args, capturing stdout/stderr.
///
/// - Local session (`distro` is `None`/empty): run the host `git` with
///   `current_dir(cwd)` (cwd is a Windows path).
/// - WSL session (`distro` set): run git *inside* WSL —
///   `wsl.exe -d <distro> git -C <cwd> <args>` — so the unix `cwd` is valid
///   natively and we never depend on the `\\wsl$` UNC share being mounted.
///   `wsl.exe` forwards each Windows argv element as a separate Linux argv
///   element, so arguments with spaces need no shell quoting.
fn git_exec(cwd: &str, args: &[&str], distro: &Option<String>) -> GitOutput {
    // A unix absolute path (no drive letter, e.g. `/home/user/repo`) means this
    // is a WSL session — run git *inside* WSL, so we never hand a unix path to
    // the host `git` (which would fail with "directory name is invalid").
    //
    // We use `wsl.exe -e git ...` (`--exec`): `-e` runs `git` directly WITHOUT
    // the user's login shell (zsh/bash). Without it, wsl routes the command
    // through the shell, which re-parses arguments and chokes on quotes/special
    // characters in commit messages or file paths ("missing end of string").
    // With a distro we pin it; without one we let `wsl.exe` pick the default.
    let is_unix_path = cwd.starts_with('/') && !cwd.contains(':');
    let mut cmd = if is_unix_path {
        let mut c = Command::new("wsl.exe");
        c.arg("-e");
        if let Some(d) = distro {
            if !d.is_empty() {
                c.args(["-d", d]);
            }
        }
        c.args(["git", "-C", cwd]);
        c.args(args);
        c
    } else {
        let mut c = Command::new("git");
        c.args(args).current_dir(resolve_dir(cwd));
        c
    };
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.output() {
        Ok(out) => GitOutput {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code().unwrap_or(-1),
        },
        Err(e) => GitOutput {
            stdout: String::new(),
            stderr: format!("failed to launch git: {e}"),
            exit_code: -1,
        },
    }
}

/// Single-quote a string for a POSIX shell, escaping embedded single quotes.
///
/// Over SSH the command runs through the remote login shell, so every argument
/// (including `cwd` and commit messages) must be quoted to survive spaces and
/// shell metacharacters. `wsl.exe -e` does NOT need this (it runs git directly
/// without a shell), but SSH does.
fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Run `git <args>` *inside* the remote host over an existing SSH session.
///
/// `cwd` is a unix path on the remote; we pass it to `git -C` just like the WSL
/// branch. Each argument is single-quoted (`sh_quote`) because russh's `exec`
/// forwards the command string through the remote shell.
pub(crate) async fn git_exec_ssh(
    ssh: &SshManager,
    cwd: &str,
    args: &[&str],
    session_id: &str,
) -> GitOutput {
    let session = match ssh.get(session_id).await {
        Ok(s) => s,
        Err(e) => {
            return GitOutput {
                stdout: String::new(),
                stderr: e.to_string(),
                exit_code: -1,
            }
        }
    };
    let mut parts: Vec<String> = vec![format!("git -C {}", sh_quote(cwd))];
    for a in args {
        parts.push(sh_quote(a));
    }
    let command = parts.join(" ");
    match session.exec_capture(&command).await {
        Ok(o) => o,
        Err(e) => GitOutput {
            stdout: String::new(),
            stderr: e.to_string(),
            exit_code: -1,
        },
    }
}

/// Dispatch a git invocation to the right backend: SSH session (when
/// `ssh_session` is set), otherwise the existing local/WSL `git_exec`.
async fn git_run(
    state: &AppState,
    cwd: &str,
    args: &[&str],
    distro: &Option<String>,
    ssh_session: &Option<String>,
) -> GitOutput {
    if let Some(id) = ssh_session {
        git_exec_ssh(&state.ssh, cwd, args, id).await
    } else {
        git_exec(cwd, args, distro)
    }
}

/// Parse `git status --porcelain=v1 -b -uall` output into `GitStatus`.
async fn parse_status(
    stdout: &str,
    cwd: &str,
    distro: &Option<String>,
    state: &AppState,
    ssh_session: &Option<String>,
) -> GitStatus {
    let mut branch = String::new();
    let mut upstream: Option<String> = None;
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut entries: Vec<GitFileEntry> = Vec::new();

    for line in stdout.lines() {
        if line.starts_with("## ") {
            let rest = &line[3..];
            // `branch...upstream [ahead N, behind M]`
            if let Some((br, tail)) = rest.split_once("...") {
                branch = br.to_string();
                let tail = tail.trim();
                // tail may be `origin/main` or `origin/main [ahead N, behind M]`
                if let Some(bracket) = tail.find('[') {
                    upstream = Some(tail[..bracket].trim().to_string());
                    let inside = &tail[bracket + 1..tail.len() - 1];
                    for part in inside.split(',') {
                        let p = part.trim();
                        if let Some(n) = p.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        } else if let Some(n) = p.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                } else {
                    upstream = Some(tail.to_string());
                }
            } else {
                branch = rest.to_string();
            }
            continue;
        }

        // Porcelain line: "XY path" (XY are single chars, possibly space).
        if line.len() < 3 {
            continue;
        }
        let x = line[0..1].to_string();
        let y = line[1..2].to_string();
        let path = line[3..].to_string();
        let staged = x != " " && x != "?" && x != "!";
        let unstaged = y != " " && y != "?" && y != "!";
        let untracked = x == "?";
        entries.push(GitFileEntry {
            path,
            x,
            y,
            staged,
            unstaged,
            untracked,
        });
    }

    // Fallback: if the `## ` header line was absent/malformed (unusual git
    // build or detached state quirks), resolve the current branch directly so
    // the panel never shows an empty branch.
    if branch.is_empty() {
        let cur = git_run(
            state,
            cwd,
            &["symbolic-ref", "--short", "HEAD"],
            distro,
            ssh_session,
        )
        .await;
        if cur.exit_code == 0 {
            let b = cur.stdout.trim().to_string();
            if !b.is_empty() {
                branch = b;
            }
        }
    }

    GitStatus {
        branch,
        upstream,
        ahead,
        behind,
        entries,
    }
}

/// Run `git status` and parse it, routing through the SSH/local/WSL dispatcher.
/// Shared by `git_status`, `git_diff` (untracked detection) and `git_push`.
async fn run_status(
    state: &AppState,
    cwd: &str,
    distro: &Option<String>,
    ssh_session: &Option<String>,
) -> Result<GitStatus, String> {
    let out = git_run(
        state,
        cwd,
        &["status", "--porcelain=v1", "-b", "-uall"],
        distro,
        ssh_session,
    )
    .await;
    if out.exit_code != 0 {
        return Err(out.stderr.trim().to_string());
    }
    Ok(parse_status(&out.stdout, cwd, distro, state, ssh_session).await)
}

/// `git status --porcelain=v1 -b -uall` → structured status.
#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    cwd: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<GitStatus, String> {
    run_status(&state, &cwd, &distro, &ssh_session).await
}

/// Parse `git branch --format=%(refname:short)` output, with the current branch
/// detected separately via `symbolic-ref` (the format omits the `*` marker) and
/// moved to the front of the list. `remote_text` is the raw output of
/// `git branch -r`; pass `None` to skip remote parsing.
fn parse_branches(local_text: &str, current: &str, remote_text: Option<&str>) -> GitBranches {
    let mut branches: Vec<String> = Vec::new();
    for line in local_text.lines() {
        let name = line.trim().to_string();
        if name.is_empty() {
            continue;
        }
        branches.push(name);
    }
    // Ensure the current branch is present in the list (and first).
    if !current.is_empty() && !branches.contains(&current.to_string()) {
        branches.insert(0, current.to_string());
    } else if !current.is_empty() {
        // Move the current branch to the front for a stable selection.
        if let Some(pos) = branches.iter().position(|b| b == current) {
            let b = branches.remove(pos);
            branches.insert(0, b);
        }
    }

    let mut remotes: Vec<String> = Vec::new();
    if let Some(text) = remote_text {
        for line in text.lines() {
            let name = line.trim().to_string();
            if name.is_empty() || name.starts_with('*') {
                continue;
            }
            // Drop the "origin/HEAD -> origin/main" symref line.
            if name.contains(" -> ") {
                continue;
            }
            remotes.push(name);
        }
    }

    GitBranches {
        current: current.to_string(),
        branches,
        remotes,
    }
}

/// `git branch` + `git branch -r` → structured branch list.
#[tauri::command]
pub async fn git_branches(
    state: State<'_, AppState>,
    cwd: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<GitBranches, String> {
    let local_out = git_run(
        &state,
        &cwd,
        &["branch", "--format=%(refname:short)"],
        &distro,
        &ssh_session,
    )
    .await;
    if local_out.exit_code != 0 {
        return Err(local_out.stderr.trim().to_string());
    }
    // `--format=%(refname:short)` does NOT emit the `*` marker, so detect the
    // current branch separately via `symbolic-ref` (errors on detached HEAD,
    // which we tolerate by leaving `current` empty).
    let current_out = git_run(
        &state,
        &cwd,
        &["symbolic-ref", "--short", "HEAD"],
        &distro,
        &ssh_session,
    )
    .await;
    let current = if current_out.exit_code == 0 {
        current_out.stdout.trim().to_string()
    } else {
        String::new()
    };

    let remote_out = git_run(&state, &cwd, &["branch", "-r"], &distro, &ssh_session).await;
    let remote_text = if remote_out.exit_code == 0 {
        Some(remote_out.stdout.as_str())
    } else {
        None
    };

    Ok(parse_branches(&local_out.stdout, &current, remote_text))
}

/// A combined status + branch snapshot used by the panel's `refresh()`.
///
/// Calling `git_status` + `git_branches` separately fires ~3 `wsl.exe`
/// invocations on WSL (each crossing the VM boundary at ~170–250ms). Batching
/// them into a single `wsl.exe` call brings a WSL refresh down to one spawn,
/// making it feel close to the instant local Git for Windows path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub status: GitStatus,
    pub branches: GitBranches,
}

/// Build a snapshot: status + branch list (+ current + remotes) in one shot.
///
/// For WSL (a unix `cwd`) we run a single `wsl.exe -e bash -c "<script>"`
/// where the script runs all four `git` queries, separated by a NUL sentinel
/// (`\0SEP\0`), and we split the combined stdout back into parts. For local
/// sessions we just call the existing helpers (each a fast host-git spawn).
#[tauri::command]
pub async fn git_snapshot(
    state: State<'_, AppState>,
    cwd: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<GitSnapshot, String> {
    // SSH session: run the four queries in ONE `exec_capture` (one round-trip).
    // The `cwd` is a unix path on the remote; quote it for the remote shell.
    if let Some(id) = &ssh_session {
        let session = state
            .ssh
            .get(id)
            .await
            .map_err(|e| e.to_string())?;
        let cwd_q = sh_quote(&cwd);
        let script = format!(
            "git -C {cwd_q} status --porcelain=v1 -b -uall; ec=$?; printf '\\0SEP\\0'; \
             git -C {cwd_q} branch --format='%(refname:short)'; printf '\\0SEP\\0'; \
             git -C {cwd_q} symbolic-ref --short HEAD; printf '\\0SEP\\0'; \
             git -C {cwd_q} branch -r; exit $ec"
        );
        let out = session
            .exec_capture(&script)
            .await
            .map_err(|e| e.to_string())?;

        // The status query is the authoritative "is this a repo?" check.
        if out.exit_code != 0 {
            return Err(out.stderr.trim().to_string());
        }

        let parts: Vec<&str> = out.stdout.split("\0SEP\0").collect();
        let status_text = parts.first().copied().unwrap_or("").trim_end();
        let branch_text = parts.get(1).copied().unwrap_or("").trim_end();
        let current_text = parts.get(2).copied().unwrap_or("").trim();
        let remote_text = parts.get(3).copied();

        let status = parse_status(status_text, &cwd, &distro, &state, &ssh_session).await;
        let branches = parse_branches(branch_text, current_text, remote_text);
        return Ok(GitSnapshot { status, branches });
    }

    let is_unix_path = cwd.starts_with('/') && !cwd.contains(':');

    if is_unix_path {
        // One `wsl.exe` call runs all queries inside WSL and prints them back
        // separated by a sentinel that cannot appear in git's own output.
        let script = format!(
            "git -C {cwd:?} status --porcelain=v1 -b -uall; printf '\\0SEP\\0'; \
             git -C {cwd:?} branch --format='%(refname:short)'; printf '\\0SEP\\0'; \
             git -C {cwd:?} symbolic-ref --short HEAD; printf '\\0SEP\\0'; \
             git -C {cwd:?} branch -r"
        );
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-e");
        if let Some(d) = &distro {
            if !d.is_empty() {
                cmd.args(["-d", d]);
            }
        }
        cmd.args(["bash", "-c", &script]);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let out = match cmd.output() {
            Ok(o) => GitOutput {
                stdout: String::from_utf8_lossy(&o.stdout).to_string(),
                stderr: String::from_utf8_lossy(&o.stderr).to_string(),
                exit_code: o.status.code().unwrap_or(-1),
            },
            Err(e) => GitOutput {
                stdout: String::new(),
                stderr: format!("failed to launch git: {e}"),
                exit_code: -1,
            },
        };

        // The status query is the authoritative "is this a repo?" check: if it
        // fails the whole snapshot is invalid. The branch/current/remote parts
        // are best-effort (e.g. current errors on detached HEAD).
        if out.exit_code != 0 {
            return Err(out.stderr.trim().to_string());
        }

        let parts: Vec<&str> = out.stdout.split("\0SEP\0").collect();
        let status_text = parts.first().copied().unwrap_or("").trim_end();
        let branch_text = parts.get(1).copied().unwrap_or("").trim_end();
        let current_text = parts.get(2).copied().unwrap_or("").trim();
        let remote_text = parts.get(3).copied();

        let status = parse_status(status_text, &cwd, &distro, &state, &ssh_session).await;
        let branches = parse_branches(branch_text, current_text, remote_text);
        return Ok(GitSnapshot { status, branches });
    }

    // Local session: delegate to the existing helpers (already fast).
    let status = run_status(&state, &cwd, &distro, &ssh_session).await?;
    let branches = git_branches(state.clone(), cwd, distro, ssh_session).await?;
    Ok(GitSnapshot { status, branches })
}

/// `git add` the given paths (or all when empty).
#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    cwd: String,
    paths: Vec<String>,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let out = if paths.is_empty() {
        git_run(&state, &cwd, &["add", "-A"], &distro, &ssh_session).await
    } else {
        let mut args: Vec<String> = vec!["add".into(), "--".into()];
        args.extend(paths.iter().cloned());
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_run(&state, &cwd, &refs, &distro, &ssh_session).await
    };
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git add failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// `git restore --staged` the given paths (or all when empty).
#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    cwd: String,
    paths: Vec<String>,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let out = if paths.is_empty() {
        git_run(&state, &cwd, &["restore", "--staged", "-A"], &distro, &ssh_session).await
    } else {
        let mut args: Vec<String> = vec!["restore".into(), "--staged".into(), "--".into()];
        args.extend(paths.iter().cloned());
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_run(&state, &cwd, &refs, &distro, &ssh_session).await
    };
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git restore --staged failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// `git commit` (optionally `--amend`).
#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    cwd: String,
    message: String,
    amend: bool,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".to_string());
    }
    let args: Vec<&str> = if amend {
        vec!["commit", "--amend", "-m", &message]
    } else {
        vec!["commit", "-m", &message]
    };
    let out = git_run(&state, &cwd, &args, &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git commit failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// Switch to an existing branch (`git switch`).
#[tauri::command]
pub async fn git_checkout(
    state: State<'_, AppState>,
    cwd: String,
    branch: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let out = git_run(&state, &cwd, &["switch", &branch], &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git switch failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// Create and switch to a new branch (`git switch -c`).
#[tauri::command]
pub async fn git_new_branch(
    state: State<'_, AppState>,
    cwd: String,
    name: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("branch name is empty".to_string());
    }
    let out = git_run(&state, &cwd, &["switch", "-c", &name], &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git switch -c failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// `git fetch` (all remotes).
#[tauri::command]
pub async fn git_fetch(
    state: State<'_, AppState>,
    cwd: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let out = git_run(&state, &cwd, &["fetch", "--all"], &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git fetch failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// `git pull` (current branch's upstream).
#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    cwd: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let out = git_run(&state, &cwd, &["pull"], &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git pull failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// `git push`; when the branch has no upstream, push `-u origin <branch>`.
#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    cwd: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let st = run_status(&state, &cwd, &distro, &ssh_session).await.ok();
    let branch = st.as_ref().map(|s| s.branch.clone()).unwrap_or_default();
    let args: Vec<&str> = if let Some(s) = st.as_ref() {
        if s.upstream.is_none() && !branch.is_empty() {
            vec!["push", "-u", "origin", &branch]
        } else {
            vec!["push"]
        }
    } else {
        vec!["push"]
    };
    let out = git_run(&state, &cwd, &args, &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git push failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// Produce a unified diff for a single file.
///
/// - `staged` true  → `git diff --cached` (changes already in the index).
/// - `staged` false → `git diff` of the working tree (unstaged edits), or for a
///   brand-new untracked file, a `git diff --no-index /dev/null <path>` so the
///   whole file shows as additions.
///
/// Porcelain reports renames as `old -> new`; we diff against the new path.
/// `git diff --no-index` exits 1 when the files differ — that is the expected
/// "has a diff" case, so we return stdout as the diff rather than erroring.
#[tauri::command]
pub async fn git_diff(
    state: State<'_, AppState>,
    cwd: String,
    path: String,
    staged: bool,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<GitDiff, String> {
    let diff_path = if let Some((_, new)) = path.split_once(" -> ") {
        new.trim()
    } else {
        path.trim()
    };
    if diff_path.is_empty() {
        return Err("file path is empty".to_string());
    }

    let args: Vec<String> = if staged {
        vec!["diff".into(), "--cached".into(), "--".into(), diff_path.into()]
    } else {
        // Untracked files have no committed version to diff against.
        let is_untracked = run_status(&state, &cwd, &distro, &ssh_session)
            .await
            .map(|s| s.entries.iter().any(|e| e.untracked && e.path == path))
            .unwrap_or(false);
        if is_untracked {
            vec![
                "diff".into(),
                "--no-index".into(),
                "--".into(),
                "/dev/null".into(),
                diff_path.into(),
            ]
        } else {
            vec!["diff".into(), "--".into(), diff_path.into()]
        }
    };

    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = git_run(&state, &cwd, &refs, &distro, &ssh_session).await;

    // `--no-index` exits 1 when there is a diff; treat that as success.
    let is_no_index = refs.windows(2).any(|w| w[0] == "diff" && w[1] == "--no-index");
    if out.exit_code != 0 && !(is_no_index && out.exit_code == 1) {
        let msg = out.stderr.trim().to_string();
        if !msg.is_empty() {
            return Err(msg);
        }
    }

    let binary = out.stdout.contains("Binary files differ")
        || out.stdout.contains("Binary files ")
        || out.stdout.contains("GIT binary patch");

    Ok(GitDiff {
        text: out.stdout,
        binary,
    })
}

/// `git log` — recent commits (hash, author, date, subject).
///
/// Uses a `\x1f`-separated custom format with `--date=short`. Because the
/// subject (`%s`) is a single line, every commit occupies exactly one output
/// line, so we can split on newlines without ambiguity.
#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    cwd: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<Vec<GitCommit>, String> {
    let out = git_run(
        &state,
        &cwd,
        &[
            "log",
            "--max-count=200",
            "--date=short",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s",
        ],
        &distro,
        &ssh_session,
    )
    .await;
    if out.exit_code != 0 {
        // A repo with no commits yet exits non-zero; return empty rather than error.
        if out.stdout.trim().is_empty() {
            return Ok(Vec::new());
        }
        return Err(out.stderr.trim().to_string());
    }

    let mut commits = Vec::new();
    for line in out.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 5 {
            continue;
        }
        commits.push(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
            subject: parts[4].to_string(),
            body: String::new(),
        });
    }
    Ok(commits)
}

/// Diff for a single commit (`git show <hash>`), reused for the log detail view.
#[tauri::command]
pub async fn git_commit_diff(
    state: State<'_, AppState>,
    cwd: String,
    hash: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<GitDiff, String> {
    if hash.trim().is_empty() {
        return Err("commit hash is empty".to_string());
    }
    let out = git_run(&state, &cwd, &["show", "--format=", &hash], &distro, &ssh_session).await;
    // `git show` exits 0 on success; non-zero means a bad hash / not a repo.
    if out.exit_code != 0 {
        let msg = out.stderr.trim().to_string();
        if !msg.is_empty() {
            return Err(msg);
        }
    }
    let binary = out.stdout.contains("Binary files differ")
        || out.stdout.contains("Binary files ")
        || out.stdout.contains("GIT binary patch");
    Ok(GitDiff {
        text: out.stdout,
        binary,
    })
}

/// Move HEAD to `target` (a commit hash or branch) with the given reset mode.
///
/// - `soft`  → move HEAD only (changes stay staged)
/// - `mixed` → move HEAD + reset index (changes stay in working tree, unstaged)
/// - `hard`  → move HEAD + reset index + working tree (DISCARDS all changes)
#[tauri::command]
pub async fn git_reset(
    state: State<'_, AppState>,
    cwd: String,
    mode: String,
    target: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    if target.trim().is_empty() {
        return Err("reset target is empty".to_string());
    }
    let out = git_run(&state, &cwd, &["reset", flag, &target], &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git reset failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}

/// Check out a commit directly (detached HEAD) to inspect an old state.
#[tauri::command]
pub async fn git_checkout_commit(
    state: State<'_, AppState>,
    cwd: String,
    hash: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    if hash.trim().is_empty() {
        return Err("commit hash is empty".to_string());
    }
    let out = git_run(&state, &cwd, &["checkout", &hash], &distro, &ssh_session).await;
    if out.exit_code == 0 {
        Ok(out.stdout.trim().to_string())
    } else {
        let msg = out.stderr.trim().to_string();
        Err(if msg.is_empty() {
            format!("git checkout failed (exit {})", out.exit_code)
        } else {
            msg
        })
    }
}
