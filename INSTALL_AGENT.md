# Antigravity Agent Installation Guide (`plugin-sync`)

This document is an automated installation runbook for an **Antigravity Agent**.
When a user shares this file (or asks you to install `antigravity-plugin-sync`), follow these steps in order.

> **Runtime note:** `plugin-sync` is written in zero-dependency Node.js ESM (`.mjs`) and reuses Antigravity's built-in `agy-node` runtime. **Do not install Python, system Node.js, or any `npm` packages.**

---

## Step 1: Download the Repository to a Temporary Directory

Detect the current OS (`Windows` vs `macOS` / `Linux`) and download `https://github.com/PolarPandaC/antigravity-plugin-sync` into a temporary folder (never into the user's project workspace).

- **If `git` is available:**
  ```bash
  git clone --depth 1 https://github.com/PolarPandaC/antigravity-plugin-sync.git "<TEMP_DIR>/antigravity-plugin-sync"
  ```
- **If `git` is not available**, download and extract `https://github.com/PolarPandaC/antigravity-plugin-sync/archive/refs/heads/main.zip`.

---

## Step 2: Run the Installer Script

Inside `<TEMP_DIR>/antigravity-plugin-sync`, run the OS-appropriate installer.

> [!IMPORTANT]
> **Do NOT pass `--enable-sidecar` and do NOT hand-edit `~/.gemini/config/config.json`.** Installing into `~/.gemini/config/plugins/plugin-sync` is sufficient for Antigravity to discover the plugin and its sidecar automatically.

- **Windows (PowerShell):**
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  ```
- **macOS / Linux:**
  ```bash
  chmod +x ./install.sh
  ./install.sh
  ```

---

## Step 3: Verify Installation & Clean Up Temp Files

1. Verify that both files exist:
   - `~/.gemini/config/plugins/plugin-sync/plugin.json`
   - `~/.gemini/config/plugins/plugin-sync/sidecars/plugin-sync/main.mjs`
2. Delete `<TEMP_DIR>/antigravity-plugin-sync` so no temporary files are left behind.

---

## Step 4: Ensure Official Google Drive Plugin (`gdrive`) Is Ready

Check whether `~/.gemini/config/plugins/gdrive` is already installed:

- **If NOT installed:**
  1. Emit the Marketplace plugin card on its own line so the user can install it with one click:
     ```markdown
     <plugin-card catalog-id="antigravity-plugins-official/plugin/gdrive"></plugin-card>
     ```
  2. Wait for the user to install it, then proceed to initialize `gdrive`.
- **Once installed**, run its CLI initializer once to download the local `gdrive` binary:
  - **Windows (PowerShell):**
    ```powershell
    & "$env:USERPROFILE\.gemini\config\plugins\gdrive\skills\gdrive\scripts\gdrive.cmd" --version
    ```
  - **macOS / Linux:**
    ```bash
    ~/.gemini/config/plugins/gdrive/skills/gdrive/scripts/gdrive --version
    ```

---

## Step 5: Hand Back to the User

Tell the user clearly:

1. **Restart Antigravity Desktop App once** so the `plugin-sync` background sidecar starts cleanly.
2. Open the **Plugin Sync** panel from the **`+`** menu in the top-right side pane (or click `[Plugin Sync](sidecar://plugin-sync/plugin-sync/)`).
3. Click **设置**:
   - Choose **官方 Google Drive 插件 (免填 Client ID，推荐)**
   - Click **保存设置**
   - Click **一键登录 Google 账号** and authorize in the browser (use the same Google account across Windows / macOS / Linux devices).
4. Click **立即同步** once (future startups will auto-sync in the background).

---

## Upgrading & Uninstalling

- **Upgrade:** Re-run Step 1–3; `install.ps1` / `install.sh` upgrades `~/.gemini/config/plugins/plugin-sync` in place without losing local settings.
- **Uninstall:**
  - Windows: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Mode Uninstall`
  - macOS / Linux: `./install.sh --uninstall`
  - Add `--purge-data` to also remove `~/.gemini/antigravity/sidecar_data/plugin-sync_plugin-sync`.
