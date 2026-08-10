//! Parsing of `usbipd list` textual output.
//!
//! `usbipd` output varies between versions, so this parser is deliberately
//! defensive: it scans for section headers (`Connected:`, `Attached:`, ...) and
//! then for device rows of the form `BUSID  VID:PID  DEVICE[  STATE]`.

/// Which section of `usbipd list` a device appeared under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Connected,
    Attached,
    Shared,
    Persisted,
    Unknown,
}

/// A single raw device entry parsed from `usbipd list`.
#[derive(Debug, Clone)]
pub struct RawDevice {
    pub busid: String,
    pub vid: String,
    pub pid: String,
    pub device_name: String,
    pub section: Section,
    /// The optional trailing state column (e.g. `Shared`, `Attached`, `Connected`).
    pub state: Option<String>,
}

/// Parse the textual output of `usbipd list` into a list of [`RawDevice`].
pub fn parse_usbipd_list(output: &str) -> Vec<RawDevice> {
    let mut devices = Vec::new();
    let mut section = Section::Unknown;

    for raw_line in output.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // ── Section headers ──
        if trimmed.eq_ignore_ascii_case("Connected:") {
            section = Section::Connected;
            continue;
        } else if trimmed.eq_ignore_ascii_case("Attached:") {
            section = Section::Attached;
            continue;
        } else if trimmed.eq_ignore_ascii_case("Shared:") {
            section = Section::Shared;
            continue;
        } else if trimmed.eq_ignore_ascii_case("Persisted:") {
            section = Section::Persisted;
            continue;
        }

        // Skip the column-header row and separator rows.
        if trimmed.to_uppercase().starts_with("BUSID") {
            continue;
        }
        if trimmed.chars().all(|c| c == '-') {
            continue;
        }

        if let Some(dev) = parse_device_line(trimmed, section) {
            devices.push(dev);
        }
    }

    devices
}

fn parse_device_line(line: &str, section: Section) -> Option<RawDevice> {
    let mut parts = line.split_whitespace();

    let busid = parts.next()?;
    if !busid.contains('-') {
        return None;
    }

    let vidpid = parts.next()?;
    let (vid, pid) = vidpid.split_once(':')?;
    if vid.len() != 4 || pid.len() != 4 || !is_hex(vid) || !is_hex(pid) {
        return None;
    }

    let rest: String = parts.collect::<Vec<_>>().join(" ");
    let (device_name, state) = split_trailing_state(&rest);

    Some(RawDevice {
        busid: busid.to_string(),
        vid: vid.to_uppercase(),
        pid: pid.to_uppercase(),
        device_name: device_name.trim().to_string(),
        section,
        state: state.map(|s| s.to_string()),
    })
}

fn is_hex(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_hexdigit())
}

/// If the device name ends with a known state word (`Shared` / `Attached` /
/// `Connected` / `Bind` / `Bound`), split it off as the STATE column.
fn split_trailing_state(name: &str) -> (String, Option<String>) {
    let known = ["Shared", "Attached", "Connected", "Bound", "Bind"];
    let trimmed_end = name.trim_end();
    for &k in &known {
        if let Some(stripped) = trimmed_end.strip_suffix(k) {
            // Require a whitespace boundary (or start of string) so we don't
            // accidentally clip a real device-name suffix.
            if stripped.is_empty() || stripped.ends_with(char::is_whitespace) {
                return (stripped.trim_end().to_string(), Some(k.to_string()));
            }
        }
    }
    (trimmed_end.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_connected_section() {
        let out = "\
Connected:
BUSID  VID:PID    DEVICE
1-2    303a:1001  USB Serial Device, (Arduino ESP32-S3)
2-1    0483:3748  ST-Link Debug
";
        let devs = parse_usbipd_list(out);
        assert_eq!(devs.len(), 2);
        assert_eq!(devs[0].busid, "1-2");
        assert_eq!(devs[0].vid, "303A");
        assert_eq!(devs[0].pid, "1001");
        assert_eq!(devs[0].section, Section::Connected);
    }

    #[test]
    fn parses_state_column() {
        let out = "\
Connected:
BUSID  VID:PID    DEVICE          STATE
1-2    303a:1001  USB Serial Device Shared
";
        let devs = parse_usbipd_list(out);
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].state.as_deref(), Some("Shared"));
    }

    #[test]
    fn parses_attached_section() {
        let out = "\
Attached:
BUSID  VID:PID    DEVICE
3-4    0403:6010  FT2232
";
        let devs = parse_usbipd_list(out);
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].section, Section::Attached);
    }
}
