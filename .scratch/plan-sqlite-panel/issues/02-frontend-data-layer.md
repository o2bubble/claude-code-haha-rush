# 02 — 前端数据层：planStore 简化 + planHistoryStore 新建 + bridge 清理

**What to build:** 清理前端 plan 相关的数据流。planStore 回退到纯任务列表（砍掉状态机）；新建 planHistoryStore 封装 Tauri invoke 调用实现分段加载；useChatBridge 移除所有 EnterPlanMode/ExitPlanMode/markImplementing 逻辑，ExitPlanMode 结果自动写入 DB。

**Blocked by:** 01 — Rust SQLite 后端

**Status:** ready-for-agent

- [ ] `planStore.ts` 移除：PlanStatus、getPlanStatus、getPlanText、setPlanStatus、markImplementing、setPlanText；保留 PlanTask、getPlanTasks、updatePlan、clearPlan、subscribe
- [ ] 新建 `planHistoryStore.ts`：PlanRecord + PlanSession 类型，loadMorePlans() 分段查询，saveCurrentPlan() 写入 DB，resetPagination() 重置偏移
- [ ] `useChatBridge.ts` content_block_stop 中移除 setPlanStatus + markImplementing 调用，只保留 TodoWrite → updatePlan
- [ ] `useChatBridge.ts` assistant handler 中同样移除状态机调用
- [ ] `useChatBridge.ts` session_loaded 中移除 EnterPlanMode/ExitPlanMode 状态恢复，只保留 clearPlan + TodoWrite 恢复
- [ ] `useChatBridge.ts` user handler 中 ExitPlanMode result → 改为调用 saveCurrentPlan 写入 DB
- [ ] `npm run build` 编译通过
