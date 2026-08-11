pub mod crypto;

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::types::{Host, HostKind, QuickCommand};
use crypto::Vault;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosts (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    kind              TEXT NOT NULL,
    hostname          TEXT,
    port              INTEGER,
    username          TEXT,
    password          TEXT,
    private_key_path  TEXT,
    passphrase        TEXT,
    save_password     INTEGER NOT NULL DEFAULT 0,
    serial_port       TEXT,
    baud_rate         INTEGER,
    data_bits         INTEGER,
    stop_bits         INTEGER,
    parity            TEXT,
    flow_control      TEXT,
    wsl_distro        TEXT,
    wsl_user          TEXT,
    wsl_cwd           TEXT,
    frp_config        TEXT,
    color             TEXT,
    tags              TEXT NOT NULL DEFAULT '[]',
    last_used         INTEGER,
    created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_commands (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    value       TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'both',
    is_hex      INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosts_last_used ON hosts(last_used DESC);
"#;

/// Columns added after the first release.
///
/// `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so new
/// columns have to be bolted on separately or upgrades break with "no such
/// column". Each statement is applied on its own and a duplicate-column error
/// is treated as "already migrated", which makes this safe to re-run forever.
const MIGRATIONS: &[&str] = &[
    "ALTER TABLE hosts ADD COLUMN wsl_distro TEXT",
    "ALTER TABLE hosts ADD COLUMN wsl_user TEXT",
    "ALTER TABLE hosts ADD COLUMN wsl_cwd TEXT",
    "ALTER TABLE hosts ADD COLUMN frp_config TEXT",
    "ALTER TABLE hosts ADD COLUMN updated_at INTEGER",
    "ALTER TABLE quick_commands ADD COLUMN updated_at INTEGER",
];

/// Apply [`MIGRATIONS`], ignoring the ones already present.
///
/// SQLite has no `ADD COLUMN IF NOT EXISTS`, so the only portable way to make
/// this idempotent is to run it and swallow the duplicate-column error.
fn migrate(conn: &Connection) -> AppResult<()> {
    for stmt in MIGRATIONS {
        match conn.execute(stmt, []) {
            Ok(_) => {}
            Err(e) if e.to_string().contains("duplicate column name") => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Unified profile (export / import, and the foundation for future sync)
// ---------------------------------------------------------------------------

/// Marker that identifies a DevOps Station data file.
const PROFILE_FORMAT: &str = "devops-station-profile";
/// Bump when the JSON shape changes. Import rejects files with a *newer*
/// schemaVersion (they need a newer app); older files keep working.
const PROFILE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileExportInfo {
    pub path: String,
    pub hosts: usize,
    pub quick_commands: usize,
    pub settings: usize,
    pub include_secrets: bool,
    pub exported_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImportInfo {
    pub hosts: usize,
    pub quick_commands: usize,
    pub settings: usize,
    pub mode: String,
}

pub struct Store {
    conn: Mutex<Connection>,
    vault: Vault,
}

impl Store {
    pub fn new(data_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let conn = Connection::open(data_dir.join("station.db"))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        let vault = Vault::open_or_create(data_dir)?;
        let store = Self {
            conn: Mutex::new(conn),
            vault,
        };
        store.seed_defaults()?;
        Ok(store)
    }

    fn seed_defaults(&self) -> AppResult<()> {
        let conn = self.conn.lock();
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM quick_commands", [], |r| r.get(0))?;
        if count == 0 {
            let defaults: [(&str, &str, &str); 6] = [
                ("AT", "AT\\r\\n", "serial"),
                ("AT+RST", "AT+RST\\r\\n", "serial"),
                ("Reset", "\\x03", "serial"),
                ("uptime", "uptime\\n", "ssh"),
                ("df -h", "df -h\\n", "ssh"),
                ("htop", "htop\\n", "ssh"),
            ];
            for (i, (name, value, scope)) in defaults.iter().enumerate() {
                conn.execute(
                    "INSERT INTO quick_commands (id, name, value, scope, is_hex, sort_order)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                    params![Uuid::new_v4().to_string(), name, value, scope, i as i64],
                )?;
            }
        }
        Ok(())
    }

    // -- Hosts --------------------------------------------------------------

    /// Read all hosts. `mask_secrets` swaps stored credentials for the
    /// `__saved__` sentinel (what the UI sees); pass `false` to get raw rows
    /// (used by the profile exporter, which reveals secrets explicitly).
    fn query_hosts(&self, mask_secrets: bool) -> AppResult<Vec<Host>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, hostname, port, username, password, private_key_path,
                    passphrase, save_password, serial_port, baud_rate, data_bits, stop_bits,
                    parity, flow_control, color, tags, last_used, created_at,
                    wsl_distro, wsl_user, wsl_cwd, frp_config, updated_at
             FROM hosts
             ORDER BY COALESCE(last_used, 0) DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let tags_json: String = row.get(17)?;
            let password_raw: Option<String> = row.get(6)?;
            let passphrase_raw: Option<String> = row.get(8)?;
            let password = if mask_secrets {
                password_raw
                    .filter(|s| !s.is_empty())
                    .map(|_| "__saved__".to_string())
            } else {
                password_raw
            };
            let passphrase = if mask_secrets {
                passphrase_raw
                    .filter(|s| !s.is_empty())
                    .map(|_| "__saved__".to_string())
            } else {
                passphrase_raw
            };
            Ok(Host {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: HostKind::from_str(&row.get::<_, String>(2)?),
                hostname: row.get(3)?,
                port: row.get::<_, Option<i64>>(4)?.map(|v| v as u16),
                username: row.get(5)?,
                password,
                private_key_path: row.get(7)?,
                passphrase,
                save_password: row.get::<_, i64>(9)? != 0,
                serial_port: row.get(10)?,
                baud_rate: row.get::<_, Option<i64>>(11)?.map(|v| v as u32),
                data_bits: row.get::<_, Option<i64>>(12)?.map(|v| v as u8),
                stop_bits: row.get::<_, Option<i64>>(13)?.map(|v| v as u8),
                parity: row.get(14)?,
                flow_control: row.get(15)?,
                color: row.get(16)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                last_used: row.get(18)?,
                created_at: row.get(19)?,
                wsl_distro: row.get(20)?,
                wsl_user: row.get(21)?,
                wsl_cwd: row.get(22)?,
                frp_config: row.get(23)?,
                updated_at: row.get(24)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_hosts(&self) -> AppResult<Vec<Host>> {
        self.query_hosts(true)
    }

    /// Raw rows (secrets not masked). Only used internally, e.g. by the
    /// profile exporter — never exposed to the frontend.
    fn raw_hosts(&self) -> AppResult<Vec<Host>> {
        self.query_hosts(false)
    }

    pub fn save_host(&self, mut host: Host) -> AppResult<Host> {
        if host.id.is_empty() {
            host.id = Uuid::new_v4().to_string();
        }
        let now = chrono::Utc::now().timestamp();
        host.created_at = Some(host.created_at.unwrap_or(now));
        host.updated_at = Some(now);

        // Sentinel means "leave the stored secret alone".
        let existing_password = self.raw_secret(&host.id, "password")?;
        let existing_passphrase = self.raw_secret(&host.id, "passphrase")?;

        let password_col = match host.password.as_deref() {
            None | Some("") => String::new(),
            Some("__saved__") => existing_password,
            Some(plain) if host.save_password => self.vault.seal(plain)?,
            Some(_) => String::new(),
        };
        let passphrase_col = match host.passphrase.as_deref() {
            None | Some("") => String::new(),
            Some("__saved__") => existing_passphrase,
            Some(plain) => self.vault.seal(plain)?,
        };

        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO hosts (id, name, kind, hostname, port, username, password,
                                private_key_path, passphrase, save_password, serial_port,
                                baud_rate, data_bits, stop_bits, parity, flow_control,
                                color, tags, last_used, created_at,
                                wsl_distro, wsl_user, wsl_cwd, frp_config, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                     ?21,?22,?23,?24,?25)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, kind=excluded.kind, hostname=excluded.hostname,
                port=excluded.port, username=excluded.username, password=excluded.password,
                private_key_path=excluded.private_key_path, passphrase=excluded.passphrase,
                save_password=excluded.save_password, serial_port=excluded.serial_port,
                baud_rate=excluded.baud_rate, data_bits=excluded.data_bits,
                stop_bits=excluded.stop_bits, parity=excluded.parity,
                flow_control=excluded.flow_control, color=excluded.color, tags=excluded.tags,
                wsl_distro=excluded.wsl_distro, wsl_user=excluded.wsl_user,
                wsl_cwd=excluded.wsl_cwd, frp_config=excluded.frp_config,
                updated_at=excluded.updated_at",
            params![
                host.id,
                host.name,
                host.kind.as_str(),
                host.hostname,
                host.port.map(|v| v as i64),
                host.username,
                password_col,
                host.private_key_path,
                passphrase_col,
                host.save_password as i64,
                host.serial_port,
                host.baud_rate.map(|v| v as i64),
                host.data_bits.map(|v| v as i64),
                host.stop_bits.map(|v| v as i64),
                host.parity,
                host.flow_control,
                host.color,
                serde_json::to_string(&host.tags)?,
                host.last_used,
                host.created_at,
                host.wsl_distro,
                host.wsl_user,
                host.wsl_cwd,
                host.frp_config,
                host.updated_at,
            ],
        )?;
        drop(conn);

        host.password = (!password_col.is_empty()).then(|| "__saved__".to_string());
        host.passphrase = (!passphrase_col.is_empty()).then(|| "__saved__".to_string());
        Ok(host)
    }

    fn raw_secret(&self, host_id: &str, column: &str) -> AppResult<String> {
        let conn = self.conn.lock();
        let sql = format!("SELECT {column} FROM hosts WHERE id = ?1");
        let value: Option<Option<String>> = conn
            .query_row(&sql, params![host_id], |r| r.get(0))
            .optional()?;
        Ok(value.flatten().unwrap_or_default())
    }

    /// Decrypt a stored credential for actually establishing a connection.
    pub fn reveal_secret(&self, host_id: &str, column: &str) -> AppResult<Option<String>> {
        if !matches!(column, "password" | "passphrase") {
            return Err(AppError::Storage(format!("unknown secret `{column}`")));
        }
        let raw = self.raw_secret(host_id, column)?;
        if raw.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.vault.open(&raw)?))
    }

    pub fn delete_host(&self, id: &str) -> AppResult<()> {
        self.conn
            .lock()
            .execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn touch_host(&self, id: &str) -> AppResult<()> {
        self.conn.lock().execute(
            "UPDATE hosts SET last_used = ?1 WHERE id = ?2",
            params![chrono::Utc::now().timestamp(), id],
        )?;
        Ok(())
    }

    // -- Quick commands -----------------------------------------------------

    pub fn list_quick_commands(&self) -> AppResult<Vec<QuickCommand>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, value, scope, is_hex, sort_order, updated_at
             FROM quick_commands ORDER BY sort_order ASC, name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(QuickCommand {
                id: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
                scope: row.get(3)?,
                is_hex: row.get::<_, i64>(4)? != 0,
                sort_order: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn save_quick_command(&self, mut cmd: QuickCommand) -> AppResult<QuickCommand> {
        if cmd.id.is_empty() {
            cmd.id = Uuid::new_v4().to_string();
        }
        cmd.updated_at = Some(chrono::Utc::now().timestamp());
        self.conn.lock().execute(
            "INSERT INTO quick_commands (id, name, value, scope, is_hex, sort_order, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, value=excluded.value, scope=excluded.scope,
                is_hex=excluded.is_hex, sort_order=excluded.sort_order,
                updated_at=excluded.updated_at",
            params![
                cmd.id,
                cmd.name,
                cmd.value,
                cmd.scope,
                cmd.is_hex as i64,
                cmd.sort_order,
                cmd.updated_at,
            ],
        )?;
        Ok(cmd)
    }

    pub fn delete_quick_command(&self, id: &str) -> AppResult<()> {
        self.conn
            .lock()
            .execute("DELETE FROM quick_commands WHERE id = ?1", params![id])?;
        Ok(())
    }

    // -- Settings -----------------------------------------------------------

    pub fn get_settings(&self) -> AppResult<serde_json::Value> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (k, v) = row?;
            let parsed: serde_json::Value =
                serde_json::from_str(&v).unwrap_or(serde_json::Value::String(v));
            map.insert(k, parsed);
        }
        Ok(serde_json::Value::Object(map))
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> AppResult<()> {
        self.conn.lock().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    // -- Unified profile (export / import / sync) ---------------------------

    /// Build the versioned profile document (settings + hosts + quick
    /// commands). When `include_secrets` is true, stored passwords/passphrases
    /// are decrypted and embedded as plaintext — the "full backup" mode;
    /// otherwise they are exported as empty strings.
    pub fn profile_doc(
        &self,
        include_secrets: bool,
        app_version: &str,
    ) -> AppResult<serde_json::Value> {
        let mut hosts = self.raw_hosts()?;
        for h in &mut hosts {
            if include_secrets {
                h.password = self.reveal_secret(&h.id, "password")?;
                h.passphrase = self.reveal_secret(&h.id, "passphrase")?;
            } else {
                h.password = Some(String::new());
                h.passphrase = Some(String::new());
            }
        }
        let quick_commands = self.list_quick_commands()?;
        let settings = self.get_settings()?;
        Ok(json!({
            "format": PROFILE_FORMAT,
            "schemaVersion": PROFILE_SCHEMA_VERSION,
            "appVersion": app_version,
            "exportedAt": chrono::Utc::now().to_rfc3339(),
            "includeSecrets": include_secrets,
            "data": {
                "settings": settings,
                "hosts": hosts,
                "quickCommands": quick_commands,
            },
        }))
    }

    /// Write the profile document to a file (the "export data" action).
    pub fn export_profile(
        &self,
        path: &Path,
        include_secrets: bool,
        app_version: &str,
    ) -> AppResult<ProfileExportInfo> {
        let doc = self.profile_doc(include_secrets, app_version)?;
        let json_text = serde_json::to_string_pretty(&doc)?;
        std::fs::write(path, json_text)?;

        let hosts = doc.pointer("/data/hosts").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let quick_commands = doc.pointer("/data/quickCommands").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let settings = doc.pointer("/data/settings").and_then(|v| v.as_object()).map(|o| o.len()).unwrap_or(0);
        let exported_at = doc.get("exportedAt").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        Ok(ProfileExportInfo {
            path: path.display().to_string(),
            hosts,
            quick_commands,
            settings,
            include_secrets,
            exported_at,
        })
    }

    /// Apply an already-parsed profile document. `mode` is `"merge"` (upsert by
    /// id, keep anything not present in the file) or `"replace"` (wipe hosts,
    /// quick commands and settings first). Passwords are re-sealed into this
    /// machine's vault; when the profile has no secrets (`includeSecrets` was
    /// false), the `__saved__` sentinel is used so re-importing never wipes a
    /// password that is already stored here.
    pub fn import_profile_value(
        &self,
        doc: serde_json::Value,
        mode: &str,
    ) -> AppResult<ProfileImportInfo> {
        let format = doc.get("format").and_then(|v| v.as_str()).unwrap_or_default();
        if format != PROFILE_FORMAT {
            return Err(AppError::Storage(
                "不是有效的 DevOps Station 数据文件".into(),
            ));
        }
        let version = doc
            .get("schemaVersion")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        if version > PROFILE_SCHEMA_VERSION {
            return Err(AppError::Storage(format!(
                "数据文件由更高版本应用导出（schema v{version}），请先升级应用"
            )));
        }
        let include_secrets = doc
            .get("includeSecrets")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let data = doc.get("data").cloned().unwrap_or_else(|| json!({}));

        let hosts: Vec<Host> = serde_json::from_value(
            data.get("hosts").cloned().unwrap_or_else(|| json!([])),
        )
        .map_err(|e| AppError::Storage(format!("主机数据解析失败: {e}")))?;
        let quick_commands: Vec<QuickCommand> = serde_json::from_value(
            data.get("quickCommands").cloned().unwrap_or_else(|| json!([])),
        )
        .map_err(|e| AppError::Storage(format!("快捷命令解析失败: {e}")))?;
        let settings = data.get("settings").cloned().unwrap_or_else(|| json!({}));

        // Parse everything above before touching any table, so a malformed file
        // can never leave the database half-replaced.
        if mode.eq_ignore_ascii_case("replace") {
            let conn = self.conn.lock();
            conn.execute("DELETE FROM hosts", [])?;
            conn.execute("DELETE FROM quick_commands", [])?;
            conn.execute("DELETE FROM settings", [])?;
        }

        let mut imported_hosts = 0usize;
        for mut h in hosts {
            if !include_secrets {
                // Empty secret in the profile → keep what this machine already
                // has (sentinel), or leave empty on a fresh import.
                if h.password.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
                    h.password = Some("__saved__".to_string());
                }
                if h.passphrase.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
                    h.passphrase = Some("__saved__".to_string());
                }
            }
            self.save_host(h)?;
            imported_hosts += 1;
        }

        let mut imported_quick = 0usize;
        for c in quick_commands {
            self.save_quick_command(c)?;
            imported_quick += 1;
        }

        let mut imported_settings = 0usize;
        if let serde_json::Value::Object(map) = settings {
            for (k, v) in map {
                self.set_setting(&k, &v)?;
                imported_settings += 1;
            }
        }

        Ok(ProfileImportInfo {
            hosts: imported_hosts,
            quick_commands: imported_quick,
            settings: imported_settings,
            mode: mode.to_string(),
        })
    }

    /// Read + parse a profile file, then apply it (see
    /// [`Store::import_profile_value`]).
    pub fn import_profile(&self, path: &Path, mode: &str) -> AppResult<ProfileImportInfo> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| AppError::Storage(format!("无法读取数据文件: {e}")))?;
        let doc: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| AppError::Storage(format!("数据文件不是合法 JSON: {e}")))?;
        self.import_profile_value(doc, mode)
    }
}
