//! Frp (fast reverse proxy) support.
//!
//! Frp is exposed to the user as just another terminal tab: we generate an
//! `frpc.toml` from a saved config, locate the `frpc` binary, and launch it on
//! the same ConPTY plumbing as a local shell. Its log output streams into the
//! terminal, and `pty_write` / `pty_resize` / `pty_close` / `pty_attach` all
//! apply — so closing the tab kills the tunnel, Ctrl-C stops it, etc.
//!
//! The `frpc` binary ships inside the app's resource directory (see
//! `locate_frpc`); if it isn't bundled we fall back to a copy next to the
//! executable or on `PATH`, and otherwise fail loudly with a clear message.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// Config model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FrpProxyType {
    Tcp,
    Udp,
    Http,
    Https,
    TcpMux,
    Stcp,
    Xtcp,
}

impl FrpProxyType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FrpProxyType::Tcp => "tcp",
            FrpProxyType::Udp => "udp",
            FrpProxyType::Http => "http",
            FrpProxyType::Https => "https",
            FrpProxyType::TcpMux => "tcpmux",
            FrpProxyType::Stcp => "stcp",
            FrpProxyType::Xtcp => "xtcp",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrpServer {
    pub server_addr: String,
    pub server_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_enable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns_server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_interval: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_timeout: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_fail_exit: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_to_file: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_custom_tls: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sni_server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_trusted_ca_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrpProxy {
    pub name: String,
    #[serde(rename = "type")]
    pub proxy_type: FrpProxyType,
    #[serde(default = "default_local_ip")]
    pub local_ip: String,
    pub local_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_domain: Option<String>,
    /// Comma-separated list for HTTP/HTTPS virtual hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_domains: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdomain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locations: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_encryption: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_compression: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bandwidth_limit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check_interval_s: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check_max_failed: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_check_timeout_s: Option<u32>,
    /// Escape hatch for any field not modelled above; flattened into the
    /// proxy section as-is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FrpConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<FrpServer>,
    #[serde(default)]
    pub proxies: Vec<FrpProxy>,
}

fn default_local_ip() -> String {
    "127.0.0.1".to_string()
}

// ---------------------------------------------------------------------------
// TOML generation
// ---------------------------------------------------------------------------

fn q(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
    )
}

/// Render an [`FrpConfig`] to `frpc.toml` text (current frp TOML schema:
/// `[common]` for the server block and `[proxies.<name>]` per proxy).
pub fn build_toml(cfg: &FrpConfig) -> String {
    let mut out = String::new();

    if let Some(s) = &cfg.server {
        out.push_str("[common]\n");
        out.push_str(&format!("server_addr = {}\n", q(&s.server_addr)));
        out.push_str(&format!("server_port = {}\n", s.server_port));
        if let Some(v) = &s.token {
            out.push_str(&format!("token = {}\n", q(v)));
        }
        if let Some(v) = &s.user {
            out.push_str(&format!("user = {}\n", q(v)));
        }
        if let Some(v) = s.tls_enable {
            out.push_str(&format!("tls_enable = {v}\n"));
        }
        if let Some(v) = &s.protocol {
            out.push_str(&format!("protocol = {}\n", q(v)));
        }
        if let Some(v) = &s.proxy_url {
            out.push_str(&format!("proxy_url = {}\n", q(v)));
        }
        if let Some(v) = &s.dns_server {
            out.push_str(&format!("dns_server = {}\n", q(v)));
        }
        if let Some(v) = s.heartbeat_interval {
            out.push_str(&format!("heartbeat_interval = {v}\n"));
        }
        if let Some(v) = s.heartbeat_timeout {
            out.push_str(&format!("heartbeat_timeout = {v}\n"));
        }
        if let Some(v) = s.login_fail_exit {
            out.push_str(&format!("login_fail_exit = {v}\n"));
        }
        if let Some(v) = &s.log_level {
            out.push_str(&format!("log_level = {}\n", q(v)));
        }
        if let Some(v) = s.log_to_file {
            out.push_str(&format!("log_to_file = {v}\n"));
        }
        if let Some(v) = s.disable_custom_tls {
            out.push_str(&format!("disable_custom_tls = {v}\n"));
        }
        if let Some(v) = &s.sni_server_name {
            out.push_str(&format!("sni_server_name = {}\n", q(v)));
        }
        if let Some(v) = &s.tls_trusted_ca_file {
            out.push_str(&format!("tls_trusted_ca_file = {}\n", q(v)));
        }
    }

    for p in &cfg.proxies {
        out.push_str(&format!("\n[proxies.{}]\n", p.name));
        out.push_str(&format!("type = {}\n", p.proxy_type.as_str()));
        out.push_str(&format!("localIP = {}\n", q(&p.local_ip)));
        out.push_str(&format!("localPort = {}\n", p.local_port));
        if let Some(rp) = p.remote_port {
            out.push_str(&format!("remotePort = {rp}\n"));
        }
        if let Some(cd) = &p.custom_domain {
            out.push_str(&format!("customDomain = {}\n", q(cd)));
        }
        if let Some(cds) = &p.custom_domains {
            let list = cds
                .split(',')
                .map(|s| q(s.trim()))
                .filter(|s| s.len() > 2) // non-empty quoted string
                .collect::<Vec<_>>()
                .join(", ");
            if !list.is_empty() {
                out.push_str(&format!("customDomains = [{list}]\n"));
            }
        }
        if let Some(sd) = &p.subdomain {
            out.push_str(&format!("subdomain = {}\n", q(sd)));
        }
        if let Some(loc) = &p.locations {
            out.push_str(&format!("locations = {}\n", q(loc)));
        }
        if let Some(v) = p.use_encryption {
            out.push_str(&format!("useEncryption = {v}\n"));
        }
        if let Some(v) = p.use_compression {
            out.push_str(&format!("useCompression = {v}\n"));
        }
        if let Some(v) = &p.proxy_protocol_version {
            out.push_str(&format!("proxyProtocolVersion = {}\n", q(v)));
        }
        if let Some(v) = &p.bandwidth_limit {
            out.push_str(&format!("bandwidthLimit = {}\n", q(v)));
        }
        if let Some(v) = &p.group {
            out.push_str(&format!("group = {}\n", q(v)));
        }
        if let Some(v) = &p.group_key {
            out.push_str(&format!("groupKey = {}\n", q(v)));
        }
        if let Some(v) = &p.health_check_type {
            out.push_str(&format!("healthCheck.type = {}\n", q(v)));
        }
        if let Some(v) = &p.health_check_url {
            out.push_str(&format!("healthCheck.url = {}\n", q(v)));
        }
        if let Some(v) = p.health_check_interval_s {
            out.push_str(&format!("healthCheck.intervalSec = {v}\n"));
        }
        if let Some(v) = p.health_check_max_failed {
            out.push_str(&format!("healthCheck.maxFailed = {v}\n"));
        }
        if let Some(v) = p.health_check_timeout_s {
            out.push_str(&format!("healthCheck.timeoutSec = {v}\n"));
        }
        if let Some(extra) = &p.extra {
            for (k, v) in extra {
                out.push_str(&format!("{k} = {}\n", q(v)));
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// Binary location + temp config
// ---------------------------------------------------------------------------

/// Find the `frpc` binary, preferring the bundled copy in the app resources.
///
/// Order: resource dir → next to the executable → `PATH`. If none is found we
/// return an error telling the user exactly where to drop the binary.
pub fn locate_frpc(app: &AppHandle) -> AppResult<PathBuf> {
    // 1) Bundled inside the app resources (the "App 内置打包" path).
    if let Ok(res) = app.path().resource_dir() {
        let bundled = if cfg!(windows) {
            res.join("frpc.exe")
        } else {
            res.join("frpc")
        };
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    // 2) Next to the running executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let next = if cfg!(windows) {
                dir.join("frpc.exe")
            } else {
                dir.join("frpc")
            };
            if next.is_file() {
                return Ok(next);
            }
        }
    }
    // 3) On PATH.
    let name = if cfg!(windows) { "frpc.exe" } else { "frpc" };
    if let Some(found) = which_on_path(name) {
        return Ok(found);
    }
    // 4) Give up with a helpful message.
    Err(AppError::Other(
        "frpc binary not found. Place frpc(.exe) in the app's resource folder, next to the \
         executable, or on your PATH. See the Frp docs for bundling instructions."
            .into(),
    ))
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let candidate = dir.join(name);
            candidate.is_file().then_some(candidate)
        })
    })
}

/// Serialize `cfg` to a temp `frpc.toml` and return its path.
pub fn write_config_file(cfg: &FrpConfig) -> AppResult<PathBuf> {
    let path = std::env::temp_dir().join(format!(
        "devops-station-frpc-{}.toml",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&path, build_toml(cfg))
        .map_err(|e| AppError::Other(format!("cannot write frpc config: {e}")))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_server_and_tcp_proxy() {
        let cfg = FrpConfig {
            server: Some(FrpServer {
                server_addr: "frp.example.com".into(),
                server_port: 7000,
                token: Some("secret".into()),
                user: None,
                tls_enable: Some(true),
                protocol: None,
                proxy_url: None,
                dns_server: None,
                heartbeat_interval: None,
                heartbeat_timeout: None,
                login_fail_exit: None,
                log_level: None,
                log_to_file: None,
                disable_custom_tls: None,
                sni_server_name: None,
                tls_trusted_ca_file: None,
            }),
            proxies: vec![FrpProxy {
                name: "ssh".into(),
                proxy_type: FrpProxyType::Tcp,
                local_ip: "127.0.0.1".into(),
                local_port: 22,
                remote_port: Some(6022),
                custom_domain: None,
                custom_domains: None,
                subdomain: None,
                locations: None,
                use_encryption: Some(true),
                use_compression: None,
                proxy_protocol_version: None,
                bandwidth_limit: None,
                group: None,
                group_key: None,
                health_check_type: None,
                health_check_url: None,
                health_check_interval_s: None,
                health_check_max_failed: None,
                health_check_timeout_s: None,
                extra: None,
            }],
        };
        let toml = build_toml(&cfg);
        assert!(toml.contains("[common]"));
        assert!(toml.contains("server_addr = \"frp.example.com\""));
        assert!(toml.contains("server_port = 7000"));
        assert!(toml.contains("token = \"secret\""));
        assert!(toml.contains("[proxies.ssh]"));
        assert!(toml.contains("type = tcp"));
        assert!(toml.contains("localPort = 22"));
        assert!(toml.contains("remotePort = 6022"));
        assert!(toml.contains("useEncryption = true"));
    }

    #[test]
    fn renders_http_custom_domains() {
        let cfg = FrpConfig {
            server: None,
            proxies: vec![FrpProxy {
                name: "web".into(),
                proxy_type: FrpProxyType::Http,
                local_ip: "127.0.0.1".into(),
                local_port: 8080,
                remote_port: None,
                custom_domain: None,
                custom_domains: Some("a.example.com, b.example.com".into()),
                subdomain: None,
                locations: None,
                use_encryption: None,
                use_compression: None,
                proxy_protocol_version: None,
                bandwidth_limit: None,
                group: None,
                group_key: None,
                health_check_type: None,
                health_check_url: None,
                health_check_interval_s: None,
                health_check_max_failed: None,
                health_check_timeout_s: None,
                extra: None,
            }],
        };
        let toml = build_toml(&cfg);
        assert!(toml.contains("type = http"));
        assert!(toml.contains("customDomains = [\"a.example.com\", \"b.example.com\"]"));
    }
}
