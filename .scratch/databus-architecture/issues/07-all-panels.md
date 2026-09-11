# 07 — 全部面板子窗口化 + CSS 浮动迁移

**What to build:** 将剩余全部面板的组件注册到 Leaf 窗口的 FloatingApp 中（替代现有 placeholder），包括：SessionPanel、PlanPanel、TasksPanel、EditorPanel、FileBrowser、TerminalPanel、SubAgentPanel、SuperDesktopPanel、SettingsPanel、WorkersPanel、SkillsPanel、SkillDialog。终端面板的 `terminal.delta.output` 走 Stream 通道。现有 CSS 浮动面板（AskQuestionFloating、SkillDialogFloating）改为使用 Tauri 原生窗口而非 CSS 浮动层。

完成后，用户可以将任意面板拖出主窗口成为独立的原生子窗口，所有面板在子窗口中功能完整。

**Blocked by:** 04 — Command 通道 + ChatInput 子窗口可用；05 — Bulk 通道 + Session 历史 & 文件加载；06 — 心跳 + Leaf 生命周期管理

**Status:** ready-for-agent

- [ ] SessionPanel 在 Leaf 可用：session 列表、切换、新建、删除
- [ ] PlanPanel 在 Leaf 可用：当前 TodoWrite 显示、plan 历史时间线
- [ ] TasksPanel 在 Leaf 可用：后台任务列表、kill 任务
- [ ] EditorPanel 在 Leaf 可用：打开文件、编辑、保存（文件 I/O 走 Leaf 自身 Tauri IPC）
- [ ] FileBrowser 在 Leaf 可用：浏览目录树、展开文件夹、文件右键菜单
- [ ] TerminalPanel 在 Leaf 可用：命令输出行实时追加（走 Stream 通道）
- [ ] SubAgentPanel 在 Leaf 可用：子代理列表、对话记录展开
- [ ] SkillsPanel 在 Leaf 可用：技能浏览、搜索、打开 SkillDialog
- [ ] SuperDesktop 在 Leaf 可用：画布渲染、items 操作（命令转发到 Hub Store）
- [ ] SettingsPanel 在 Leaf 可用：设置查看和修改
- [ ] WorkersPanel 在 Leaf 可用：后端/MCP 状态显示
- [ ] AskQuestionFloating 改为 Tauri 原生子窗口
- [ ] SkillDialogFloating 改为 Tauri 原生子窗口
- [ ] 所有面板 dock 回主窗口功能正常（现有 FloatingRenderer dock 机制复用）
