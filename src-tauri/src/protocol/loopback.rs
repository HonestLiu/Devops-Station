//! Internal loopback virtual channel for the Protocol Designer.
//!
//! Lets the designer exercise the full encode → parse pipeline without a
//! physical device. `LoopbackChannel` mirrors a serial session's read side:
//! bytes written via `send` are fed through the parser on a blocking task
//! (so CRC / field extraction never stalls the async runtime) and the resulting
//! frames are emitted as `protocol-frame-{id}` events for the UI.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{AppHandle, Emitter};

use crate::error::AppResult;
use crate::protocol::parser::{shared_parser, ProtocolParser, SharedParser};
use crate::protocol::types::{
    AutoAnswerRule, FieldValue, FrameDirection, ParsedFrame, ProtocolConfig, ProtocolFrameEvent,
};

#[derive(Clone)]
pub struct LoopbackChannel {
    parser: SharedParser,
    app: AppHandle,
    id: String,
}

impl LoopbackChannel {
    pub fn new(id: String, config: ProtocolConfig, app: AppHandle) -> Self {
        Self {
            parser: shared_parser(config),
            app,
            id,
        }
    }

    /// Feed bytes into the virtual RX buffer, parse them and emit frames.
    /// Runs the CPU-bound parse on a blocking task to keep the runtime free.
    /// After parsing, auto-answer rules are evaluated against each frame and
    /// any matching rule produces a reply frame (emitted with `is_reply`).
    pub fn send(&self, bytes: &[u8]) -> AppResult<()> {
        let parser = self.parser.clone();
        let app = self.app.clone();
        let id = self.id.clone();
        let chunk = bytes.to_vec();
        let raw_b64 = B64.encode(bytes);

        tauri::async_runtime::spawn_blocking(move || {
            let (frames, rules): (Vec<ParsedFrame>, Vec<AutoAnswerRule>) = {
                let p = parser.lock();
                let frames = p.parse_stream(&chunk);
                let rules = p
                    .get_config()
                    .map(|c| c.auto_answer.clone())
                    .unwrap_or_default();
                (frames, rules)
            };
            for frame in frames {
                let evt = ProtocolFrameEvent {
                    channel_id: id.clone(),
                    frame: ParsedFrame {
                        dir: FrameDirection::Tx,
                        ..frame.clone()
                    },
                    raw: raw_b64.clone(),
                    is_reply: false,
                    dir: FrameDirection::Tx,
                };
                let evt_name = format!("protocol-frame-{id}");
                let _ = app.emit(&evt_name, evt);

                // Auto-answer: build a reply for any matching enabled rule.
                for rule in &rules {
                    if !rule.enabled {
                        continue;
                    }
                    let trigger = frame
                        .fields
                        .iter()
                        .find(|f| f.name == rule.when_field)
                        .and_then(|f| f.value.as_i64());
                    if trigger != Some(rule.when_value) {
                        continue;
                    }
                    // Seed reply values from the parsed frame, then apply overrides.
                    let mut reply_fields: Vec<FieldValue> = frame
                        .fields
                        .iter()
                        .map(|f| FieldValue {
                            name: f.name.clone(),
                            value: f.value.clone(),
                        })
                        .collect();
                    for ov in &rule.reply {
                        if let Some(slot) = reply_fields.iter_mut().find(|x| x.name == ov.name) {
                            slot.value = ov.value.clone();
                        } else {
                            reply_fields.push(ov.clone());
                        }
                    }
                    let (reply_bytes, reply_frame) = {
                        let p = parser.lock();
                        match p.encode(&reply_fields) {
                            Ok(b) => {
                                // Parse the reply back so it carries its decoded
                                // fields + checksum status, just like a received frame.
                                let parsed = p.parse(&b).unwrap_or_else(|_| ParsedFrame {
                                    raw: B64.encode(&b),
                                    valid: false,
                                    checksum_valid: false,
                                    fields: vec![],
                                    error_msg: None,
                                    dir: FrameDirection::Reply,
                                });
                                (b, parsed)
                            }
                            Err(_) => continue,
                        }
                    };
                    let reply_evt = ProtocolFrameEvent {
                        channel_id: id.clone(),
                        frame: ParsedFrame {
                            dir: FrameDirection::Reply,
                            ..reply_frame
                        },
                        raw: B64.encode(&reply_bytes),
                        is_reply: true,
                        dir: FrameDirection::Reply,
                    };
                    let reply_name = format!("protocol-frame-{id}");
                    let _ = app.emit(&reply_name, reply_evt);
                }
            }
        });
        Ok(())
    }

    /// Swap the active protocol (e.g. when the user edits the config).
    pub fn reload(&self, config: ProtocolConfig) {
        let mut p = self.parser.lock();
        let _ = p.load_config(config);
    }
}
