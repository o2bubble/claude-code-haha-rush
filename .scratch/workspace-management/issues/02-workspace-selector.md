# 02 — WorkspaceSelector 组件

**What to build:** 新建工作区选择器覆盖层组件，替换旧的 FirstLaunchWizard，支持多工作区列表、选中、删除、新建、启动。

**Blocked by:** 01

**Status:** completed

- [x] 工作区列表：显示所有已保存工作区，点击选中（radio 样式高亮）
- [x] 删除工作区：每行 ✕ 按钮，从本地列表移除，启动时同步到 settings
- [x] 新建工作区：文本输入框 + 浏览按钮（Tauri dialog）+ 添加按钮
- [x] 去重检查：添加已存在的工作区时自动选中已有项
- [x] 启动按钮：调用 `onLaunch(selectedWorkDir, workspaceList)` 持久化并启动后端
- [x] 空列表状态：仅显示新建区域 + 引导提示文字
- [x] i18n：`workspace.*` 9 个 key 中英文覆盖

**实现说明：**
- 组件维护本地 `list` state（从 props 复制），删除操作只影响本地
- 点击"启动"时将完整 `list` 回传给 App.tsx，一并持久化
