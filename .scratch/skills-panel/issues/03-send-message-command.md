# 03 — useChatBridge 注册 SEND_MESSAGE 命令

**What to build:** 新增 `commands.register("SEND_MESSAGE", ...)` 让 SkillsPanel 可以跨组件发送消息。

**Status:** completed

- [x] 注册 `"SEND_MESSAGE"` 命令：`addMessage + send("user", { content })`
- [x] SkillsPanel 通过 `commands.execute("SEND_MESSAGE", content)` 调用

**实现说明:**
- 遵循 CommandRegistry 模式，不直接导入 WS 函数
