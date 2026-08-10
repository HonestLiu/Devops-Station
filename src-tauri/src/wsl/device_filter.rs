//! Embedded-development USB device classification & filtering.
//!
//! We only surface devices relevant to embedded development and hide consumer
//! peripherals (cameras, mice, keyboards, Bluetooth, audio, hubs, internal
//! chips). Classification is driven primarily by VID/PID with a vendor-based
//! fallback for known silicon vendors.

/// Coarse category used by the UI to pick icons, actions, and labels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceCategory {
    UsbSerial,
    DebugProbe,
    McuDevBoard,
    UsbJtag,
}

impl DeviceCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeviceCategory::UsbSerial => "USB Serial",
            DeviceCategory::DebugProbe => "Debug Probe",
            DeviceCategory::McuDevBoard => "MCU Dev Board",
            DeviceCategory::UsbJtag => "USB-JTAG",
        }
    }
}

/// Resolved identity for a device.
pub struct DeviceInfo {
    pub friendly_name: String,
    pub category: DeviceCategory,
}

/// Devices we never want to show (consumer / internal peripherals).
///
/// Keyed by VID (uppercase, 4 hex digits).
fn hidden_vendor(vid: &str) -> bool {
    matches!(
        vid,
        // Intel internal
        "8087"
        // USB hubs
        | "05E3" | "1A40" | "0B95" | "2109"
        // Bluetooth (CSR / Realtek)
        | "0A12" | "0BDA"
        // Audio (C-Media / SigmaTel / Creative)
        | "0D8C" | "1130" | "041E"
        // Webcams (Sunplus / Chicony / IMC Networks)
        | "1BCF" | "04F2" | "13D3"
        // Logitech (mostly mice / webcams / keyboards)
        | "046D"
        // Common gaming mice
        | "1532" | "1038"
        // Microsoft HID
        | "045E"
    )
}

/// Devices we never want to show, keyed by full `VID:PID`.
fn hidden_device(vid: &str, pid: &str) -> bool {
    let _ = pid;
    // Add specific known non-dev devices here if needed.
    matches!(vid, "8087") // Intel internal controllers
}

/// Hidden if the device name clearly indicates a consumer peripheral.
fn hidden_by_name(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("keyboard")
        || n.contains("mouse")
        || n.contains("webcam")
        || n.contains("camera")
        || n.contains("bluetooth")
        || n.contains("headset")
        || n.contains("headphone")
        || n.contains("speaker")
        || n.contains("microphone")
        || n.contains(" hub")
        || n.starts_with("hub ")
        || n.contains("touchpad")
        || n.contains("fingerprint")
        || n.contains("infrared")
        || n.contains("biometric")
}

/// Returns `true` if the device should be hidden from the UI.
pub fn is_hidden(vid: &str, pid: &str, name: &str) -> bool {
    if hidden_device(vid, pid) {
        return true;
    }
    if hidden_vendor(vid) {
        return true;
    }
    hidden_by_name(name)
}

/// Produce a clean, human-friendly name from the raw Windows device string.
///
/// Prefers text inside parentheses: `USB Serial Device, (Arduino ESP32-S3)`
/// → `ESP32-S3`. Falls back to stripping generic `USB Serial Device` prefixes.
fn clean_name(name: &str) -> String {
    if let Some(start) = name.find('(') {
        if let Some(end_rel) = name[start..].find(')') {
            let inner = name[start + 1..start + end_rel].trim();
            if !inner.is_empty() {
                return inner.to_string();
            }
        }
    }
    let n = name.trim();
    for prefix in [
        "USB Serial Device, ",
        "USB Serial Device",
        "USB Device, ",
        "USB Device",
    ] {
        if let Some(stripped) = n.strip_prefix(prefix) {
            let s = stripped.trim();
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    n.to_string()
}

/// Classify a device by VID/PID (and name) into an embeddev-relevant identity.
///
/// Returns `None` when the device is not a recognized embedded-dev device and
/// should therefore be hidden.
pub fn classify(vid: &str, pid: &str, name: &str) -> Option<DeviceInfo> {
    let key = format!("{}:{}", vid.to_uppercase(), pid.to_uppercase());
    let v = vid.to_uppercase();

    // ── 1) Exact VID:PID matches (strongest signal) ──
    let exact = match key.as_str() {
        // ── USB Serial ──
        "10C4:EA60" | "10C4:EA70" => Some(("Silicon Labs CP210x", DeviceCategory::UsbSerial)),
        "1A86:7523" => Some(("WCH CH340", DeviceCategory::UsbSerial)),
        "1A86:55D4" => Some(("WCH CH343", DeviceCategory::UsbSerial)),
        "1A86:7522" => Some(("WCH CH9102", DeviceCategory::UsbSerial)),
        "0403:6001" | "0403:6015" => Some(("FTDI FT232 (USB Serial)", DeviceCategory::UsbSerial)),
        // ── Debug Probes ──
        "0483:3748" | "0483:374B" | "0483:3753" => Some(("ST-Link Debugger", DeviceCategory::DebugProbe)),
        "1366:0101" | "1366:0105" => Some(("SEGGER J-Link", DeviceCategory::DebugProbe)),
        "0D28:0204" | "0D28:0207" | "0D28:0202" => Some(("CMSIS-DAP", DeviceCategory::DebugProbe)),
        // ── USB-JTAG (FTDI multi-channel) ──
        "0403:6010" | "0403:6011" | "0403:6014" | "0403:601C" => {
            Some(("FTDI USB-JTAG", DeviceCategory::UsbJtag))
        }
        // ── MCU Dev Boards ──
        "303A:1001" | "303A:1000" | "303A:0002" => Some(("ESP32-S3 Dev Board", DeviceCategory::McuDevBoard)),
        "2341:0043" | "2341:0042" | "2341:0041" => Some(("Arduino", DeviceCategory::McuDevBoard)),
        "2E8A:0005" | "2E8A:000A" | "2E8A:0003" => Some(("Raspberry Pi Pico (RP2040)", DeviceCategory::McuDevBoard)),
        "239A:8011" | "239A:8010" => Some(("Adafruit", DeviceCategory::McuDevBoard)),
        "1B4F:0016" => Some(("SparkFun", DeviceCategory::McuDevBoard)),
        _ => None,
    };

    if let Some((friendly, category)) = exact {
        return Some(DeviceInfo {
            friendly_name: friendly.to_string(),
            category,
        });
    }

    // ── 2) Vendor-based fallback for known embedded silicon vendors ──
    let by_vendor = match v.as_str() {
        "303A" => Some(("Espressif ESP32", DeviceCategory::McuDevBoard)),
        "2341" | "2342" | "239A" | "1B4F" | "2E8A" => {
            Some(("MCU Dev Board", DeviceCategory::McuDevBoard))
        }
        "0483" => Some(("ST Device (ST-Link / STM32)", DeviceCategory::DebugProbe)),
        "1366" => Some(("SEGGER J-Link", DeviceCategory::DebugProbe)),
        "0D28" => Some(("CMSIS-DAP / mbed", DeviceCategory::DebugProbe)),
        "10C4" | "1A86" => Some(("USB-to-Serial", DeviceCategory::UsbSerial)),
        "0403" => Some(("FTDI USB Device", DeviceCategory::UsbJtag)),
        _ => None,
    };

    if let Some((friendly, category)) = by_vendor {
        // Prefer the cleaned Windows name when it's more specific.
        let friendly_name = if name.contains('(') || (!name.is_empty() && !name.to_lowercase().starts_with("usb")) {
            clean_name(name)
        } else {
            friendly.to_string()
        };
        return Some(DeviceInfo {
            friendly_name,
            category,
        });
    }

    // ── 3) Not a recognized embedded device → hidden ──
    None
}
