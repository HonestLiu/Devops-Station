pub mod metrics;
pub mod sftp;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::{self, Handle};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock};

use crate::error::{AppError, AppResult};
use crate::stream::{Attached, OutputBuffer};
use crate::types::{SessionClosed, SshConnectConfig, SshConnectResult, StreamChunk};

/// Event name helpers — Tauri event names must stay in `[A-Za-z0-9_/-]`.
pub fn data_event(session_id: &str) -> String {
    format!("ssh-data-{session_id}")
}
pub fn closed_event(session_id: &str) -> String {
    format!("ssh-closed-{session_id}")
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Trust-on-first-use handler.
///
/// NOTE: `check_server_key` currently accepts every host key and simply records
/// the fingerprint so the UI can show it. A real known_hosts check belongs here
/// (`russh::keys::check_known_hosts`) — tracked as a follow-up, because it needs
/// UI for the "unknown host, accept?" prompt.
pub(crate) struct ClientHandler {
    fingerprint: Arc<parking_lot::Mutex<String>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        *self.fingerprint.lock() = server_public_key
            .fingerprint(HashAlg::Sha256)
            .to_string();
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

pub struct SshSession {
    pub id: String,
    pub handle: Arc<Handle<ClientHandler>>,
    /// Write side of the interactive PTY channel.
    pty_write: Mutex<Option<ChannelWriteHalf<client::Msg>>>,
    /// Lazily-opened SFTP subsystem on its own channel.
    sftp: Mutex<Option<Arc<SftpSession>>>,
    /// Used as the fallback hostname when the remote probe can't read one.
    pub hostname: String,
    /// Holds the MOTD and first prompt until the terminal is listening.
    output: Arc<OutputBuffer>,
}

impl SshSession {
    /// Hand the UI everything the remote shell sent before it could listen.
    ///
    /// This is not an optimisation — without it the MOTD and the first prompt
    /// are guaranteed to be lost, because `connect()` still has to open the
    /// SFTP subsystem (another round-trip or two) before the UI even learns
    /// the session id.
    pub fn attach(&self) -> Attached {
        self.output.attach()
    }

    pub async fn write(&self, bytes: &[u8]) -> AppResult<()> {
        let guard = self.pty_write.lock().await;
        let w = guard
            .as_ref()
            .ok_or_else(|| AppError::SessionNotFound(self.id.clone()))?;
        w.data_bytes(bytes.to_vec()).await?;
        Ok(())
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        let guard = self.pty_write.lock().await;
        if let Some(w) = guard.as_ref() {
            w.window_change(cols, rows, 0, 0).await?;
        }
        Ok(())
    }

    /// Run a one-shot command on a fresh channel and collect stdout.
    pub async fn exec(&self, command: &str) -> AppResult<String> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut out = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => out.extend_from_slice(data),
                // stderr is intentionally ignored: the monitoring probes below
                // tolerate missing tools and we don't want warnings in the data.
                ChannelMsg::ExtendedData { .. } => {}
                ChannelMsg::Eof | ChannelMsg::Close => break,
                ChannelMsg::ExitStatus { .. } => {}
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&out).to_string())
    }

    /// Get (opening if needed) the SFTP subsystem for this session.
    pub async fn sftp(&self) -> AppResult<Arc<SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = SftpSession::new(channel.into_stream()).await?;
        let session = Arc::new(session);
        *guard = Some(session.clone());
        Ok(session)
    }

    pub async fn close(&self) -> AppResult<()> {
        if let Some(w) = self.pty_write.lock().await.take() {
            let _ = w.eof().await;
            let _ = w.close().await;
        }
        if let Some(sftp) = self.sftp.lock().await.take() {
            let _ = sftp.close().await;
        }
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "bye", "en")
            .await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct SshManager {
    sessions: RwLock<HashMap<String, Arc<SshSession>>>,
}

impl SshManager {
    pub async fn get(&self, id: &str) -> AppResult<Arc<SshSession>> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    pub async fn ids(&self) -> Vec<String> {
        self.sessions.read().await.keys().cloned().collect()
    }

    pub async fn disconnect(&self, id: &str) -> AppResult<()> {
        let session = self.sessions.write().await.remove(id);
        if let Some(s) = session {
            s.close().await?;
        }
        Ok(())
    }

    pub async fn disconnect_all(&self) {
        let sessions: Vec<_> = self.sessions.write().await.drain().map(|(_, s)| s).collect();
        for s in sessions {
            let _ = s.close().await;
        }
    }

    pub async fn connect(
        &self,
        app: AppHandle,
        cfg: SshConnectConfig,
    ) -> AppResult<SshConnectResult> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let fingerprint = Arc::new(parking_lot::Mutex::new(String::new()));

        let config = Arc::new(client::Config {
            // Interactive sessions must not be garbage-collected while idle.
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            // Terminals are latency-sensitive; Nagle would batch keystrokes.
            nodelay: true,
            ..Default::default()
        });

        let handler = ClientHandler {
            fingerprint: fingerprint.clone(),
        };

        let addr = (cfg.hostname.as_str(), cfg.port);
        let mut handle = client::connect(config, addr, handler)
            .await
            .map_err(|e| AppError::Ssh(format!("cannot reach {}:{} — {e}", cfg.hostname, cfg.port)))?;

        authenticate(&mut handle, &cfg).await?;

        // --- interactive PTY channel ---
        let channel = handle.channel_open_session().await?;
        channel
            .request_pty(false, &cfg.term, cfg.cols, cfg.rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;
        let (mut read_half, write_half) = channel.split();

        let handle = Arc::new(handle);
        let output = Arc::new(OutputBuffer::new());
        let session = Arc::new(SshSession {
            id: session_id.clone(),
            handle: handle.clone(),
            pty_write: Mutex::new(Some(write_half)),
            sftp: Mutex::new(None),
            hostname: cfg.hostname.clone(),
            output: output.clone(),
        });

        self.sessions
            .write()
            .await
            .insert(session_id.clone(), session.clone());

        // --- pump PTY output to the frontend ---
        let sid = session_id.clone();
        let app_for_task = app.clone();
        tauri::async_runtime::spawn(async move {
            let data_evt = data_event(&sid);
            let mut exit_code = None;
            let mut reason = "closed by remote".to_string();

            while let Some(msg) = read_half.wait().await {
                match msg {
                    ChannelMsg::Data { ref data } | ChannelMsg::ExtendedData { ref data, .. } => {
                        if output.accept(data) {
                            let _ = app_for_task.emit(
                                &data_evt,
                                StreamChunk {
                                    session_id: sid.clone(),
                                    data: B64.encode(data),
                                },
                            );
                            crate::perm::scan_and_emit(&app_for_task, &sid, data.as_ref());
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status);
                        reason = format!("shell exited with code {exit_status}");
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }

            let closed = SessionClosed {
                session_id: sid.clone(),
                reason,
                exit_code,
            };
            if output.accept_closed(&closed) {
                let _ = app_for_task.emit(&closed_event(&sid), closed);
            }
        });

        // Best-effort: resolve the remote home directory for the SFTP sidebar.
        let home_dir = match session.sftp().await {
            Ok(sftp) => sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into()),
            Err(_) => "/".to_string(),
        };

        let fp = fingerprint.lock().clone();
        Ok(SshConnectResult {
            session_id,
            server_key_fingerprint: fp,
            home_dir,
        })
    }
}

async fn authenticate(handle: &mut Handle<ClientHandler>, cfg: &SshConnectConfig) -> AppResult<()> {
    // 1. Private key, if one was supplied.
    if let Some(key_path) = cfg.private_key_path.as_deref().filter(|p| !p.is_empty()) {
        let key = load_secret_key(key_path, cfg.passphrase.as_deref())
            .map_err(|e| AppError::Ssh(format!("cannot load private key `{key_path}`: {e}")))?;
        let rsa_hash = handle.best_supported_rsa_hash().await?.flatten();
        let result = handle
            .authenticate_publickey(
                cfg.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash),
            )
            .await?;
        if result.success() {
            return Ok(());
        }
        // Fall through to password auth if a password was also supplied.
        if cfg.password.as_deref().unwrap_or("").is_empty() {
            return Err(AppError::AuthFailed(cfg.username.clone()));
        }
    }

    // 2. Password.
    if let Some(password) = cfg.password.as_deref().filter(|p| !p.is_empty()) {
        let result = handle
            .authenticate_password(cfg.username.clone(), password)
            .await?;
        if result.success() {
            return Ok(());
        }
        return Err(AppError::AuthFailed(cfg.username.clone()));
    }

    // 3. Last resort: `none` auth (some appliances and jump boxes allow it).
    let result = handle.authenticate_none(cfg.username.clone()).await?;
    if result.success() {
        return Ok(());
    }
    Err(AppError::AuthFailed(cfg.username.clone()))
}
