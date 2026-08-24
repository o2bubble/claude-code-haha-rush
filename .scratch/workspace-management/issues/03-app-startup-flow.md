# 03 — App.tsx 启动流程改造

**What to build:** 替换 `showWizard` / `FirstLaunchWizard` 为 `showWorkspaceSelector` / `WorkspaceSelector`。每次启动都先显示工作区选择器，用户选完工作区后才启动后端。

**Blocked by:** 01, 02

**Status:** completed

- [x] 去掉 `isFirstLaunch` 启动分支（layout 恢复仍保留在所有分支前）
- [x] `loadSettings()` 后总是 `setShowWorkspaceSelector(true)` + `setAppReady(true)`
- [x] `handleWorkspaceLaunch(workDir, wss)` — 保存 workspaces + workDir 到 settings → 启动后端 → 隐藏选择器
- [x] 监听 `WORKSPACE_OPEN_SELECTOR` 事件（SettingsPanel 触发）
- [x] 移除 `FirstLaunchWizard` 导入，改用 `WorkspaceSelector`

**实现说明：**
- 后端不再在 `.setup()` 后自动连接，而是延迟到用户选择工作区后 `BackendService.init(workDir)` 调用
