# 09 �?B 类命�?panel 映射

**What to build:** 当用户输�?B 类命令（�?`/plan`、`/diff`、`/model`、`/tasks`）时，GUI 拦截并打开对应 panel，不发送到后端�?
**Blocked by:** 04 (命令路由), 08 (命令发送流�?

**Status:** completed

- [ ] `/plan` �?确保 PlanPanel 所�?group 可见，激�?PlanPanel tab
- [ ] `/tasks` �?确保 TasksPanel 可见（TaskPanel �?ChatInputPanel 内渲染，始终可见，聚焦即可）
- [ ] `/diff` �?打开 EditorPanel，触�?diff 视图（如无文件变更为空状态）
- [ ] `/model` �?触发 Toolbar ModelDropdown 展开
- [ ] 映射通过 `layoutStore` �?`findTabByPanelId` + `ensureGroupVisible` + `setActiveTab` 完成
- [ ] 验证：输�?`/plan` �?PlanPanel 获得焦点

**实现说明�?*
- B 类命令不消�?token——纯 GUI 侧操�?- 如果目标 panel 所在的 group 是隐藏状态，�?`ensureGroupVisible`
- `/diff` 需�?EditorPanel 打开——如果当前无打开文件，显示提�?无文件变�?
