//! AI assistant backend.
//!
//! The webview's CSP forbids outbound network (`connect-src 'self' ipc: …`), so all calls to
//! model providers (OpenAI / Claude / Gemini / Ollama / custom) MUST happen here, in Rust.
//! The frontend sends a `ChatRequest` (including the resolved provider config) via `ai_chat`
//! and receives the reply as a stream of `ai-chunk-{id}` events followed by one `ai-done-{id}`.
//!
//! Because the sandbox cannot reach the network, the provider's *full* response is fetched and
//! then re-emitted in small chunks to preserve the streaming UX without depending on SSE parsing.

pub mod provider;

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

#[tauri::command]
pub async fn ai_chat(app: AppHandle, req: ChatRequest) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let req = std::sync::Arc::new(req);
    let id_clone = id.clone();
    tauri::async_runtime::spawn(async move {
        let result = provider::complete(&app, &req, &id_clone).await;
        let done = DonePayload {
            id: id_clone.clone(),
            error: result.err(),
        };
        if let Err(_) = app.emit(&format!("ai-done-{id_clone}"), done) {
            // best-effort; ignore
        }
    });
    Ok(id)
}
