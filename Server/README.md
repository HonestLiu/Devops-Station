# Devops-Station 同步服务器

纯 Python 标准库实现的多端同步服务器（账号注册/登录、昵称头像、配置数据同步），无任何第三方依赖，Python 3.10+ 即可运行。

## 启动

```bash
cd Server
python server.py                # 默认 0.0.0.0:8765
python server.py --port 9000    # 自定义端口
python server.py --data ./data  # 自定义数据目录（默认 Server/data）
```

## 在客户端配置

Devops-Station → 设置 → 账号：

1. 填入服务器地址，如 `http://192.168.1.10:8765`（本机测试用 `http://127.0.0.1:8765`）；
2. 输入用户名 + 密码，点 **注册**（新账号）或 **登录**；
3. 登录后可编辑昵称、头像，点 **立即同步** 推送/拉取配置。

## 同步内容与跨平台裁剪

| 数据 | 是否同步 | 说明 |
|---|---|---|
| 显示/通用设置（主题、语言、字体栈、字号、光标、快捷键、通知、审批 HOOK 开关、AI 配置等） | ✅ | 跨平台通用 |
| 主机列表（SSH/串口/WSL/Frp） | ✅ | 含密码/私钥路径，**明文存储**（见下） |
| 快捷命令 | ✅ | 通用 |
| 昵称 / 头像 | ✅ | 服务器统一保存 |
| `localShell`、`jlinkPath`、`importedFonts`、侧栏折叠状态 | ❌ | 平台/机器相关，不同步（各端本地保持） |

## 安全说明

- **密码**：PBKDF2-SHA256（12 万次迭代 + 随机盐）哈希存储，不落明文。
- **同步数据（含主机密码、私钥路径、AI API Key）以明文 JSON 保存在服务器** `Server/data/users.db`。这是自托管方案的信任模型——**请只在可信网络部署**；如需公网访问，务必前置 HTTPS（nginx / caddy 反代）并限制访问。
- 认证使用 Bearer token（登录后签发，重新登录会刷新 token）。
- 同步冲突策略：**最后写入者胜**（每用户一个版本号），多端同时修改以最后一次推送为准。

## API 一览

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/api/register` | - | `{username, password}` → `{token, nickname, avatar}` |
| POST | `/api/login` | - | `{username, password}` → `{token, nickname, avatar}` |
| GET | `/api/sync` | Bearer | → `{version, data}` |
| POST | `/api/sync` | Bearer | `{data}` → `{version}`（覆盖式保存） |
| GET | `/api/profile` | Bearer | → `{nickname, avatar}` |
| POST | `/api/profile` | Bearer | `{nickname?, avatar?}` → `{nickname, avatar}` |
| GET | `/api/health` | - | 健康检查 |

## 快速自测

```bash
curl -s -X POST http://127.0.0.1:8765/api/register -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
# → {"token":"…","nickname":"","avatar":""}

TOKEN=<上一步的 token>
curl -s http://127.0.0.1:8765/api/sync -H "Authorization: Bearer $TOKEN"
# → {"version":0,"data":{}}

curl -s -X POST http://127.0.0.1:8765/api/sync -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"data":{"settings":{"theme":"tokyo-night"}}}'
```
