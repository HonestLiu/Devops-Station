# DevOps Station

> 一个现代化的跨平台终端运维工作台 — SSH + SFTP + 串口调试 + 设备监控，四合一。
>
> Termius 的连接管理 · MobaXterm 的一体化 · VS Code 的界面语言 · Serial Studio 的串口绘图。

基于 **Tauri v2 + Rust + React 18 + TypeScript** 构建，原生性能，安装包体积小。

---

## 功能特性

### 🖥 SSH 终端

- 基于 `russh` 的纯 Rust 异步 SSH 实现（`ring` 后端，Windows 免 CMake/NASM）
- `xterm.js` 渲染，完整 ANSI 256 色 + True Color，支持 `bash` / `zsh` / `fish` / `tmux`
- Nerd Font 字形支持（Unicode11 addon），Powerlevel10k 等主题正常显示
- 密码 / 私钥（含 passphrase）/ none 三级自动认证回退
- 首次连接 TOFU 记录 SHA256 主机指纹
- 终端内搜索、Web 链接点击、自动 fit + PTY resize 同步

### 📁 SFTP 文件管理

- 与终端同会话复用 SSH 连接，无需二次认证
- 目录浏览（文件夹优先排序）、面包屑导航、上级跳转
- 上传 / 下载带**实时进度事件**（64KB 分块）
- 新建目录、重命名、删除
- 显示权限位、属主、大小、修改时间

### 📊 设备监控

- **无 Agent**：单条 POSIX shell 探针脚本，通过已建立的 SSH 会话执行
- 采集 CPU 占用率（`/proc/stat` jiffies 差分）、内存、磁盘（`df`）、网络收发速率（`/proc/net/dev` 差分）、温度（`thermal_zone`）、负载、Top 进程
- 本机监控走 `sysinfo`，Dashboard 实时刷新
- ⚠️ 速率类指标需要**连续两次采样**才有值，首次调用为 0

### 🔌 串口工作台

- `serialport-rs`，独立线程阻塞读取，不阻塞 UI
- 波特率 / 数据位 / 校验位 / 停止位 / 流控完整可配
- **三种数据模式**：
  - **Normal** — 带时间戳的日志流，可切 HEX / ASCII 显示
  - **Terminal** — 完整 xterm.js 终端仿真（调试 U-Boot / Linux console）
  - **Plot** — `uPlot` 实时曲线，自动解析 `key:value` / CSV 数值流
- 快捷命令面板（可持久化到 SQLite）
- 行尾控制（None / CR / LF / CRLF）、编码切换（UTF-8 / GBK / HEX）
- 内置 HEX / ASCII / Binary / Decimal 转换器

### 🎨 全局体验

- 浏览器式**多标签页**，状态点实时反映连接中 / 已连接 / 断开 / 错误
- **命令面板** `Ctrl/Cmd + K` — 页面跳转、主机连接、新建会话、主题切换
- **5 套主题**：Tokyo Night（默认）/ Dark / Light / Nord / Dracula，终端配色与 UI 同步
- 侧边栏导航：Dashboard / Hosts / Monitoring / Settings

### 🔐 数据存储

- `rusqlite`（bundled SQLite）持久化主机、快捷命令、设置
- 凭据使用 **XChaCha20-Poly1305** 加密落盘，密钥文件 `secret.key`（Unix 下 0600）
- 列表接口返回 `__saved__` 哨兵值，密文永不出后端边界，仅在连接时解密

> **安全说明（务必知悉）**：当前方案防的是「磁盘上的明文」，**不防**「能读取你 home 目录的攻击者」——`secret.key` 与数据库同处一地。真正的操作系统级密钥托管请接入 `tauri-plugin-stronghold` 或系统 Keychain，代码中已预留升级点。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri v2 |
| 后端 | Rust · russh 0.62 · russh-sftp 2.4 · portable-pty 0.9 · serialport 4.9 · sysinfo 0.39 · rusqlite 0.40 · tokio |
| 前端 | React 18 · TypeScript 5 · Vite 6 · TailwindCSS 3 · Zustand 5 |
| 终端 | xterm.js 5.5（fit / search / web-links / unicode11） |
| 图表 | uPlot 1.6 |
| 加密 | chacha20poly1305（XChaCha20-Poly1305） |

---

## 项目结构

```
devops-station/
├── src/                          # 前端
│   ├── main.tsx                  # 入口：挂载 + 启动加载设置/主机
│   ├── App.tsx                   # AppShell：侧边栏 + 标签栏 + 页面路由
│   ├── components/
│   │   ├── Sidebar.tsx           # 主导航
│   │   ├── TopBar.tsx            # 顶栏（拖拽区 + 命令面板入口）
│   │   ├── TabBar.tsx            # 浏览器式标签
│   │   ├── CommandPalette.tsx    # Cmd+K 命令面板
│   │   ├── HostDialog.tsx        # 主机新建/编辑
│   │   ├── QuickCommandsEditor.tsx
│   │   ├── MetricsView.tsx       # 监控卡片组
│   │   ├── ConnectionOverlay.tsx # 连接中/错误遮罩
│   │   ├── ui.tsx                # Button/Input/Select/Dialog/Bar...
│   │   ├── terminal/Terminal.tsx # xterm 封装（ssh|pty|serial 三种传输）
│   │   ├── sftp/SftpPanel.tsx
│   │   ├── serial/SerialPlot.tsx
│   │   ├── serial/Converter.tsx
│   │   └── workspace/            # SshWorkspace / LocalWorkspace / SerialWorkspace
│   ├── pages/                    # Dashboard / Hosts / Monitoring / Settings
│   ├── store/                    # Zustand: useAppStore / useHostsStore / useTabsStore
│   ├── lib/                      # api.ts(IPC封装) types.ts utils.ts themes.ts
│   └── styles/globals.css        # 5 套主题 CSS 变量
└── src-tauri/                    # 后端
    ├── src/
    │   ├── lib.rs                # AppState + ~35 个 #[tauri::command]
    │   ├── types.rs              # 前后端共享类型（serde camelCase）
    │   ├── error.rs              # AppError（IPC 可序列化）
    │   ├── ssh/{mod,sftp,metrics}.rs
    │   ├── serial/mod.rs
    │   ├── pty/mod.rs
    │   ├── system/mod.rs
    │   └── storage/{mod,crypto}.rs
    ├── Cargo.toml
    └── tauri.conf.json
```

---

## 开发与构建

### 前置要求

- Node.js ≥ 18（本项目验证于 22.22.2）
- Rust stable（验证于 1.97.1 msvc）
- Windows：MSVC Build Tools + WebView2 Runtime
- Linux：`libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
- macOS：Xcode Command Line Tools

### 命令

```bash
npm install

npm run dev        # 仅前端 Vite 开发服务器（localhost:1420）
npm run build      # tsc --noEmit && vite build（前端类型检查 + 打包）

npm run app:dev    # Tauri 桌面开发模式（前端 + Rust 热重载）
npm run app:build  # 打包生产安装包（msi/dmg/AppImage）
```

> `cargo` / `rustc` 若不在 PATH：`export PATH="$HOME/.cargo/bin:$PATH"`

### IPC 约定

所有二进制数据（终端输出、串口字节流）跨 Tauri IPC 边界时使用 **base64** 编码，避免非法 UTF-8 被破坏。

事件命名规范：

| 事件 | 说明 |
| --- | --- |
| `ssh-data-{sessionId}` / `ssh-closed-{sessionId}` | SSH 数据流 / 会话关闭 |
| `pty-data-{sessionId}` / `pty-closed-{sessionId}` | 本地 PTY |
| `serial-data-{sessionId}` / `serial-closed-{sessionId}` | 串口 |
| `sftp-progress` | 上传/下载进度 |

---

## 已知限制 / 后续路线

- [ ] 凭据托管升级到 Stronghold / 系统 Keychain
- [ ] 主机指纹持久化 + 变更告警（当前仅 TOFU 记录，未落库比对）
- [ ] 端口转发（Local / Remote / Dynamic SOCKS）
- [ ] 会话录制与回放
- [ ] SFTP 断点续传 + 目录递归传输
- [ ] 串口 Plot 自定义解析规则（当前为启发式 `key:value` / CSV）
- [ ] 插件系统

---

## License

MIT
