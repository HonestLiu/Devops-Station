//! Cross-device sync through S3-compatible object storage (MinIO, Tencent COS,
//! Cloudflare R2, AWS S3, …).
//!
//! The unit of sync is the unified profile built by `storage::Store` — we
//! push/pull a single versioned JSON object containing settings, hosts and
//! quick commands. Pulling merges by record id with `updated_at` LWW; pushing
//! overwrites the remote object. Credentials are never synced: the remote
//! profile always carries empty secrets (unless the user explicitly opts in),
//! and the other device's `sync` settings are stripped on import so a pull
//! never hijacks our own sync configuration.
//!
//! Requests are signed with AWS SigV4 (AWS4-HMAC-SHA256) implemented here on
//! top of the project's existing `reqwest`, so we don't pull in a second HTTP
//! stack just for object storage.

use hmac::{Hmac, Mac};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::storage::Store;

type HmacSha256 = Hmac<Sha256>;

/// Object key inside the bucket (optionally prefixed by `cfg.prefix`).
const SYNC_OBJECT_KEY: &str = "profile-v1.json";
/// Marker that identifies a DevOps Station sync object.
const SYNC_FORMAT: &str = "devops-station-sync";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// S3-compatible endpoint, e.g. `https://s3.us-east-1.amazonaws.com`,
    /// `http://127.0.0.1:9000` (MinIO), `cos.ap-guangzhou.myqcloud.com`.
    pub endpoint: String,
    /// Signing region (`us-east-1` works for most non-AWS providers).
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Optional object prefix (folder) inside the bucket; empty = bucket root.
    pub prefix: String,
    /// Path-style URLs (MinIO / R2 / COS usually need this). Virtual-host for AWS.
    pub path_style: bool,
    /// Opt-in: embed plaintext saved passwords in the pushed profile. Object
    /// storage is shared infrastructure — keep this off unless you trust it.
    pub include_secrets: bool,
    /// Stable per-install id, recorded in the envelope for provenance.
    pub device_id: String,
}

impl SyncConfig {
    fn validate(&self) -> AppResult<()> {
        if self.endpoint.trim().is_empty() {
            return Err(AppError::Other("同步：请填写对象存储端点 (Endpoint)".into()));
        }
        if self.bucket.trim().is_empty() {
            return Err(AppError::Other("同步：请填写 Bucket 名称".into()));
        }
        if self.access_key_id.trim().is_empty() || self.secret_access_key.trim().is_empty() {
            return Err(AppError::Other(
                "同步：请填写 Access Key ID 与 Secret Access Key".into(),
            ));
        }
        Ok(())
    }

    fn endpoint(&self) -> String {
        let e = self.endpoint.trim().trim_end_matches('/');
        if e.starts_with("http://") || e.starts_with("https://") {
            e.to_string()
        } else {
            format!("https://{e}")
        }
    }

    fn object_key(&self) -> String {
        let p = self.prefix.trim().trim_matches('/');
        if p.is_empty() {
            SYNC_OBJECT_KEY.to_string()
        } else {
            format!("{p}/{SYNC_OBJECT_KEY}")
        }
    }

    /// Compute the request URL and the `host` value used in SigV4 signing.
    fn request_url(&self) -> AppResult<(Url, String)> {
        let endpoint = self.endpoint();
        let base = Url::parse(&endpoint)
            .map_err(|e| AppError::Other(format!("同步：端点 URL 无效: {e}")))?;
        let host = match base.port() {
            Some(p) => format!("{}:{p}", base.host_str().unwrap_or("")),
            None => base.host_str().unwrap_or("").to_string(),
        };
        let bucket = self.bucket.trim();
        let key = self.object_key();
        let url_str = if self.path_style {
            format!("{endpoint}/{bucket}/{key}")
        } else {
            format!("https://{bucket}.{host}/{key}")
        };
        let url = Url::parse(&url_str)
            .map_err(|e| AppError::Other(format!("同步：请求 URL 无效: {e}")))?;
        let canonical_host = if self.path_style {
            host
        } else {
            format!("{bucket}.{host}")
        };
        Ok((url, canonical_host))
    }
}

// --- SigV4 ------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex(&h.finalize())
}

/// Sign one request with AWS SigV4 and send it.
async fn send_signed(
    cfg: &SyncConfig,
    method: &str,
    url: &Url,
    host: &str,
    body: &[u8],
) -> AppResult<reqwest::Response> {
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = sha256_hex(body);

    let canonical_uri = url.path();
    let canonical_headers = format!(
        "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    let scope = format!("{date_stamp}/{}/s3/aws4_request", cfg.region.trim());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(
        format!("AWS4{}", cfg.secret_access_key.trim()).as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, cfg.region.trim().as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        cfg.access_key_id.trim()
    );

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| AppError::Other(format!("同步：请求方法无效: {e}")))?;
    let client = Client::new();
    let mut req = client
        .request(method, url.clone())
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .header("authorization", &authorization);
    if !body.is_empty() {
        req = req.body(body.to_vec());
    }
    req.send()
        .await
        .map_err(|e| AppError::Other(format!("同步：网络请求失败: {e}")))
}

// --- Commands ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTestResult {
    pub success: bool,
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResult {
    pub pushed_at: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResult {
    pub hosts: usize,
    pub quick_commands: usize,
    pub settings: usize,
    pub remote_device: String,
    pub pulled_at: String,
    pub first_time: bool,
    pub message: String,
}

/// Verify credentials + bucket reachability (HEAD the sync object).
pub async fn sync_test(cfg: SyncConfig) -> AppResult<SyncTestResult> {
    cfg.validate()?;
    let (url, host) = cfg.request_url()?;
    let resp = send_signed(&cfg, "HEAD", &url, &host, &[]).await?;
    let status = resp.status();
    if status.is_success() {
        Ok(SyncTestResult {
            success: true,
            status: status.as_u16(),
            message: "连接成功，对象已存在".into(),
        })
    } else if status == StatusCode::NOT_FOUND {
        Ok(SyncTestResult {
            success: true,
            status: 404,
            message: "连接成功（尚无同步文件，可先推送）".into(),
        })
    } else {
        Ok(SyncTestResult {
            success: false,
            status: status.as_u16(),
            message: format!("连接失败 (HTTP {status})：请检查端点、凭据与桶名"),
        })
    }
}

/// Upload the local profile (secrets stripped unless explicitly opted in).
pub async fn sync_push(cfg: SyncConfig, store: &Store) -> AppResult<SyncPushResult> {
    cfg.validate()?;
    let profile = store.profile_doc(cfg.include_secrets, env!("CARGO_PKG_VERSION"))?;
    let pushed_at = chrono::Utc::now().to_rfc3339();
    let envelope = serde_json::json!({
        "format": SYNC_FORMAT,
        "schemaVersion": 1,
        "deviceId": cfg.device_id,
        "pushedAt": pushed_at,
        "profile": profile,
    });
    let body = serde_json::to_vec_pretty(&envelope)?;

    let (url, host) = cfg.request_url()?;
    let resp = send_signed(&cfg, "PUT", &url, &host, &body).await?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "同步：上传失败 (HTTP {})",
            resp.status().as_u16()
        )));
    }
    Ok(SyncPushResult {
        pushed_at,
        bytes: body.len(),
    })
}

/// Download the remote profile and merge it into the local database.
pub async fn sync_pull(cfg: SyncConfig, store: &Store) -> AppResult<SyncPullResult> {
    cfg.validate()?;
    let (url, host) = cfg.request_url()?;
    let resp = send_signed(&cfg, "GET", &url, &host, &[]).await?;
    match resp.status() {
        StatusCode::NOT_FOUND => Ok(SyncPullResult {
            hosts: 0,
            quick_commands: 0,
            settings: 0,
            remote_device: String::new(),
            pulled_at: String::new(),
            first_time: true,
            message: "远端尚无同步数据（首次请先推送）".into(),
        }),
        s if s.is_success() => {
            let bytes = resp.bytes().await?;
            let doc: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|e| AppError::Other(format!("同步：远端数据解析失败: {e}")))?;
            let format = doc.get("format").and_then(|v| v.as_str()).unwrap_or_default();
            if format != SYNC_FORMAT {
                return Err(AppError::Other(
                    "同步：远端对象不是有效的 DevOps Station 同步文件".into(),
                ));
            }
            let remote_device = doc
                .get("deviceId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let pulled_at = doc
                .get("pushedAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let mut profile = doc
                .get("profile")
                .cloned()
                .ok_or_else(|| AppError::Other("同步：远端数据缺少 profile 字段".into()))?;

            // Never let another device's sync credentials overwrite ours.
            if let Some(settings) = profile
                .get_mut("data")
                .and_then(|d| d.get_mut("settings"))
                .and_then(|s| s.as_object_mut())
            {
                settings.remove("sync");
            }

            let info = store.import_profile_value(profile, "merge")?;
            Ok(SyncPullResult {
                hosts: info.hosts,
                quick_commands: info.quick_commands,
                settings: info.settings,
                remote_device: remote_device.clone(),
                pulled_at,
                first_time: false,
                message: format!("拉取成功（来源设备 {remote_device}）"),
            })
        }
        other => Err(AppError::Other(format!("同步：拉取失败 (HTTP {other})"))),
    }
}
