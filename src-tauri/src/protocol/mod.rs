//! Protocol Designer backend module.
//!
//! Exposes the protocol parser engine + loopback channel to the frontend via
//! Tauri commands. Stays fully decoupled from the serial/ble transport: it
//! never opens a port or touches a live session — the UI feeds it raw bytes
//! (base64) and gets parsed frames back. This keeps the feature "pluggable":
//! the basic serial tool is untouched when no protocol is bound.

pub mod checksum;
pub mod loopback;
pub mod parser;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::storage::Store;
use parser::{parse_hex, shared_parser, ProtocolParser};
use types::*;

use crate::AppState;

/// In-memory registry of loopback channels + a handle to the config store.
pub struct ProtocolManager {
    loopbacks: Mutex<HashMap<String, loopback::LoopbackChannel>>,
    store: Arc<Store>,
}

impl ProtocolManager {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            loopbacks: Mutex::new(HashMap::new()),
            store,
        }
    }

    // --- CRUD (delegated to SQLite) ---------------------------------------

    pub fn list(&self) -> AppResult<Vec<ProtocolSummary>> {
        self.store.list_protocol_configs()
    }

    pub fn save(&self, mut cfg: ProtocolConfig) -> AppResult<ProtocolConfig> {
        let now = chrono::Utc::now().timestamp() as u64;
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        if cfg.created_at == 0 {
            cfg.created_at = now;
        }
        cfg.updated_at = now;
        self.store.save_protocol_config(&cfg)?;
        Ok(cfg)
    }

    pub fn load(&self, id: &str) -> AppResult<ProtocolConfig> {
        self.store.load_protocol_config(id)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.store.delete_protocol_config(id)
    }

    pub fn duplicate(&self, id: &str, new_name: &str) -> AppResult<ProtocolConfig> {
        let mut cfg = self.store.load_protocol_config(id)?;
        cfg.id = uuid::Uuid::new_v4().to_string();
        cfg.name = new_name.to_string();
        cfg.created_at = 0;
        let saved = cfg.clone();
        self.save(cfg)?;
        Ok(saved)
    }

    /// Resolve the effective config for a parse/encode call (explicit override
    /// wins, otherwise load from storage by id).
    fn resolve_config(&self, id: &str, override_cfg: Option<ProtocolConfig>) -> AppResult<ProtocolConfig> {
        match override_cfg {
            Some(c) => Ok(c),
            None => self.load(id),
        }
    }

    /// Parse a byte buffer (stream) into all contained frames.
    pub fn parse(
        &self,
        id: &str,
        raw: &[u8],
        override_cfg: Option<ProtocolConfig>,
    ) -> AppResult<Vec<ParsedFrame>> {
        let cfg = self.resolve_config(id, override_cfg)?;
        let parser = shared_parser(cfg);
        let frames = {
            let p = parser.lock();
            p.parse_stream(raw)
        };
        Ok(frames)
    }

    /// Encode structured field values into a wire frame.
    pub fn encode(
        &self,
        id: &str,
        fields: &[FieldValue],
        override_cfg: Option<ProtocolConfig>,
    ) -> AppResult<Vec<u8>> {
        let cfg = self.resolve_config(id, override_cfg)?;
        let parser = shared_parser(cfg);
        let bytes = {
            let p = parser.lock();
            p.encode(fields)?
        };
        Ok(bytes)
    }

    // --- Loopback ---------------------------------------------------------

    pub fn loopback_open(&self, id: &str, config: ProtocolConfig, app: AppHandle) -> AppResult<()> {
        let ch = loopback::LoopbackChannel::new(id.to_string(), config, app);
        self.loopbacks.lock().insert(id.to_string(), ch);
        Ok(())
    }

    pub fn loopback_send(&self, id: &str, raw: &[u8]) -> AppResult<()> {
        let ch = self
            .loopbacks
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Other(format!("loopback `{id}` not open")))?;
        ch.send(raw)
    }

    pub fn loopback_reload(&self, id: &str, config: ProtocolConfig) -> AppResult<()> {
        if let Some(ch) = self.loopbacks.lock().get(id) {
            ch.reload(config);
        }
        Ok(())
    }

    pub fn loopback_close(&self, id: &str) -> AppResult<()> {
        self.loopbacks.lock().remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parser::{shared_parser, ProtocolParser};

    fn demo_config() -> ProtocolConfig {
        ProtocolConfig {
            id: "test".into(),
            name: "传感器帧示例".into(),
            description: None,
            head: Some(vec![0xAA, 0xBB]),
            tail: Some(vec![0x0D, 0x0A]),
            length_field: None,
            endian: Some(Endian::Big),
            timeout_ms: 50,
            checksum: Some(ChecksumConfig {
                algo: ChecksumAlgo::Crc16Modbus,
                start: None,
                end: None,
            }),
            fields: vec![
                FieldDef { name: "addr".into(), display_name: "设备地址".into(), offset: 0, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
                FieldDef { name: "cmd".into(), display_name: "命令字".into(), offset: 1, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
                FieldDef { name: "temperature".into(), display_name: "温度".into(), offset: 2, length: 2, data_type: FieldDataType::Int16, scale: Some(0.1), unit: Some("°C".into()), enum_map: None, condition: None },
                FieldDef { name: "humidity".into(), display_name: "湿度".into(), offset: 4, length: 4, data_type: FieldDataType::Float32, scale: None, unit: Some("%RH".into()), enum_map: None, condition: None },
                FieldDef { name: "serial".into(), display_name: "序列号".into(), offset: 8, length: 4, data_type: FieldDataType::HexString, scale: None, unit: None, enum_map: None, condition: None },
            ],
            auto_answer: vec![],
            created_at: 0,
            updated_at: 0,
            doc: None,
        }
    }

    #[test]
    fn encode_then_parse_roundtrip_produces_frame() {
        let cfg = demo_config();
        let p = shared_parser(cfg);

        let fields = vec![
            FieldValue { name: "addr".into(), value: serde_json::json!(1) },
            FieldValue { name: "cmd".into(), value: serde_json::json!(2) },
            FieldValue { name: "temperature".into(), value: serde_json::json!(250) },
            FieldValue { name: "humidity".into(), value: serde_json::json!(1.0) },
            FieldValue { name: "serial".into(), value: serde_json::json!("DEADBEEF") },
        ];
        let bytes = {
            let p = p.lock();
            p.encode(&fields).expect("encode should succeed")
        };
        assert!(bytes.starts_with(&[0xAA, 0xBB]), "head must be preserved");
        // Tail comes right before the trailing checksum, not at the very end.
        let n = bytes.len();
        assert_eq!(&bytes[n - 4..n - 2], &[0x0D, 0x0A], "tail must be present before checksum");

        let frames = {
            let p = p.lock();
            p.parse_stream(&bytes)
        };
        assert_eq!(frames.len(), 1, "exactly one frame should be parsed");
        let frame = &frames[0];
        assert!(frame.valid, "frame should be valid");
        assert!(frame.checksum_valid, "crc16 modbus should validate");
        let addr = frame.fields.iter().find(|f| f.name == "addr").unwrap();
        assert_eq!(addr.byte_offset, 0);
        assert_eq!(addr.raw_value, "01");
    }

    fn air_purifier_config() -> ProtocolConfig {
        // User's "智能空气净化器控制协议": head AA BB, 7 uint8 fields,
        // CRC16-MODBUS, tail 0D 0A → 13 bytes total.
        let mut enum_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        enum_map.insert("1".into(), "开机".into());
        enum_map.insert("2".into(), "关机".into());
        ProtocolConfig {
            id: "ap".into(),
            name: "智能空气净化器控制协议".into(),
            description: None,
            head: Some(vec![0xAA, 0xBB]),
            tail: Some(vec![0x0D, 0x0A]),
            length_field: None,
            endian: Some(Endian::Big),
            timeout_ms: 50,
            checksum: Some(ChecksumConfig {
                algo: ChecksumAlgo::Crc16Modbus,
                start: None,
                end: None,
            }),
            fields: vec![
                FieldDef { name: "addr".into(), display_name: "设备地址".into(), offset: 0, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
                FieldDef { name: "cmd".into(), display_name: "命令字".into(), offset: 1, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: Some(enum_map), condition: None },
                FieldDef { name: "fan".into(), display_name: "风速".into(), offset: 2, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: Some("%".into()), enum_map: None, condition: None },
                FieldDef { name: "mode".into(), display_name: "模式".into(), offset: 3, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
                FieldDef { name: "filter".into(), display_name: "滤网寿命".into(), offset: 4, length: 1, data_type: FieldDataType::Uint8, scale: Some(0.0), unit: Some("%".into()), enum_map: None, condition: None },
                FieldDef { name: "pm25".into(), display_name: "PM2.5".into(), offset: 5, length: 1, data_type: FieldDataType::Uint8, scale: Some(0.0), unit: Some("μg/m³".into()), enum_map: None, condition: None },
                FieldDef { name: "status".into(), display_name: "状态".into(), offset: 6, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
            ],
            auto_answer: vec![],
            created_at: 0,
            updated_at: 0,
            doc: None,
        }
    }

    /// Mirror the frontend `openLoopback` first-sample flow: encode a sample
    /// frame, then feed it through `parse_stream` (exactly what the loopback
    /// channel does). The frame must be valid and pass CRC16-MODBUS.
    #[test]
    fn openloopback_first_sample_is_valid() {
        let cfg = air_purifier_config();
        let p = shared_parser(cfg);
        let sample = vec![
            FieldValue { name: "addr".into(), value: serde_json::json!(1) },
            FieldValue { name: "cmd".into(), value: serde_json::json!(1) },
            FieldValue { name: "fan".into(), value: serde_json::json!(3) },
            FieldValue { name: "mode".into(), value: serde_json::json!(2) },
            FieldValue { name: "filter".into(), value: serde_json::json!(80) },
            FieldValue { name: "pm25".into(), value: serde_json::json!(42) },
            FieldValue { name: "status".into(), value: serde_json::json!(1) },
        ];
        let bytes = {
            let p = p.lock();
            p.encode(&sample).expect("encode sample")
        };
        assert_eq!(bytes.len(), 13, "13-byte frame expected");
        let frame = {
            let p = p.lock();
            p.parse_stream(&bytes).into_iter().next().expect("one frame")
        };
        assert!(frame.valid, "frame should be valid");
        assert!(frame.checksum_valid, "crc16 modbus should validate");
    }

    /// Reproduce the loopback auto-answer path: encode a sample TX frame,
    /// parse it, then build the reply exactly as `LoopbackChannel::send` does
    /// and re-parse it. Both frames must be valid (no "校验失败").
    /// Reproduce a frame-delimit bug: if the body or checksum bytes happen to
    /// contain the tail sequence (here `0D 0A`), a naive tail search matches a
    /// *false* tail and mis-delimits the frame, shifting the checksum range so
    /// the parse reports "校验失败" even though encode/parse use one config.
    /// Regression for the "校验失败 on every frame" report: an AI-generated
    /// protocol serialises its checksum range as `start: 0, end: 0` (because
    /// `Number(null) === 0`). The parser must treat `Some(0)` as "unbounded"
    /// on both the encode and parse sides, otherwise the checksum range
    /// collapses to zero length and every frame fails.
    #[test]
    fn checksum_end_zero_is_treated_as_unbounded() {
        let cfg = ProtocolConfig {
            id: "z".into(),
            name: "z".into(),
            description: None,
            head: Some(vec![0xAA, 0xBB]),
            tail: Some(vec![0x0D, 0x0A]),
            length_field: None,
            endian: Some(Endian::Big),
            timeout_ms: 50,
            checksum: Some(ChecksumConfig {
                algo: ChecksumAlgo::Crc16Modbus,
                start: Some(0),
                end: Some(0),
            }),
            fields: vec![
                FieldDef { name: "addr".into(), display_name: "addr".into(), offset: 0, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
                FieldDef { name: "cmd".into(), display_name: "cmd".into(), offset: 1, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
            ],
            auto_answer: vec![],
            created_at: 0,
            updated_at: 0,
            doc: None,
        };
        let p = shared_parser(cfg);
        let fields = vec![
            FieldValue { name: "addr".into(), value: serde_json::json!(1) },
            FieldValue { name: "cmd".into(), value: serde_json::json!(2) },
        ];
        let bytes = {
            let p = p.lock();
            p.encode(&fields).expect("encode")
        };
        let frame = {
            let p = p.lock();
            p.parse_stream(&bytes).into_iter().next().expect("one frame")
        };
        assert!(frame.valid, "frame valid with checksum end=0");
        assert!(frame.checksum_valid, "crc valid with checksum end=0");
    }

    #[test]
    fn frame_with_tail_in_body_is_not_misdelimited() {
        // One uint8 field whose value is 0x0D, immediately followed by a field
        // whose value is 0x0A — together they form the tail `0D 0A` mid-frame.
        let cfg = ProtocolConfig {
            id: "x".into(),
            name: "x".into(),
            description: None,
            head: Some(vec![0xAA, 0xBB]),
            tail: Some(vec![0x0D, 0x0A]),
            length_field: None,
            endian: Some(Endian::Big),
            timeout_ms: 50,
            checksum: Some(ChecksumConfig {
                algo: ChecksumAlgo::Crc16Modbus,
                start: None,
                end: None,
            }),
            fields: vec![
                FieldDef { name: "a".into(), display_name: "a".into(), offset: 0, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
                FieldDef { name: "b".into(), display_name: "b".into(), offset: 1, length: 1, data_type: FieldDataType::Uint8, scale: None, unit: None, enum_map: None, condition: None },
            ],
            auto_answer: vec![],
            created_at: 0,
            updated_at: 0,
            doc: None,
        };
        let p = shared_parser(cfg);
        let fields = vec![
            FieldValue { name: "a".into(), value: serde_json::json!(0x0D) },
            FieldValue { name: "b".into(), value: serde_json::json!(0x0A) },
        ];
        let bytes = {
            let p = p.lock();
            p.encode(&fields).expect("encode")
        };
        // The encoded frame is: AA BB 0D 0A .. 0D 0A <crc>. The body contains
        // the tail sequence; a naive parser would split at the first 0D 0A.
        let frames = {
            let p = p.lock();
            p.parse_stream(&bytes)
        };
        assert_eq!(frames.len(), 1, "must be exactly one frame (no false split)");
        let frame = &frames[0];
        assert!(frame.valid, "frame valid despite tail-in-body");
        assert!(frame.checksum_valid, "crc valid despite tail-in-body");
    }

    #[test]
    fn openloopback_autoanswer_reply_is_valid() {
        let cfg = air_purifier_config();
        let p = shared_parser(cfg.clone());

        let sample = vec![
            FieldValue { name: "addr".into(), value: serde_json::json!(1) },
            FieldValue { name: "cmd".into(), value: serde_json::json!(2) },
            FieldValue { name: "fan".into(), value: serde_json::json!(3) },
            FieldValue { name: "mode".into(), value: serde_json::json!(2) },
            FieldValue { name: "filter".into(), value: serde_json::json!(80) },
            FieldValue { name: "pm25".into(), value: serde_json::json!(42) },
            FieldValue { name: "status".into(), value: serde_json::json!(1) },
        ];
        let bytes = {
            let p = p.lock();
            p.encode(&sample).expect("encode sample")
        };
        let frame = {
            let p = p.lock();
            p.parse_stream(&bytes).into_iter().next().expect("one frame")
        };
        assert!(frame.valid && frame.checksum_valid, "tx frame valid");

        // Build the reply the same way the loopback does.
        let mut reply: Vec<FieldValue> = frame
            .fields
            .iter()
            .map(|f| FieldValue { name: f.name.clone(), value: f.value.clone() })
            .collect();
        // Simulate an auto-answer override (e.g. echo cmd=1 as ack).
        if let Some(slot) = reply.iter_mut().find(|x| x.name == "cmd") {
            slot.value = serde_json::json!(1);
        }
        let reply_frame = {
            let p = p.lock();
            let b = p.encode(&reply).expect("reply encode");
            p.parse(&b).expect("reply parse")
        };
        assert!(reply_frame.valid, "reply frame must be valid");
        assert!(reply_frame.checksum_valid, "reply crc must validate");
    }

    #[test]
    fn reply_frame_reparsed_carries_fields_and_direction() {
        let cfg = demo_config();
        let p = shared_parser(cfg);

        // Simulate an auto-answer reply: seed from a parsed frame, override cmd.
        let reply_fields = vec![
            FieldValue { name: "addr".into(), value: serde_json::json!(1) },
            FieldValue { name: "cmd".into(), value: serde_json::json!(1) },
            FieldValue { name: "temperature".into(), value: serde_json::json!(0) },
            FieldValue { name: "humidity".into(), value: serde_json::json!(0.0) },
            FieldValue { name: "serial".into(), value: serde_json::json!("00000000") },
        ];
        let reply_bytes = {
            let p = p.lock();
            p.encode(&reply_fields).expect("reply encode")
        };
        // The loopback re-parses the reply so it carries decoded fields.
        let reply_frame = {
            let p = p.lock();
            p.parse(&reply_bytes).expect("reply parse")
        };
        assert!(!reply_frame.fields.is_empty(), "reply must show decoded fields, not empty");
        assert_eq!(reply_frame.dir, FrameDirection::Rx);
        let cmd = reply_frame.fields.iter().find(|f| f.name == "cmd").unwrap();
        assert_eq!(cmd.raw_value, "01");
    }
}

// ===========================================================================
// Tauri commands
// ===========================================================================

#[tauri::command]
pub async fn protocol_list(state: State<'_, AppState>) -> AppResult<Vec<ProtocolSummary>> {
    state.protocol.list()
}

#[tauri::command]
pub async fn protocol_save(state: State<'_, AppState>, config: ProtocolConfig) -> AppResult<ProtocolConfig> {
    state.protocol.save(config)
}

#[tauri::command]
pub async fn protocol_load(state: State<'_, AppState>, id: String) -> AppResult<ProtocolConfig> {
    state.protocol.load(&id)
}

#[tauri::command]
pub async fn protocol_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.protocol.delete(&id)
}

#[tauri::command]
pub async fn protocol_duplicate(
    state: State<'_, AppState>,
    id: String,
    new_name: String,
) -> AppResult<ProtocolConfig> {
    state.protocol.duplicate(&id, &new_name)
}

#[tauri::command]
pub async fn protocol_parse(
    state: State<'_, AppState>,
    id: String,
    raw: String,
    config: Option<ProtocolConfig>,
) -> AppResult<Vec<ParsedFrame>> {
    let bytes = B64.decode(&raw).map_err(|e| AppError::Other(format!("bad base64: {e}")))?;
    // Resolve config + build the parser *before* the blocking task so we don't
    // capture a borrow of `state` across the 'static spawn boundary.
    let cfg = match config {
        Some(c) => c,
        None => state.protocol.load(&id)?,
    };
    let parser = shared_parser(cfg);
    let frames = tauri::async_runtime::spawn_blocking(move || {
        let p = parser.lock();
        p.parse_stream(&bytes)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(frames)
}

#[tauri::command]
pub async fn protocol_encode(
    state: State<'_, AppState>,
    id: String,
    fields: Vec<FieldValue>,
    config: Option<ProtocolConfig>,
) -> AppResult<String> {
    let cfg = match config {
        Some(c) => c,
        None => state.protocol.load(&id)?,
    };
    let parser = shared_parser(cfg);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let p = parser.lock();
        p.encode(&fields)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(B64.encode(bytes))
}

#[tauri::command]
pub async fn protocol_validate(
    state: State<'_, AppState>,
    id: String,
    raw: String,
    config: Option<ProtocolConfig>,
) -> AppResult<bool> {
    // Accept either base64 (wire) or a loose hex string (handy for quick tests).
    let bytes = match B64.decode(&raw) {
        Ok(b) => b,
        Err(_) => parse_hex(&raw)?,
    };
    let cfg = match config {
        Some(c) => c,
        None => state.protocol.load(&id)?,
    };
    let parser = shared_parser(cfg);
    let p = parser.lock();
    // Guard: a validate call is meaningless without an active config.
    if p.get_config().is_none() {
        return Err(AppError::Other("no protocol config loaded".into()));
    }
    Ok(p.validate(&bytes))
}

#[tauri::command]
pub async fn protocol_loopback_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    config: ProtocolConfig,
) -> AppResult<()> {
    state.protocol.loopback_open(&id, config, app)
}

#[tauri::command]
pub async fn protocol_loopback_send(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> AppResult<()> {
    let bytes = B64.decode(&data).map_err(|e| AppError::Other(format!("bad base64: {e}")))?;
    state.protocol.loopback_send(&id, &bytes)
}

#[tauri::command]
pub async fn protocol_loopback_reload(
    state: State<'_, AppState>,
    id: String,
    config: ProtocolConfig,
) -> AppResult<()> {
    state.protocol.loopback_reload(&id, config)
}

#[tauri::command]
pub async fn protocol_loopback_close(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.protocol.loopback_close(&id)
}
