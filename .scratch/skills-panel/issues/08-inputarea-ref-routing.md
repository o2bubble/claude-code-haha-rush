# 08 — InputArea @ref 路由（对话框打开时跳过）

**What to build:** InputArea 的 `CHAT_ADD_REFERENCE` handler 加 guard——`activeSkillDialog` 非 null 时跳过。

**Status:** completed

- [x] `if (getChatState().activeSkillDialog) return;` 加在 handler 首行
- [x] `CHAT_INSERT_TEXT` 不受影响（仍走 InputArea）

**实现说明:**
- SkillDialog 自己也订阅了 `CHAT_ADD_REFERENCE`，无需任何分发逻辑
- 两个消费者通过 store flag 互斥
