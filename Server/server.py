#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DevOps Station 多端同步服务器（纯 Python 标准库，无第三方依赖）

为 Devops-Station 客户端提供账号 + 配置同步：
  - 注册 / 登录（PBKDF2 密码哈希，Bearer token）
  - 昵称 / 头像（base64）资料维护
  - 同步数据存取（settings / hosts / quickCommands 整体覆盖，last-write-wins）

用法：
  python server.py                 # 默认 0.0.0.0:8765
  python server.py --port 9000     # 自定义端口
  python server.py --data ./data   # 自定义数据目录（默认 ./data）

说明：
  - 数据存于本地 SQLite（data/users.db），每用户一份 JSON（含密码原文，请仅在
    可信网络部署；如需公网建议前置 HTTPS 反向代理，如 nginx/caddy）。
  - 同步为"最后写入者胜"：每用户一个 version，推送时 +1，多端各自拉取合并。

API：
  POST /api/register   {username, password}              -> {token, nickname, avatar}
  POST /api/login      {username, password}              -> {token, nickname, avatar}
  GET  /api/sync       (Bearer)                          -> {version, data}
  POST /api/sync       (Bearer) {data}                   -> {version}
  GET  /api/profile    (Bearer)                          -> {nickname, avatar}
  POST /api/profile    (Bearer) {nickname?, avatar?}     -> {nickname, avatar}
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ---------------------------------------------------------------- helpers

PBKDF2_ITER = 120_000
MAX_BODY = 8 * 1024 * 1024  # 8MB（头像 base64 上限）
AVATAR_MAX_B64 = 1_500_000  # 头像 base64 长度上限 ~1.5MB（约 1.1MB 图片）


def hash_password(password: str, salt: bytes) -> str:
    return base64.b64encode(
        hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER)
    ).decode("ascii")


def new_token() -> str:
    return secrets.token_hex(32)


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- storage


class Store:
    """Thin SQLite wrapper: users table with one JSON blob + version per user."""

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
                token         TEXT,
                nickname      TEXT NOT NULL DEFAULT '',
                avatar        TEXT NOT NULL DEFAULT '',
                data          TEXT NOT NULL DEFAULT '{}',
                version       INTEGER NOT NULL DEFAULT 0,
                updated_at    INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        self.conn.commit()

    def find(self, username: str):
        cur = self.conn.execute("SELECT * FROM users WHERE username = ?", (username,))
        return cur.fetchone()

    def by_token(self, token: str):
        cur = self.conn.execute("SELECT * FROM users WHERE token = ?", (token,))
        return cur.fetchone()

    def create(self, username: str, password: str) -> sqlite3.Row:
        salt = secrets.token_bytes(16)
        self.conn.execute(
            "INSERT INTO users (username, password_hash, salt, token, updated_at) VALUES (?,?,?,?,?)",
            (username, hash_password(password, salt), base64.b64encode(salt).decode("ascii"),
             new_token(), now_ms()),
        )
        self.conn.commit()
        return self.find(username)

    def set_token(self, user_id: int, token: str):
        self.conn.execute("UPDATE users SET token = ? WHERE id = ?", (token, user_id))
        self.conn.commit()

    def save_sync(self, user_id: int, data: dict) -> int:
        version = now_ms()  # monotonic-ish: use epoch-ms as a natural version
        self.conn.execute(
            "UPDATE users SET data = ?, version = ?, updated_at = ? WHERE id = ?",
            (json.dumps(data, ensure_ascii=False), version, version, user_id),
        )
        self.conn.commit()
        return version

    def update_profile(self, user_id: int, nickname: str | None, avatar: str | None):
        sets, vals = [], []
        if nickname is not None:
            sets.append("nickname = ?")
            vals.append(nickname[:64])
        if avatar is not None:
            sets.append("avatar = ?")
            vals.append(avatar[:AVATAR_MAX_B64])
        if not sets:
            return
        sets.append("updated_at = ?")
        vals.append(now_ms())
        vals.append(user_id)
        self.conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", vals)
        self.conn.commit()


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    store: Store = None  # set by main()

    # --- CORS ---------------------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")
        # Chromium's Private Network Access: pages served from a secure origin
        # (e.g. https://tauri.localhost in the packaged app) must pass a
        # preflight with this header before they may call private-network
        # (localhost / LAN) servers. Without it the webview blocks the fetch.
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # --- plumbing -----------------------------------------------------------
    def log_message(self, fmt, *args):
        sys.stderr.write("[sync] %s - %s\n" % (self.address_string(), fmt % args))

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > MAX_BODY:
                return None
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        """Return the authenticated user row or None."""
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        return self.store.by_token(header[7:].strip())

    # --- routes -------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/sync":
            user = self._auth()
            if not user:
                return self._send(401, {"error": "unauthorized"})
            try:
                data = json.loads(user["data"] or "{}")
            except Exception:
                data = {}
            return self._send(200, {"version": user["version"], "data": data})
        if path == "/api/profile":
            user = self._auth()
            if not user:
                return self._send(401, {"error": "unauthorized"})
            return self._send(200, {"nickname": user["nickname"], "avatar": user["avatar"]})
        if path == "/api/health":
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/register":
            return self._register()
        if path == "/api/login":
            return self._login()
        if path == "/api/sync":
            return self._sync()
        if path == "/api/profile":
            return self._profile()
        return self._send(404, {"error": "not found"})

    def _register(self):
        body = self._read_json()
        if not body:
            return self._send(400, {"error": "bad request"})
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        if not username or len(username) > 64 or len(password) < 6:
            return self._send(400, {"error": "username required (<=64), password >= 6 chars"})
        if self.store.find(username):
            return self._send(409, {"error": "username taken"})
        user = self.store.create(username, password)
        return self._send(200, {"token": user["token"], "nickname": "", "avatar": ""})

    def _login(self):
        body = self._read_json()
        if not body:
            return self._send(400, {"error": "bad request"})
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        user = self.store.find(username)
        if not user:
            return self._send(401, {"error": "invalid credentials"})
        salt = base64.b64decode(user["salt"].encode("ascii"))
        if not hmac.compare_digest(user["password_hash"], hash_password(password, salt)):
            return self._send(401, {"error": "invalid credentials"})
        token = new_token()
        self.store.set_token(user["id"], token)
        return self._send(200, {"token": token, "nickname": user["nickname"], "avatar": user["avatar"]})

    def _sync(self):
        user = self._auth()
        if not user:
            return self._send(401, {"error": "unauthorized"})
        body = self._read_json()
        if body is None or "data" not in body or not isinstance(body.get("data"), dict):
            return self._send(400, {"error": "data object required"})
        version = self.store.save_sync(user["id"], body["data"])
        return self._send(200, {"version": version})

    def _profile(self):
        user = self._auth()
        if not user:
            return self._send(401, {"error": "unauthorized"})
        body = self._read_json()
        if body is None:
            return self._send(400, {"error": "bad request"})
        nickname = body.get("nickname")
        avatar = body.get("avatar")
        if nickname is not None:
            nickname = str(nickname).strip()
        if avatar is not None:
            avatar = str(avatar)
            if len(avatar) > AVATAR_MAX_B64:
                return self._send(400, {"error": "avatar too large"})
        self.store.update_profile(user["id"], nickname, avatar)
        user = self.store.find(user["username"])
        return self._send(200, {"nickname": user["nickname"], "avatar": user["avatar"]})


def main():
    parser = argparse.ArgumentParser(description="DevOps Station sync server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    args = parser.parse_args()

    store = Store(args.data)
    Handler.store = store
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"DevOps Station sync server listening on http://{args.host}:{args.port}")
    print(f"Data dir: {args.data}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
