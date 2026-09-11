# 05 — 文件树右键"发送到聊天"

**What to build:** 在 `FileTree.tsx` 右键菜单中添加"发送到聊天"选项，将文件/目录转换为 `@ref{...}` 插入到输入框。

**Blocked by:** 02 — 引用解析器（需要 formatReference）

**Status:** completed

- [x] 文件树右键菜单增加"发送到聊天"选项（位于重命名和删除之间）
- [x] 文件: 插入 `@ref{file:<absPath>|<basename>}`
- [x] 目录: 插入 `@ref{dir:<absPath>|<dirname>}`
- [x] 调用 `formatReference()` 生成字符串
- [x] 通过 EventBus `CHAT_INSERT_TEXT` 事件传递到 InputArea
- [x] 菜单项带 `<Send>` 图标（ContextMenu 新增 `icon?: ReactNode` 支持）

**实现说明：**
- InputArea 需要暴露 `insertAtCursor` 或类似方法
- 如果 InputArea 不支持外部插入，需新增一个 EventBus 事件 `CHAT_INSERT_TEXT`
- 文件路径使用绝对路径（agent 需要完整路径读取）
