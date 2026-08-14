//! AI assistant backend.
//!
//! The webview's CSP forbids outbound network (`connect-src 'self' ipc: …`), so all calls to
//! model providers (OpenAI / Claude / Gemini / Ollama / custom) MUST happen here, in Rust.
//! The frontend sends a `ChatRequest` (including the resolved provider config) via `ai_chat`
//! and receives the reply as a stream of `ai-chunk-{id}` events followed by one `ai-done-{id}`.
//!
//! The provider call runs with `stream:true` and deltas are forwarded as they arrive (see
//! `provider::complete`). Every in-flight request keeps a `tokio::task::AbortHandle` in the
//! `ACTIVE` map so the frontend can stop a long generation with `ai_cancel`.

pub mod provider;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// Resolved provider configuration (built by the frontend from settings).
    pub provider: provider::ProviderConfig,
    pub messages: Vec<ChatMessage>,
    /// Optional environment context (host, cwd, os, …) injected as a system message.
    #[serde(default)]
    pub context: Option<String>,
    /// Caller-provided request id so the frontend can register its event
    /// listeners *before* invoking (`listen-before-invoke`, which eliminates the
    /// lost-`ai-done` race on fast providers). Empty/absent → generated here.
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ChunkPayload {
    pub id: String,
    pub delta: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DonePayload {
    pub id: String,
    pub error: Option<String>,
}

/// In-flight generations keyed by request id, so `ai_cancel` can abort them.
static ACTIVE: OnceLock<Mutex<HashMap<String, tokio::task::AbortHandle>>> = OnceLock::new();

fn active() -> &'static Mutex<HashMap<String, tokio::task::AbortHandle>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn ai_chat(app: AppHandle, req: ChatRequest) -> Result<String, String> {
    let id = req
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let req = Arc::new(req);
    let id_clone = id.clone();
    let app_clone = app.clone();

    let handle = tokio::spawn(async move {
        let result = provider::complete(&app_clone, &req, &id_clone).await;
        // The task is done either way — drop it from the active map (best-effort).
        let _ = active()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id_clone);
        let done = DonePayload {
            id: id_clone.clone(),
            error: result.err(),
        };
        // If the task was aborted (cancelled), the caller of `ai_cancel` emits the
        // done event itself; this emit is then a harmless no-op because the
        // frontend already unsubscribed / the id is gone.
        if let Err(_) = app_clone.emit(&format!("ai-done-{id_clone}"), done) {
            // best-effort; ignore
        }
    });

    active()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), handle.abort_handle());
    Ok(id)
}

/// Abort an in-flight generation. Emits a final `ai-done-{id}` with
/// `error = "cancelled"` so the frontend flips its message out of the streaming
/// state instead of leaving a spinner forever.
#[tauri::command]
pub async fn ai_cancel(app: AppHandle, id: String) -> Result<(), String> {
    let handle = active()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if let Some(h) = handle {
        h.abort();
    }
    let done = DonePayload {
        id: id.clone(),
        error: Some("cancelled".to_string()),
    };
    let _ = app.emit(&format!("ai-done-{id}"), done);
    Ok(())
}

/// Remove stale entries (e.g. after the webview reloads mid-request).
#[tauri::command]
pub async fn ai_clear_inflight() -> Result<(), String> {
    active()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    Ok(())
}
