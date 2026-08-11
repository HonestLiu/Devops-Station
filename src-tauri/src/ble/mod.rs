//! Bluetooth Low Energy transparent-transmission transport.
//!
//! Mirrors [`crate::serial`] on purpose: a BLE session looks exactly like a
//! serial session to the frontend (same `StreamChunk` / `SessionClosed`
//! payloads, same [`OutputBuffer`] attach handshake), so the whole record /
//! plot / send stack works against either transport unchanged.
//!
//! The wire model is the common "BLE serial bridge" GATT profile used by
//! DX-BT24 / DX-BT16 style modules: one service holding a *write*
//! characteristic (host -> device) and a *notify* characteristic
//! (device -> host). Both default to 0xFFE1 on the 0xFFE0 service, but the
//! caller can point at any UUID triple.
//!
//! Unlike `serialport`, btleplug is async all the way down, so sessions live on
//! tokio tasks rather than dedicated OS threads.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use btleplug::api::{
    CharPropFlags, Characteristic, Central, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::stream::StreamExt;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::stream::{Attached, OutputBuffer};
use crate::types::{BleDeviceInfo, BleOpenConfig, SessionClosed, StreamChunk};

pub fn data_event(session_id: &str) -> String {
    format!("ble-data-{session_id}")
}
pub fn closed_event(session_id: &str) -> String {
    format!("ble-closed-{session_id}")
}

/// Default ATT payload for an unnegotiated 23-byte MTU. Writing more than this
/// in one GATT operation is silently truncated by many bridge modules, so we
/// fragment instead and let the device reassemble.
const DEFAULT_CHUNK: usize = 20;
/// Pacing between fragments of a write-without-response burst. Without it the
/// controller's outbound queue overflows and the tail of a long line is lost.
const CHUNK_GAP: Duration = Duration::from_millis(8);
/// How often the reader task re-checks the link while no notification arrives.
const WATCHDOG: Duration = Duration::from_secs(1);

/// Expand a 16-/32-bit GATT shorthand into a full UUID, or parse a 128-bit one.
///
/// Port of the reference project's `normalizeGattUuid`, so "FFE0", "0xffe0" and
/// "0000ffe0-0000-1000-8000-00805f9b34fb" all resolve to the same service.
pub fn parse_gatt_uuid(value: &str, field: &str) -> AppResult<Uuid> {
    let raw = value.trim();
    let short = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")).unwrap_or(raw);

    if (short.len() == 4 || short.len() == 8) && short.chars().all(|c| c.is_ascii_hexdigit()) {
        let n = u32::from_str_radix(short, 16)
            .map_err(|_| AppError::Ble(format!("{field} is not a valid GATT UUID: {raw}")))?;
        // Bluetooth Base UUID: 0000xxxx-0000-1000-8000-00805F9B34FB
        return Ok(Uuid::from_fields(
            n,
            0x0000,
            0x1000,
            &[0x80, 0x00, 0x00, 0x80, 0x5f, 0x9b, 0x34, 0xfb],
        ));
    }

    Uuid::parse_str(short)
        .map_err(|_| AppError::Ble(format!("{field} must be a 16-, 32- or 128-bit UUID: {raw}")))
}

pub struct BleSession {
    pub device_name: String,
    peripheral: Peripheral,
    write_char: Characteristic,
    write_type: WriteType,
    notify_char: Option<Characteristic>,
    chunk_size: usize,
    running: Arc<AtomicBool>,
    output: Arc<OutputBuffer>,
}

impl BleSession {
    /// Same pre-attach replay as serial — a module may notify the moment we
    /// subscribe, before React has registered its listener.
    pub fn attach(&self) -> Attached {
        self.output.attach()
    }

    pub async fn write(&self, bytes: &[u8]) -> AppResult<()> {
        let chunk = self.chunk_size.max(1);
        let fragmented = bytes.len() > chunk;
        for part in bytes.chunks(chunk) {
            self.peripheral
                .write(&self.write_char, part, self.write_type)
                .await
                .map_err(|e| {
                    AppError::Ble(format!("write to {} failed: {e}", self.device_name))
                })?;
            if fragmented && matches!(self.write_type, WriteType::WithoutResponse) {
                tokio::time::sleep(CHUNK_GAP).await;
            }
        }
        Ok(())
    }

    fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }

    /// Tear the GATT link down. The reader task notices `running == false` on
    /// its next watchdog tick and emits the close event.
    async fn teardown(&self) {
        self.stop();
        if let Some(c) = &self.notify_char {
            let _ = self.peripheral.unsubscribe(c).await;
        }
        let _ = self.peripheral.disconnect().await;
    }
}

#[derive(Default)]
pub struct BleManager {
    /// The adapter is created lazily: constructing a WinRT/BlueZ central at
    /// startup would spin up radio machinery for users who never touch BLE.
    /// `Manager` is kept alive alongside it — dropping it invalidates `Adapter`.
    central: tokio::sync::Mutex<Option<(Manager, Arc<Adapter>)>>,
    /// Peripherals seen by the most recent scans, keyed by btleplug's stable
    /// per-adapter id. `open` needs the live handle, not just the id string.
    discovered: Mutex<HashMap<String, Peripheral>>,
    sessions: Mutex<HashMap<String, Arc<BleSession>>>,
}

impl BleManager {
    async fn adapter(&self) -> AppResult<Arc<Adapter>> {
        let mut guard = self.central.lock().await;
        if let Some((_, a)) = guard.as_ref() {
            return Ok(a.clone());
        }
        let manager = Manager::new()
            .await
            .map_err(|e| AppError::Ble(format!("Bluetooth stack unavailable: {e}")))?;
        let adapter = manager
            .adapters()
            .await
            .map_err(|e| AppError::Ble(format!("cannot enumerate Bluetooth adapters: {e}")))?
            .into_iter()
            .next()
            .ok_or_else(|| {
                AppError::Ble(
                    "no Bluetooth adapter found — check that Bluetooth is switched on".into(),
                )
            })?;
        let adapter = Arc::new(adapter);
        *guard = Some((manager, adapter.clone()));
        Ok(adapter)
    }

    /// True when a usable adapter exists. Used to grey out the Bluetooth tab.
    pub async fn available(&self) -> bool {
        self.adapter().await.is_ok()
    }

    pub fn get(&self, id: &str) -> AppResult<Arc<BleSession>> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    /// Run a discovery window and report everything the adapter can see.
    ///
    /// `service` narrows the advertisement filter the same way the reference
    /// project's `filters: [{ services: [...] }]` does; passing `None` is the
    /// equivalent of `acceptAllDevices` and is what the custom-GATT flow needs.
    pub async fn scan(
        &self,
        duration_ms: u64,
        service: Option<String>,
    ) -> AppResult<Vec<BleDeviceInfo>> {
        let adapter = self.adapter().await?;
        let services = match service {
            Some(s) if !s.trim().is_empty() => vec![parse_gatt_uuid(&s, "service UUID")?],
            _ => Vec::new(),
        };

        adapter
            .start_scan(ScanFilter { services })
            .await
            .map_err(|e| AppError::Ble(format!("cannot start scan: {e}")))?;
        tokio::time::sleep(Duration::from_millis(duration_ms.clamp(500, 30_000))).await;
        let _ = adapter.stop_scan().await;

        let peripherals = adapter
            .peripherals()
            .await
            .map_err(|e| AppError::Ble(format!("cannot read scan results: {e}")))?;

        let mut out = Vec::with_capacity(peripherals.len());
        let mut found = Vec::with_capacity(peripherals.len());
        for p in peripherals {
            let id = p.id().to_string();
            let props = p.properties().await.ok().flatten();
            let connected = p.is_connected().await.unwrap_or(false);
            let (name, address, rssi, services) = match props {
                Some(pr) => (
                    pr.local_name.unwrap_or_default(),
                    pr.address.to_string(),
                    pr.rssi,
                    pr.services.iter().map(|u| u.to_string()).collect(),
                ),
                None => (String::new(), String::new(), None, Vec::new()),
            };
            found.push((id.clone(), p));
            out.push(BleDeviceInfo {
                id,
                name,
                address,
                rssi,
                services,
                connected,
            });
        }

        // Merge rather than replace: a device found in an earlier, narrower scan
        // must stay resolvable so `open` doesn't fail after the user re-scans.
        {
            let mut cache = self.discovered.lock();
            for (id, p) in found {
                cache.insert(id, p);
            }
        }

        // Strongest signal first, but always push nameless beacons to the back —
        // they're almost never what the user is looking for.
        out.sort_by(|a, b| {
            let named = b.name.is_empty().cmp(&a.name.is_empty());
            named.then(b.rssi.unwrap_or(i16::MIN).cmp(&a.rssi.unwrap_or(i16::MIN)))
        });
        Ok(out)
    }

    /// Look up a live peripheral handle, re-scanning once if the cache is cold
    /// (which is the normal case when a saved BLE tab reconnects after restart).
    async fn resolve(&self, device_id: &str) -> AppResult<Peripheral> {
        if let Some(p) = self.discovered.lock().get(device_id).cloned() {
            return Ok(p);
        }

        let adapter = self.adapter().await?;
        let _ = adapter.start_scan(ScanFilter::default()).await;
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let _ = adapter.stop_scan().await;
        let list = adapter
            .peripherals()
            .await
            .map_err(|e| AppError::Ble(format!("cannot read scan results: {e}")))?;

        let mut cache = self.discovered.lock();
        for p in list {
            cache.insert(p.id().to_string(), p);
        }
        cache.get(device_id).cloned().ok_or_else(|| {
            AppError::Ble(format!(
                "device `{device_id}` is out of range or powered off — scan again"
            ))
        })
    }

    pub async fn open(&self, app: AppHandle, cfg: BleOpenConfig) -> AppResult<String> {
        let service = parse_gatt_uuid(&cfg.service, "service UUID")?;
        let write_uuid = parse_gatt_uuid(&cfg.write_characteristic, "write characteristic UUID")?;
        let notify_uuid = match cfg.notify_characteristic.as_deref() {
            Some(s) if !s.trim().is_empty() => {
                Some(parse_gatt_uuid(s, "notify characteristic UUID")?)
            }
            _ => None,
        };

        let peripheral = self.resolve(&cfg.device_id).await?;

        if !peripheral.is_connected().await.unwrap_or(false) {
            peripheral
                .connect()
                .await
                .map_err(|e| AppError::Ble(format!("GATT connect failed: {e}")))?;
        }
        peripheral
            .discover_services()
            .await
            .map_err(|e| AppError::Ble(format!("service discovery failed: {e}")))?;

        let chars = peripheral.characteristics();
        // Prefer an exact service+characteristic match; fall back to the bare
        // characteristic so a mis-typed service UUID still connects if unique.
        let pick = |uuid: Uuid| -> Option<Characteristic> {
            chars
                .iter()
                .find(|c| c.uuid == uuid && c.service_uuid == service)
                .or_else(|| chars.iter().find(|c| c.uuid == uuid))
                .cloned()
        };

        let write_char = pick(write_uuid).ok_or_else(|| {
            AppError::Ble(format!(
                "write characteristic {write_uuid} not found on this device"
            ))
        })?;
        if !write_char
            .properties
            .intersects(CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE)
        {
            return Err(AppError::Ble(
                "the selected write characteristic does not support GATT write".into(),
            ));
        }
        // Same preference order as the reference `writeGattValue`: unacked
        // writes are dramatically faster for a transparent serial bridge.
        let write_type = if write_char
            .properties
            .contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)
        {
            WriteType::WithoutResponse
        } else {
            WriteType::WithResponse
        };

        let notify_char = match notify_uuid {
            Some(u) => {
                let c = pick(u).ok_or_else(|| {
                    AppError::Ble(format!("notify characteristic {u} not found on this device"))
                })?;
                if !c
                    .properties
                    .intersects(CharPropFlags::NOTIFY | CharPropFlags::INDICATE)
                {
                    return Err(AppError::Ble(
                        "the selected notify characteristic supports neither notify nor indicate"
                            .into(),
                    ));
                }
                peripheral
                    .subscribe(&c)
                    .await
                    .map_err(|e| AppError::Ble(format!("cannot subscribe to notifications: {e}")))?;
                Some(c)
            }
            None => None,
        };

        let device_name = match cfg.device_name.filter(|n| !n.trim().is_empty()) {
            Some(n) => n,
            None => peripheral
                .properties()
                .await
                .ok()
                .flatten()
                .and_then(|p| p.local_name)
                .unwrap_or_else(|| cfg.device_id.clone()),
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let running = Arc::new(AtomicBool::new(true));
        let output = Arc::new(OutputBuffer::new());
        let session = Arc::new(BleSession {
            device_name,
            peripheral: peripheral.clone(),
            write_char,
            write_type,
            notify_char,
            chunk_size: cfg.chunk_size.unwrap_or(DEFAULT_CHUNK).clamp(1, 512),
            running: running.clone(),
            output: output.clone(),
        });
        self.sessions
            .lock()
            .insert(session_id.clone(), session.clone());

        // --- notification pump -------------------------------------------------
        let sid = session_id.clone();
        let want = notify_uuid;
        tokio::spawn(async move {
            let data_evt = data_event(&sid);
            let mut reason = String::from("closed by user");

            match peripheral.notifications().await {
                Ok(mut stream) => {
                    let mut ticker = tokio::time::interval(WATCHDOG);
                    ticker.tick().await; // the first tick resolves immediately

                    while running.load(Ordering::Relaxed) {
                        tokio::select! {
                            item = stream.next() => match item {
                                Some(n) => {
                                    // A device may notify on several characteristics;
                                    // only the configured RX one is session data.
                                    if want.map_or(true, |u| u == n.uuid) && output.accept(&n.value) {
                                        let _ = app.emit(
                                            &data_evt,
                                            StreamChunk {
                                                session_id: sid.clone(),
                                                data: B64.encode(&n.value),
                                            },
                                        );
                                        crate::perm::scan_and_emit(&app, &sid, &n.value);
                                    }
                                }
                                None => {
                                    if running.load(Ordering::Relaxed) {
                                        reason = "notification stream ended".into();
                                    }
                                    break;
                                }
                            },
                            _ = ticker.tick() => {
                                // Check the user-close flag *before* the link state:
                                // our own disconnect must not be reported as a drop.
                                if !running.load(Ordering::Relaxed) {
                                    break;
                                }
                                if !peripheral.is_connected().await.unwrap_or(false) {
                                    reason = "device disconnected".into();
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    reason = format!("cannot read notifications: {e}");
                }
            }

            running.store(false, Ordering::Relaxed);
            let _ = peripheral.disconnect().await;

            let closed = SessionClosed {
                session_id: sid.clone(),
                reason,
                exit_code: None,
            };
            if output.accept_closed(&closed) {
                let _ = app.emit(&closed_event(&sid), closed);
            }
        });

        Ok(session_id)
    }

    pub async fn close(&self, id: &str) -> AppResult<()> {
        let session = self.sessions.lock().remove(id);
        if let Some(s) = session {
            s.teardown().await;
        }
        Ok(())
    }

    /// Best-effort teardown on app exit. Disconnecting is async and the window
    /// is already going away, so the actual GATT close is fire-and-forget.
    pub fn close_all(&self) {
        for (_, s) in self.sessions.lock().drain() {
            s.stop();
            tokio::spawn(async move {
                s.teardown().await;
            });
        }
    }
}
