//! Graphical Docker operations for the Local/WSL/SSH terminal workspaces.
//!
//! Every command shells out to the `docker` CLI. The target is selected the
//! same way Git does (see `git.rs`):
//! - `ssh_session` set  -> run over the active SSH session (`docker ...`)
//! - `distro` set       -> run inside WSL via `wsl.exe -e docker ...`
//! - neither            -> run the host `docker` directly (Docker Desktop)
//!
//! Output is returned as plain `Result<_, String>` so the frontend can surface
//! Docker's own messages and treat a non-zero exit as an expected, recoverable
//! event (e.g. "container already running", auth errors).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use crate::git::GitOutput;
use crate::ssh::SshManager;
use crate::AppState;

/// A single container, as reported by `docker ps --format '{{json .}}'`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub names: String,
    pub image: String,
    pub status: String,
    /// Coarse lifecycle state: running | exited | paused | created | ...
    pub state: String,
    pub ports: String,
    pub created: String,
    pub command: String,
    pub size: String,
}

/// A single image, as reported by `docker images --format '{{json .}}'`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id: String,
    pub repo: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}

/// Options for `docker run`, deserialized from the frontend form.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerRunOptions {
    pub image: String,
    pub name: Option<String>,
    pub ports: Vec<String>,
    pub envs: Vec<String>,
    pub cmd: Option<String>,
    pub detach: bool,
    pub rm: bool,
}

/// Single-quote a string for a POSIX shell, escaping embedded single quotes.
/// Over SSH the command runs through the remote login shell, so every argument
/// must be quoted to survive spaces and shell metacharacters.
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

/// Run `docker <args>` on the host (or inside WSL when `distro` is set),
/// capturing stdout/stderr/exit code.
fn docker_exec(args: &[String], distro: &Option<String>) -> GitOutput {
    let is_wsl = distro.as_ref().map(|d| !d.is_empty()).unwrap_or(false);
    let mut cmd = if is_wsl {
        let mut c = Command::new("wsl.exe");
        c.arg("-e").args(["-d", distro.as_ref().unwrap()]);
        c.args(["docker"]);
        c.args(args);
        c
    } else {
        let mut c = Command::new("docker");
        c.args(args);
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
            stderr: format!("failed to launch docker: {e}"),
            exit_code: -1,
        },
    }
}

/// Run `docker <args>` *inside* the remote host over an existing SSH session.
async fn docker_exec_ssh(ssh: &SshManager, args: &[String], session_id: &str) -> GitOutput {
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
    let mut parts: Vec<String> = vec!["docker".to_string()];
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

/// Dispatch a docker invocation to the right backend: SSH session (when
/// `ssh_session` is set), otherwise the local/WSL `docker_exec`.
async fn docker_dispatch(
    state: &AppState,
    args: &[String],
    distro: &Option<String>,
    ssh_session: &Option<String>,
) -> GitOutput {
    if let Some(id) = ssh_session {
        docker_exec_ssh(&state.ssh, args, id).await
    } else {
        docker_exec(args, distro)
    }
}

/// Convert a process result: success -> Ok(stdout), failure -> Err(stderr).
fn ok_or_err(out: &GitOutput) -> Result<String, String> {
    if out.exit_code == 0 {
        Ok(out.stdout.clone())
    } else {
        let msg = if out.stderr.trim().is_empty() {
            &out.stdout
        } else {
            &out.stderr
        };
        Err(msg.trim().to_string())
    }
}

fn parse_container(line: &str) -> Option<DockerContainer> {
    let v: Value = serde_json::from_str(line).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    // `docker ps --format '{{json .}}'` serializes `.Ports` as a JSON array
    // of {IP, PrivatePort, PublicPort, Type}, *not* a string. Flatten it into
    // the `host:container` text the frontend already knows how to parse.
    let ports = match v.get("Ports") {
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|p| {
                let ip = p.get("IP").and_then(|x| x.as_str()).unwrap_or("");
                let private = p.get("PrivatePort").and_then(|x| x.as_u64()).unwrap_or(0);
                let public = p.get("PublicPort").and_then(|x| x.as_u64()).unwrap_or(0);
                let typ = p.get("Type").and_then(|x| x.as_str()).unwrap_or("tcp");
                if public > 0 {
                    // Published: map the host port to the container port.
                    let bind = if ip.is_empty() { "0.0.0.0" } else { ip };
                    format!("{}:{}->{}", bind, public, private)
                } else {
                    // Exposed only: no host binding.
                    format!("{}/{}", private, typ.to_lowercase())
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        // Fall back to a plain string if the format ever changes.
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    Some(DockerContainer {
        id: get("ID"),
        names: get("Names"),
        image: get("Image"),
        status: get("Status"),
        state: get("State"),
        ports,
        created: get("CreatedAt"),
        command: get("Command"),
        size: get("Size"),
    })
}

fn parse_image(line: &str) -> Option<DockerImage> {
    let v: Value = serde_json::from_str(line).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(DockerImage {
        id: get("ID"),
        repo: get("Repository"),
        tag: get("Tag"),
        size: get("Size"),
        created: get("CreatedAt"),
    })
}

/// Whether a Docker daemon is reachable in the target environment.
#[tauri::command]
pub async fn docker_available(
    state: State<'_, AppState>,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<bool, String> {
    let out = docker_dispatch(
        &state,
        &["info".to_string()],
        &distro,
        &ssh_session,
    )
    .await;
    Ok(out.exit_code == 0)
}

/// List all containers (running + stopped).
#[tauri::command]
pub async fn docker_ps(
    state: State<'_, AppState>,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<Vec<DockerContainer>, String> {
    let out = docker_dispatch(
        &state,
        &[
            "ps".to_string(),
            "-a".to_string(),
            "--no-trunc".to_string(),
            "--format".to_string(),
            "{{json .}}".to_string(),
        ],
        &distro,
        &ssh_session,
    )
    .await;
    if out.exit_code != 0 {
        return Err(ok_or_err(&out).unwrap_err());
    }
    let mut containers = Vec::new();
    for line in out.stdout.lines() {
        if let Some(c) = parse_container(line) {
            containers.push(c);
        }
    }
    Ok(containers)
}

/// List images.
#[tauri::command]
pub async fn docker_images(
    state: State<'_, AppState>,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<Vec<DockerImage>, String> {
    let out = docker_dispatch(
        &state,
        &[
            "images".to_string(),
            "--no-trunc".to_string(),
            "--format".to_string(),
            "{{json .}}".to_string(),
        ],
        &distro,
        &ssh_session,
    )
    .await;
    if out.exit_code != 0 {
        return Err(ok_or_err(&out).unwrap_err());
    }
    let mut images = Vec::new();
    for line in out.stdout.lines() {
        if let Some(i) = parse_image(line) {
            images.push(i);
        }
    }
    Ok(images)
}

/// Start a container.
#[tauri::command]
pub async fn docker_start(
    state: State<'_, AppState>,
    id: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<(), String> {
    let out = docker_dispatch(&state, &["start".to_string(), id], &distro, &ssh_session).await;
    ok_or_err(&out).map(|_| ())
}

/// Stop a container.
#[tauri::command]
pub async fn docker_stop(
    state: State<'_, AppState>,
    id: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<(), String> {
    let out = docker_dispatch(&state, &["stop".to_string(), id], &distro, &ssh_session).await;
    ok_or_err(&out).map(|_| ())
}

/// Restart a container.
#[tauri::command]
pub async fn docker_restart(
    state: State<'_, AppState>,
    id: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<(), String> {
    let out = docker_dispatch(
        &state,
        &["restart".to_string(), id],
        &distro,
        &ssh_session,
    )
    .await;
    ok_or_err(&out).map(|_| ())
}

/// Remove a container (`--force` when `force` is true).
#[tauri::command]
pub async fn docker_remove(
    state: State<'_, AppState>,
    id: String,
    force: bool,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["rm".to_string()];
    if force {
        args.push("--force".to_string());
    }
    args.push(id);
    let out = docker_dispatch(&state, &args, &distro, &ssh_session).await;
    ok_or_err(&out).map(|_| ())
}

/// Remove an image (`--force` when `force` is true).
#[tauri::command]
pub async fn docker_rmi(
    state: State<'_, AppState>,
    id: String,
    force: bool,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["rmi".to_string()];
    if force {
        args.push("--force".to_string());
    }
    args.push(id);
    let out = docker_dispatch(&state, &args, &distro, &ssh_session).await;
    ok_or_err(&out).map(|_| ())
}

/// Pull an image. Returns the pull progress text on success.
#[tauri::command]
pub async fn docker_pull(
    state: State<'_, AppState>,
    name: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let out = docker_dispatch(&state, &["pull".to_string(), name], &distro, &ssh_session).await;
    ok_or_err(&out)
}

/// Fetch the last `tail` lines of a container's logs.
#[tauri::command]
pub async fn docker_logs(
    state: State<'_, AppState>,
    id: String,
    tail: i32,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let out = docker_dispatch(
        &state,
        &[
            "logs".to_string(),
            "--tail".to_string(),
            tail.to_string(),
            id,
        ],
        &distro,
        &ssh_session,
    )
    .await;
    ok_or_err(&out)
}

/// Build `docker run` args from the structured options.
fn build_run_args(opts: &DockerRunOptions) -> Vec<String> {
    let mut args = vec!["run".to_string()];
    if opts.detach {
        args.push("--detach".to_string());
    }
    if opts.rm {
        args.push("--rm".to_string());
    }
    if let Some(name) = &opts.name {
        if !name.is_empty() {
            args.push("--name".to_string());
            args.push(name.clone());
        }
    }
    for p in &opts.ports {
        if !p.is_empty() {
            args.push("-p".to_string());
            args.push(p.clone());
        }
    }
    for e in &opts.envs {
        if !e.is_empty() {
            args.push("-e".to_string());
            args.push(e.clone());
        }
    }
    args.push(opts.image.clone());
    if let Some(cmd) = &opts.cmd {
        if !cmd.is_empty() {
            for part in cmd.split_whitespace() {
                args.push(part.to_string());
            }
        }
    }
    args
}

/// Create and start a container from `opts`. Returns the new container id.
#[tauri::command]
pub async fn docker_run(
    state: State<'_, AppState>,
    opts: DockerRunOptions,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let args = build_run_args(&opts);
    let out = docker_dispatch(&state, &args, &distro, &ssh_session).await;
    ok_or_err(&out).map(|s| s.trim().to_string())
}

/// Run a docker compose action (`up` / `down` / `ps` / `restart`) against the
/// compose file at `path`.
#[tauri::command]
pub async fn docker_compose(
    state: State<'_, AppState>,
    path: String,
    action: String,
    distro: Option<String>,
    ssh_session: Option<String>,
) -> Result<String, String> {
    let args = vec![
        "compose".to_string(),
        "-f".to_string(),
        path,
        action,
    ];
    let out = docker_dispatch(&state, &args, &distro, &ssh_session).await;
    ok_or_err(&out)
}
