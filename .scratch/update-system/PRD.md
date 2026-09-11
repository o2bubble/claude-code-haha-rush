# Update System — PRD

## Overview

桌面应用选择性增量更新系统。用户可选择更新 7 个组件中的任意部分，GUI/CLI exe 通过 SHA256 hash 对比，目录组件通过时间戳对比。复用 release-platform (FastAPI, 8765) 作为更新服务器。

## Goal

- 用户无需重新下载安装包即可将 GUI + 运行时组件更新到最新版本
- 支持选择性更新：只更新有变化的组件，跳过不需要的项目
- 支持从服务器补充下载本地缺失的组件（"修复"模式）
- 组件安装后可执行 post-install hooks（数据库迁移、环境变量、注册表等）

## Non-Goals

- 不追求增量/二进制差分包（全量下载组件 zip）
- 不支持版本回滚（只更新到最新）
- 不支持中间版本增量升级链
- 不自动触发更新（用户手动操作）

## Architecture

```
release-platform (123.56.66.84:8765)
  └── /api/updates/latest                     → manifest.json
  └── /api/updates/{version}/components/{name}/download → component.zip
  └── /api/updates/{version}/upload           → (manual release)

GUI Client
  └── Rust update.rs
        ├── check_for_updates(base_url)       → UpdateCheckResult
        ├── download_and_install_component()  → download + extract + post_install
        ├── prepare_gui_update()              → download GUI + write Update.exe instructions
        └── launch_updater_and_exit()         → run Update.exe + exit
  └── JS updateService.ts                     → thin invoke wrappers
  └── UpdatePanel.tsx                         → UI with checkboxes + progress
  └── Toolbar.tsx                             → download button + openUpdateFloat()

Update.exe (standalone Rust exe)
  └── reads %TEMP%/claude-update.json → replace GUI exe → launch new GUI
```

## Components

| ID | Compare | Path(s) | Notes |
|----|---------|---------|-------|
| `gui` | SHA256 | `claude-code-gui.exe` | Self-update via Update.exe stager |
| `claude` | SHA256 | `bin/claude.exe` | CLI backend |
| `bun` | SHA256 | `bin/bun.exe` | Runtime |
| `tools` | timestamp | `bin/rg.exe`, `bin/fd.exe`, etc. | CLI utilities |
| `python` | timestamp | `python/` directory | Embedded Python 3.12 |
| `git` | timestamp | `git/` directory | Git Bash + Git tools |
| `extensions` | timestamp | `extensions/` directory | IDE plugins |

## Manifest Format

```json
{
  "version": "2026.07.30",
  "release_notes": "修复权限持久化竞态 + 新增 WelcomeWizard",
  "published_at": "2026-07-30T12:00:00Z",
  "components": {
    "gui": {
      "sha256": "a1b2c3d4...",
      "size": 15728640,
      "post_install": {
        "type": "command",
        "run": "setx CLAUDE_GUI_VERSION 2026.07.30",
        "description": "Set version env var"
      }
    },
    "python": {
      "updated_at": "2026-07-30T12:00:00Z",
      "size": 120000000,
      "post_install": {
        "type": "script",
        "path": "_post_install.bat",
        "description": "Install new pip packages and run DB migration"
      }
    }
  }
}
```

## Post-Install Hooks

Two types supported:

| Type | Field | Behavior |
|------|-------|----------|
| `script` | `path` | Run a `.bat`/`.cmd` script shipped inside the component zip (relative path) |
| `command` | `run` | Run a shell command directly (e.g., `setx`, `reg add`) |

Rules:
- Executed AFTER files are installed to the target directory
- Working directory = component's install directory
- Hook failure is logged but does NOT fail the update
- Description shown in the GUI before install (⚡ icon)

## Release Flow (Manual)

1. Run `build.ts` → produces `dist/`
2. Build GUI: `cd gui && bun run build && cd src-tauri && cargo build --release`
3. Build Update.exe: `cd updater && cargo build --release`
4. Determine version (YYYY.MM.DD format)
5. Compute SHA256 for gui/claude/bun exes
6. Compute latest mtime for tools/python/git/extensions dirs
7. Write `manifest.json` with release_notes + post_install hooks
8. Create component zips (one per component)
9. Upload to server: `POST /api/updates/{version}/upload` with API key

## Frontend States

```
idle → [Check] → checking → available → [select + Update Selected] → downloading → needsRestart (if GUI) / idle
                                    ↓
                               upToDate (no updates)
                                    ↓
                               error (network/server failure)
```

## Settings

- `updateServerUrl` in AppSettings (Rust + TS) — default `http://123.56.66.84:8765`
- Auto-check on startup: 5s delay, non-blocking, silent on error
- Manual check: Toolbar button → floating UpdatePanel
