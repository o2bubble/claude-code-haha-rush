# 02 — Toolbar 系统终端下拉

**What to build:** Toolbar 新增 Terminal 下拉按钮，点击可选择打开 cmd / PowerShell / Git Bash。

**Blocked by:** 01 — Rust open_system_terminal 命令

**Status:** completed

- [x] Toolbar 新增 `TerminalDropdown` 组件
- [x] 通过 `SETTINGS_CHANGED` EventBus sticky event 获取 `workDir`
- [x] 下拉三选一：Command Prompt / PowerShell / Git Bash
- [x] 调用 `invoke("open_system_terminal", { terminalType, workDir })`
- [x] `Terminal` 图标（lucide-react），`right: 0` 对齐避免窗口裁切
- [x] 放在 PanelDropdown 和 Settings 按钮之间

**实现说明：**
- 遵循 EventBus 规范：通过 `useEvent<SettingsChangedPayload>` 获取 workDir
- `openTerminal()` 动态 import `@tauri-apps/api/core` 调用 invoke
