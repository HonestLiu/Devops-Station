# DevOps Station 自动更新功能说明

本文档说明 DevOps Station（Tauri 2 + Vite 6 + React 18 桌面应用）的自动更新机制：
从架构、代码位置、签名密钥、发布流程，到私有仓库的特殊处理与常见故障排查。

---

## 1. 功能概述

基于 Tauri 官方插件 `tauri-plugin-updater` 实现应用内自动更新，具备：

- **启动自动检查**：应用启动约 2.5 秒后静默检查（可在设置中关闭）。
- **手动检查更新**：「关于」对话框与「设置 → 更新」节均提供「检查更新」按钮。
- **更新弹窗**：展示新版本号与更新内容，用户确认后开始下载。
- **下载进度条**：下载过程中实时显示进度（含未知总大小的兜底进度）。
- **自动安装并重启**：下载完成后自动安装，并通过 `tauri-plugin-process` 重新启动应用。
- **签名校验**：所有更新包使用 ed25519 密钥对签名，安装前校验，防止被篡改。

> Windows / Linux 端更新链路完整可用。**macOS 端因未做 Apple 代码签名，Sparkle 可能拒绝应用更新**（见第 9 节）。

---

## 2. 技术架构

```
┌──────────────┐    latest.json (含版本/签名/下载URL)     ┌──────────────────────┐
│  DevOps Station │ ───────────────────────────────────────▶ │  GitHub Releases      │
│  (已安装应用)   │ ◀──────────── 更新包 + *.sig ────────────── │  HonestLiu/           │
└──────────────┘                                           │  Devops-Station       │
       │ 比对当前版本号                                        └──────────────────────┘
       │ 发现更高版本 → 下载 → 校验签名 → 安装 → relaunch
       ▼
 更新弹窗 / 进度条 (前端 React)
```

- **更新清单**：`latest.json` 托管在 GitHub Releases 的 `releases/latest/download/latest.json`，由 CI 自动聚合三端产物生成。
- **签名**：每个平台安装包配套一个 `.sig` 签名文件，公钥写在 `tauri.conf.json`，私钥仅在 CI 中通过 Secret 使用。
- **版本比较**：按语义化版本号（SemVer）比较，`latest.json` 中的版本高于当前安装版本时才提示更新（只能递增，不能回退）。

---

## 3. 前端实现

### 3.1 依赖

`package.json` 中需包含：

```json
"dependencies": {
  "@tauri-apps/plugin-updater": "^2.3.0",
  "@tauri-apps/plugin-process": "^2.2.0"
}
```

> 注意：加装依赖后必须同步 `package-lock.json`（见第 10.1 节），否则 CI 的 `npm ci` 会失败。

### 3.2 核心文件

| 文件 | 职责 |
| --- | --- |
| `src/store/useUpdaterStore.ts` | 更新弹窗状态（checking / updating / downloading / progress / error / open） |
| `src/lib/updater.ts` | `checkForUpdate()` 检查更新、`installUpdate()` 下载+安装+重启 |
| `src/components/UpdateDialog.tsx` | 更新弹窗 UI（版本差、更新内容、进度条、稍后/立即更新），含 `CheckForUpdatesButton` |
| `src/App.tsx` | 启动 2.5 秒后静默自动检查（受 `autoCheckUpdates` 开关控制） |
| `src/components/AboutDialog.tsx` | `getVersion()` 显示真实版本号 + 「检查更新」按钮 |
| `src/pages/Settings.tsx` | 「更新」设置节（见第 7 节） |
| `src/store/useAppStore.ts` | 持久化 `autoCheckUpdates` / `autoDownloadUpdates` 开关 |
| `src/vite-env.d.ts` | `vite/client` 类型声明，供 `import.meta.env` 读取构建期 token |

### 3.3 核心逻辑（`src/lib/updater.ts`）

```ts
// 检查更新；notifyWhenCurrent=true 时即便已是最新也弹窗提示；auto=true 为启动静默检查
export async function checkForUpdate(notifyWhenCurrent = false, auto = false): Promise<void>

// 下载并安装更新，进度写入 store，完成后 relaunch
export async function installUpdate(): Promise<void>
```

- 发现更新且 `auto && settings.autoDownloadUpdates` 为真时，跳过「立即更新」手动点击，直接开始下载安装。
- 私有仓库鉴权：`check()` 与 `downloadAndInstall()` 均会带上 `Authorization: Bearer <token>` 头（token 来自构建期环境变量，详见第 8 节）。

---

## 4. 后端与配置

### 4.1 Rust 依赖（`src-tauri/Cargo.toml`）

```toml
[dependencies]
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

### 4.2 插件初始化（`src-tauri/src/lib.rs`）

```rust
// tauri-plugin-updater v2 使用 Builder::new().build()，没有 init()
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

### 4.3 更新器配置（`src-tauri/tauri.conf.json`）

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6...",
      "endpoints": [
        "https://github.com/HonestLiu/Devops-Station/releases/latest/download/latest.json"
      ]
    }
  }
}
```

- `createUpdaterArtifacts: true`：打包时生成更新包与 `.sig`。
- `pubkey`：ed25519 公钥（明文，可入库）。
- `endpoints`：更新清单地址（必须与发布仓库一致）。

### 4.4 权限（`src-tauri/capabilities/default.json`）

```json
{
  "permissions": [
    "updater:default",
    "process:default",
    "process:allow-restart"
  ]
}
```

---

## 5. 密钥与签名

### 5.1 生成密钥对

```bash
# 在 src-tauri 同级（项目根）执行，会生成 .tauri/devops-station.key（私钥）与 .tauri/devops-station.key.pub（公钥）
npx tauri signer generate --ci -w .tauri/devops-station.key -f
```

- 公钥内容读取自 `.tauri/devops-station.key.pub`，填入 `tauri.conf.json` 的 `pubkey`。
- 私钥 `.tauri/*.key` 已被 `.gitignore` 忽略，**不会入库**；请妥善保管，泄露后必须重新生成密钥对并更新 `pubkey`。

### 5.2 GitHub Secret

仓库 **Settings → Secrets and variables → Actions → New repository secret**：

| Name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `.tauri/devops-station.key` 文件的**全部内容**（不是 `.pub`！） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 仅当生成密钥时设了密码才需要 |

---

## 6. 发布流程（CI）

### 6.1 工作流（` .github/workflows/release.yml`）

使用官方 `tauri-apps/tauri-action@v1`，触发条件：

```yaml
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
```

关键点：

- `env` 注入 `TAURI_SIGNING_PRIVATE_KEY`（与可选 `_PASSWORD`）。
- `includeUpdater: true`：生成并上传 `latest.json` + 各平台 `.sig`。
- `releaseDraft: false`：发布为正式 Release（草稿态下 `releases/latest` 无法被解析，应用取不到更新）。
- 矩阵：Windows / macOS (aarch64) / Linux (ubuntu-22.04)。

### 6.2 触发发布的命令

```bash
# 1. 升版本号（自动改 package.json / Cargo.toml / tauri.conf.json 三处 + commit + 打注释 tag）
npm version patch          # 末位 +1；也可用 minor / major

# 2. 推送到 github remote（注释 tag 会被 --follow-tags 一起推送，触发 release.yml）
git push github --follow-tags
```

完成后到 GitHub **Actions** 看构建进度、**Releases** 看产物（构建完会带上 `latest.json` + 各平台 `.sig`）。三端构建通常需 10–20 分钟。

> 已装旧版本的用户会在下次启动约 2.5 秒后自动检测到更新。

---

## 7. 用户侧体验与设置

「设置 → 更新」节（`src/pages/Settings.tsx`）提供：

- **启动自动检查更新**（`autoCheckUpdates`，默认开）：关闭后启动不再联网查更新。
- **自动下载并安装更新**（`autoDownloadUpdates`，默认关）：仅对启动自动检查发现的更新生效，自动下载安装重启，无需手动点「立即更新」；手动点「检查更新」仍先展示更新内容。
- **当前版本**：显示真实版本号（如 `v0.1.5`）+ 内联「检查更新」按钮。

「关于」对话框同样提供版本号与「检查更新」按钮。

---

## 8. 私有仓库的特殊处理（重要）

### 8.1 现象

应用启动/手动检查更新报：

```
Could not fetch a valid release JSON from the remote
```

### 8.2 根因

更新端点指向 **私有仓库** 时，GitHub 对 Release 资产做**匿名访问返回 404**。tauri-plugin-updater 把「非 200 / 取不到合法 JSON」统一报成上面这条错误。即使 `latest.json` 已正确发布，匿名请求也拿不到。

### 8.3 方案 A：把仓库设为 Public（推荐，零代码改动）

GitHub 仓库 **Settings → Change visibility → 设为 Public**。匿名即可下载 `latest.json`，**已分发的二进制无需重发版即可立即更新**。

### 8.4 方案 B：保留私有仓库（token 鉴权）

updater 插件的 `check()` / `downloadAndInstall()` 支持 `headers`，可带 `Authorization: Bearer <PAT>`。本项目已实现：

- 读构建期环境变量 `import.meta.env.VITE_GITHUB_UPDATER_TOKEN`（见 `src/lib/updater.ts` 的 `updaterHeaders()`）。
- **本地调试**：仓库根目录建 `.env.local`（已被 gitignore），写：

  ```bash
  VITE_GITHUB_UPDATER_TOKEN=github_pat_xxxxxxxx
  ```

  然后 `npm run app:dev` 即可测。

- **CI 发布**：在 `release.yml` 的 tauri-action `env` 中加：

  ```yaml
  VITE_GITHUB_UPDATER_TOKEN: ${{ secrets.VITE_GITHUB_UPDATER_TOKEN }}
  ```

  并在 GitHub Secrets 增加 `VITE_GITHUB_UPDATER_TOKEN`（用 fine-grained PAT，权限仅 `Contents: Read`、限定本仓库）。

- **安全提示**：该 token 会**内联进打包后的二进制**，任何人拿到 app 都能提取。私有内部工具可接受；想彻底不发货则选方案 A。

> 若不设 token，代码自动退化为「公开仓库」行为，不影响公开仓库使用。

---

## 9. 已知限制

- **macOS 未做 Apple 代码签名**：Sparkle updater 在 macOS 上可能拒绝应用更新（Windows / Linux 不受影响）。如需 macOS 自动更新生效，需在 Secrets 配置 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`。
- **版本只能递增**：`latest.json` 按 SemVer 比较，不能回退到更低版本。
- **Windows 未签名**：安装时会有 SmartScreen 提示，属正常现象。

---

## 10. 故障排查

### 10.1 CI 报 `npm ci` → `Missing: @tauri-apps/plugin-* from lock file`

根因：往 `package.json` 加依赖时用了 `npm install --no-save`，只装了 `node_modules` 没更新 `package-lock.json`，而 `npm ci` 要求二者严格同步。

修复：

```bash
npm install                 # 或 npm install --package-lock-only，同步 lock 文件
git add package-lock.json
```

> 经验：加依赖**务必同步 lock**，不要使用 `--no-save`。

### 10.2 推了 tag 但 Actions 没触发

根因：`git push --follow-tags` **只推送注释 tag**，轻量 tag（`git tag vX.Y.Z` 不带 `-a`）不会被推送。

修复：用 `npm version patch` 打注释 tag；或手动显式推送：`git push github vX.Y.Z`。

### 10.3 推到 origin 不触发 Actions

根因：项目有两个 remote —— `github`（真正跑 Actions）与 `origin`（本地 Gitea）。`git push` 默认推 `origin`。

修复：发布必须推 `github` remote：`git push github --follow-tags`。

### 10.4 更新报 "Could not fetch a valid release JSON"

按第 8 节处理：确认 Release 已发布且含 `latest.json`；若仓库私有，按方案 A（公开）或方案 B（token）处理。

### 10.5 `npm version` 报 "working directory not clean"

根因：有未提交改动（如 `Cargo.lock` 被 cargo 改过），`npm version` 拒绝在脏工作树上打版本。

修复：先 `git add -A && git commit` 提交相关改动，再 `npm version patch`。

---

## 11. 本地调试

```bash
npm run app:dev          # 启动开发模式，可点「检查更新」验证链路
```

- 公开仓库：无需任何额外配置即可联调。
- 私有仓库：在 `.env.local` 配置 `VITE_GITHUB_UPDATER_TOKEN` 后联调。

---

## 附录：关键命令速查

```bash
# 生成签名密钥对
npx tauri signer generate --ci -w .tauri/devops-station.key -f

# 发布新版本（自动触发 CI 三端构建 + 发布 latest.json）
npm version patch
git push github --follow-tags

# 本地调试
npm run app:dev
```

相关代码位置：`src/lib/updater.ts`、`src/components/UpdateDialog.tsx`、`src/App.tsx`、`src/components/AboutDialog.tsx`、`src/pages/Settings.tsx`、`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`.github/workflows/release.yml`。
