//! At-rest encryption for stored credentials.
//!
//! ## Threat model (be honest about this)
//!
//! Secrets are sealed with XChaCha20-Poly1305 using a 32-byte key kept in
//! `secret.key` next to the database, created with 0600 permissions on Unix.
//!
//! This protects against: database file leaking through a backup, sync folder,
//! screenshot, or someone poking at `hosts.db` with a SQLite browser.
//!
//! This does NOT protect against: an attacker who already has read access to
//! the user's home directory as that user — they can read the key too.
//!
//! For real OS-keychain-backed storage the upgrade path is
//! `tauri-plugin-stronghold`; the API here (`seal` / `open`) is intentionally
//! shaped so it can be swapped without touching call sites.

use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};

use crate::error::{AppError, AppResult};

const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
/// Marker so we can tell sealed values apart from legacy plaintext.
const PREFIX: &str = "v1:";

pub struct Vault {
    cipher: XChaCha20Poly1305,
}

impl Vault {
    pub fn open_or_create(dir: &Path) -> AppResult<Self> {
        let key_path: PathBuf = dir.join("secret.key");
        let key = if key_path.exists() {
            let raw = fs::read(&key_path)?;
            if raw.len() != KEY_LEN {
                return Err(AppError::Storage(format!(
                    "secret.key is corrupted ({} bytes, expected {KEY_LEN})",
                    raw.len()
                )));
            }
            raw
        } else {
            let mut key = vec![0u8; KEY_LEN];
            getrandom::getrandom(&mut key)
                .map_err(|e| AppError::Storage(format!("failed to generate key: {e}")))?;
            fs::write(&key_path, &key)?;
            restrict_permissions(&key_path);
            key
        };

        let cipher = XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|e| AppError::Storage(format!("invalid key: {e}")))?;
        Ok(Self { cipher })
    }

    /// Encrypt a secret for storage. Returns `v1:<base64(nonce||ciphertext)>`.
    pub fn seal(&self, plaintext: &str) -> AppResult<String> {
        if plaintext.is_empty() {
            return Ok(String::new());
        }
        let mut nonce_bytes = [0u8; NONCE_LEN];
        getrandom::getrandom(&mut nonce_bytes)
            .map_err(|e| AppError::Storage(format!("nonce generation failed: {e}")))?;
        let nonce = XNonce::from(nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|_| AppError::Storage("encryption failed".into()))?;

        let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        Ok(format!("{PREFIX}{}", B64.encode(blob)))
    }

    /// Decrypt a stored secret. Values without the `v1:` prefix are returned
    /// untouched so pre-encryption rows keep working.
    pub fn open(&self, stored: &str) -> AppResult<String> {
        if stored.is_empty() {
            return Ok(String::new());
        }
        let Some(encoded) = stored.strip_prefix(PREFIX) else {
            return Ok(stored.to_string());
        };
        let blob = B64
            .decode(encoded)
            .map_err(|e| AppError::Storage(format!("bad ciphertext: {e}")))?;
        if blob.len() <= NONCE_LEN {
            return Err(AppError::Storage("ciphertext truncated".into()));
        }
        let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
        let nonce: [u8; NONCE_LEN] = nonce_bytes
            .try_into()
            .map_err(|_| AppError::Storage("bad nonce length".into()))?;
        let plaintext = self
            .cipher
            .decrypt(&XNonce::from(nonce), ciphertext)
            .map_err(|_| AppError::Storage("decryption failed — wrong or rotated key".into()))?;
        String::from_utf8(plaintext).map_err(|e| AppError::Storage(e.to_string()))
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {
    // On Windows the file inherits the user profile ACL, which is already
    // restricted to the current user.
}
