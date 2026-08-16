//! SSH port forwarding over an existing [`SshSession`].
//!
//! Supports the three `ssh` forward modes:
//! * **Local** (`-L`): bind a TCP listener locally; every connection is tunnelled
//!   to `remote_host:remote_port` through the SSH session.
//! * **Dynamic** (`-D`): bind a SOCKS5 proxy locally; the target of each
//!   connection is chosen by the client (CONNECT).
//! * **Remote** (`-R`): ask the server to bind a port; inbound connections are
//!   tunnelled back to a local target on this machine.
//!
//! Status follows the Netcatty port-forward runtime model: a rule is only
//! reported `active` once a real listener is bound (local/dynamic) or the server
//! has confirmed the forward (remote). Buttons never invent status.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;

use russh::Channel;
use russh::ChannelMsg;
use russh::client::Msg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, RwLock};

use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;
use crate::storage::Store;
use crate::types::{ForwardType, PortForwardRule, PortForwardStatus};

const ST_ACTIVE: &str = "active";
const ST_ERROR: &str = "error";

struct ForwardRuntime {
    rule: PortForwardRule,
    session: Arc<SshSession>,
    session_id: String,
    status: String,
    error: Option<String>,
    bound_port: Option<u16>,
    /// Signalling this drops the accept loop / cancels the remote forward.
    stop: Option<oneshot::Sender<()>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub struct PortForwardManager {
    runtimes: RwLock<HashMap<String, ForwardRuntime>>,
    store: Arc<Store>,
}

impl PortForwardManager {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            runtimes: RwLock::new(HashMap::new()),
            store,
        }
    }

    /// Start a forward. Idempotent: an already-active rule returns its status.
    pub async fn start(
        &self,
        session: Arc<SshSession>,
        rule: PortForwardRule,
    ) -> AppResult<PortForwardStatus> {
        if let Some(rt) = self.runtimes.read().await.get(&rule.id) {
            if rt.status == ST_ACTIVE {
                return Ok(status_of(rt));
            }
        }

        let session_id = session.id.clone();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();

        // Each arm returns the live state; this avoids dead initial assignments
        // and makes it obvious that the success path is always active.
        let (bound_port, status, task) = match rule.forward_type {
            ForwardType::Local | ForwardType::Dynamic => {
                let bind = (rule.local_host.clone(), rule.local_port);
                let listener = match TcpListener::bind(bind).await {
                    Ok(l) => l,
                    Err(e) => {
                        return Ok(PortForwardStatus {
                            id: rule.id.clone(),
                            status: ST_ERROR.into(),
                            error: Some(format!(
                                "bind {}:{} failed: {e}",
                                rule.local_host, rule.local_port
                            )),
                            bound_port: None,
                        });
                    }
                };
                let bound_port = Some(listener.local_addr()?.port());
                let task = tauri::async_runtime::spawn(forward_accept_loop(
                    listener,
                    stop_rx,
                    session.clone(),
                    rule.clone(),
                ));
                (bound_port, ST_ACTIVE.to_string(), Some(task))
            }
            ForwardType::Remote => {
                // Register the local target so the client handler can bridge any
                // inbound connection the server opens for this port.
                session
                    .remote_forwards
                    .write()
                    .await
                    .insert(rule.remote_port as u32, (rule.local_host.clone(), rule.local_port));
                match session
                    .handle
                    .tcpip_forward(rule.remote_host.clone(), rule.remote_port as u32)
                    .await
                {
                    Ok(assigned) => (Some(assigned as u16), ST_ACTIVE.to_string(), None),
                    Err(e) => {
                        session
                            .remote_forwards
                            .write()
                            .await
                            .remove(&(rule.remote_port as u32));
                        return Ok(PortForwardStatus {
                            id: rule.id.clone(),
                            status: ST_ERROR.into(),
                            error: Some(format!("server refused forward: {e}")),
                            bound_port: None,
                        });
                    }
                }
            }
        };

        let rt = ForwardRuntime {
            rule: rule.clone(),
            session: session.clone(),
            session_id: session_id.clone(),
            status: status.clone(),
            error: None,
            bound_port,
            stop: Some(stop_tx),
            task,
        };
        self.runtimes.write().await.insert(rule.id.clone(), rt);

        Ok(PortForwardStatus {
            id: rule.id.clone(),
            status,
            error: None,
            bound_port,
        })
    }

    /// Stop a running forward and tear its listener / server-forward down.
    pub async fn stop(&self, id: &str) -> AppResult<()> {
        let rt = self.runtimes.write().await.remove(id);
        let Some(mut rt) = rt else {
            return Ok(());
        };
        if let Some(tx) = rt.stop.take() {
            let _ = tx.send(());
        }
        if let Some(task) = rt.task.take() {
            task.abort();
        }
        if rt.rule.forward_type == ForwardType::Remote {
            let _ = rt
                .session
                .handle
                .cancel_tcpip_forward(rt.rule.remote_host.clone(), rt.rule.remote_port as u32)
                .await;
            rt.session
                .remote_forwards
                .write()
                .await
                .remove(&(rt.rule.remote_port as u32));
        } else {
            // Closing the SSH session also kills the listener task, but we still
            // want an explicit, immediate stop when the user hits the button.
            let _ = rt.session.handle.disconnect(
                russh::Disconnect::ByApplication,
                "port forward stopped",
                "en",
            );
        }
        Ok(())
    }

    /// Tear down every forward bound to a session (called on disconnect so the
    /// UI never shows a stale "active" tunnel over a dead SSH connection).
    pub async fn stop_for_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .runtimes
            .read()
            .await
            .values()
            .filter(|rt| rt.session_id == session_id)
            .map(|rt| rt.rule.id.clone())
            .collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    /// Live statuses for one session.
    pub async fn list(&self, session_id: &str) -> Vec<PortForwardStatus> {
        self.runtimes
            .read()
            .await
            .values()
            .filter(|rt| rt.session_id == session_id)
            .map(status_of)
            .collect()
    }

    /// Start every `auto_start` rule for a host as soon as its session opens.
    pub async fn start_auto_for(&self, session: &Arc<SshSession>, host_id: &str) {
        let rules = match self.store.auto_start_port_forwards(host_id) {
            Ok(r) => r,
            Err(_) => return,
        };
        for rule in rules {
            let _ = self.start(session.clone(), rule).await;
        }
    }
}

fn status_of(rt: &ForwardRuntime) -> PortForwardStatus {
    PortForwardStatus {
        id: rt.rule.id.clone(),
        status: rt.status.clone(),
        error: rt.error.clone(),
        bound_port: rt.bound_port,
    }
}

/// Accept loop for local / dynamic forwards.
async fn forward_accept_loop(
    listener: TcpListener,
    mut stop_rx: oneshot::Receiver<()>,
    session: Arc<SshSession>,
    rule: PortForwardRule,
) {
    let is_dynamic = rule.forward_type == ForwardType::Dynamic;
    loop {
        tokio::select! {
            _ = &mut stop_rx => break,
            accept = listener.accept() => {
                match accept {
                    Ok((tcp, _)) => {
                        let s = session.clone();
                        let rh = rule.remote_host.clone();
                        let rp = rule.remote_port;
                        tauri::async_runtime::spawn(async move {
                            let res = if is_dynamic {
                                handle_socks5(tcp, s).await
                            } else {
                                open_local_tunnel(s, &rh, rp, tcp).await
                            };
                            if let Err(_e) = res {
                                // Tunnel ended (peer closed / SSH error). The
                                // listener stays up, so other connections are fine.
                            }
                        });
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

/// Open a direct-tcpip channel to `remote_host:remote_port` and pump it.
async fn open_local_tunnel(
    session: Arc<SshSession>,
    remote_host: &str,
    remote_port: u16,
    tcp: TcpStream,
) -> AppResult<()> {
    if remote_host.is_empty() || remote_port == 0 {
        return Err(AppError::Other(
            "port forward: remote host/port not set".into(),
        ));
    }
    let channel = session
        .handle
        .channel_open_direct_tcpip(remote_host, remote_port.into(), "127.0.0.1", 0)
        .await?;
    pump(channel, tcp).await
}

/// Bridge a server-initiated forwarded channel back to a local target.
pub(crate) async fn bridge_forwarded(
    channel: Channel<Msg>,
    local_host: String,
    local_port: u16,
) -> AppResult<()> {
    let tcp = TcpStream::connect((local_host, local_port))
        .await
        .map_err(|e| AppError::Other(format!("port forward: local target connect failed: {e}")))?;
    pump(channel, tcp).await
}

/// Bidirectionally copy an SSH channel and a TCP stream until either closes.
async fn pump(channel: Channel<Msg>, tcp: TcpStream) -> AppResult<()> {
    let (mut r, w) = channel.split();
    let (mut tcp_r, mut tcp_w) = tcp.into_split();

    // SSH channel -> TCP (server output to the local socket).
    let ssh_to_tcp = tauri::async_runtime::spawn(async move {
        while let Some(msg) = r.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if tcp_w.write_all(data.as_ref()).await.is_err() {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => {
                    let _ = tcp_w.shutdown().await;
                    break;
                }
                _ => {}
            }
        }
    });

    // TCP -> SSH channel (local input to the server).
    let tcp_to_ssh = tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 16384];
        loop {
            match tcp_r.read(&mut buf).await {
                Ok(0) => {
                    let _ = w.eof().await;
                    break;
                }
                Ok(n) => {
                    if w.data_bytes(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = w.eof().await;
                    break;
                }
            }
        }
    });

    let _ = ssh_to_tcp.await;
    let _ = tcp_to_ssh.await;
    Ok(())
}

/// Minimal SOCKS5 (RFC 1928) CONNECT server for dynamic forwards.
async fn handle_socks5(mut tcp: TcpStream, session: Arc<SshSession>) -> AppResult<()> {
    // --- handshake: VER, NMETHODS, METHODS... ---
    let mut hdr = [0u8; 2];
    tcp.read_exact(&mut hdr).await?;
    if hdr[0] != 5 {
        return Err(AppError::Other("SOCKS5 only".into()));
    }
    let nmethods = hdr[1] as usize;
    let mut methods = vec![0u8; nmethods];
    tcp.read_exact(&mut methods).await?;
    // We only support no-auth (0x00).
    tcp.write_all(&[0x05, 0x00]).await?;

    // --- request: VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT ---
    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await?;
    if req[0] != 5 || req[1] != 1 {
        // Only CONNECT is supported.
        let _ = tcp
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        return Err(AppError::Other("SOCKS5 command not supported".into()));
    }
    let atyp = req[3];
    let (host, port) = match atyp {
        1 => {
            let mut a = [0u8; 4];
            tcp.read_exact(&mut a).await?;
            let mut p = [0u8; 2];
            tcp.read_exact(&mut p).await?;
            (Ipv4Addr::from(a).to_string(), u16::from_be_bytes(p))
        }
        4 => {
            let mut a = [0u8; 16];
            tcp.read_exact(&mut a).await?;
            let mut p = [0u8; 2];
            tcp.read_exact(&mut p).await?;
            (Ipv6Addr::from(a).to_string(), u16::from_be_bytes(p))
        }
        3 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await?;
            let mut d = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut d).await?;
            let mut p = [0u8; 2];
            tcp.read_exact(&mut p).await?;
            (String::from_utf8_lossy(&d).to_string(), u16::from_be_bytes(p))
        }
        _ => return Err(AppError::Other("SOCKS5: bad address type".into())),
    };

    let channel = session
        .handle
        .channel_open_direct_tcpip(&host, port.into(), "127.0.0.1", 0)
        .await?;

    // Success reply (no resolved bind address needed).
    let _ = tcp
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await;

    pump(channel, tcp).await
}
