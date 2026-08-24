# 05 — SkillDialog 组件（contentEditable + @ref chip）

**What to build:** 对话框内容组件，contentEditable 输入区，支持 @ref chip 插入。

**Status:** completed

- [x] 技能名 + 描述 Header
- [x] contentEditable 输入区（多行编辑，Enter 换行，Shift+Enter 发送）
- [x] 监听 `CHAT_ADD_REFERENCE` 事件 → @ref chip
- [x] 监听 `CHAT_INSERT_TEXT` 事件 → 文本插入
- [x] `extractContent` 提取文本（含 `\u00A0` 归一化）
- [x] 底部按钮栏：收藏星标 + 发送按钮
- [x] Escape 关闭
- [x] Props: `{ skill, isFavorite, onToggleFavorite, onSend, onClose }`

**实现说明:**
- 复用 `formatReference()` 生成 @ref 格式
- chip 样式与 InputArea 保持统一
