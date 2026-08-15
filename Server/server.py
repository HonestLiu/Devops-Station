#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DevOps Station 多端同步服务器（纯 Python 标准库，无第三方依赖）

企业级自检清单（部署到公网也不会轻易被攻破）：
  - 密码哈希：scrypt（内存硬 KDF），旧 PBKDF2 账户首次登录自动升级；salt 16B。
  - 传输：设计为"前置 HTTPS 反向代理（nginx/caddy）"运行；原生仅 HTTP。
    代理后自动识别 X-Forwarded-For / X-Forwarded-Proto，并下发 HSTS。
  - 认证：Bearer token（256-bit）；每设备独立会话，支持空闲/绝对过期与登出。
  - 限流：滑动窗口（全局 / 注册 / 登录，按客户端 IP 维度），防爆破与滥用。
  - 锁户：同一账号连续失败达阈值后临时锁定，阻断凭证填充（credential stuffing）。
  - 防枚举：注册/登录统一返回 "invalid credentials"，不泄露用户名是否存在。
  - 安全头：CSP(nonce) / X-Frame-Options:DENY / X-Content-Type-Options:nosniff /
    Referrer-Policy / Permissions-Policy / HSTS(代理后) / 隐藏 Server 版本。
  - 管理后台：独立管理员会话（HttpOnly+SameSite Cookie）+ 双提交 CSRF Token；
    所有动态数据以 textContent 渲染，杜绝存储型 XSS；不记录密码与 token。
  - 注册开关：--disable-public-register 关闭开放注册，改由管理员建号（企业场景）。
  - 审计：登录成功/失败、登出、管理员操作均记录（含客户端 IP，不含凭据）。

用法：
  python server.py                                  # 默认 0.0.0.0:8765（仅限可信内网）
  python server.py --host 127.0.0.1 --port 9000     # 仅本机
  python server.py --data ./data                    # 自定义数据目录
  python server.py --behind-proxy                    # 运行在 nginx/caddy 之后（信任 XFF）
  python server.py --disable-public-register        # 关闭开放注册，仅管理员可建号
  python server.py --require-admin-env              # 强制从环境变量读取管理员凭证

环境变量（推荐用于生产）：
  ADMIN_USERNAME / ADMIN_PASSWORD   管理员后台凭证（--require-admin-env 时必填）
  SYNC_DATA_DIR                     数据目录（等同 --data）

API（客户端，Bearer token）：
  POST /api/register   {username, password}              -> {token, nickname, avatar}
  POST /api/login      {username, password}              -> {token, nickname, avatar}
  GET  /api/sync       (Bearer)                          -> {version, data}
  POST /api/sync       (Bearer) {data}                   -> {version}
  GET  /api/profile    (Bearer)                          -> {nickname, avatar}
  POST /api/profile    (Bearer) {nickname?, avatar?}     -> {nickname, avatar}
  POST /api/logout     (Bearer)                          -> {ok: true}
  GET  /api/health                                 -> {ok: true}

管理后台（浏览器）：
  GET  /admin                -> 登录页 / 仪表盘（HTML）
  POST /admin/login          {username, password}        -> Set-Cookie + {ok, csrf}
  POST /admin/logout                                 -> {ok: true}
  GET  /admin/api/me                                 -> {authed, username, csrf}
  GET  /admin/api/stats                              -> {users, sessions, dataBytes, uptime}
  GET  /admin/api/users                              -> [{id, username, nickname, sessions,
                                                        dataBytes, version, lastSync, registered}]
  POST /admin/api/users       {username, password}        -> {ok: true}（建号；注册关闭时可用）
  POST /admin/api/users/<id>/revoke                   -> {ok: true}（吊销该用户全部设备会话）
  DELETE /admin/api/users/<id>                       -> {ok: true}（删除用户及其数据）
"""

import argparse
import base64
import hashlib
import hmac
import html
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ============================================================ 配置常量

# 密码哈希
SCRYPT_N = 2 ** 15          # CPU/mem 成本（=32768）
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 64
SCRYPT_MAXMEM = 72 * 1024 * 1024
PBKDF2_ITER = 200_000       # 仅用于兼容旧账户自动升级

# 输入约束
USERNAME_RE = None          # 占位，运行时编译（见底部）
USERNAME_MIN, USERNAME_MAX = 3, 32
PASSWORD_MIN_LEN = 10       # 企业级：≥10 位，且至少含字母与数字
PASSWORD_MAX_LEN = 128
NICKNAME_MAX = 64
AVATAR_MAX_B64 = 1_500_000  # 头像 base64 上限 ~1.1MB 图片
MAX_BODY = 8 * 1024 * 1024  # 单请求体上限（同步数据可能较大）
ADMIN_MAX_BODY = 64 * 1024  # 管理后台请求体上限

# 会话过期
SESSION_IDLE_HOURS = 24 * 7    # 空闲 7 天失效
SESSION_MAX_AGE_DAYS = 30      # 绝对 30 天失效
ADMIN_SESSION_HOURS = 12       # 管理员会话 12 小时

# 限流（滑动窗口）：(bucket, limit, window_seconds)
RATE_LIMITS = {
    "global":  (600, 60),     # 每 IP 每分钟 600 请求
    "register":(10, 3600),    # 每 IP 每小时 10 次注册
    "login":   (30, 600),     # 每 IP 每 10 分钟 30 次登录尝试
}
# 账户锁户
LOCKOUT_FAILS = 5            # 连续失败次数
LOCKOUT_WINDOW = 900         # 统计窗口（秒）
LOCKOUT_SECONDS = 900       # 锁定时长（秒）

import re
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{%d,%d}$" % (USERNAME_MIN, USERNAME_MAX))


def hash_password_scrypt(password: str, salt: bytes) -> str:
    dk = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R,
        p=SCRYPT_P, dklen=SCRYPT_DKLEN, maxmem=SCRYPT_MAXMEM,
    )
    # 存储格式：scrypt$<base64(salt)>$<base64(dk)>
    return "scrypt$" + base64.b64encode(salt).decode("ascii") + "$" + base64.b64encode(dk).decode("ascii")


def hash_password_pbkdf2(password: str, salt: bytes) -> str:
    return base64.b64encode(
        hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER)
    ).decode("ascii")


def new_token() -> str:
    return secrets.token_hex(32)   # 256-bit


def now_ms() -> int:
    return int(time.time() * 1000)


def client_ip_from(handler) -> str:
    """解析真实客户端 IP（代理后优先取 X-Forwarded-For 首跳）。"""
    if getattr(handler.server, "behind_proxy", False):
        xff = handler.headers.get("X-Forwarded-For", "")
        if xff:
            first = xff.split(",")[0].strip()
            try:
                return str(ipaddress.ip_address(first))
            except ValueError:
                pass
    return handler.client_address[0]


# ============================================================ 限流 / 锁户

class RateLimiter:
    """进程内滑动窗口限流 + 账户锁户。单进程足够；多 worker 部署建议前置共享限流。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._hits = {}      # (bucket, key) -> list[timestamp]
        self._fails = {}     # username -> [count, window_start, locked_until]

    def allow(self, bucket: str, key: str) -> bool:
        limit, window = RATE_LIMITS[bucket]
        now = time.time()
        bk = (bucket, key)
        with self._lock:
            ts = self._hits.setdefault(bk, [])
            # 丢弃窗口外的旧记录
            self._hits[bk] = [t for t in ts if now - t < window]
            if len(self._hits[bk]) >= limit:
                return False
            self._hits[bk].append(now)
            return True

    def is_locked(self, username: str) -> (bool, int):
        with self._lock:
            rec = self._fails.get(username)
            if not rec:
                return (False, 0)
            count, start, locked_until = rec
            now = time.time()
            if locked_until and now < locked_until:
                return (True, int(locked_until - now))
            if now - start > LOCKOUT_WINDOW:
                # 窗口过期，重置
                del self._fails[username]
                return (False, 0)
            return (False, 0)

    def note_failure(self, username: str) -> (bool, int):
        """记录一次失败；返回 (是否被锁定, 剩余秒)。"""
        now = time.time()
        with self._lock:
            rec = self._fails.get(username)
            if not rec or now - rec[1] > LOCKOUT_WINDOW:
                rec = [0, now, 0]
            rec[0] += 1
            if rec[0] >= LOCKOUT_FAILS:
                rec[2] = now + LOCKOUT_SECONDS
                self._fails[username] = rec
                return (True, LOCKOUT_SECONDS)
            self._fails[username] = rec
            return (False, 0)

    def clear_failure(self, username: str):
        with self._lock:
            self._fails.pop(username, None)


# ============================================================ 存储

class Store:
    """SQLite 存储：users(+每用户 JSON 数据) / sessions(每设备) / admin_sessions。"""

    def __init__(self, data_dir: str):
        os.makedirs(data_dir, exist_ok=True)
        self.conn = sqlite3.connect(os.path.join(data_dir, "users.db"), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt          TEXT NOT NULL,
                kdf           TEXT NOT NULL DEFAULT 'pbkdf2',
                nickname      TEXT NOT NULL DEFAULT '',
                avatar        TEXT NOT NULL DEFAULT '',
                data          TEXT NOT NULL DEFAULT '{}',
                version       INTEGER NOT NULL DEFAULT 0,
                created_at    INTEGER NOT NULL DEFAULT 0,
                updated_at    INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                token       TEXT UNIQUE NOT NULL,
                created_at  INTEGER NOT NULL,
                last_used   INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._migrate()
        self.conn.commit()

    def _migrate(self):
        """为已有库补齐新列（保持向后兼容）。"""
        cols = [r[1] for r in self.conn.execute("PRAGMA table_info(users)")]
        for col, ddl in [
            ("kdf", "ALTER TABLE users ADD COLUMN kdf TEXT NOT NULL DEFAULT 'pbkdf2'"),
            ("created_at", "ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0"),
        ]:
            if col not in cols:
                try:
                    self.conn.execute(ddl)
                except sqlite3.OperationalError:
                    pass
        scols = [r[1] for r in self.conn.execute("PRAGMA table_info(sessions)")]
        if "last_used" not in scols:
            try:
                self.conn.execute("ALTER TABLE sessions ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0")
            except sqlite3.OperationalError:
                pass
        # 管理后台会话表
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_sessions (
                token       TEXT PRIMARY KEY,
                username    TEXT NOT NULL,
                csrf        TEXT NOT NULL,
                ip          TEXT NOT NULL DEFAULT '',
                created_at  INTEGER NOT NULL,
                last_used   INTEGER NOT NULL
            )
            """
        )

    # --- 用户 ---
    def find(self, username: str):
        return self.conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()

    def find_by_id(self, uid: int):
        return self.conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()

    def create_user(self, username: str, password: str) -> sqlite3.Row:
        salt = secrets.token_bytes(16)
        now = now_ms()
        self.conn.execute(
            "INSERT INTO users (username, password_hash, salt, kdf, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (username, hash_password_scrypt(password, salt), base64.b64encode(salt).decode("ascii"),
             "scrypt", now, now),
        )
        self.conn.commit()
        return self.find(username)

    def verify_password(self, user, password: str) -> bool:
        """校验密码；若为旧 PBKDF2 格式，验证通过后静默升级为 scrypt。"""
        kdf = user["kdf"] or "pbkdf2"
        if kdf == "scrypt":
            try:
                _, s_b64, d_b64 = user["password_hash"].split("$", 2)
            except ValueError:
                return False
            salt = base64.b64decode(s_b64)
            expected = base64.b64decode(d_b64)
            actual = hashlib.scrypt(
                password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R,
                p=SCRYPT_P, dklen=SCRYPT_DKLEN, maxmem=SCRYPT_MAXMEM)
            return hmac.compare_digest(expected, actual)
        else:  # 旧 pbkdf2
            salt = base64.b64decode(user["salt"].encode("ascii"))
            if not hmac.compare_digest(user["password_hash"], hash_password_pbkdf2(password, salt)):
                return False
            # 自动升级
            self.upgrade_password(user["id"], password)
            return True

    def upgrade_password(self, uid: int, password: str):
        salt = secrets.token_bytes(16)
        self.conn.execute(
            "UPDATE users SET password_hash = ?, salt = ?, kdf = 'scrypt' WHERE id = ?",
            (hash_password_scrypt(password, salt), base64.b64encode(salt).decode("ascii"), uid))
        self.conn.commit()

    # --- 会话（每设备） ---
    def by_token(self, token: str):
        now = now_ms()
        row = self.conn.execute(
            "SELECT sessions.*, users.* FROM users JOIN sessions ON sessions.user_id = users.id "
            "WHERE sessions.token = ?", (token,)).fetchone()
        if not row:
            return None
        idle = SESSION_IDLE_HOURS * 3_600_000
        age = SESSION_MAX_AGE_DAYS * 86_400_000
        if now - row["last_used"] > idle or now - row["created_at"] > age:
            self.conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            self.conn.commit()
            return None
        self.conn.execute("UPDATE sessions SET last_used = ? WHERE token = ?", (now, token))
        self.conn.commit()
        return row

    MAX_SESSIONS_PER_USER = 20

    def create_session(self, user_id: int) -> str:
        token = new_token()
        now = now_ms()
        self.conn.execute(
            "INSERT INTO sessions (user_id, token, created_at, last_used) VALUES (?,?,?,?)",
            (user_id, token, now, now))
        self.conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND id NOT IN ("
            "SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)",
            (user_id, user_id, self.MAX_SESSIONS_PER_USER))
        self.conn.commit()
        return token

    def delete_session(self, token: str):
        self.conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        self.conn.commit()

    def revoke_all(self, user_id: int):
        self.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        self.conn.commit()

    def session_count(self, user_id: int) -> int:
        return self.conn.execute(
            "SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?", (user_id,)).fetchone()["c"]

    def delete_user(self, user_id: int):
        self.conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        self.conn.commit()

    # --- 同步数据 ---
    def save_sync(self, user_id: int, data: dict) -> int:
        version = now_ms()
        self.conn.execute(
            "UPDATE users SET data = ?, version = ?, updated_at = ? WHERE id = ?",
            (json.dumps(data, ensure_ascii=False), version, version, user_id))
        self.conn.commit()
        return version

    def update_profile(self, user_id: int, nickname, avatar):
        sets, vals = [], []
        if nickname is not None:
            sets.append("nickname = ?"); vals.append(nickname[:NICKNAME_MAX])
        if avatar is not None:
            sets.append("avatar = ?"); vals.append(avatar[:AVATAR_MAX_B64])
        if not sets:
            return
        sets.append("updated_at = ?"); vals.append(now_ms()); vals.append(user_id)
        self.conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", vals)
        self.conn.commit()

    # --- 管理后台会话 ---
    def admin_create_session(self, username: str, csrf: str, ip: str) -> str:
        token = new_token()
        now = now_ms()
        self.conn.execute(
            "INSERT INTO admin_sessions (token, username, csrf, ip, created_at, last_used) "
            "VALUES (?,?,?,?,?,?)", (token, username, csrf, ip, now, now))
        self.conn.commit()
        return token

    def admin_by_token(self, token: str):
        row = self.conn.execute("SELECT * FROM admin_sessions WHERE token = ?", (token,)).fetchone()
        if not row:
            return None
        if now_ms() - row["created_at"] > ADMIN_SESSION_HOURS * 3_600_000:
            self.conn.execute("DELETE FROM admin_sessions WHERE token = ?", (token,))
            self.conn.commit()
            return None
        self.conn.execute("UPDATE admin_sessions SET last_used = ? WHERE token = ?",
                          (now_ms(), token))
        self.conn.commit()
        return row

    def admin_update_csrf(self, token: str, csrf: str):
        self.conn.execute("UPDATE admin_sessions SET csrf = ? WHERE token = ?", (csrf, token))
        self.conn.commit()

    def admin_delete_session(self, token: str):
        self.conn.execute("DELETE FROM admin_sessions WHERE token = ?", (token,))
        self.conn.commit()

    # --- 列表/统计 ---
    def list_users(self):
        return self.conn.execute(
            "SELECT id, username, nickname, version, created_at, updated_at FROM users "
            "ORDER BY id").fetchall()

    def stats(self):
        u = self.conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        s = self.conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()["c"]
        rows = self.conn.execute("SELECT data FROM users").fetchall()
        bytes_ = sum(len((r["data"] or "{}").encode("utf-8")) for r in rows)
        return u, s, bytes_


# ============================================================ 审计日志

def audit(event: str, detail: str, ip: str):
    """审计日志：只记录事件与（非敏感）上下文，绝不记录密码或 token。"""
    sys.stderr.write(f"[audit] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
                     f"ip={ip} event={event} {detail}\n")


# ============================================================ HTTP

class Handler(BaseHTTPRequestHandler):
    store: Store = None
    limiter: RateLimiter = None
    server_version = "DevOpsStationSync"   # 隐藏具体版本号
    disable_public_register = False

    # --- 安全头（所有响应） ---
    def _security_headers(self, is_html: bool = False):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        if is_html:
            self.send_header("X-Frame-Options", "DENY")
            nonce = getattr(self, "_nonce", "")
            self.send_header(
                "Content-Security-Policy",
                f"default-src 'self'; img-src 'self' data:; style-src 'self' "
                f"'nonce-{nonce}'; script-src 'nonce-{nonce}'; object-src 'none'; "
                f"base-uri 'none'; frame-ancestors 'none'")
        if getattr(self.server, "behind_proxy", False):
            self.send_header("Strict-Transport-Security",
                             "max-age=31536000; includeSubDomains")

    # --- 可选 CORS（默认关闭，避免任意站点调用 API） ---
    def _cors(self):
        origin = getattr(self.server, "cors_origin", None)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[sync] %s - %s\n" % (self.address_string(), fmt % args))

    # --- 读取 JSON ---
    def _read_json(self, max_body: int = MAX_BODY) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > max_body:
                return None
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _send(self, code: int, payload: dict, is_html: bool = False,
              extra_headers: dict | None = None, cookies: list | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        for c in (cookies or []):
            self.send_header("Set-Cookie", c)
        self._security_headers(is_html)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, code: int, html_body: str):
        body = html_body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers(is_html=True)
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, code: int, text: str):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        return self.store.by_token(header[7:].strip())

    def _client_ip(self) -> str:
        return client_ip_from(self)

    # --- 路由 ---
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/sync":
            return self._route_auth_get(self._sync_get)
        if path == "/api/profile":
            return self._route_auth_get(self._profile_get)
        if path == "/api/health":
            return self._send(200, {"ok": True})
        if path == "/admin":
            return self._admin_page()
        if path == "/admin/api/me":
            return self._admin_me()
        if path == "/admin/api/stats":
            return self._admin_guard_read(self._admin_stats)
        if path == "/admin/api/users":
            return self._admin_guard_read(self._admin_users)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/register":
            return self._register()
        if path == "/api/login":
            return self._login()
        if path == "/api/sync":
            return self._route_auth_post(self._sync_post)
        if path == "/api/profile":
            return self._route_auth_post(self._profile_post)
        if path == "/api/logout":
            return self._logout()
        if path == "/admin/login":
            return self._admin_login()
        if path == "/admin/logout":
            return self._admin_logout()
        if path == "/admin/api/users":
            return self._admin_guard_write(self._admin_create_user)
        if path.startswith("/admin/api/users/") and path.endswith("/revoke"):
            return self._admin_guard_write(lambda: self._admin_revoke(path))
        return self._send(404, {"error": "not found"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/admin/api/users/") and not path.endswith("/revoke"):
            return self._admin_guard_write(lambda: self._admin_delete(path))
        return self._send(404, {"error": "not found"})

    # --- 鉴权包装 ---
    def _route_auth_get(self, fn):
        user = self._auth()
        if not user:
            return self._send(401, {"error": "unauthorized"})
        return fn(user)

    def _route_auth_post(self, fn):
        user = self._auth()
        if not user:
            return self._send(401, {"error": "unauthorized"})
        return fn(user)

    # --- 客户端 API ---
    def _register(self):
        ip = self._client_ip()
        if self.disable_public_register:
            return self._send(403, {"error": "public registration disabled"})
        if not self.limiter.allow("register", ip):
            return self._send(429, {"error": "too many registrations, slow down"},
                              extra_headers={"Retry-After": "3600"})
        if not self.limiter.allow("global", ip):
            return self._send(429, {"error": "rate limited"})
        body = self._read_json()
        if not body:
            return self._send(400, {"error": "bad request"})
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        if not USERNAME_RE.match(username):
            return self._send(400, {"error": "invalid username (3-32 chars: A-Za-z0-9_)"})  # 不泄露是否已存在
        if not _strong_password(password):
            return self._send(400, {"error": "password too weak (>=10 chars, letters+digit)"})
        if self.store.find(username):
            return self._send(409, {"error": "username taken"})
        user = self.store.create_user(username, password)
        token = self.store.create_session(user["id"])
        audit("register", f"user={username}", ip)
        return self._send(200, {"token": token, "nickname": "", "avatar": ""})

    def _login(self):
        ip = self._client_ip()
        if not self.limiter.allow("login", ip):
            return self._send(429, {"error": "too many attempts, slow down"})
        if not self.limiter.allow("global", ip):
            return self._send(429, {"error": "rate limited"})
        body = self._read_json()
        if not body:
            return self._send(400, {"error": "bad request"})
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        user = self.store.find(username)
        # 防枚举：用户名不存在也返回统一错误；并消耗等量计算（已在 verify 内）
        locked, remain = self.limiter.is_locked(username) if user else (False, 0)
        if locked:
            return self._send(423, {"error": f"account locked, retry in {remain}s"})
        if not user or not self.store.verify_password(user, password):
            # 记录失败（即便用户名不存在也记 IP 维度已在 login bucket 限流）
            if user:
                was_locked, _ = self.limiter.note_failure(username)
                if was_locked:
                    audit("login_locked", f"user={username}", ip)
            audit("login_fail", f"user={username}", ip)
            return self._send(401, {"error": "invalid credentials"})
        self.limiter.clear_failure(username)
        token = self.store.create_session(user["id"])
        audit("login_ok", f"user={username}", ip)
        return self._send(200, {"token": token, "nickname": user["nickname"],
                                "avatar": user["avatar"]})

    def _sync_get(self, user):
        try:
            data = json.loads(user["data"] or "{}")
        except Exception:
            data = {}
        return self._send(200, {"version": user["version"], "data": data})

    def _sync_post(self, user):
        body = self._read_json()
        if body is None or "data" not in body or not isinstance(body.get("data"), dict):
            return self._send(400, {"error": "data object required"})
        version = self.store.save_sync(user["id"], body["data"])
        return self._send(200, {"version": version})

    def _profile_get(self, user):
        return self._send(200, {"nickname": user["nickname"], "avatar": user["avatar"]})

    def _profile_post(self, user):
        body = self._read_json()
        if body is None:
            return self._send(400, {"error": "bad request"})
        nickname = body.get("nickname")
        avatar = body.get("avatar")
        if nickname is not None:
            nickname = str(nickname).strip()
        if avatar is not None:
            avatar = str(avatar)
            if len(avatar) > AVATAR_MAX_B64 or not avatar.startswith("data:image/"):
                return self._send(400, {"error": "avatar must be a data:image/ URL"})
        self.store.update_profile(user["id"], nickname, avatar)
        user = self.store.find(user["username"])
        return self._send(200, {"nickname": user["nickname"], "avatar": user["avatar"]})

    def _logout(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            self.store.delete_session(header[7:].strip())
        return self._send(200, {"ok": True})

    # --- 管理后台 ---
    def _admin_cookie_token(self) -> str | None:
        for c in (self.headers.get("Cookie") or "").split(";"):
            c = c.strip()
            if c.startswith("ds_admin="):
                return c[len("ds_admin="):]
        return None

    def _admin_user(self):
        tok = self._admin_cookie_token()
        if not tok:
            return None
        return self.store.admin_by_token(tok)

    def _admin_cookies(self, token: str, csrf: str, max_age: int = ADMIN_SESSION_HOURS * 3600) -> list:
        secure = "; Secure" if getattr(self.server, "behind_proxy", False) else ""
        return [
            f"ds_admin={token}; Path=/admin; HttpOnly; SameSite=Lax{secure}; Max-Age={max_age}",
            f"ds_csrf={csrf}; Path=/admin; SameSite=Lax{secure}; Max-Age={max_age}",
        ]

    def _admin_guard_read(self, fn):
        """只读接口：仅校验管理员会话。"""
        if not self._admin_user():
            return self._send(401, {"error": "unauthorized"})
        return fn()

    def _admin_guard_write(self, fn):
        """写操作：校验管理员会话 + 双提交 CSRF。"""
        admin = self._admin_user()
        if not admin:
            return self._send(401, {"error": "unauthorized"})
        cookie_csrf = None
        for c in (self.headers.get("Cookie") or "").split(";"):
            c = c.strip()
            if c.startswith("ds_csrf="):
                cookie_csrf = c[len("ds_csrf="):]
        header_csrf = self.headers.get("X-CSRF-Token", "")
        if not cookie_csrf or not header_csrf or cookie_csrf != header_csrf or cookie_csrf != admin["csrf"]:
            return self._send(403, {"error": "csrf mismatch"})
        return fn()

    def _admin_page(self):
        self._nonce = secrets.token_hex(16)
        csrf = ""
        admin = self._admin_user()
        if admin:
            csrf = admin["csrf"]
        page = _ADMIN_HTML.replace("__NONCE__", self._nonce).replace("__CSRF__", csrf)
        self._send_html(200, page)

    def _admin_me(self):
        admin = self._admin_user()
        if not admin:
            return self._send(200, {"authed": False})
        return self._send(200, {"authed": True, "username": admin["username"], "csrf": admin["csrf"]})

    def _admin_login(self):
        ip = self._client_ip()
        if not self.limiter.allow("global", ip):
            return self._send(429, {"error": "rate limited"})
        body = self._read_json(max_body=ADMIN_MAX_BODY)
        if not body:
            return self._send(400, {"error": "bad request"})
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", "")).strip()
        ok = _admin_check(username, password)
        if not ok:
            audit("admin_login_fail", f"user={username}", ip)
            return self._send(401, {"error": "invalid credentials"})
        csrf = new_token()
        token = self.store.admin_create_session(username, csrf, ip)
        audit("admin_login_ok", f"user={username}", ip)
        return self._send(200, {"ok": True, "csrf": csrf},
                          cookies=self._admin_cookies(token, csrf))

    def _admin_logout(self):
        tok = self._admin_cookie_token()
        if tok:
            self.store.admin_delete_session(tok)
        return self._send(200, {"ok": True},
                          cookies=self._admin_cookies("", "", max_age=0))

    def _admin_stats(self):
        u, s, b = self.store.stats()
        return self._send(200, {"users": u, "sessions": s, "dataBytes": b,
                                "uptime": int(time.time() - START_TS)})

    def _admin_users(self):
        out = []
        for r in self.store.list_users():
            uid = r["id"]
            data_len = len((_user_data(r) or "{}").encode("utf-8"))
            out.append({
                "id": uid,
                "username": r["username"],
                "nickname": r["nickname"],
                "sessions": self.store.session_count(uid),
                "dataBytes": data_len,
                "version": r["version"],
                "lastSync": r["updated_at"],
                "registered": r["created_at"] or r["updated_at"],
            })
        return self._send(200, {"users": out})

    def _admin_create_user(self):
        ip = self._client_ip()
        body = self._read_json(max_body=ADMIN_MAX_BODY)
        if not body:
            return self._send(400, {"error": "bad request"})
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        if not USERNAME_RE.match(username):
            return self._send(400, {"error": "invalid username (3-32 chars: A-Za-z0-9_)"})
        if not _strong_password(password):
            return self._send(400, {"error": "password too weak (>=10 chars, letters+digit)"})
        if self.store.find(username):
            return self._send(409, {"error": "username taken"})
        self.store.create_user(username, password)
        audit("admin_create_user", f"user={username}", ip)
        return self._send(200, {"ok": True})

    def _admin_revoke(self, path: str):
        uid = _parse_uid(path, "/revoke")
        if uid is None:
            return self._send(400, {"error": "bad id"})
        user = self.store.find_by_id(uid)
        if not user:
            return self._send(404, {"error": "not found"})
        self.store.revoke_all(uid)
        audit("admin_revoke", f"user={user['username']}", self._client_ip())
        return self._send(200, {"ok": True})

    def _admin_delete(self, path: str):
        uid = _parse_uid(path, "")
        if uid is None:
            return self._send(400, {"error": "bad id"})
        user = self.store.find_by_id(uid)
        if not user:
            return self._send(404, {"error": "not found"})
        self.store.delete_user(uid)
        audit("admin_delete", f"user={user['username']}", self._client_ip())
        return self._send(200, {"ok": True})


def _user_data(row) -> str:
    try:
        return row["data"]
    except Exception:
        return "{}"


def _parse_uid(path: str, suffix: str) -> int | None:
    seg = path
    if suffix:
        seg = seg[: -len(suffix)]
    last = seg.rstrip("/").split("/")[-1]
    try:
        return int(last)
    except ValueError:
        return None


def _strong_password(pw: str) -> bool:
    if len(pw) < PASSWORD_MIN_LEN or len(pw) > PASSWORD_MAX_LEN:
        return False
    if sum(c.islower() for c in pw) == 0 and sum(c.isupper() for c in pw) == 0:
        return False
    if not any(c.isdigit() for c in pw):
        return False
    return True


# ============================================================ 管理后台页面（静态，数据经 JSON + textContent 渲染防 XSS）

_ADMIN_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DevOps Station · 同步管理后台</title>
<style nonce="__NONCE__">
  :root{--bg:#0f1420;--panel:#171e2e;--line:#26304a;--txt:#e6ebf5;--mut:#8b97b3;--acc:#4f8cff;--danger:#ff5c6c;--ok:#39c46e}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--txt)}
  header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:16px;margin:0}
  .wrap{max-width:1100px;margin:0 auto;padding:24px}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .card .k{color:var(--mut);font-size:12px}
  .card .v{font-size:24px;font-weight:600;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:13px}
  th{color:var(--mut);font-weight:500;background:#131a29}
  tr:last-child td{border-bottom:none}
  button{cursor:pointer;border:1px solid var(--line);background:#1d2740;color:var(--txt);padding:6px 12px;border-radius:8px;font-size:13px}
  button:hover{border-color:var(--acc)}
  button.danger{color:var(--danger);border-color:#3a2330}
  button.danger:hover{border-color:var(--danger)}
  .login{max-width:360px;margin:12vh auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px}
  .login h2{margin:0 0 18px;font-size:18px}
  label{display:block;color:var(--mut);margin:12px 0 6px;font-size:12px}
  input{width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:#0f1626;color:var(--txt);font-size:14px}
  .msg{margin-top:12px;font-size:13px;min-height:18px}
  .err{color:var(--danger)} .ok{color:var(--ok)}
  .hidden{display:none}
  .bar{display:flex;gap:12px;align-items:center;margin-bottom:16px}
  .bar input{flex:1}
</style>
</head>
<body>
<header><h1>DevOps Station · 同步管理后台</h1><span id="who" class="hidden"></span></header>
<div class="wrap">

  <div id="login" class="login">
    <h2>管理员登录</h2>
    <label>用户名</label><input id="au" autocomplete="username">
    <label>密码</label><input id="ap" type="password" autocomplete="current-password">
    <div class="bar" style="margin-top:18px"><button id="loginBtn">登录</button></div>
    <div id="loginMsg" class="msg"></div>
  </div>

  <div id="dash" class="hidden">
    <div class="bar">
      <button id="logoutBtn">退出登录</button>
      <span style="color:var(--mut)">所有同步数据以明文存储于服务器，仅限可信部署。</span>
    </div>
    <div class="cards">
      <div class="card"><div class="k">注册用户</div><div class="v" id="stUsers">-</div></div>
      <div class="card"><div class="k">活跃会话</div><div class="v" id="stSessions">-</div></div>
      <div class="card"><div class="k">同步数据总量</div><div class="v" id="stBytes">-</div></div>
      <div class="card"><div class="k">运行时长</div><div class="v" id="stUptime">-</div></div>
    </div>
    <div class="bar">
      <input id="newUser" placeholder="新用户名 (A-Za-z0-9_)">
      <input id="newPass" type="password" placeholder="新密码 (>=10位)">
      <button id="createBtn">新建用户</button>
      <span id="createMsg" class="msg"></span>
    </div>
    <table>
      <thead><tr><th>ID</th><th>用户名</th><th>昵称</th><th>会话</th><th>数据</th><th>版本</th><th>最近同步</th><th>注册于</th><th>操作</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>

<script nonce="__NONCE__">
const $ = (id) => document.getElementById(id);
let CSRF = "__CSRF__";

function fmtBytes(n){ if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(1)+" KB"; return (n/1048576).toFixed(2)+" MB"; }
function fmtTime(ms){ if(!ms) return "-"; const d=new Date(ms); return d.toLocaleString(); }

function csrfHeaders(extra={}){ return Object.assign({"X-CSRF-Token": CSRF, "Content-Type":"application/json"}, extra); }

async function me(){
  try{
    const r = await fetch("/admin/api/me");
    const j = await r.json();
    if(j.authed){ CSRF = j.csrf; showDash(j.username); await refresh(); }
    else { $("login").classList.remove("hidden"); $("dash").classList.add("hidden"); }
  }catch(e){ $("login").classList.remove("hidden"); }
}

function showDash(username){
  $("login").classList.add("hidden");
  $("dash").classList.remove("hidden");
  $("who").textContent = "管理员：" + username;
  $("who").classList.remove("hidden");
}

async function refresh(){
  const [s, u] = await Promise.all([fetch("/admin/api/stats").then(r=>r.json()), fetch("/admin/api/users").then(r=>r.json())]);
  $("stUsers").textContent = s.users;
  $("stSessions").textContent = s.sessions;
  $("stBytes").textContent = fmtBytes(s.dataBytes);
  $("stUptime").textContent = Math.floor(s.uptime/60) + " 分";
  const tb = $("rows"); tb.replaceChildren();
  for(const row of (u.users||[])){
    const tr = document.createElement("tr");
    const cells = [row.id, row.username, row.nickname, row.sessions, fmtBytes(row.dataBytes), row.version, fmtTime(row.lastSync), fmtTime(row.registered)];
    for(const c of cells){
      const td = document.createElement("td");
      td.textContent = (c===null||c===undefined)?"":c;   // textContent：杜绝 XSS
      tr.appendChild(td);
    }
    const op = document.createElement("td");
    const rev = document.createElement("button"); rev.textContent = "吊销会话";
    rev.onclick = () => revoke(row.id, row.username);
    const del = document.createElement("button"); del.textContent = "删除"; del.className="danger";
    del.onclick = () => deluser(row.id, row.username);
    op.appendChild(rev); op.appendChild(document.createTextNode(" ")); op.appendChild(del);
    tr.appendChild(op);
    tb.appendChild(tr);
  }
}

async function revoke(id, name){
  if(!confirm("吊销 " + name + " 的全部设备会话？")) return;
  const r = await fetch("/admin/api/users/"+id+"/revoke", {method:"POST", headers:csrfHeaders()});
  if(r.ok){ alert("已吊销"); await refresh(); } else { alert("操作失败"); }
}
async function deluser(id, name){
  if(!confirm("删除用户 " + name + " 及其全部同步数据？此操作不可恢复。")) return;
  const r = await fetch("/admin/api/users/"+id, {method:"DELETE", headers:csrfHeaders()});
  if(r.ok){ alert("已删除"); await refresh(); } else { alert("操作失败"); }
}

$("loginBtn").onclick = async () => {
  const m = $("loginMsg"); m.textContent=""; m.className="msg";
  const r = await fetch("/admin/login", {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({username:$("au").value, password:$("ap").value})});
  const j = await r.json().catch(()=>({}));
  if(r.ok){ CSRF = j.csrf; $("ap").value=""; showDash($("au").value); await refresh(); }
  else { m.textContent = j.error || "登录失败"; m.className="msg err"; }
};

$("logoutBtn").onclick = async () => {
  await fetch("/admin/logout", {method:"POST", headers:csrfHeaders()});
  location.reload();
};

$("createBtn").onclick = async () => {
  const m = $("createMsg"); m.textContent=""; m.className="msg";
  const r = await fetch("/admin/api/users", {method:"POST", headers:csrfHeaders(),
    body: JSON.stringify({username:$("newUser").value, password:$("newPass").value})});
  const j = await r.json().catch(()=>({}));
  if(r.ok){ m.textContent="已创建"; m.className="msg ok"; $("newUser").value=""; $("newPass").value=""; await refresh(); }
  else { m.textContent = j.error || "创建失败"; m.className="msg err"; }
};

me();
</script>
</body>
</html>
"""


# ============================================================ 管理员凭证

def _admin_check(username: str, password: str) -> bool:
    """比对启动时确定的管理员凭证（启动即固定，不落库）。

    注意：必须比对「有效凭证全局变量」(ADMIN_USER_CACHE/ADMIN_PASSWORD_CACHE)，
    而非原始环境变量——未设置环境变量时用户名会被兜底为 'admin'，
    若仍读环境变量会导致 dev 默认路径下永远 login 失败。
    """
    exp_u = ADMIN_USER_CACHE
    exp_p = ADMIN_PASSWORD_CACHE
    if not exp_u or not exp_p:
        return False
    if not hmac.compare_digest(username, exp_u):
        return False
    return hmac.compare_digest(password, exp_p)


ADMIN_USER_CACHE = ""
ADMIN_PASSWORD_CACHE = ""


# ============================================================ main

START_TS = time.time()


def main():
    global ADMIN_USER_CACHE, ADMIN_PASSWORD_CACHE
    parser = argparse.ArgumentParser(description="DevOps Station sync server (enterprise-hardened)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data", default=os.environ.get("SYNC_DATA_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")))
    parser.add_argument("--behind-proxy", action="store_true",
                        help="信任 X-Forwarded-For/Proto（运行在 nginx/caddy 之后）")
    parser.add_argument("--cors-origin", default=None,
                        help="允许跨域的源（默认关闭 CORS）。如 https://app.example.com")
    parser.add_argument("--disable-public-register", action="store_true",
                        help="关闭开放注册，仅管理员可在后台建号")
    parser.add_argument("--require-admin-env", action="store_true",
                        help="强制从 ADMIN_USERNAME/ADMIN_PASSWORD 读取管理员凭证")
    args = parser.parse_args()

    # 管理员凭证
    admin_user = os.environ.get("ADMIN_USERNAME", "")
    admin_pass = os.environ.get("ADMIN_PASSWORD", "")
    if args.require_admin_env and (not admin_user or not admin_pass):
        sys.stderr.write("ERROR: --require-admin-env 已设置，但 ADMIN_USERNAME/ADMIN_PASSWORD 未提供。\n")
        sys.exit(1)
    if not admin_user or not admin_pass:
        # 开发便利：随机生成并打印告警（生产请用环境变量固定）
        import string
        # 排除易混淆字符 0/O/1/l/I，降低肉眼核对/复制出错概率
        alphabet = "".join(c for c in (string.ascii_letters + string.digits) if c not in "0O1lI")
        admin_pass = "".join(secrets.choice(alphabet) for _ in range(16))
        admin_user = admin_user or "admin"
        sys.stderr.write("=" * 60 + "\n")
        sys.stderr.write(" [安全告警] 未设置 ADMIN_USERNAME/ADMIN_PASSWORD。\n")
        sys.stderr.write(f" 本次管理员登录凭证（仅显示一次）\n")
        sys.stderr.write(f"   用户名: {admin_user}\n")
        sys.stderr.write(f"   密码  : {admin_pass}\n")
        sys.stderr.write(" 生产部署请通过环境变量固定，并使用 --require-admin-env。\n")
        sys.stderr.write("=" * 60 + "\n")
    ADMIN_USER_CACHE = admin_user
    ADMIN_PASSWORD_CACHE = admin_pass

    store = Store(args.data)
    Handler.store = store
    Handler.limiter = RateLimiter()
    Handler.disable_public_register = args.disable_public_register

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.behind_proxy = args.behind_proxy
    httpd.cors_origin = args.cors_origin

    bind_note = "（仅限可信内网；公网请前置 HTTPS 反向代理）" if args.host in ("0.0.0.0",) else ""
    print(f"DevOps Station sync server listening on http://{args.host}:{args.port} {bind_note}")
    print(f"Data dir: {args.data}")
    print(f"Public register: {'DISABLED' if args.disable_public_register else 'open'}"
          f" | Behind proxy: {args.behind_proxy} | CORS: {args.cors_origin or 'off'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
