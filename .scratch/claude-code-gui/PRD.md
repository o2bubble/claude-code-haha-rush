# PRD: Claude Code Desktop GUI

> Status: `ready-for-agent` | 2026-07-17

## Problem Statement

当前 claude-code-haha 只有一个 Ink 终端 TUI 和一个基于 vanilla JS 的浏览器聊天 UI（general_ui）。缺少一个真正的桌面 GUI 应用，无法利用原生窗口管理、系统级文件对话框，以及 eidtor-baby-dev 中已验证的灵活面板/布局/拖拽系统。

用户需要一个跨平台桌面应用，具备可拖拽重排的面板布局、与 IDE mode 后端通信的聊天面板，以及项目文件浏览能力。

## Solution

构建一个基于 Tauri 2 + React 18 + TypeScript 的桌面 GUI 程序（位于 `gui/` 目录），直接复用 eidtor-baby-dev 的布局系统（layout tree + drag-drop + floating windows + panel registry），通过 WebSocket 连接到 claude-code-haha 的 IDE mode 后端实现聊天功能。

核心设计：
- **Tauri 2 壳**：原生窗口、系统文件对话框、进程管理
- **布局系统**：从 eidtor-baby-dev 完整移植（LayoutRenderer, FloatingRenderer, layoutStore, panelRegistry）
- **后端通信**：与 general_ui 相同的 WebSocket 协议（`ws://127.0.0.1:<port>/ws`），Rust 侧负责启动 IDE mode 子进程
- **不包含**：Monaco 编辑器、顶部菜单栏、文件编辑功能

## User Stories

1. As a user, I want to launch a native desktop app that shows a flexible panel layout, so that I can arrange my workspace to my liking.
2. As a user, I want to drag-and-drop tabs between panels and into floating windows, so that I can customize my workspace layout.
3. As a user, I want to resize panels by dragging dividers between them, so that I can adjust space allocation.
4. As a user, I want to type messages in a chat panel and see streaming AI responses, so that I can interact with Claude.
5. As a user, I want to see rendered Markdown, code blocks with syntax highlighting, and collapsible tool execution cards in chat messages, so that I can easily read complex responses.
6. As a user, I want to see thinking/reasoning blocks collapsed by default with an option to expand, so that the chat stays readable.
7. As a user, I want to approve or deny tool execution permissions inline, so that I maintain control over what the AI does.
8. As a user, I want to browse the project file tree in a side panel, so that I can understand the project structure.
9. As a user, I want to switch between chat sessions, so that I can work on multiple topics.
10. As a user, I want to see background agent tasks and their progress, so that I can track parallel work.
11. As a user, I want the app to auto-reconnect to the backend if the connection drops, so that I don't lose my work.
12. As a user, I want floating windows that can be dragged back ("docked") into the main layout, so that I can temporarily expand a panel and then restore it.

## Implementation Decisions

### Architecture

- **前端框架**：React 18 + TypeScript + Vite 6，沿用 eidtor-baby-dev 的技术栈
- **桌面壳**：Tauri 2（Rust），二进制体积约 8MB
- **后端通信**：WebSocket 直连 IDE mode（与 general_ui `bridge.js` 相同协议），不经过 IPC 中转
- **状态管理**：模块级单例 + 订阅-发布模式（与 layoutStore 相同模式），不用 Zustand/Redux

### Layout System

- 完整移植 eidtor-baby-dev 的布局系统，不做修改
- 默认布局：左侧 activity bar（Chat/Sessions/Files）+ 中间聊天区 + 右侧可隐藏面板 + 底部可隐藏面板
- `PINNED_GROUPS` 机制保留：系统锚点面板只能隐藏不能删除
- 默认左侧栏较窄（5%），主要空间给中间聊天区（95%）

### Chat Panel

- 仿 general_ui 的消息渲染逻辑，但用 React 组件重写
- Markdown 渲染用 `marked` + `highlight.js`
- 流式更新用 `requestAnimationFrame` 节流
- 消息状态存在模块级 `chatStore`（与 layoutStore 相同模式）
- WebSocket 连接封装为 `useChatBridge` hook

### Backend Integration

- Tauri Rust 启动时 spawn IDE mode 子进程
- 通过 stdout 解析 `CLAUDE_CODE_IDE_PORT` 获取 WebSocket 端口
- 前端直接通过浏览器 WebSocket API 连接（CSP 已开放 `ws:` `wss:`）

### File Browser

- 从 eidtor-baby-dev 移植 FileTree + ExplorerPanel
- Rust 侧实现 `read_dir` + `read_file` Tauri 命令（从 eidtor-baby-dev 复制）
- `fileService.ts` 封装 Tauri IPC（动态 import 模式，优雅降级）

## Testing Decisions

- 每个 Phase 完成后手动验证：启动 `cargo tauri dev`，确认对应功能可用
- 前端可通过 `bun run dev` 单独在浏览器中测试（Vite HMR）
- Rust 侧 `cargo check` 确保编译通过
- 布局系统已在 eidtor-baby-dev 中充分验证，移植后回归测试拖拽/分割/浮窗操作

## Out of Scope

- Monaco 代码编辑器
- 顶部菜单栏（MenuBar）
- 终端面板
- 插件系统
- 深色主题（后续迭代）
- Tauri 原生子窗口（Phase 1 不做，后续考虑）
- 会话持久化（Session Storage 集成，后续 Phase）

## Further Notes

- Phase 1（Tauri 骨架 + 布局系统移植）已完成：
  - `gui/` 目录已创建，完整文件结构就位
  - 布局系统文件已从 eidtor-baby-dev 移植
  - 默认布局树已适配新面板 ID（chat/sessions/files）
  - 前端构建通过（`bun run build`），Rust 编译通过（`cargo check`）
  - CSP 已配置允许 WebSocket 连接
  - Vite watcher 已排除 Rust target 目录
- Phase 2（聊天面板）待开始
