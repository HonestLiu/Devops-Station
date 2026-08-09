//! Provider abstraction for the AI assistant.
//!
//! A single `ProviderConfig` drives every backend. The `kind` selects the request shape and
//! endpoint convention:
//!   - `ollama`           → Ollama `/api/chat` (no auth)
//!   - `openai` / `custom` → OpenAI Chat Completions API (`/chat/completions`, Bearer auth)
//! Both use `stream:false`; the reply is re-chunked downstream to mimic streaming.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::ai::{ChatRequest, ChunkPayload};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// `ollama` | `openai` | `custom`.
    pub kind: String,
    /// Base URL, e.g. `https://api.openai.com/v1`, `http://localhost:11434`.
    pub base_url: String,
    /// API key (OpenAI-compatible). Ignored for Ollama.
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_temperature() -> f32 {
    0.3
}

/// Build the (url, json body, optional Authorization header) for a provider.
fn build_request(
    cfg: &ProviderConfig,
    req: &ChatRequest,
) -> Result<(String, String, Option<String>), String> {
    let base = cfg.base_url.trim_end_matches('/');

    let mut messages: Vec<Value> = Vec::new();
    if let Some(ctx) = &req.context {
        if !ctx.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": ctx }));
        }
    }
    for m in &req.messages {
        let role = if m.role == "assistant" {
            "assistant"
        } else if m.role == "system" {
            "system"
        } else {
            "user"
        };
        messages.push(json!({ "role": role, "content": m.content }));
    }

    match cfg.kind.as_str() {
        "ollama" => {
            let url = format!("{base}/api/chat");
            let body = json!({
                "model": cfg.model,
                "messages": messages,
                "stream": false,
                "options": { "temperature": cfg.temperature },
            })
            .to_string();
            Ok((url, body, None))
        }
        "openai" | "custom" => {
            let url = format!("{base}/chat/completions");
            let auth = if cfg.api_key.is_empty() {
                None
            } else {
                Some(format!("Bearer {}", cfg.api_key))
            };
            let body = json!({
                "model": cfg.model,
                "messages": messages,
                "temperature": cfg.temperature,
                "stream": false,
            })
            .to_string();
            Ok((url, body, auth))
        }
        other => Err(format!("Unsupported AI provider kind: {other}")),
    }
}

/// Extract the assistant text from a provider response.
fn parse_content(kind: &str, text: &str) -> Result<String, String> {
    let v: Value =
        serde_json::from_str(text).map_err(|e| format!("Bad JSON from provider: {e}"))?;
    match kind {
        "ollama" => v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "Ollama response missing message.content".to_string()),
        _ => v
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                "OpenAI response missing choices[0].message.content".to_string()
            }),
    }
}

pub async fn complete(app: &AppHandle, req: &ChatRequest, id: &str) -> Result<(), String> {
    let cfg = &req.provider;
    let (url, body, auth) = build_request(cfg, req)?;

    let client = Client::new();
    let mut builder = client
        .post(&url)
        .header("Content-Type", "application/json");
    if let Some(a) = auth {
        builder = builder.header("Authorization", a);
    }

    let resp = builder
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Provider request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Read body: {e}"))?;

    if !status.is_success() {
        return Err(format!("Provider error {status}: {text}"));
    }

    let content = parse_content(&cfg.kind, &text)?;
    stream_chunks(app, id, &content).await;
    Ok(())
}

/// Re-emit the full reply as small chunks so the UI shows a typing effect without SSE parsing.
async fn stream_chunks(app: &AppHandle, id: &str, content: &str) {
    let bytes = content.as_bytes();
    let step = 12usize;
    let mut i = 0;
    while i < bytes.len() {
        let end = (i + step).min(bytes.len());
        let delta = String::from_utf8_lossy(&bytes[i..end]).to_string();
        let payload = ChunkPayload {
            id: id.to_string(),
            delta,
        };
        let _ = app.emit(&format!("ai-chunk-{id}"), payload);
        i = end;
        tokio::time::sleep(Duration::from_millis(6)).await;
    }
}
