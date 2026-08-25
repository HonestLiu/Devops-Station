//! Serial port management.
//!
//! `serialport` is a blocking API, so each open port gets its own OS thread
//! running a short-timeout read loop. Writes go through a cloned handle guarded
//! by a mutex, which keeps `serial_write` callable from any async context
//! without blocking the Tauri runtime for more than a syscall.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::stream::{Attached, OutputBuffer};
use crate::types::{SerialOpenConfig, SerialPortInfo, SessionClosed, StreamChunk};

pub fn data_event(session_id: &str) -> String {
    format!("serial-data-{session_id}")
}
pub fn closed_event(session_id: &str) -> String {
    format!("serial-closed-{session_id}")
}

const READ_TIMEOUT: Duration = Duration::from_millis(50);
const READ_BUF: usize = 8192;

pub struct SerialSession {
    pub port_name: String,
    writer: Mutex<Box<dyn SerialPort>>,
    running: Arc<AtomicBool>,
    output: Arc<OutputBuffer>,
}

impl SerialSession {
    /// Hand the UI whatever the device sent before it could listen — matters
    /// for boards that dump a boot log the instant the port opens (DTR reset).
    pub fn attach(&self) -> Attached {
        self.output.attach()
    }

    pub fn write(&self, bytes: &[u8]) -> AppResult<()> {
        let mut w = self.writer.lock();
        // Naming the port matters here: a failed write usually means the
        // adapter was unplugged, and the user needs to know *which* one.
        w.write_all(bytes)
            .map_err(|e| AppError::Serial(format!("write to {} failed: {e}", self.port_name)))?;
        w.flush()
            .map_err(|e| AppError::Serial(format!("flush on {} failed: {e}", self.port_name)))?;
        Ok(())
    }

    pub fn set_signals(&self, dtr: Option<bool>, rts: Option<bool>) -> AppResult<()> {
        let mut w = self.writer.lock();
        if let Some(v) = dtr {
            w.write_data_terminal_ready(v)?;
        }
        if let Some(v) = rts {
            w.write_request_to_send(v)?;
        }
        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct SerialManager {
    sessions: Mutex<HashMap<String, Arc<SerialSession>>>,
}

impl SerialManager {
    pub fn get(&self, id: &str) -> AppResult<Arc<SerialSession>> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    pub fn close(&self, id: &str) -> AppResult<()> {
        if let Some(s) = self.sessions.lock().remove(id) {
            s.stop();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        for (_, s) in self.sessions.lock().drain() {
            s.stop();
        }
    }

    pub fn open(&self, app: AppHandle, cfg: SerialOpenConfig) -> AppResult<String> {
        let session_id = uuid::Uuid::new_v4().to_string();

        let port = serialport::new(&cfg.port, cfg.baud_rate)
            .data_bits(match cfg.data_bits {
                5 => DataBits::Five,
                6 => DataBits::Six,
                7 => DataBits::Seven,
                _ => DataBits::Eight,
            })
            .stop_bits(match cfg.stop_bits {
                2 => StopBits::Two,
                _ => StopBits::One,
            })
            .parity(match cfg.parity.as_str() {
                "odd" => Parity::Odd,
                "even" => Parity::Even,
                _ => Parity::None,
            })
            .flow_control(match cfg.flow_control.as_str() {
                "software" => FlowControl::Software,
                "hardware" => FlowControl::Hardware,
                _ => FlowControl::None,
            })
            .timeout(READ_TIMEOUT)
            .open()
            .map_err(|e| AppError::Serial(format!("cannot open {} — {e}", cfg.port)))?;

        let mut reader = port
            .try_clone()
            .map_err(|e| AppError::Serial(format!("cannot clone port handle: {e}")))?;

        let running = Arc::new(AtomicBool::new(true));
        let output = Arc::new(OutputBuffer::new());
        let session = Arc::new(SerialSession {
            port_name: cfg.port.clone(),
            writer: Mutex::new(port),
            running: running.clone(),
            output: output.clone(),
        });

        self.sessions
            .lock()
            .insert(session_id.clone(), session.clone());

        // --- blocking read loop on its own thread ---
        let sid = session_id.clone();
        std::thread::Builder::new()
            .name(format!("serial-{}", cfg.port))
            .spawn(move || {
                let data_evt = data_event(&sid);
                let mut buf = vec![0u8; READ_BUF];
                let mut reason = String::from("closed by user");

                while running.load(Ordering::Relaxed) {
                    match reader.read(&mut buf) {
                        Ok(0) => {}
                        Ok(n) => {
                            if output.accept(&buf[..n]) {
                                let _ = app.emit(
                                    &data_evt,
                                    StreamChunk {
                                        session_id: sid.clone(),
                                        data: B64.encode(&buf[..n]),
                                    },
                                );
                                crate::perm::scan_and_emit(&sid, &buf[..n]);
                            }
                        }
                        Err(e) if e.kind() == ErrorKind::TimedOut => {}
                        Err(e) if e.kind() == ErrorKind::Interrupted => {}
                        Err(e) => {
                            // Unplugged USB adapters land here.
                            reason = format!("port error: {e}");
                            break;
                        }
                    }
                }

                let closed = SessionClosed {
                    session_id: sid.clone(),
                    reason,
                    exit_code: None,
                    restart: None,
                };
                if output.accept_closed(&closed) {
                    let _ = app.emit(&closed_event(&sid), closed);
                }
            })
            .map_err(|e| AppError::Serial(format!("cannot spawn reader thread: {e}")))?;

        Ok(session_id)
    }
}

pub fn list_ports() -> AppResult<Vec<SerialPortInfo>> {
    let ports = serialport::available_ports()?;
    let mut out: Vec<SerialPortInfo> = ports
        .into_iter()
        .map(|p| {
            let (kind, manufacturer, product, serial_number, vid, pid) = match p.port_type {
                SerialPortType::UsbPort(info) => (
                    "usb",
                    info.manufacturer,
                    info.product,
                    info.serial_number,
                    Some(info.vid),
                    Some(info.pid),
                ),
                SerialPortType::PciPort => ("pci", None, None, None, None, None),
                SerialPortType::BluetoothPort => ("bluetooth", None, None, None, None, None),
                SerialPortType::Unknown => ("unknown", None, None, None, None, None),
            };
            SerialPortInfo {
                name: p.port_name,
                kind: kind.to_string(),
                manufacturer,
                product,
                serial_number,
                vid,
                pid,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Common baud rates offered in the UI dropdown.
pub const COMMON_BAUD_RATES: &[u32] = &[
    9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000, 2000000, 3000000,
];
