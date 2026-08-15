//! MQTT client management (ported MQTTX-style functionality).
//!
//! Each live connection is a `rumqttc::AsyncClient` plus a background task that
//! drives the `EventLoop` and streams incoming/outgoing packets to the frontend
//! as Tauri events: `mqtt-message-<id>` and `mqtt-status-<id>`. The task owns
//! the `EventLoop`; the `AsyncClient` (cheaply cloneable, Arc-backed) is kept in
//! the manager so publish/subscribe work from any async context.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use rumqttc::{
    AsyncClient, ClientError, ConnectReturnCode, Event, MqttOptions, Packet, QoS,
    TlsConfiguration, Transport,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::storage::Store;
use crate::types::{MqttConnectConfig, MqttMessage, MqttStatus};

/// Per-connection state kept in the manager.
struct MqttEntry {
    client: AsyncClient,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct MqttManager {
    clients: Mutex<HashMap<String, MqttEntry>>,
}

fn message_event(id: &str) -> String {
    format!("mqtt-message-{id}")
}
fn status_event(id: &str) -> String {
    format!("mqtt-status-{id}")
}

fn qos_from_u8(q: u8) -> QoS {
    match q {
        2 => QoS::ExactlyOnce,
        1 => QoS::AtLeastOnce,
        _ => QoS::AtMostOnce,
    }
}

fn qos_to_u8(q: QoS) -> u8 {
    match q {
        QoS::AtMostOnce => 0,
        QoS::AtLeastOnce => 1,
        QoS::ExactlyOnce => 2,
    }
}

/// A certificate verifier used when the user opts to skip TLS verification
/// (self-signed brokers, e.g. EMQX local dev). It delegates the
/// handshake-signature checks to the built-in WebPKI verifier (so we never
/// accept a server that can't prove possession of the presented key) but skips
/// the chain-of-trust / hostname binding check in `verify_server_cert`.
#[derive(Debug)]
struct AcceptAllVerifier {
    inner: Arc<WebPkiServerVerifier>,
}

impl ServerCertVerifier for AcceptAllVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Build the TLS configuration. With `insecure_skip_verify` we accept any cert /
/// hostname (self-signed brokers); otherwise the OS trust store is used.
fn tls_configuration(insecure: bool) -> AppResult<TlsConfiguration> {
    if insecure {
        let roots = RootCertStore::empty();
        let inner = WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|e| AppError::Mqtt(format!("TLS init failed: {e}")))?;
        let config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAllVerifier { inner }))
            .with_no_client_auth();
        Ok(TlsConfiguration::Rustls(Arc::new(config)))
    } else {
        Ok(TlsConfiguration::default())
    }
}

fn build_transport(cfg: &MqttConnectConfig) -> AppResult<Transport> {
    let tls = tls_configuration(cfg.insecure_skip_verify)?;
    Ok(match cfg.protocol.as_str() {
        "mqtts" => Transport::Tls(tls),
        "wss" => Transport::Wss(tls),
        "ws" => Transport::Ws,
        _ => Transport::Tcp,
    })
}

/// Build the `MqttOptions` for a connection.
///
/// rumqttc stores the `MqttOptions::new` *host* argument verbatim as
/// `broker_addr`. For the WebSocket transports (`ws`/`wss`) rumqttc parses that
/// field as a **full URL** (`scheme://host:port/path`); passing a bare host makes
/// `split_url` fail with `InvalidUrl(Host)` and the event loop then loops forever
/// ("reconnecting"). So for ws/wss we pass the full URL as the `host` argument.
/// EMQX (and most public brokers) serve MQTT over WS at `/mqtt`, which we use as
/// the default path when the user leaves it blank.
fn build_mqtt_options(cfg: &MqttConnectConfig, client_id: &str) -> AppResult<MqttOptions> {
    let (host_arg, port) = if cfg.protocol == "ws" || cfg.protocol == "wss" {
        let path = if cfg.path.is_empty() { "/mqtt" } else { cfg.path.as_str() };
        let scheme = if cfg.protocol == "wss" { "wss" } else { "ws" };
        (
            format!("{scheme}://{}:{}{}", cfg.host, cfg.port, path),
            cfg.port,
        )
    } else {
        (cfg.host.clone(), cfg.port)
    };
    let mut opts = MqttOptions::new(client_id, host_arg, port);
    opts.set_transport(build_transport(cfg)?);
    Ok(opts)
}

fn emit_message(
    app: &AppHandle,
    id: &str,
    topic: &str,
    payload: Vec<u8>,
    qos: u8,
    retain: bool,
    direction: &str,
) {
    let msg = MqttMessage {
        id: id.to_string(),
        topic: topic.to_string(),
        payload_base64: B64.encode(&payload),
        qos,
        retain,
        direction: direction.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
    };
    let _ = app.emit(&message_event(id), msg);
}

impl MqttManager {
    fn get(&self, id: &str) -> AppResult<AsyncClient> {
        self.clients
            .lock()
            .get(id)
            .map(|e| e.client.clone())
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    /// Connect to a broker and start streaming events. Returns the backend
    /// session id used as the event-suffix (distinct from the MQTT client id).
    pub fn connect(
        &self,
        app: AppHandle,
        store: &Store,
        mut cfg: MqttConnectConfig,
    ) -> AppResult<String> {
        // Resolve a sealed password for saved connections.
        if cfg.password.as_deref() == Some("__saved__") {
            if let Some(host_id) = &cfg.host_id {
                cfg.password = store.reveal_mqtt_secret(host_id)?;
            }
        }

        let session_id = uuid::Uuid::new_v4().to_string();
        let client_id = if cfg.client_id.trim().is_empty() {
            format!("devops-station-{}", &session_id[..8])
        } else {
            cfg.client_id.trim().to_string()
        };

        let mut opts = build_mqtt_options(&cfg, &client_id)?;
        opts.set_keep_alive(Duration::from_secs(cfg.keep_alive.max(1) as u64));
        opts.set_clean_session(cfg.clean);
        match (cfg.username.clone(), cfg.password.clone()) {
            (Some(u), Some(p)) => {
                opts.set_credentials(u, p);
            }
            (Some(u), None) => {
                opts.set_credentials(u, "");
            }
            _ => {}
        }

        let (client, mut eventloop) = AsyncClient::new(opts, 10);
        let _ = app.emit(
            &status_event(&session_id),
            MqttStatus {
                id: session_id.clone(),
                status: "connecting".to_string(),
                detail: None,
            },
        );

        let app2 = app.clone();
        let sid = session_id.clone();
        let handle = tokio::spawn(async move {
            loop {
                match eventloop.poll().await {
                    Ok(Event::Incoming(Packet::ConnAck(ca))) => {
                        let ok = ca.code == ConnectReturnCode::Success;
                        let _ = app2.emit(
                            &status_event(&sid),
                            MqttStatus {
                                id: sid.clone(),
                                status: if ok { "connected" } else { "error" }.to_string(),
                                detail: if ok {
                                    None
                                } else {
                                    Some(format!("CONNACK: {:?}", ca.code))
                                },
                            },
                        );
                    }
                    Ok(Event::Incoming(Packet::Publish(p))) => {
                        emit_message(
                            &app2,
                            &sid,
                            &p.topic,
                            p.payload.to_vec(),
                            qos_to_u8(p.qos),
                            p.retain,
                            "in",
                        );
                    }
                    // Outgoing events only carry the packet-id (u16) in rumqttc,
                    // not the payload — outgoing messages are emitted directly
                    // from `publish` where the full payload is available.
                    Ok(Event::Outgoing(_)) => {}
                    Ok(_) => {}
                    Err(e) => {
                        let _ = app2.emit(
                            &status_event(&sid),
                            MqttStatus {
                                id: sid.clone(),
                                status: "reconnecting".to_string(),
                                detail: Some(e.to_string()),
                            },
                        );
                        // Backoff before the next reconnect attempt.
                        tokio::time::sleep(Duration::from_millis(800)).await;
                    }
                }
            }
        });

        self.clients.lock().insert(
            session_id.clone(),
            MqttEntry { client, handle },
        );
        Ok(session_id)
    }

    /// Tear down a connection: abort the event loop and drop the client.
    pub fn disconnect(&self, id: &str) -> AppResult<()> {
        if let Some(entry) = self.clients.lock().remove(id) {
            entry.handle.abort();
        }
        Ok(())
    }

    pub async fn publish(
        &self,
        app: &AppHandle,
        id: &str,
        topic: &str,
        payload: &[u8],
        qos: u8,
        retain: bool,
    ) -> AppResult<()> {
        self.get(id)?
            .publish(
                topic.to_string(),
                qos_from_u8(qos),
                retain,
                payload.to_vec(),
            )
            .await
            .map_err(|e: ClientError| AppError::Mqtt(e.to_string()))?;
        // Echo the outgoing message to the UI (the event loop can't see it).
        emit_message(app, id, topic, payload.to_vec(), qos, retain, "out");
        Ok(())
    }

    pub async fn subscribe(&self, id: &str, topic: &str, qos: u8) -> AppResult<()> {
        self.get(id)?
            .subscribe(topic.to_string(), qos_from_u8(qos))
            .await
            .map_err(|e: ClientError| AppError::Mqtt(e.to_string()))
    }

    pub async fn unsubscribe(&self, id: &str, topic: &str) -> AppResult<()> {
        self.get(id)?
            .unsubscribe(topic.to_string())
            .await
            .map_err(|e: ClientError| AppError::Mqtt(e.to_string()))
    }
}

/// Tear every live MQTT session down (window close).
impl MqttManager {
    pub fn close_all(&self) {
        for (_, entry) in self.clients.lock().drain() {
            entry.handle.abort();
        }
    }
}
