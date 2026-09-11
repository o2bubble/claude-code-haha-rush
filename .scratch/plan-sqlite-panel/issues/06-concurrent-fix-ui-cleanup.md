# 06 — 并发加载修复 + UI 清理

**What to build:** 修复 `loadMorePlans` 被并发调用时相同数据 append 两次导致 UI 渲染重复记录的问题。generation 计数器在 `resetPagination` 时递增，在途请求完成后检查该计数器，不匹配则丢弃结果。同时删除历史计划条目上的状态标签（等待中/进行中），因 agent 常忘记更新 TodoWrite 导致状态不可靠。

**Blocked by:** 04 — EventBus 通信替换

**Status:** ready-for-agent

- [ ] planHistoryStore: 加 `generation` 计数器，`resetPagination` 时递增，`loadMorePlans` 完成后校验
- [ ] PlanPanel: 删除 `STATUS_BADGE` 常量
- [ ] PlanPanel: 删除历史条目上的状态标签渲染（保留任务计数 done/total）
