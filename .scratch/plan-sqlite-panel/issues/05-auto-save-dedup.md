# 05 — 计划自动保存 + 去重修复

**What to build:** agent 未走 ExitPlanMode 时也能保留中间 todo 列表。`updatePlan()` 写入新任务前比较新旧任务内容摘要，不同则自动将旧计划存入 SQLite。同时修复 ID 去重策略，同一组任务内容无论从哪个路径保存都生成相同 ID。

**Blocked by:** 04 — EventBus 通信替换

**Status:** ready-for-agent

- [ ] planStore: `updatePlan()` 内比较 `tasksDigest`，不同则调用 `saveCurrentPlan` 自动保存旧计划
- [ ] planStore: `tasksDigest()` 对任务内容排序后 hash，导出供 planHistoryStore 复用
- [ ] planHistoryStore: ID 从 `sessionId-planTitle` 改为 `sessionId-tasksDigest(tasks)`，确保同任务同 ID
