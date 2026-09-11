# 11 — SuperDesktopPanel + DesktopTabs + CanvasToolbar

**What to build:** 面板外壳组件

**SuperDesktopPanel:**
- [ ] 顶层组件，渲染 DesktopTabs + CanvasToolbar + SuperDesktopCanvas
- [ ] 用 `useEvent(DESKTOP_CHANGED)` 获取状态
- [ ] `useCommand` 注册 DESKTOP_* 命令 handler
- [ ] mount 时若无桌面则自动创建一个默认桌面
- [ ] mount 时调用 desktopStore 加载 SQLite 数据

**DesktopTabs:**
- [ ] 水平标签栏，显示所有桌面名称
- [ ] 点击切换 → `setActiveDesktop(id)`
- [ ] [+ New] 按钮 → `createDesktop("Desktop N")`
- [ ] 右键菜单：重命名、删除
- [ ] 高亮当前活动标签

**CanvasToolbar:**
- [ ] [添加文本] → 在画布中心创建 TextItem
- [ ] [添加图表] → 弹出类型选择 → 创建 ChartItem
- [ ] [添加图形] → 弹出类型选择(流程图/思维导图) → 创建 GraphicItem
- [ ] [添加引用] → 输入 @ref → 创建 RefItem
- [ ] 缩放控件: [-] [100%] [+]
- [ ] 网格 toggle
- [ ] [发送到Agent] → 选中项的 "Send to Agent"
