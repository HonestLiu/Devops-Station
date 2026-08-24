//! Protocol frame parser + encoder.
//!
//! `DefaultParser` is the reference `ProtocolParser` implementation: it performs
//! frame synchronization (head / tail / length-field delimiting), checksum
//! verification and typed field extraction. It is `Send + Sync` and holds no
//! per-call mutable state, so it can run on a dedicated thread or inside a
//! `spawn_blocking` future without touching the serial receive path.

use std::collections::HashMap;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use serde_json::Value as Json;

use crate::error::{AppError, AppResult};
use crate::protocol::checksum;
use crate::protocol::types::*;

/// Trait every protocol parser implements. Decouples the UI / loopback driver
/// from the concrete engine so new algorithms can be added behind the same API.
pub trait ProtocolParser: Send + Sync {
    /// Load (or replace) the active configuration.
    fn load_config(&mut self, config: ProtocolConfig) -> AppResult<()>;
    /// Parse a single, complete frame.
    fn parse(&self, raw: &[u8]) -> AppResult<ParsedFrame>;
    /// Extract every complete frame from a byte stream (the main entry for the
    /// live / loopback data path). Incomplete trailing bytes are ignored.
    fn parse_stream(&self, buf: &[u8]) -> Vec<ParsedFrame>;
    /// Encode structured field values into a wire frame.
    fn encode(&self, fields: &[FieldValue]) -> AppResult<Vec<u8>>;
    /// Validate that `raw` looks like a well-formed frame for the config.
    fn validate(&self, raw: &[u8]) -> bool;
    /// Current configuration, if any.
    fn get_config(&self) -> Option<&ProtocolConfig>;
}

/// Default engine. Holds the active config immutably once loaded.
pub struct DefaultParser {
    config: Option<ProtocolConfig>,
}

impl Default for DefaultParser {
    fn default() -> Self {
        Self { config: None }
    }
}

impl DefaultParser {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ProtocolParser for DefaultParser {
    fn load_config(&mut self, config: ProtocolConfig) -> AppResult<()> {
        self.config = Some(config);
        Ok(())
    }

    fn get_config(&self) -> Option<&ProtocolConfig> {
        self.config.as_ref()
    }

    fn parse(&self, raw: &[u8]) -> AppResult<ParsedFrame> {
        let cfg = self
            .config
            .as_ref()
            .ok_or_else(|| AppError::Other("no protocol config loaded".into()))?;

        let mut fields_out: Vec<ParsedField> = Vec::new();
        let mut valid = true;
        let mut checksum_valid = true;

        // --- checksum verification ---------------------------------------
        if let Some(cs) = &cfg.checksum {
            if cs.algo != ChecksumAlgo::None {
                // `Some(0)` for an offset is meaningless (a zero-length range),
                // so treat it identically to `None` ("unbounded"). This defends
                // against frontends that serialize an absent limit as `0` and
                // would otherwise mark every frame as a checksum failure.
                let start = cs.start.filter(|s| *s > 0).unwrap_or(0).min(raw.len());
                let end = match cs.end {
                    Some(0) | None => raw.len(),
                    Some(e) => e,
                }
                .min(raw.len());
                let cs_len = checksum_len(cs.algo);
                if end > start && (end - start) >= cs_len {
                    let body = &raw[start..end - cs_len];
                    let stored = &raw[end - cs_len..end];
                    let computed = checksum::compute(cs.algo, body).unwrap_or(0);
                    // Checksum bytes are always appended big-endian on the wire.
                    let stored_val = read_uint(stored, Endian::Big, false) as u64;
                    checksum_valid = computed == stored_val;
                    if !checksum_valid {
                        valid = false;
                    }
                } else {
                    checksum_valid = false;
                    valid = false;
                }
            }
        }

        // --- field extraction --------------------------------------------
        // `raw` here is the full frame *including* the head. Fields are
        // addressed relative to the body that starts after the head.
        let head_len = cfg.head.as_deref().map_or(0, |h| h.len());

        // Pre-extract raw values so conditions (`name == value`) can be checked.
        let mut raw_values: HashMap<String, i64> = HashMap::new();
        for f in &cfg.fields {
            if let Some(v) = decode_field_int(raw, f, cfg.endian.unwrap_or(Endian::Big), head_len) {
                raw_values.insert(f.name.clone(), v);
            }
        }

        let mut oob_names: Vec<String> = Vec::new();
        for f in &cfg.fields {
            // Simple condition: `name == int`. Skip the field if unmet.
            if let Some(cond) = &f.condition {
                if !condition_met(cond, &raw_values) {
                    continue;
                }
            }

            let start = head_len + f.offset;
            let end = start + f.length;
            if end > raw.len() {
                fields_out.push(ParsedField {
                    name: f.name.clone(),
                    display_name: f.display_name.clone(),
                    raw_value: "—".into(),
                    value: Json::Null,
                    display_value: "越界".into(),
                    unit: f.unit.clone(),
                    byte_offset: f.offset,
                    byte_length: f.length,
                });
                oob_names.push(f.display_name.clone());
                valid = false;
                continue;
            }

            let bytes = &raw[start..end];
            let raw_hex = bytes_to_hex(bytes);

            let decode = decode_field_value(bytes, f, cfg.endian.unwrap_or(Endian::Big));
            let display = build_display(&decode, f);

            fields_out.push(ParsedField {
                name: f.name.clone(),
                display_name: f.display_name.clone(),
                raw_value: raw_hex,
                value: decode.value,
                display_value: display,
                unit: f.unit.clone(),
                byte_offset: f.offset,
                byte_length: f.length,
            });
        }

        // Compose a specific error so the UI can tell checksum failures apart
        // from layout problems (was previously one opaque "字段越界或校验失败").
        let error_msg = if valid {
            None
        } else if !oob_names.is_empty() && !checksum_valid {
            Some(format!(
                "字段越界（{}）且校验失败",
                oob_names.join("、")
            ))
        } else if !oob_names.is_empty() {
            Some(format!("字段越界：{}", oob_names.join("、")))
        } else {
            Some("校验失败".to_string())
        };

        Ok(ParsedFrame {
            raw: B64.encode(raw),
            valid,
            checksum_valid,
            fields: fields_out,
            error_msg,
            dir: FrameDirection::Rx,
        })
    }

    fn parse_stream(&self, buf: &[u8]) -> Vec<ParsedFrame> {
        let cfg = match &self.config {
            Some(c) => c,
            None => return Vec::new(),
        };
        let head = cfg.head.as_deref().unwrap_or(&[]);
        let tail = cfg.tail.as_deref();
        let mut out = Vec::new();

        let mut pos = 0usize;
        while pos < buf.len() {
            // Find frame start.
            let start = if head.is_empty() {
                pos
            } else {
                match find_sub(buf, head, pos) {
                    Some(i) => i,
                    None => break,
                }
            };

            // Determine frame end.
            let end = if let Some(lf) = &cfg.length_field {
                match frame_len_by_length_field(buf, start, lf, head.len(), cfg.endian) {
                    Some(len) if start + len <= buf.len() => start + len,
                    _ => break, // incomplete frame; wait for more data
                }
            } else if let Some(t) = tail {
                // Prefer delimiting by the config's known *total* frame length.
                // This is robust against the body or checksum bytes accidentally
                // containing the tail sequence (e.g. a field value of `0D` right
                // before `0A`), which a naive "first tail occurrence" search would
                // mis-split into a short frame and report a spurious "校验失败".
                let cs_len = cfg
                    .checksum
                    .as_ref()
                    .filter(|c| c.algo != ChecksumAlgo::None)
                    .map(|c| checksum_len(c.algo))
                    .unwrap_or(0);
                let body_len = cfg
                    .fields
                    .iter()
                    .map(|f| f.offset + f.length)
                    .max()
                    .unwrap_or(0);
                let total = head.len() + body_len + t.len() + cs_len;
                let fixed_end = start + total;
                let tail_at = head.len() + body_len; // tail offset within the frame
                if fixed_end <= buf.len() && buf[start + tail_at..start + tail_at + t.len()] == *t {
                    // Total-length delimiter lands exactly on the real tail — use it.
                    fixed_end
                } else {
                    // Config has no well-formed fixed length (e.g. gapped fields
                    // or an unsynchronised buffer): fall back to the first tail
                    // occurrence, which is correct when the tail truly only
                    // appears at frame boundaries.
                    match find_sub(buf, t, start + head.len()) {
                        Some(i) => i + t.len() + cs_len,
                        None => break, // incomplete
                    }
                }
            } else {
                // No length, no tail: consume to end of buffer.
                buf.len()
            };

            let frame = &buf[start..end];
            if let Ok(pf) = self.parse(frame) {
                out.push(pf);
            }
            pos = end;
        }
        out
    }

    fn encode(&self, fields: &[FieldValue]) -> AppResult<Vec<u8>> {
        let cfg = self
            .config
            .as_ref()
            .ok_or_else(|| AppError::Other("no protocol config loaded".into()))?;
        let endian = cfg.endian.unwrap_or(Endian::Big);
        let head = cfg.head.as_deref().unwrap_or(&[]);
        let tail = cfg.tail.as_deref().unwrap_or(&[]);

        // Capacity: head + max field end (+ tail + checksum). Field offsets are
        // measured from *after* the head, so the body starts at `head.len()`.
        let mut body_end = 0usize;
        for f in &cfg.fields {
            body_end = body_end.max(f.offset + f.length);
        }
        let mut buf: Vec<u8> = vec![0u8; head.len() + body_end.max(1)];
        buf[..head.len()].copy_from_slice(head);

        let mut by_name: HashMap<&str, &Json> = HashMap::new();
        for fv in fields {
            by_name.insert(fv.name.as_str(), &fv.value);
        }

        for f in &cfg.fields {
            let start = head.len() + f.offset;
            let end = start + f.length;
            if end > buf.len() {
                buf.resize(end, 0);
            }
            let json = by_name.get(f.name.as_str()).copied();
            encode_field_value(&mut buf[start..end], f, endian, json);
        }

        // Append tail.
        buf.extend_from_slice(tail);

        // Length field (if configured) — written after tail so the value
        // already accounts for tail + checksum.
        if let Some(lf) = &cfg.length_field {
            let total = buf.len() + checksum_len(cfg.checksum.as_ref().map(|c| c.algo).unwrap_or(ChecksumAlgo::None));
            let mut len_val = if lf.include_self {
                (total - lf.offset) as u64
            } else {
                (total - (lf.offset + lf.length)) as u64
            };
            len_val = len_val.min(u64::MAX);
            let n = lf.length.min(8) as usize;
            let bytes = if endian == Endian::Little {
                len_val.to_le_bytes()
            } else {
                len_val.to_be_bytes()
            };
            let (s, e) = if endian == Endian::Little {
                (0, n)
            } else {
                (8usize.saturating_sub(n), 8)
            };
            let slice = &bytes[s..e];
            let lf_end = (lf.offset + lf.length).min(buf.len());
            buf[lf.offset..lf_end].copy_from_slice(slice);
        }

        // Checksum (appended at end of the checksummed range).
        if let Some(cs) = &cfg.checksum {
            if cs.algo != ChecksumAlgo::None {
                // Mirror `parse`: `Some(0)` / `None` mean "unbounded" so a
                // frontend serialising an absent limit as `0` still checksum
                // the whole frame instead of an empty range.
                let start = cs.start.filter(|s| *s > 0).unwrap_or(0).min(buf.len());
                let end = match cs.end {
                    Some(0) | None => buf.len(),
                    Some(e) => e,
                }
                .min(buf.len());
                let cs_len = checksum_len(cs.algo);
                let computed = checksum::compute(cs.algo, &buf[start..end]).unwrap_or(0);
                for i in 0..cs_len {
                    buf.push((computed >> ((cs_len - 1 - i) * 8)) as u8);
                }
            }
        }

        Ok(buf)
    }

    fn validate(&self, raw: &[u8]) -> bool {
        match self.parse(raw) {
            Ok(f) => f.valid,
            Err(_) => false,
        }
    }
}

// ===========================================================================
// Frame-sync helpers
// ===========================================================================

fn find_sub(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| from + i)
}

/// Resolve frame length from a length field. Returns total frame byte count.
fn frame_len_by_length_field(
    buf: &[u8],
    start: usize,
    lf: &LengthField,
    head_len: usize,
    endian: Option<Endian>,
) -> Option<usize> {
    let lf_abs = start + lf.offset;
    let lf_end = lf_abs + lf.length;
    if lf_end > buf.len() {
        return None;
    }
    let n = read_uint(&buf[lf_abs..lf_end], endian.unwrap_or(Endian::Big), false) as usize;
    // (read_uint above already takes Option<Endian>; resolve the default here)
    let tail_room = 0usize; // tail is matched separately; length field is authoritative
    let total = if lf.include_self {
        head_len + lf.offset + n
    } else {
        head_len + lf.offset + lf.length + n
    };
    Some(total + tail_room)
}

fn checksum_len(algo: ChecksumAlgo) -> usize {
    match algo {
        ChecksumAlgo::None => 0,
        ChecksumAlgo::Sum | ChecksumAlgo::Xor | ChecksumAlgo::Crc8 => 1,
        ChecksumAlgo::Crc16Modbus => 2,
        ChecksumAlgo::Crc32 => 4,
    }
}

// ===========================================================================
// Field decode / encode
// ===========================================================================

fn decode_field_int(raw: &[u8], f: &FieldDef, endian: Endian, head_len: usize) -> Option<i64> {
    let start = head_len + f.offset;
    let end = start + f.length;
    if end > raw.len() {
        return None;
    }
    let bytes = &raw[start..end];
    match f.data_type {
        FieldDataType::Uint8 => Some(bytes.first().copied().unwrap_or(0) as i64),
        FieldDataType::Int16
        | FieldDataType::Uint16
        | FieldDataType::Int32
        | FieldDataType::Uint32
        | FieldDataType::Bitfield => Some(read_uint(bytes, endian, signed_of(f.data_type))),
        _ => None,
    }
}

struct Decoded {
    value: Json,
    /// Raw numeric value (before scale) if numeric.
    raw_num: Option<f64>,
}

fn decode_field_value(bytes: &[u8], f: &FieldDef, endian: Endian) -> Decoded {
    let signed = signed_of(f.data_type);
    match f.data_type {
        FieldDataType::Uint8 => {
            let v = bytes.first().copied().unwrap_or(0) as u64;
            Decoded { value: Json::Number(v.into()), raw_num: Some(v as f64) }
        }
        FieldDataType::Int16 | FieldDataType::Uint16 | FieldDataType::Int32 | FieldDataType::Uint32 | FieldDataType::Bitfield => {
            let v = read_uint(bytes, endian, signed);
            Decoded { value: Json::Number(v.into()), raw_num: Some(v as f64) }
        }
        FieldDataType::Float32 => {
            let v = read_f32(bytes, endian);
            Decoded { value: json_f64(v as f64), raw_num: Some(v as f64) }
        }
        FieldDataType::Float64 => {
            let v = read_f64(bytes, endian);
            Decoded { value: json_f64(v), raw_num: Some(v) }
        }
        FieldDataType::HexString => {
            let s = bytes_to_hex(bytes);
            Decoded { value: Json::String(s.clone()), raw_num: None }
        }
        FieldDataType::AsciiString => {
            let s = String::from_utf8_lossy(bytes).to_string();
            Decoded { value: Json::String(s.clone()), raw_num: None }
        }
    }
}

fn signed_of(dt: FieldDataType) -> bool {
    matches!(dt, FieldDataType::Int16 | FieldDataType::Int32)
}

/// Build the human display string: enum mapping takes priority, then
/// scale + unit, else the raw value. The unit is intentionally NOT baked
/// into the string — the frontend renders it as a separate tag so the
/// row stays aligned ("0  μg/m³" not "0 μg/m³ μg/m³").
fn build_display(decoded: &Decoded, f: &FieldDef) -> String {
    if let Some(num) = decoded.raw_num {
        if let Some(map) = &f.enum_map {
            let key_int = format!("{}", num as i64);
            let key_hex = format!("{:#x}", num as i64);
            if let Some(s) = map.get(&key_int).or_else(|| map.get(&key_hex)) {
                return s.clone();
            }
        }
        // A non-finite/zero `scale` would zero out the physical value
        // (e.g. PM2.5 rendered as "0" because scale was 0). Treat
        // "absent or zero" as "no scale" and fall through to the raw
        // integer instead.
        if let Some(scale) = f.scale.filter(|s| *s != 0.0) {
            let phys = num * scale;
            return format!("{}", trim_float(phys));
        }
        return format!("{}", num);
    }
    match &decoded.value {
        Json::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn encode_field_value(slot: &mut [u8], f: &FieldDef, endian: Endian, json: Option<&Json>) {
    let n = slot.len();
    if n == 0 {
        return;
    }
    let signed = signed_of(f.data_type);
    let as_int = |json: Option<&Json>| -> i64 {
        match json {
            Some(Json::Number(x)) => x.as_i64().unwrap_or(0),
            Some(Json::String(s)) => s.parse::<i64>().unwrap_or(0),
            _ => 0,
        }
    };

    match f.data_type {
        FieldDataType::HexString | FieldDataType::AsciiString => {
            let s = match json {
                Some(Json::String(s)) => s.clone(),
                _ => String::new(),
            };
            let src = if f.data_type == FieldDataType::HexString {
                hex_to_bytes(&s).unwrap_or_default()
            } else {
                s.into_bytes()
            };
            let take = src.len().min(n);
            slot[..take].copy_from_slice(&src[..take]);
            // left-pad / zero-fill rest
            for b in slot.iter_mut().skip(take) {
                *b = 0;
            }
        }
        FieldDataType::Float32 => {
            let v = match json {
                Some(Json::Number(x)) => x.as_f64().unwrap_or(0.0) as f32,
                _ => 0.0,
            };
            let bits = v.to_be_bytes();
            slot.copy_from_slice(&bits[..n.min(4)]);
        }
        FieldDataType::Float64 => {
            let v = match json {
                Some(Json::Number(x)) => x.as_f64().unwrap_or(0.0),
                _ => 0.0,
            };
            let bits = v.to_be_bytes();
            slot.copy_from_slice(&bits[..n.min(8)]);
        }
        _ => {
            let v = as_int(json) as u64;
            let bytes = if signed {
                (v as i64).to_be_bytes()
            } else {
                v.to_be_bytes()
            };
            let take = n.min(8);
            slot.copy_from_slice(&bytes[8 - take..]);
            if endian == Endian::Little {
                slot[..take].reverse();
            }
        }
    }
}

// ===========================================================================
// Numeric helpers
// ===========================================================================

fn read_uint(bytes: &[u8], endian: Endian, signed: bool) -> i64 {
    if bytes.is_empty() {
        return 0;
    }
    let little = endian == Endian::Little;
    let mut v: u64 = 0;
    if little {
        for &b in bytes.iter().rev() {
            v = (v << 8) | b as u64;
        }
    } else {
        for &b in bytes {
            v = (v << 8) | b as u64;
        }
    }
    // Truncate to the field width.
    let bits = (bytes.len() * 8).min(64);
    let mask = if bits >= 64 { u64::MAX } else { (1u64 << bits) - 1 };
    v &= mask;
    if signed {
        // Sign-extend.
        let sign_bit = 1u64 << (bits - 1);
        if v & sign_bit != 0 {
            (v as i64) - (1i64 << bits)
        } else {
            v as i64
        }
    } else {
        v as i64
    }
}

fn read_f32(bytes: &[u8], endian: Endian) -> f32 {
    let mut b = [0u8; 4];
    let take = bytes.len().min(4);
    if endian == Endian::Little {
        for (i, x) in bytes[..take].iter().rev().enumerate() {
            b[i] = *x;
        }
    } else {
        b[..take].copy_from_slice(&bytes[..take]);
    }
    f32::from_be_bytes(b)
}

fn read_f64(bytes: &[u8], endian: Endian) -> f64 {
    let mut b = [0u8; 8];
    let take = bytes.len().min(8);
    if endian == Endian::Little {
        for (i, x) in bytes[..take].iter().rev().enumerate() {
            b[i] = *x;
        }
    } else {
        b[..take].copy_from_slice(&bytes[..take]);
    }
    f64::from_be_bytes(b)
}

/// Evaluate a field-show condition against already-decoded integer field
/// values. Supports a single comparison or several joined by `&&` / `||`:
///   `cmd == 1`            field `cmd` equals 1
///   `cmd != 0`            not equal
///   `temp > 25`           numeric comparison (>, <, >=, <=)
///   `cmd == 1 && id > 3`  all must hold (AND) / any (OR)
/// Values may be decimal or `0x` hex. An empty/blank condition is always true.
fn condition_met(cond: &str, values: &HashMap<String, i64>) -> bool {
    let cond = cond.trim();
    if cond.is_empty() {
        return true;
    }
    // Split on `||` first (lowest precedence), then `&&` within each chunk.
    let or_parts: Vec<&str> = cond.split("||").collect();
    or_parts.iter().any(|part| {
        let and_parts: Vec<&str> = part.split("&&").collect();
        and_parts.iter().all(|atom| eval_atom(atom.trim(), values))
    })
}

/// Evaluate one atomic comparison `name op value` (op ∈ == != > < >= <=).
fn eval_atom(atom: &str, values: &HashMap<String, i64>) -> bool {
    let parse_target = |rhs: &str| -> i64 {
        let rhs = rhs.trim();
        if let Some(h) = rhs.strip_prefix("0x").or_else(|| rhs.strip_prefix("0X")) {
            i64::from_str_radix(h, 16).unwrap_or(0)
        } else {
            rhs.parse().unwrap_or(0)
        }
    };
    for (op, kind) in [
        ("==", 0),
        ("!=", 1),
        (">=", 2),
        ("<=", 3),
        (">", 4),
        ("<", 5),
    ] {
        if let Some((l, r)) = atom.split_once(op) {
            let name = l.trim();
            let target = parse_target(r);
            let val = match values.get(name).copied() {
                Some(v) => v,
                None => return false,
            };
            return match kind {
                0 => val == target,
                1 => val != target,
                2 => val >= target,
                3 => val <= target,
                4 => val > target,
                _ => val < target,
            };
        }
    }
    // No recognised operator → fall back to truthy "field present and non-zero".
    match values.get(atom).copied() {
        Some(v) => v != 0,
        None => false,
    }
}

fn json_f64(v: f64) -> Json {
    match serde_json::Number::from_f64(v) {
        Some(n) => Json::Number(n),
        None => Json::Null,
    }
}

fn trim_float(v: f64) -> f64 {
    // Round to 6 significant decimals to avoid 25.6000000001 noise.
    let r = (v * 1_000_000.0).round() / 1_000_000.0;
    r
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ")
}

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, AppError> {
    let s = s.replace([' ', '\t', '\n', '\r'], "");
    let s = s.trim();
    if s.is_empty() {
        return Ok(Vec::new());
    }
    let s = if s.len() % 2 != 0 { format!("0{}", s) } else { s.to_string() };
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| AppError::Other(format!("invalid hex: {e}"))))
        .collect()
}

/// Shared hex parse used by the manager when accepting config head/tail.
pub fn parse_hex(s: &str) -> Result<Vec<u8>, AppError> {
    hex_to_bytes(s)
}

/// A `DefaultParser` behind an `Arc<Mutex<…>>`, so it can be shared across the
/// loopback worker and the on-demand parse command.
pub type SharedParser = Arc<Mutex<DefaultParser>>;

/// Build a `SharedParser` pre-loaded with `config` (used by the on-demand
/// parse / encode commands and the loopback channel).
pub fn shared_parser(config: ProtocolConfig) -> SharedParser {
    let mut p = DefaultParser::new();
    let _ = p.load_config(config);
    Arc::new(Mutex::new(p))
}
