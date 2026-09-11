# PRD: GUI Settings — Work Directory Configuration

> Status: `ready-for-agent` | 2026-07-17

## Problem Statement

GUI 启动时把 `CLAUDE_CODE_CWD` 硬编码为项目根目录（`claude-code-haha-dev/`），用户无法配置自己的工作区。每次对话的 file I/O 都限定在这个目录，不能切换到其他项目。

需要一个设置面板让用户配置工作目录，并在首次启动时引导用户完成设置。

## Solution

实现一个完整的设置系统：

1. **持久化**：`%APPDATA%/claude-code-gui/settings.json`，由 Rust 端读写，前端通过 Tauri IPC 调用
2. **默认值**：首次启动时默认使用 `~/claude-code-workspace/`
3. **首次向导**：首次启动时弹出向导 Overlay，展示默认工作目录，用户可确认或修改
4. **设置面板**：Activity Bar 添加齿轮图标，点击进入 Settings tab，可随时修改工作目录
5. **后端联动**：工作目录变更后，Rust 重启 IDE 后端进程并传入新的 `CLAUDE_CODE_CWD`

## User Stories

1. As a first-time user, I want to see a setup wizard when I launch the GUI, so that I can confirm or change my workspace directory before starting.
2. As a user, I want my workspace directory setting to persist across restarts, so that I don't need to reconfigure every time.
3. As a user, I want to change my workspace directory from a Settings panel, so that I can switch between projects.
4. As a user, I want a sensible default workspace directory created for me, so that I can start working immediately without manual setup.

## Implementation Decisions

### Settings storage

- File: `%APPDATA%/claude-code-gui/settings.json`（Windows）或 `~/.config/claude-code-gui/settings.json`（Unix）
- Schema: `{ "workDir": string, "isFirstLaunch": boolean }`
- Rust 负责文件 I/O，暴露 3 个 Tauri 命令：`get_settings`, `save_settings`, `get_default_work_dir`
- 前端通过 `settingsStore.ts` 模块级单例封装

### Settings panel

- Activity Bar 新增齿轮图标（`Icons.settings` / Lucide `Settings`）
- 点击后在 sidebar-left 内容区显示设置表单
- 字段：Work Directory（文本输入 + Browse 按钮触发 Tauri dialog）
- Save 按钮 → 前端调 `saveSettings` → 前端通知 Rust 重启后端并传入新 CWD

### First-launch wizard

- `isFirstLaunch === true` 时，ChatPanel 上方显示向导 Overlay
- 内容：标题 + 工作目录输入（预填默认值 `~/claude-code-workspace/`）+ Browse 按钮 + "Get Started" 按钮
- 确认后保存设置，关闭向导，Rust 用该目录启动 IDE 后端

### Backend restart

- `saveSettings` 后，前端调用 `invoke("restart_ide_backend")`
- Rust 杀掉旧进程，用新 workDir 重新 spawn

## Testing Decisions

- `cargo tauri dev` 启动验证
- 删除 `%APPDATA%/claude-code-gui/settings.json` 模拟首次启动
- 修改工作目录后确认 IDE 后端在该目录下操作

## Out of Scope

- 多工作区支持
- 其他设置项（模型、主题等）
- 设置导入/导出
