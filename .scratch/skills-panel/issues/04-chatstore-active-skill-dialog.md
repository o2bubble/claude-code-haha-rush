# 04 — chatStore 新增 activeSkillDialog 字段

**What to build:** `ChatState` 新增 `activeSkillDialog: { skill: SlashCommand; isFav: boolean } | null`，用于在浮动窗口 drag 时保持数据。

**Status:** completed

- [x] 类型：`{ skill: SlashCommand; isFav: boolean } | null`
- [x] 默认 `null`
- [x] Set：打开对话框时 `updateChatState({ activeSkillDialog: {...} })`
- [x] Clear：发送/关闭时 `updateChatState({ activeSkillDialog: null })`

**实现说明:**
- 同 AskQuestion 模式：数据存在 store 而非模块变量，drag 时不会丢失
