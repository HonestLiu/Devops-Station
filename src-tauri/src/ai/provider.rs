//! Provider abstraction for the AI assistant.
//!
//! A single `ProviderConfig` drives every backend. The `kind` selects the request shape and
//! endpoint convention:
//!   - `ollama`           → Ollama `/api/chat` (no auth, SSE stream)
//!   - `openai` / `custom` → OpenAI Chat Completions API (`/chat/completions`, Bearer auth,
//!     SSE stream)
//!
//! Both use `stream:true` and are forwarded **as they arrive** (true streaming): every
//! server-sent `data:` delta is re-emitted to the frontend as an `ai-chunk-{id}` event, so the
//! UI shows the first tokens without waiting for the full reply. The previous
//! `stream:false` + re-chunking approach made the first-word latency equal to the whole
//! generation time, which felt broken for long answers and multi-step agent runs.

use std::time::Duration;

use futures::StreamExt;
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
                "stream": true,
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
                "stream": true,
                "stream_options": { "include_usage": false },
            })
            .to_string();
            Ok((url, body, auth))
        }
        other => Err(format!("Unsupported AI provider kind: {other}")),
    }
}

/// Extract one assistant-text delta from a single SSE `data:` payload line.
///
/// OpenAI emits `data: {"choices":[{"delta":{"content":"..."}}]}` and a final
/// `data: [DONE]`. Ollama emits `data: {"message":{"content":"..."}}` chunks and
/// finishes with `data: {"done":true}`. Anything that does not carry content is
/// skipped so the stream keeps flowing.
fn parse_sse_data(kind: &str, line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || !line.starts_with("data:") {
        return None;
    }
    let payload = line[5..].trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    let v: Value = serde_json::from_str(payload).ok()?;
    match kind {
        "ollama" => v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string()),
        _ => v
            .get("choices")
            .and_then(|c| c.as_array()?.first())
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string()),
    }
}

/// True when an SSE line signals the end of the stream.
fn is_stream_end(kind: &str, line: &str) -> bool {
    let payload = line.trim();
    if payload == "data: [DONE]" {
        return true;
    }
    if kind != "ollama" {
        return false;
    }
    // Ollama: `data: {"done":true,...}` closes the stream.
    let Some(data) = payload.strip_prefix("data:") else {
        return false;
    };
    serde_json::from_str::<Value>(data.trim())
        .ok()
        .and_then(|v| v.get("done").and_then(|d| d.as_bool()))
        .unwrap_or(false)
}

/// Stream a completion from the provider, forwarding each delta as `ai-chunk-{id}`.
///
/// The request is `stream:true`; the response body is read as a byte stream and
/// split on newlines so every SSE `data:` line is parsed immediately. Errors
/// (transport, non-2xx status, malformed payloads) are returned as `Err`, which
/// the caller converts into a single `ai-done-{id}` with the error text — the
/// frontend shows it instead of hanging.
pub async fn complete(app: &AppHandle, req: &ChatRequest, id: &str) -> Result<(), String> {
    let cfg = &req.provider;
    let (url, body, auth) = build_request(cfg, req)?;

    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;

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
    if !status.is_success() {
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable body>".to_string());
        return Err(format!("Provider error {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut any_chunk = false;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Provider stream read failed: {e}"))?;
        buf.extend_from_slice(&bytes);

        // Extract complete newline-terminated lines out of the buffer.
        let mut start = 0usize;
        while let Some(pos) = buf[start..].iter().position(|&b| b == b'\n') {
            let abs = start + pos;
            let line = String::from_utf8_lossy(&buf[start..abs]).to_string();
            if is_stream_end(&cfg.kind, &line) {
                return Ok(());
            }
            if let Some(delta) = parse_sse_data(&cfg.kind, &line) {
                any_chunk = true;
                let payload = ChunkPayload {
                    id: id.to_string(),
                    delta,
                };
                if app.emit(&format!("ai-chunk-{id}"), payload).is_err() {
                    return Ok(()); // frontend gone — stop streaming quietly
                }
            }
            start = abs + 1;
        }
        if start > 0 {
            buf.drain(..start);
        }
    }

    // Provider closed the stream without an explicit end marker.
    if let Ok(rest) = std::str::from_utf8(&buf) {
        if !is_stream_end(&cfg.kind, rest) {
            if let Some(delta) = parse_sse_data(&cfg.kind, rest) {
                any_chunk = true;
                let payload = ChunkPayload {
                    id: id.to_string(),
                    delta,
                };
                let _ = app.emit(&format!("ai-chunk-{id}"), payload);
            }
        }
    }

    if !any_chunk {
        return Err("Provider returned an empty stream".to_string());
    }
    Ok(())
}
