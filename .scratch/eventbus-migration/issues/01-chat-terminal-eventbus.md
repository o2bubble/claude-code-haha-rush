# 01 — chatStore + terminalStore EventBus 迁移

**What to build:** 将 chatStore 和 terminalStore 的自定义 subscribe/notify 模式替换为 EventBus 事件（`CHAT_STATE_CHANGED`、`TERMINAL_CHANGED`），6 个消费者组件改用 `useEvent`/`useEventHandler` hooks。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] chatStore: 删 subscribe/listeners/notify，4 个 mutator 改为 `eventBus.emit(CHAT_STATE_CHANGED, {state}, sticky)`
- [ ] terminalStore: 删 subscribe/listeners/notify，9 个 mutator 改为 `eventBus.emit(TERMINAL_CHANGED, {entries, activeEntryId})`
- [ ] events.ts: 加 `CHAT_STATE_CHANGED`、`TERMINAL_CHANGED` 事件 + payload 类型
- [ ] ChatMessagesPanel、ChatInputPanel、SessionPanel、TasksPanel、WorkerPanel: subscribe → useEvent
- [ ] TerminalPanel: subscribe → useEventHandler
