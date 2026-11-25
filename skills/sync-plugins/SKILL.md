---
name: sync-plugins
description: >-
  Manage cross-device Antigravity plugin synchronization via Google Drive (official gdrive plugin, OAuth 2.0, or rclone).
  Use when the user asks to check plugin sync status, sync plugins across Windows/macOS/Linux,
  configure Google Drive sync, or review and confirm pending plugin deletions.
---

# Plugin Sync (`plugin-sync`)

This skill helps the user inspect, trigger, and manage cross-device plugin synchronization via Google Drive (`AntigravityPluginSync/`). It runs on Antigravity's built-in Node.js runtime (`agy-node` / `node`) with zero external dependencies.

## Sidebar UI Panel

When the `plugin-sync/plugin-sync` sidecar is enabled and running, surface a one-click pill so the user can open the sidebar panel directly:

`[Plugin Sync](sidecar://plugin-sync/plugin-sync/)`

## CLI Commands

Locate the plugin directory (`PLUGIN_ROOT`, e.g., `~/.gemini/config/plugins/plugin-sync`) and invoke `scripts/cli.mjs` with `node` (or Antigravity's `agy-node`):

```bash
# Show JSON snapshot of all plugins, connection status, and pending deletions
node "<PLUGIN_ROOT>/scripts/cli.mjs" status --json

# Run a bidirectional sync immediately
node "<PLUGIN_ROOT>/scripts/cli.mjs" sync --json

# Confirm deleting a plugin (local deletion -> mark deleted in Drive; remote deletion -> move local copy to trash)
node "<PLUGIN_ROOT>/scripts/cli.mjs" confirm-delete "<dirName>" --kind local
node "<PLUGIN_ROOT>/scripts/cli.mjs" confirm-delete "<dirName>" --kind remote

# Restore a locally deleted plugin from Google Drive
node "<PLUGIN_ROOT>/scripts/cli.mjs" restore "<dirName>"

# Keep local plugin and ignore a remote deletion notice (or re-upload it to Drive)
node "<PLUGIN_ROOT>/scripts/cli.mjs" keep-local "<dirName>"
node "<PLUGIN_ROOT>/scripts/cli.mjs" reupload "<dirName>"

# Test Google Drive / rclone connection or list rclone remotes
node "<PLUGIN_ROOT>/scripts/cli.mjs" test-connection
node "<PLUGIN_ROOT>/scripts/cli.mjs" list-rclone-remotes
```

## Safety Rules

- Never delete a plugin without explicit user confirmation (via the Sidebar UI or `confirm-delete`).
- Do not hand-edit `~/.gemini/config/config.json` from the agent; guide the user to toggle the plugin in Antigravity UI or use the installer script.
- When the user first sets up Google Drive sync, explain the options clearly:
  1. **Official Google Drive plugin (`gdrive`, recommended)**: Zero Client ID/Secret needed — install Antigravity's official Google Drive plugin, select `gdrive` in Plugin Sync settings, and click **一键登录 Google 账号**.
  2. **Google Drive API (OAuth 2.0)**: Create a Desktop App OAuth Client ID once in Google Cloud Console, paste `Client ID` and `Client Secret` in the Plugin Sync sidebar settings, and click **使用 Google 账号登录**.
  3. **`rclone`**: Install `rclone`, run `rclone config` to add a `drive` remote, then pick that remote in the Plugin Sync sidebar settings.
