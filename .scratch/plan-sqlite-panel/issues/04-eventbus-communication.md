# 04 — EventBus 通信替换

**What to build:** planStore 和 planHistoryStore 的数据变更通知从自定义 subscribe/notify 改为 GUI 标准的 EventBus（`eventBus.emit` + `useEvent` hook），确保计划面板数据实时刷新。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] planStore: `updatePlan()` / `clearPlan()` 改为 `eventBus.emit(PLAN_UPDATED, {tasks}, sticky)`
- [ ] planHistoryStore: `notify()` 改为 `eventBus.emit(PLAN_HISTORY_CHANGED, {records})`
- [ ] events.ts: 新增 `PLAN_UPDATED` / `PLAN_HISTORY_CHANGED` 事件常量 + payload 类型
- [ ] PlanPanel: 使用 `useEvent()` hook 取代 `planSubscribe` / `historySubscribe`
- [ ] useChatBridge: 修复 `getPlanTasks` 动态→静态导入的 Vite 警告
