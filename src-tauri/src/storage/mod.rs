pub mod crypto;

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
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

    pub fn list_hosts(&self) -> AppResult<Vec<Host>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, hostname, port, username, password, private_key_path,
                    passphrase, save_password, serial_port, baud_rate, data_bits, stop_bits,
                    parity, flow_control, color, tags, last_used, created_at,
                    wsl_distro, wsl_user, wsl_cwd, frp_config
             FROM hosts
             ORDER BY COALESCE(last_used, 0) DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let tags_json: String = row.get(17)?;
            Ok(Host {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: HostKind::from_str(&row.get::<_, String>(2)?),
                hostname: row.get(3)?,
                port: row.get::<_, Option<i64>>(4)?.map(|v| v as u16),
                username: row.get(5)?,
                // Credentials stay sealed until `reveal_secret` is called.
                password: row
                    .get::<_, Option<String>>(6)?
                    .filter(|s| !s.is_empty())
                    .map(|_| "__saved__".to_string()),
                private_key_path: row.get(7)?,
                passphrase: row
                    .get::<_, Option<String>>(8)?
                    .filter(|s| !s.is_empty())
                    .map(|_| "__saved__".to_string()),
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
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn save_host(&self, mut host: Host) -> AppResult<Host> {
        if host.id.is_empty() {
            host.id = Uuid::new_v4().to_string();
        }
        let now = chrono::Utc::now().timestamp();
        host.created_at = Some(host.created_at.unwrap_or(now));

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
                                wsl_distro, wsl_user, wsl_cwd, frp_config)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                     ?21,?22,?23,?24)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, kind=excluded.kind, hostname=excluded.hostname,
                port=excluded.port, username=excluded.username, password=excluded.password,
                private_key_path=excluded.private_key_path, passphrase=excluded.passphrase,
                save_password=excluded.save_password, serial_port=excluded.serial_port,
                baud_rate=excluded.baud_rate, data_bits=excluded.data_bits,
                stop_bits=excluded.stop_bits, parity=excluded.parity,
                flow_control=excluded.flow_control, color=excluded.color, tags=excluded.tags,
                wsl_distro=excluded.wsl_distro, wsl_user=excluded.wsl_user,
                wsl_cwd=excluded.wsl_cwd, frp_config=excluded.frp_config",
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
            "SELECT id, name, value, scope, is_hex, sort_order
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
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn save_quick_command(&self, mut cmd: QuickCommand) -> AppResult<QuickCommand> {
        if cmd.id.is_empty() {
            cmd.id = Uuid::new_v4().to_string();
        }
        self.conn.lock().execute(
            "INSERT INTO quick_commands (id, name, value, scope, is_hex, sort_order)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, value=excluded.value, scope=excluded.scope,
                is_hex=excluded.is_hex, sort_order=excluded.sort_order",
            params![
                cmd.id,
                cmd.name,
                cmd.value,
                cmd.scope,
                cmd.is_hex as i64,
                cmd.sort_order
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
}
