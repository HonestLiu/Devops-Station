//! Central state aggregator for the AI approval-reminder feature.
//!
//! Consolidates what was previously scattered dedup / state logic across
//! `perm.rs`, `perm_hook.rs`, and the frontend `usePermStore` into a single
//! source of truth (pattern inspired by ai-light's `StateAggregator`). It:
//!   - tracks every detected AI-agent session **by project** (derived from the
//!     agent's `cwd`), so the frontend can render a per-project "traffic light";
//!   - de-duplicates re-rendered approval prompts (an agent TUI repaints its
//!     permission box on every keystroke, which would otherwise re-alert);
//!   - drives the in-app bell (`perm-request`) **and** the OS notification from
//!     one place, so the two can never disagree;
//!   - auto-escalates approvals that have waited too long (re-raises the OS
//!     toast) and auto-clears ones that have waited far too long.
//!
//! A background sweep thread (mirroring ai-light's `codex_watcher`) polls the
//! active set on a fixed cadence to apply the escalation / cleanup timers.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::types::PermRequest;

/// Hard backstop: never re-emit the *same* session's approval more often than
/// this, whatever the prompt text looks like on each frame.
const COOLDOWN_MS: u64 = 8_000;
/// If an approval is still waiting this long, re-raise the OS notification so a
/// forgotten prompt cannot silently sit forever.
const ESCALATE_AFTER: Duration = Duration::from_secs(8 * 60);
/// If an approval has waited this long (since it first appeared) and was never
/// acknowledged, drop it from the list entirely.
const CLEAR_AFTER: Duration = Duration::from_secs(15 * 60);
/// Background sweep cadence (mirrors ai-light's codex_watcher POLL_INTERVAL).
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);

/// Ordered severity of an AI-agent session, used for the per-project aggregate
/// (max wins) and the traffic-light colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle = 0,
    Working = 1,
    WaitingApproval = 2,
    Resolved = 3,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSession {
    pub session_id: String,
    pub tool: String,
    pub status: AgentStatus,
    /// ANSI-stripped, truncated prompt text / command (the "what").
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// First-detection timestamp (epoch ms).
    pub ts: u64,
    /// True once the escalation sweep has re-alerted this (still-unhandled) item.
    pub escalated: bool,
    #[serde(skip)]
    pub created_at: Instant,
    #[serde(skip)]
    pub updated_at: Instant,
    #[serde(skip)]
    pub last_notified_at: Instant,
    /// User has acted on it (approve / reject / dismiss) — escalation stops.
    #[serde(skip)]
    pub acknowledged: bool,
    /// Stable identity of the prompt text, for cross-frame dedup.
    #[serde(skip)]
    pub fp: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectLight {
    pub project_id: String,
    pub project_label: String,
    pub status: AgentStatus,
    pub sessions: Vec<AgentSession>,
    pub last_event_at: u64,
}

impl ProjectLight {
    fn aggregate_status(&mut self) {
        self.status = self
            .sessions
            .iter()
            .map(|s| s.status)
            .max()
            .unwrap_or(AgentStatus::Idle);
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PermState {
    pub lights: Vec<ProjectLight>,
}

struct AggState {
    lights: HashMap<String, ProjectLight>,
    session_to_project: HashMap<String, String>,
    order: Vec<String>,
}

/// Cloneable handle to the shared aggregator; the sweep thread holds a clone.
#[derive(Clone)]
pub struct PermAggregator {
    app: AppHandle,
    state: Arc<RwLock<AggState>>,
}

impl PermAggregator {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            state: Arc::new(RwLock::new(AggState {
                lights: HashMap::new(),
                session_to_project: HashMap::new(),
                order: Vec::new(),
            })),
        }
    }

    /// Ingest a "waiting for approval" event. Emits the bell (`perm-request`) +
    /// OS toast itself when this is a *fresh* alert, and always re-emits the
    /// aggregate `perm-state-changed`.
    pub fn ingest_waiting(
        &self,
        tool: &str,
        snippet: &str,
        cwd: Option<String>,
        session_id: &str,
        source: &str,
    ) {
        let now = now_ms();
        let fp = fingerprint(snippet);
        let project_id = project_id_for(cwd.as_deref(), session_id);
        let label = project_label_for(cwd.as_deref());
        let now_inst = Instant::now();

        // Ensure the project + ordering exist first (no `light` borrow held yet,
        // so the later session mutation can re-lock cleanly).
        {
            let mut st = self.state.write().expect("perm aggregator lock poisoned");
            if !st.lights.contains_key(&project_id) {
                st.lights.insert(
                    project_id.clone(),
                    ProjectLight {
                        project_id: project_id.clone(),
                        project_label: label,
                        status: AgentStatus::Idle,
                        sessions: Vec::new(),
                        last_event_at: now,
                    },
                );
                st.order.push(project_id.clone());
            }
            st.session_to_project
                .insert(session_id.to_string(), project_id.clone());
        }

        let mut fresh = false;
        {
            let mut st = self.state.write().expect("perm aggregator lock poisoned");
            let light = st.lights.get_mut(&project_id).expect("project exists");
            if let Some(s) = light
                .sessions
                .iter_mut()
                .find(|s| s.session_id == session_id)
            {
                let since_notify = now_inst.saturating_duration_since(s.last_notified_at);
                let cooldown_ok = since_notify >= Duration::from_millis(COOLDOWN_MS);
                // Same session, same prompt, inside the cooldown window → a TUI
                // repaint (or a hook firing twice). Suppress.
                if s.status == AgentStatus::WaitingApproval && s.fp == fp && !cooldown_ok {
                    // duplicate — keep silent
                } else {
                    s.status = AgentStatus::WaitingApproval;
                    s.snippet = snippet.to_string();
                    s.tool = tool.to_string();
                    s.cwd = cwd.clone();
                    s.ts = now;
                    s.fp = fp;
                    s.escalated = false;
                    s.acknowledged = false;
                    s.updated_at = now_inst;
                    s.last_notified_at = now_inst;
                    fresh = true;
                }
            } else {
                light.sessions.push(AgentSession {
                    session_id: session_id.to_string(),
                    tool: tool.to_string(),
                    status: AgentStatus::WaitingApproval,
                    snippet: snippet.to_string(),
                    cwd: cwd.clone(),
                    ts: now,
                    escalated: false,
                    acknowledged: false,
                    created_at: now_inst,
                    updated_at: now_inst,
                    last_notified_at: now_inst,
                    fp,
                });
                fresh = true;
            }
            light.last_event_at = now;
            light.aggregate_status();
        }

        if fresh {
            self.emit_bell(tool, snippet, cwd, session_id, source, false);
        }
        self.emit_state();
    }

    /// Ingest a non-approval status change (working / idle / resolved) for the
    /// traffic-light view. `Resolved` removes the session; the rest update it.
    pub fn ingest_status(
        &self,
        session_id: &str,
        tool: &str,
        status: AgentStatus,
        cwd: Option<String>,
    ) {
        let now = now_ms();
        let project_id = project_id_for(cwd.as_deref(), session_id);
        let label = project_label_for(cwd.as_deref());
        let now_inst = Instant::now();

        if status == AgentStatus::Resolved {
            let mut st = self.state.write().expect("perm aggregator lock poisoned");
            if let Some(pid) = st.session_to_project.get(session_id).cloned() {
                if let Some(light) = st.lights.get_mut(&pid) {
                    light.sessions.retain(|s| s.session_id != session_id);
                    if light.sessions.is_empty() {
                        st.lights.remove(&pid);
                        st.order.retain(|x| x != &pid);
                    } else {
                        light.aggregate_status();
                    }
                }
                st.session_to_project.remove(session_id);
            }
            drop(st);
            self.emit_state();
            return;
        }

        {
            let mut st = self.state.write().expect("perm aggregator lock poisoned");
            if !st.lights.contains_key(&project_id) {
                st.lights.insert(
                    project_id.clone(),
                    ProjectLight {
                        project_id: project_id.clone(),
                        project_label: label,
                        status: AgentStatus::Idle,
                        sessions: Vec::new(),
                        last_event_at: now,
                    },
                );
                st.order.push(project_id.clone());
            }
            st.session_to_project
                .insert(session_id.to_string(), project_id.clone());
            let light = st.lights.get_mut(&project_id).expect("project exists");
            if let Some(s) = light
                .sessions
                .iter_mut()
                .find(|s| s.session_id == session_id)
            {
                s.status = status;
                s.tool = tool.to_string();
                s.cwd = cwd.clone();
                s.updated_at = now_inst;
            } else {
                light.sessions.push(AgentSession {
                    session_id: session_id.to_string(),
                    tool: tool.to_string(),
                    status,
                    snippet: String::new(),
                    cwd: cwd.clone(),
                    ts: now,
                    escalated: false,
                    acknowledged: false,
                    created_at: now_inst,
                    updated_at: now_inst,
                    last_notified_at: now_inst,
                    fp: String::new(),
                });
            }
            light.last_event_at = now;
            light.aggregate_status();
        }
        self.emit_state();
    }

    /// The user acted on a session (approve / reject / dismiss): stop tracking
    /// it so the bell + traffic light stop reminding, and escalation halts.
    pub fn ack(&self, session_id: &str) {
        let mut st = self.state.write().expect("perm aggregator lock poisoned");
        if let Some(pid) = st.session_to_project.get(session_id).cloned() {
            if let Some(light) = st.lights.get_mut(&pid) {
                light.sessions.retain(|s| s.session_id != session_id);
                if light.sessions.is_empty() {
                    st.lights.remove(&pid);
                    st.order.retain(|x| x != &pid);
                } else {
                    light.aggregate_status();
                }
            }
            st.session_to_project.remove(session_id);
        }
        drop(st);
        self.emit_state();
    }

    /// Background sweep: re-alert stale approvals and clear ancient ones.
    pub fn sweep(&self) {
        let now_inst = Instant::now();
        let mut to_escalate: Vec<(String, String, String)> = Vec::new();
        let mut to_clear: Vec<String> = Vec::new();

        {
            let mut st = self.state.write().expect("perm aggregator lock poisoned");
            for light in st.lights.values_mut() {
                for s in light.sessions.iter_mut() {
                    if s.status != AgentStatus::WaitingApproval || s.acknowledged {
                        continue;
                    }
                    let since_notify = now_inst.saturating_duration_since(s.last_notified_at);
                    let since_create = now_inst.saturating_duration_since(s.created_at);
                    if since_notify >= ESCALATE_AFTER {
                        s.escalated = true;
                        s.last_notified_at = now_inst;
                        s.updated_at = now_inst;
                        to_escalate.push((
                            s.session_id.clone(),
                            s.tool.clone(),
                            s.snippet.clone(),
                        ));
                    } else if since_create >= CLEAR_AFTER {
                        to_clear.push(s.session_id.clone());
                    }
                }
                light.aggregate_status();
            }
            for sid in &to_clear {
                if let Some(pid) = st.session_to_project.get(sid).cloned() {
                    if let Some(light) = st.lights.get_mut(&pid) {
                        light.sessions.retain(|s| s.session_id != *sid);
                        if light.sessions.is_empty() {
                            st.lights.remove(&pid);
                            st.order.retain(|x| x != &pid);
                        } else {
                            light.aggregate_status();
                        }
                    }
                    st.session_to_project.remove(sid);
                }
            }
        }

        for (sid, tool, snippet) in &to_escalate {
            self.renotify(tool, snippet);
            if let Some(pid) = self.project_for(sid) {
                if let Ok(mut st) = self.state.try_write() {
                    if let Some(light) = st.lights.get_mut(&pid) {
                        if let Some(s) = light.sessions.iter_mut().find(|s| s.session_id == *sid) {
                            s.escalated = true;
                        }
                    }
                }
            }
        }
        if !to_escalate.is_empty() || !to_clear.is_empty() {
            self.emit_state();
        }
    }

    fn project_for(&self, session_id: &str) -> Option<String> {
        self.state
            .read()
            .ok()
            .and_then(|st| st.session_to_project.get(session_id).cloned())
    }

    /// Emit a `perm-request` (bell) + OS toast for a fresh alert. When
    /// `escalated` is true we *only* re-show the OS toast (the bell entry
    /// already exists) so we never pile up duplicate bell entries.
    fn emit_bell(
        &self,
        tool: &str,
        snippet: &str,
        cwd: Option<String>,
        session_id: &str,
        source: &str,
        escalated: bool,
    ) {
        let ts = now_ms();
        let payload = PermRequest {
            session_id: session_id.to_string(),
            tool: tool.to_string(),
            snippet: snippet.to_string(),
            ts,
            source: source.to_string(),
            cwd,
        };
        if !escalated {
            let _ = self.app.emit("perm-request", &payload);
        }
        if crate::perm::approval_notifications_enabled() {
            let app = self.app.clone();
            let tool = tool.to_string();
            let snippet = snippet.to_string();
            std::thread::spawn(move || {
                let lines: Vec<&str> = snippet.lines().collect();
                let body = if lines.len() > 3 {
                    format!("{}\n…", lines[..3].join("\n"))
                } else {
                    snippet
                };
                let title = if escalated {
                    format!("⏰ 仍未处理 · {tool}")
                } else {
                    format!("Approval needed · {tool}")
                };
                crate::notify::show(&app, &title, &body);
            });
        }
    }

    /// Re-raise the OS toast for an escalated (still-waiting) approval.
    fn renotify(&self, tool: &str, snippet: &str) {
        if !crate::perm::approval_notifications_enabled() {
            return;
        }
        let app = self.app.clone();
        let tool = tool.to_string();
        let snippet = snippet.to_string();
        std::thread::spawn(move || {
            let lines: Vec<&str> = snippet.lines().collect();
            let body = if lines.len() > 3 {
                format!("{}\n…", lines[..3].join("\n"))
            } else {
                snippet
            };
            crate::notify::show(&app, &format!("⏰ 仍未处理 · {tool}"), &body);
        });
    }

    pub fn get_state(&self) -> PermState {
        let st = self.state.read().expect("perm aggregator lock poisoned");
        let lights = st
            .order
            .iter()
            .filter_map(|id| st.lights.get(id).cloned())
            .collect();
        PermState { lights }
    }

    fn emit_state(&self) {
        let state = self.get_state();
        let _ = self.app.emit("perm-state-changed", &state);
    }

    /// Spawn the escalation sweep thread (runs for the app's lifetime).
    fn start_sweep(&self) {
        let agg = self.clone();
        let _ = std::thread::Builder::new()
            .name("perm-escalation".into())
            .spawn(move || loop {
                std::thread::sleep(SWEEP_INTERVAL);
                agg.sweep();
            });
    }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

static GLOBAL: OnceLock<PermAggregator> = OnceLock::new();

/// Initialise the aggregator exactly once (called from `setup`). Starts the
/// escalation sweep. Subsequent calls are no-ops.
pub fn init(app: AppHandle) {
    GLOBAL.get_or_init(|| {
        let agg = PermAggregator::new(app);
        agg.start_sweep();
        agg
    });
}

/// Access the global aggregator (None only before `init`).
pub fn global() -> Option<&'static PermAggregator> {
    GLOBAL.get()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Stable identity for a prompt: collapse whitespace, fold digits, lower-case,
/// and cap — so a TUI repaint (cursor / spinner / echoed keystrokes) collapses
/// to the same fingerprint while a genuinely different command does not.
fn fingerprint(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .to_ascii_lowercase()
        .chars()
        .take(120)
        .collect()
}

/// Group key for a session. Prefer the agent's `cwd` (project path) so every
/// session in the same project shares one light; fall back to the session id
/// when no project is known (avoids merging unrelated sessions).
fn project_id_for(cwd: Option<&str>, session_id: &str) -> String {
    match cwd {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => format!("session:{session_id}"),
    }
}

fn project_label_for(cwd: Option<&str>) -> String {
    match cwd {
        Some(c) if !c.trim().is_empty() => Path::new(c)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(c)
            .to_string(),
        _ => "未关联项目".to_string(),
    }
}
