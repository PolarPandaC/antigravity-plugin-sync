# Antigravity Plugin Sync (`plugin-sync`)

通过 **Google Drive** 在 **Windows / macOS / Linux** 多台电脑之间同步 Antigravity 桌面端插件，并在侧边栏提供管理面板。

**纯 Node.js 零依赖实现**：直接复用 Antigravity 桌面端内置的 Node.js 22+ 运行时（`agy-node`），**无需安装 Python、无需安装系统 Node.js、无需 `npm install`**。

## 核心能力

- **启动自动同步**：借助 Antigravity Sidecar 机制，在 B 电脑启动 Antigravity 桌面端时自动拉起后台进程，自动补装 A 电脑新安装的插件并同步更新。
- **侧边栏管理面板**：可在右上角辅助栏 `+` 打开 **Plugin Sync**，查看全部已安装/云端/排除/内置插件状态、手动触发同步与排查日志。
- **安全删除确认（防误删）**：
  - 本机卸载了某插件：云端不会立刻消失，侧边栏顶部会提示 **“本机已删除插件 X，是否同步删除云端？”**，可选择 `同步删除云端` 或 `从云端恢复`。
  - 其他设备删除了某插件：本机不会静默丢失，侧边栏顶部会提示 **“设备 Y 已删除插件 X，是否同步从本机删除？”**，可选择 `同步从本机删除`（移至可恢复的 `trash/` 回收站）、`仅本机保留` 或 `重新上传到云端`。
- **三种 Google Drive 后端**：官方 **Google Drive 插件 (`gdrive`，免填 Client ID)**、**Google Drive API (自建 OAuth 2.0)**、**`rclone`**；数据存放在你 Google Drive 可见目录 `AntigravityPluginSync/`。

---

## 一、快速安装（无需装 Python / Node.js）

只要你的电脑已经安装并启动过一次 **Antigravity 桌面端**，直接克隆本仓库并运行安装脚本即可：

### Windows (PowerShell)

```powershell
git clone https://github.com/PolarPandaC/antigravity-plugin-sync.git
cd antigravity-plugin-sync
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/PolarPandaC/antigravity-plugin-sync.git
cd antigravity-plugin-sync
chmod +x ./install.sh
./install.sh
```

> 卸载命令：Windows 执行 `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mode Uninstall`；macOS / Linux 执行 `./install.sh --uninstall`（追加 `--purge-data` 会同时清理本地同步状态与回收站）。

---

## 二、配置 Google Drive（任选其一）

安装并重启 Antigravity 后，打开侧边栏 **Plugin Sync → 设置**：

### 方式 1：官方 Google Drive 插件（免填 Client ID，推荐）

1. 在 Antigravity 插件市场安装官方 **Google Drive** 插件。
2. 在 Plugin Sync 设置页将同步后端选为 **官方 Google Drive 插件 (免填 Client ID，推荐)**，点击 **保存设置**。
3. 点击 **一键登录 Google 账号**，在浏览器确认授权即可（三台电脑登录同一 Google 账号即可互通）。

### 方式 2：Google Drive API (自建 OAuth 2.0)

如需独立于官方 `gdrive` 插件，可在 Google Cloud 免费建一个桌面客户端凭据（三台电脑共用同一个 Client ID / Secret）：

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，启用 **Google Drive API**。
2. 在 OAuth 同意屏幕添加你的 Google 邮箱为测试用户。
3. 创建 **桌面应用 (Desktop app)** OAuth 客户端 ID 并下载 JSON，点击设置页的 **导入 Google credentials.json**，保存后点击 **使用 Google 账号登录**。

### 方式 3：`rclone`

1. 在终端运行 `rclone config` 配置名为 `gdrive` 的 Google Drive 远程。
2. 在 Plugin Sync 设置页选 `rclone`，点击 **检测 rclone 远程** 并选中它保存。

---

## 三、数据目录与安全恢复

- 同步配置、日志、备份与回收站均位于：
  `~/.gemini/antigravity/sidecar_data/plugin-sync_plugin-sync/data/`
- 插件被云端更新覆盖前，旧版本会自动备份至 `data/backups/`；确认从本机删除的插件会移至 `data/trash/`。
- `plugin-sync` 自身、`.git`、`node_modules`（可在设置中关闭）、`.env`、`.DS_Store`、`credentials.json` 等文件默认自动排除。
