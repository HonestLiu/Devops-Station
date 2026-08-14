//! Detects "waiting for approval" prompts emitted by vibecoding CLI tools
//! (Claude Code, Codex, Gemini CLI, Aider, Cursor, OpenCode, …) in the live
//! terminal output of any session, and turns them into:
//!   1. an in-app `perm-request` event (frontend shows a bell entry), and
//!   2. an OS-level system notification (so the user is pulled back to approve).
//!
//! Detection runs on the *live* output path of every transport (pty/ssh/serial),
//! gated behind a cheap substring check so the hot path stays cheap, then a
//! small set of regex rules classifies the tool and captures the prompt text.
//!
//! IMPORTANT: this function is invoked on the per-session output thread/task for
//! *every* chunk of terminal output. A coding agent re-renders its permission
//! prompt on every frame (spinner / cursor movement), so the exact text is
//! never identical twice. We therefore throttle by (session, tool) — not by the
//! exact snippet — to at most one alert per window. Otherwise we would emit a
//! `perm-request` event and raise an OS notification on every frame, flooding
//! the webview main thread and freezing the whole app. The OS notification is
//! also raised off the hot path (spawned onto the async runtime) so even a slow
//! or blocking `show()` can never stall the terminal output thread.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use tauri::{AppHandle, Emitter};

use crate::types::PermRequest;

/// One matcher: a regex that flags a permission prompt (in the tail of output).
/// The tool *label* is derived separately by `attribute_tool`, because the agent's
/// own name usually lives in the banner rather than in the tail prompt box.
struct Rule {
    re: Regex,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mk = |pat: &str| Rule {
            re: Regex::new(pat).expect("perm rule regex must compile"),
        };
        // Confirmation tokens an agent CLI shows next to an approval prompt.
        // Covers every `(y/n)` / `[Y/N]` / `yes/no` / single-letter `(y)` shape
        // we have seen across tools, so a prompt is caught regardless of which
        // specific character the tool uses for its shortcut.
        const TOKEN: &str = r"(?:\(y/n\)|\(Y/n\)|\(y/N\)|\(Y/N\)|\(y\)|\(Y\)|\(yes/no\)|\(Yes/No\)|\[y/n\]|\[Y/n\]|\[y/N\]|\[Y/N\]|\[yes/no\]|\[Yes/No\]|\byes/no\b|\bYes/No\b|\by/n\b|\bY/N\b|\by\|n\b)";
        // Verbs that introduce an approval / confirmation request. `permission`
        // is included so prompts like "Permission required (y/n)" match even
        // though they do not use the verb "allow".
        const VERB: &str = r"(?:allow|approve|permit|confirm|proceed|authorize|authorization|accept|grant|permission)";
        // Approval context that a tool name may appear next to (no token needed).
        const CTX: &str = r"(?:permission|approval|wants|needs|is requesting|requests|would like|to (?:run|execute|edit|read|write|modify|create|delete|access|open|install|update|make|use))";
        // Known agent-CLI brands (matched case-insensitively). Word boundaries on
        // the short ones (`\broo\b`, `\bkilo\b`) stop "kilobytes" / "borrowed"
        // from being treated as Roo / Kilo. A bare mention still never triggers —
        // every rule below requires the name *with* a verb/token/context.
        const TOOLS: &str = r"(?:claude|codex|gemini|aider|cursor|opencode|windsurf|cline|goose|\broo\b|\bkilo\b|qwen|copilot|amazon\s+q|q\s*developer|qwen\s*code)";
        vec![
            // --- Claude Code (expanded) ---
            mk(r"(?i)(claude (needs|wants|is requesting|requests|would like|may|is about to|is trying to)( your)? (permission|approval|to (run|execute|edit|read|write|modify|create|delete|access|open|install|update|make|use))|allow (claude|once|always)|claude (wants|needs) (your )?(go|ok|okay))"),
            // --- Codex (OpenAI) ---
            mk(r"(?i)(codex|would you like to (run|execute|perform|make) (the following|this|an?)|tell (codex|the agent) what to do differently)"),
            mk(r"(?i)proceed \((y|Y)\)|yes,? proceed \((y|Y)\)"),
            // --- Gemini CLI ---
            mk(r"(?i)(approve \(y/n\)|allow gemini|gemini (needs|wants)( your)? (permission|to)|do you want gemini)"),
            // --- Aider ---
            mk(r"(?i)(apply edit\?|edit the file\?|commit\?|aider.*approve|allow aider)"),
            // --- Cursor ---
            mk(r"(?i)(cursor agent|approve this action|allow this (action|tool)|cursor (wants|needs)( your)? (permission|to))"),
            // --- Continue (the AI tool): matched only by its own phrasing, never
            //     by the English word "continue" used elsewhere, so installer
            //     "Press enter to continue" prompts stay silent. ---
            mk(r"(?i)continue (wants|needs|is requesting|would like)( your)? (permission|approval|to (run|execute|read|write|edit|create|delete|access))"),
            // --- Goose / Roo / Kilo / Qwen / Copilot / Amazon Q / OpenCode /
            //     Windsurf / Cline: brand name *together with* either an approval
            //     context or a confirmation token. A bare mention (path/URL/install
            //     command) never triggers. ---
            mk(&format!(r"(?i)({TOOLS}).{{0,80}}?({CTX})")),
            mk(&format!(r"(?i)({TOOLS}).{{0,60}}?({TOKEN})")),
            // --- generic fallback (tight): only agent-style confirmations, NOT
            //     arbitrary `Allow X? (y/n)` (e.g. a cookie banner). We require
            //     either "permission/authorization" next to a token, or an approval
            //     verb followed by a determiner (this/the/these/that/it) then a
            //     token — phrasing typical of agent CLIs. ---
            mk(&format!(r"(?i)(permission|authorization) (required|needed|requested).{{0,30}}?({TOKEN})")),
            mk(&format!(r"(?i)({VERB}) (this|the|these|that|it) .{{0,30}}?({TOKEN})")),
            // --- question-style approvals that may show NO visible token ---
            mk(r"(?i)do you want to (allow|proceed|approve|run|execute|continue|accept)"),
            mk(r"(?i)would you like to (allow|proceed|approve|continue|accept)"),
            mk(r"(?i)(accept|confirm) (the )?(change|edit|command|action|operation)\?"),
            mk(r"(?i)are you sure you want to (run|execute|delete|remove|overwrite|proceed|apply)"),
            mk(r"(?i)press .{0,30}?to (accept|proceed|confirm|approve|allow|run|execute)"),
        ]
    })
}

/// Substrings that, if present, make running the (cheaper) regex worthwhile.
/// Only the *distinctive* tool names live here; ordinary English words that an
/// agent banner would not uniquely own (e.g. "continue") are deliberately kept
/// out so a pager like `less --MORE--` or an installer "press enter to continue"
/// never reaches the (still precise) regex stage.
const TRIGGERS: &[&str] = &[
    "y/n", "Y/n", "y/N", "yes/no", "approve", "allow", "permission", "proceed",
    "confirm", "accept", "sure", "claude", "codex", "gemini", "aider", "cursor",
    "opencode", "windsurf", "cline", "goose", "roo", "kilo", "qwen", "copilot",
    "amazon q", "q developer", "edit the file", "run command", "do you want to",
    "would you like to",
];

/// Matches ANSI/console escape sequences so the notification text is clean.
fn ansi_strip() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap())
}

/// One recorded alert per session: when it fired and the prompt prefix we saw.
/// The prefix is what lets us tell "same approval, TUI redraw" (dedupe) from
/// "genuinely new approval" (notify immediately).
struct AlertStamp {
    at: Instant,
    prefix: String,
}

/// Per session last-alert stamp — used to throttle the alert so a re-rendering
/// prompt cannot spam the user or the webview thread. Dedup keyed by (session,
/// prompt-prefix) instead of a bare time window so a *new* approval is never
/// swallowed inside the window of a previous one, and the *same* approval is
/// not re-alerted every window expiry while it is still waiting on the user.
fn last_alert() -> &'static Mutex<HashMap<String, AlertStamp>> {
    static LAST: OnceLock<Mutex<HashMap<String, AlertStamp>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Global switch for native OS notifications triggered by approval prompts.
/// The frontend toggles this via `set_approval_notifications`.
static APPROVAL_NOTIFICATIONS_ENABLED: AtomicBool = AtomicBool::new(true);

/// Enable or disable native OS notifications for agent/CLI approval prompts.
pub fn set_approval_notifications(enabled: bool) {
    APPROVAL_NOTIFICATIONS_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Same-prompt redraws within this window are deduplicated. 300s is long
/// enough that an ignored approval gets one (quiet) nudge later, while a fresh
/// approval (different prefix) always passes immediately.
const ALERT_WINDOW: Duration = Duration::from_secs(300);

/// How much of the (tail of the) text we surface as the notification snippet.
const SNIPPET_LEN: usize = 240;

fn cheap_hit(text: &str) -> bool {
    TRIGGERS.iter().any(|t| text.contains(t))
}

/// Per session last-attributed specific tool (e.g. "Claude Code"). When the
/// current chunk falls back to the generic "Coding Agent" we keep using the
/// tool name we already pinned for this session — a TUI's approval prompt
/// itself rarely contains the agent's own brand name (only the banner does),
/// so a session-scoped cache is the cheapest way to avoid mis-labelling the
/// notification toast.
fn last_attributed_tool() -> &'static Mutex<HashMap<String, String>> {
    static LAST: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pick the most likely tool from the whole chunk. A coding agent's own name
/// ("claude", "codex", …) usually lives in the startup banner / earlier output,
/// not in the tail prompt box, so we look across the entire chunk for the first
/// known marker. This runs only after we have *confirmed* a prompt is present
/// (see `scan_and_emit`), so the whole-chunk scan is never on the hot path.
fn attribute_tool(text: &str) -> &'static str {
    // Lowercased once; only reached when a real prompt was just detected.
    let t = text.to_ascii_lowercase();
    // Order matters: more specific / distinctive brands first. "amazon q" and
    // "q developer" are checked before the bare "qwen" family so the label is
    // precise; "continue" is last so it can only label a prompt that actually
    // tripped the Continue-specific rule above (not ordinary "continue" text).
    if t.contains("claude") {
        "Claude Code"
    } else if t.contains("codex") {
        "Codex"
    } else if t.contains("gemini") {
        "Gemini CLI"
    } else if t.contains("aider") {
        "Aider"
    } else if t.contains("cursor") {
        "Cursor"
    } else if t.contains("opencode") {
        "OpenCode"
    } else if t.contains("windsurf") {
        "Windsurf"
    } else if t.contains("cline") {
        "Cline"
    } else if t.contains("goose") {
        "Goose"
    } else if t.contains("roo") {
        "Roo Code"
    } else if t.contains("kilo") {
        "Kilo Code"
    } else if t.contains("qwen") {
        "Qwen Code"
    } else if t.contains("copilot") {
        "GitHub Copilot"
    } else if t.contains("amazon q") || t.contains("q developer") {
        "Amazon Q"
    } else if t.contains("continue") {
        "Continue"
    } else {
        "Coding Agent"
    }
}

/// Inspect one chunk of raw terminal output. If it reads as a permission prompt,
/// emit a `perm-request` event and raise an OS notification — at most once per
/// `ALERT_WINDOW` per session, and with the OS notification raised off the hot path.
pub fn scan_and_emit(app: &AppHandle, session_id: &str, chunk: &[u8]) {
    let raw = String::from_utf8_lossy(chunk);
    if !cheap_hit(&raw) {
        return;
    }

    // Strip ANSI so control sequences / box-drawing don't interfere with matching.
    // We match the WHOLE chunk: a TUI (Claude Code, etc.) redraws its permission
    // box with cursor-control sequences, so the prompt text is NOT at the byte
    // stream's tail — scanning only the tail would miss it entirely. A too-loose
    // whole-chunk scan caused false positives before, so the rules themselves are
    // kept precise (specific phrases / approval-verb + y/n token) to compensate.
    let cleaned = ansi_strip().replace_all(&raw, "");
    if !rules().iter().any(|r| r.re.is_match(&cleaned)) {
        return;
    }

    // Attribute the tool across the WHOLE chunk — the agent's own name usually
    // lives in the banner, not in the prompt box, so a tail-only match would
    // otherwise always fall back to the generic "Coding Agent" label. When the
    // current chunk does fall back to "Coding Agent", keep using the specific
    // tool name we already pinned for this session (if any) so the OS toast and
    // the in-app bell show "Claude Code" instead of "Coding Agent" for a
    // Claude Code session whose approval prompt itself doesn't contain the word
    // "claude".
    let raw_tool = attribute_tool(&raw);
    let tool = if raw_tool == "Coding Agent" {
        last_attributed_tool()
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| raw_tool.to_string())
    } else {
        last_attributed_tool()
            .lock()
            .unwrap()
            .insert(session_id.to_string(), raw_tool.to_string());
        raw_tool.to_string()
    };

    // Surface the HEAD of the prompt as the notification snippet — the *head* is
    // the stable part of an agent-CLI approval prompt (question + command) and
    // doesn't move when the TUI re-renders cursor/option-highlight on its tail.
    // Take whole lines (up to 6, capped by SNIPPET_LEN chars) instead of a raw
    // char slice so we never land on a truncated word like "…mmand" in the OS
    // toast. We deliberately take from the *front* of the prompt so the snippet
    // is stable across redraws — a sliding tail would produce a different snippet
    // every frame and the prefix-based dedup would miss every fire.
    let snippet: String = {
        let lines: Vec<&str> = cleaned
            .lines()
            .map(str::trim_end)
            .filter(|l| !l.trim().is_empty())
            .collect();
        let max = SNIPPET_LEN;
        let mut buf = String::new();
        for line in lines.iter().take(6) {
            if !buf.is_empty() {
                buf.push('\n');
            }
            buf.push_str(line);
            if buf.chars().count() >= max {
                break;
            }
        }
        buf
    };
    if snippet.trim().is_empty() {
        return;
    }

    // Throttle by (session, prompt-prefix). This is the critical guard that
    // prevents the emit + OS-notification storm that previously froze the whole
    // app when a coding agent re-rendered its prompt on every frame. The prefix
    // comparison means:
    //   • same approval re-rendering (TUI redraw, spinner, cursor) → deduped,
    //   • a genuinely new approval → let through immediately, never swallowed
    //     inside a previous alert's window, so it doesn't feel slow or silent.
    let prefix: String = snippet.chars().take(60).collect();
    {
        let mut last = last_alert().lock().unwrap();
        let now = Instant::now();
        let dup = last.get(session_id).map_or(false, |st| {
            now.saturating_duration_since(st.at) < ALERT_WINDOW && st.prefix == prefix
        });
        if dup {
            return;
        }
        last.insert(session_id.to_string(), AlertStamp { at: now, prefix });
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let payload = PermRequest {
        session_id: session_id.to_string(),
        tool: tool.to_string(),
        snippet: snippet.clone(),
        ts,
    };
    // In-app bell + history (frontend listens on this event). Throttled to once
    // per ALERT_WINDOW, so this can no longer flood the webview main thread.
    let _ = app.emit("perm-request", &payload);

    // OS-level system notification so the user is pulled away from whatever
    // they were doing and comes back to approve. Failures are non-fatal. This is
    // spawned onto the async runtime (not run inline) so a slow or blocking
    // `show()` can never stall the terminal output thread, which was part of
    // what made the app feel frozen.
    if APPROVAL_NOTIFICATIONS_ENABLED.load(Ordering::Relaxed) {
        let app2 = app.clone();
        let snippet2 = snippet;
        tauri::async_runtime::spawn(async move {
            let title = format!("Approval needed · {tool}");
            // Cap the toast body at 3 whole lines so a long prompt never lands on
            // a truncated word in the OS notification centre.
            let lines: Vec<&str> = snippet2.lines().collect();
            let body = if lines.len() > 3 {
                format!("{}\n…", lines[..3].join("\n"))
            } else {
                snippet2
            };
            // Attribute the OS notification to this app (see crate::notify).
            crate::notify::show(&app2, &title, &body);
        });
    }
}
