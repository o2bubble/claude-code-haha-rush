# 04 — SettingsPanel 切换工作区入口

**What to build:** Settings 面板增加"切换工作区"按钮，点击后重新打开 WorkspaceSelector。

**Blocked by:** 02, 03

**Status:** completed

- [x] SettingsPanel 添加 eventBus + Events import
- [x] 工作目录区域下方增加"切换工作区"按钮
- [x] 点击按钮 emit `Events.WORKSPACE_OPEN_SELECTOR`
- [x] App.tsx 监听该事件，重新设置 workspaceList 并显示 WorkspaceSelector
- [x] i18n：`settings.switchWorkspace` 中英文

**实现说明：**
- 使用 eventBus 解耦 SettingsPanel 和 App.tsx，无需 prop drilling
- 打开选择器时从 `getSettings()` 读取最新的 workspaces 列表
