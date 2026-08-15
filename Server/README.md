# Devops-Station 同步服务器

纯 Python 标准库实现的多端同步服务器（账号注册/登录、昵称头像、配置数据同步、Web 管理后台），**无任何第三方依赖**，Python 3.10+ 即可运行。

> 数据目录 `Server/data/` 已加入项目 `.gitignore`，**不会被提交**。请自行备份该目录。

---

## 启动

```bash
cd Server
python server.py                 # 默认 0.0.0.0:8765（仅限可信内网）
python server.py --port 9000    # 自定义端口
python server.py --data ./data  # 自定义数据目录（默认 Server/data）
```

### 生产/公网部署推荐参数

```bash
# 仅本机 + 关闭开放注册（改由管理员在后台建号）+ 前置 HTTPS 代理
ADMIN_USERNAME=admin ADMIN_PASSWORD='更换为强密码' \
  python server.py --host 127.0.0.1 --data /var/lib/devops-sync \
  --behind-proxy --disable-public-register --require-admin-env
```

---

## Web 管理后台

浏览器访问 `http://<host>:<port>/admin`，用管理员账号登录后可：

- 查看全局统计（注册用户数、活跃会话数、同步数据总量、运行时长）；
- 查看/搜索用户列表（会话数、数据量、最近同步、注册时间）；
- **新建用户**（关闭开放注册时唯一建号途径）；
- **吊销某用户全部设备会话**（强制其所有端重新登录）；
- **删除用户**及其全部同步数据（不可恢复）。

> 后台所有动态数据均以 `textContent` 渲染，杜绝存储型 XSS；写操作强制双提交 CSRF Token。

---

## 安全模型（企业级自检）

| 维度 | 措施 |
|---|---|
| 密码哈希 | **scrypt**（内存硬 KDF，N=2^15 / r=8 / p=1），salt 16B。旧 PBKDF2 账户首次登录**自动升级**为 scrypt。 |
| 密码强度 | ≥10 位，且至少含字母与数字（企业策略，可在 `PASSWORD_MIN_LEN` 调整）。 |
| 传输 | 设计为"前置 HTTPS 反向代理（nginx / caddy）"。`--behind-proxy` 下信任 `X-Forwarded-For/Proto` 并下发 HSTS。原生仅 HTTP，请勿直接公网暴露。 |
| 认证 | Bearer token（256-bit）；每设备独立会话，支持**空闲 7 天 / 绝对 30 天**过期；`/api/logout` 仅使当前设备失效。 |
| 限流 | 滑动窗口：全局 600/分/IP、注册 10/小时/IP、登录 30/10 分/IP。防爆破与资源滥用。 |
| 锁户 | 同一账号连续失败 5 次锁定 15 分钟，阻断凭证填充（credential stuffing）。 |
| 防枚举 | 注册/登录统一返回 `invalid credentials`，不泄露用户名是否存在。 |
| 安全响应头 | `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 收紧；后台页 `X-Frame-Options: DENY` + `Content-Security-Policy`（nonce）；代理后 `Strict-Transport-Security`。Server 版本号已隐藏。 |
| CORS | **默认关闭**（避免任意站点调用 API）；仅 `--cors-origin` 显式指定时才开放。 |
| 管理后台 | 独立管理员会话（HttpOnly + SameSite=Lax Cookie，代理后加 Secure）；双提交 CSRF Token；凭证来自环境变量，**不落库**。 |
| 注册开关 | `--disable-public-register` 关闭开放注册，仅管理员可在后台建号（企业场景）。 |
| 审计 | 登录成功/失败、锁户、登出、管理员操作均记录（含客户端 IP，**不记录密码与 token**）。 |

> ⚠️ 同步数据（含主机密码、私钥路径、AI API Key）以明文 JSON 存于 `users.db`。这是自托管信任模型：请只在可信网络 / 前置鉴权代理下部署，并对磁盘与备份加密。

---

## 环境变量

| 变量 | 说明 |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理后台凭证。**生产务必设置**；配合 `--require-admin-env` 可强制必填。未设置时启动会随机生成并打印（仅显示一次）告警。 |
| `SYNC_DATA_DIR` | 数据目录（等同 `--data`）。 |

---

## 命令行参数

| 参数 | 说明 |
|---|---|
| `--host` / `--port` | 监听地址/端口（默认 `0.0.0.0:8765`）。公网建议 `--host 127.0.0.1` + 反代。 |
| `--data` | 数据目录。 |
| `--behind-proxy` | 信任 `X-Forwarded-For/Proto`（运行在 nginx/caddy 之后）。 |
| `--cors-origin` | 允许跨域的源，如 `https://app.example.com`。默认不开放 CORS。 |
| `--disable-public-register` | 关闭开放注册，仅管理员可在后台建号。 |
| `--require-admin-env` | 强制从环境变量读取管理员凭证，缺失则拒绝启动。 |

---

## 公网部署示例（nginx + TLS）

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;
    ssl_certificate     /etc/ssl/sync/fullchain.pem;
    ssl_certificate_key /etc/ssl/sync/privkey.pem;

    # 仅暴露必要路径；后台建议再加一层 Basic Auth 或 IP 白名单
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    # 可选：对 /admin 额外限制
    location /admin {
        auth_basic "admin";
        auth_basic_user_file /etc/nginx/sync-admin.htpasswd;
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启动服务（仅本机，由 nginx 对外）：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='强密码' \
  python server.py --host 127.0.0.1 --behind-proxy \
  --disable-public-register --require-admin-env
```

---

## 客户端配置

Devops-Station → 设置 → 账号：

1. 填入服务器地址，如 `https://sync.example.com`（本机测试 `http://127.0.0.1:8765`）；
2. 输入用户名 + 密码，点 **注册**（新账号，需开放注册）或 **登录**；
3. 登录后可编辑昵称、头像，点 **立即同步** 推送/拉取配置。

---

## 同步内容与跨平台裁剪

| 数据 | 是否同步 | 说明 |
|---|---|---|
| 显示/通用设置（主题、语言、字体栈、字号、光标、快捷键、通知、审批 HOOK 开关、AI 配置等） | ✅ | 跨平台通用 |
| 主机列表（SSH/串口/WSL/Frp） | ✅ | 含密码/私钥路径，**明文存储**（见上"安全模型"） |
| 快捷命令 | ✅ | 通用 |
| 昵称 / 头像 | ✅ | 服务器统一保存 |
| `localShell`、`jlinkPath`、`importedFonts`、侧栏折叠状态 | ❌ | 平台/机器相关，不同步（各端本地保持） |

同步冲突策略：**最后写入者胜**（每用户一个版本号），多端同时修改以最后一次推送为准。

---

## API 一览

### 客户端（Bearer token）

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/api/register` | - | `{username, password}` → `{token, nickname, avatar}`（受注册开关与限流约束） |
| POST | `/api/login` | - | `{username, password}` → `{token, nickname, avatar}` |
| GET | `/api/sync` | Bearer | → `{version, data}` |
| POST | `/api/sync` | Bearer | `{data}` → `{version}`（覆盖式保存） |
| GET | `/api/profile` | Bearer | → `{nickname, avatar}` |
| POST | `/api/profile` | Bearer | `{nickname?, avatar?}` → `{nickname, avatar}` |
| POST | `/api/logout` | Bearer | 使当前设备会话失效 → `{ok:true}` |
| GET | `/api/health` | - | 健康检查 `{ok:true}` |

### 管理后台（管理员 Cookie + CSRF）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin` | 登录页 / 仪表盘（HTML） |
| POST | `/admin/login` | `{username, password}` → Set-Cookie + `{ok, csrf}` |
| POST | `/admin/logout` | 退出管理员会话 |
| GET | `/admin/api/me` | `{authed, username, csrf}` |
| GET | `/admin/api/stats` | `{users, sessions, dataBytes, uptime}` |
| GET | `/admin/api/users` | 用户列表（含会话数、数据量、时间戳） |
| POST | `/admin/api/users` | 新建用户 `{username, password}` |
| POST | `/admin/api/users/<id>/revoke` | 吊销该用户全部设备会话 |
| DELETE | `/admin/api/users/<id>` | 删除用户及其数据 |

---

## 快速自测

```bash
curl -s -X POST http://127.0.0.1:8765/api/register -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"Abcd1234xy"}'
# → {"token":"…","nickname":"","avatar":""}

TOKEN=<上一步的 token>
curl -s http://127.0.0.1:8765/api/sync -H "Authorization: Bearer $TOKEN"
# → {"version":0,"data":{}}

curl -s -X POST http://127.0.0.1:8765/api/sync -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"data":{"settings":{"theme":"tokyo-night"}}}'
```
