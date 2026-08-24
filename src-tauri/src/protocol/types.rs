//! Protocol Designer — shared data structures.
//!
//! These mirror the TypeScript `ProtocolConfig` / `FieldDef` / `ParsedFrame`
//! shapes used by the frontend. All structs are `serde` (camelCase) so they
//! round-trip straight through the Tauri IPC boundary.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Byte-endianness for multi-byte integer / float fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Endian {
    Little,
    Big,
}

/// Checksum / frame-integrity algorithm applied to a byte range of the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChecksumAlgo {
    None,
    /// 8-bit累加和 (mod 256).
    Sum,
    /// 逐字节 XOR.
    Xor,
    /// CRC-8 (poly 0x07, init 0x00).
    Crc8,
    /// CRC-16/MODBUS (poly 0x8005, init 0xFFFF, refin/refout).
    Crc16Modbus,
    /// CRC-32 (poly 0x04C11DB7, init 0xFFFFFFFF, refin/refout).
    Crc32,
}

/// Typed interpretation of a field's bytes when decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldDataType {
    Uint8,
    Int16,
    Uint16,
    Int32,
    Uint32,
    Float32,
    Float64,
    HexString,
    AsciiString,
    Bitfield,
}

/// Optional length-field descriptor used for frame delimiting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LengthField {
    /// Byte offset of the length field, relative to frame start (0 = first byte).
    pub offset: usize,
    /// Width of the length field in bytes (1 / 2 / 4).
    pub length: usize,
    /// Whether the length value includes the length field's own bytes.
    pub include_self: bool,
}

/// A single field definition inside a protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    /// Machine name (unique within the protocol), e.g. `temperature`.
    pub name: String,
    /// Human-friendly display name, e.g. `温度值`.
    pub display_name: String,
    /// Byte offset relative to frame start (0-based).
    pub offset: usize,
    /// Field width in bytes.
    pub length: usize,
    pub data_type: FieldDataType,
    /// Multiplier converting the raw integer/float to a physical value.
    #[serde(default)]
    pub scale: Option<f64>,
    /// Physical unit, e.g. `°C`.
    #[serde(default)]
    pub unit: Option<String>,
    /// Raw-value → readable-string map, e.g. `{"1": "启动"}`.
    #[serde(default)]
    pub enum_map: Option<HashMap<String, String>>,
    /// Simple show/parse condition, e.g. `command == 1`. (Full expression
    /// evaluation is a P2 follow-up; only `name == int` is honored for now.)
    #[serde(default)]
    pub condition: Option<String>,
}

/// Checksum configuration: algorithm + byte range (relative to frame start).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumConfig {
    pub algo: ChecksumAlgo,
    /// First byte index of the checksummed range (inclusive). Defaults to 0.
    #[serde(default)]
    pub start: Option<usize>,
    /// Last byte index of the checksummed range (exclusive). Defaults to frame end.
    #[serde(default)]
    pub end: Option<usize>,
}

/// A complete protocol definition (the unit of CRUD + storage).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolConfig {
    /// Stable id; empty on first save → backend assigns a UUID.
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Markdown documentation for the protocol (user manual / notes). Optional.
    #[serde(default)]
    pub doc: Option<String>,
    /// Fixed frame head (hex). Optional.
    #[serde(default)]
    pub head: Option<Vec<u8>>,
    /// Fixed frame tail (hex). Optional.
    #[serde(default)]
    pub tail: Option<Vec<u8>>,
    #[serde(default)]
    pub length_field: Option<LengthField>,
    #[serde(default)]
    pub fields: Vec<FieldDef>,
    #[serde(default)]
    pub checksum: Option<ChecksumConfig>,
    #[serde(default)]
    pub endian: Option<Endian>,
    /// Inter-frame idle timeout (ms) — used by the UI for frame splitting.
    #[serde(default)]
    pub timeout_ms: u64,
    /// Auto-answer rules: when an incoming frame's `whenField == whenValue`,
    /// the channel encodes `reply` (field overrides) and emits it as a reply
    /// frame. Used by the loopback channel for offline "device simulation".
    #[serde(default)]
    pub auto_answer: Vec<AutoAnswerRule>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// One auto-answer rule (P2). Triggered by a parsed frame field matching a
/// value; produces a reply frame by encoding the protocol with `reply` field
/// overrides merged on top of the triggering frame's values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoAnswerRule {
    /// Whether the rule is active.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Human-readable note shown in the UI.
    #[serde(default)]
    pub note: Option<String>,
    /// Field name to test against the parsed frame.
    pub when_field: String,
    /// Value the field must equal to trigger the reply.
    pub when_value: i64,
    /// Field overrides used to build the reply frame (field name → value).
    #[serde(default)]
    pub reply: Vec<FieldValue>,
}

fn default_true() -> bool {
    true
}

/// Lightweight row for the protocol list (avoids shipping full configs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub updated_at: u64,
}

/// One field's decoded result inside a parsed frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedField {
    pub name: String,
    pub display_name: String,
    /// Raw bytes as a hex string (e.g. `A1 02`).
    pub raw_value: String,
    /// Decoded value (number / string / object).
    pub value: serde_json::Value,
    /// Display string after scale + enum mapping, e.g. `25.6 °C`.
    pub display_value: String,
    #[serde(default)]
    pub unit: Option<String>,
    /// Byte offset within the frame (for Hex-view highlighting).
    pub byte_offset: usize,
    /// Byte length within the frame.
    pub byte_length: usize,
}

/// Direction of a parsed frame, so the UI can distinguish what the user sent
/// from what the device (or the simulated loopback auto-answer) sent back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FrameDirection {
    /// Frame produced by the user (structured send / loopback input).
    #[default]
    Tx,
    /// Frame received from the device (or parsed from a live feed).
    Rx,
    /// Frame synthesised by an auto-answer rule (a simulated device reply).
    Reply,
}

/// A single parsed frame (may be partial / invalid if parsing failed).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFrame {
    /// Full frame bytes as a base64 string (compact over the wire; the UI
    /// decodes to render the Hex view + highlight).
    pub raw: String,
    pub valid: bool,
    pub checksum_valid: bool,
    pub fields: Vec<ParsedField>,
    #[serde(default)]
    pub error_msg: Option<String>,
    /// Who produced this frame: `tx` (user), `rx` (device), `reply` (auto-answer).
    #[serde(default)]
    pub dir: FrameDirection,
}

/// A field value supplied to the encoder for structured sending.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldValue {
    pub name: String,
    pub value: serde_json::Value,
}

/// Payload emitted on `protocol-frame-{id}` (loopback) events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolFrameEvent {
    pub channel_id: String,
    pub frame: ParsedFrame,
    /// Echo of the raw bytes that were fed in (base64), for the Hex view.
    pub raw: String,
    /// True when this frame was produced by an auto-answer rule (a simulated
    /// device reply) rather than parsed from input bytes.
    #[serde(default)]
    pub is_reply: bool,
    /// Direction of the frame (mirrors `ParsedFrame.dir`).
    #[serde(default)]
    pub dir: FrameDirection,
}
