# 03 — PlanPanel 重写：当前计划 + 历史时间线

**What to build:** 重写 PlanPanel 组件。上部分显示 agent 当前 TodoWrite 的任务列表（进度条 + 任务条目）；下部分显示按 session 分组的历史计划时间线，日期分割线分隔不同天，每个计划可展开查看任务列表，底部 IntersectionObserver 触发分段加载更多。

**Blocked by:** 02 — 前端数据层

**Status:** ready-for-agent

- [ ] 上部分：当前计划区域，复用现有进度条 + 任务列表渲染逻辑（来自 planStore）
- [ ] 下部分：历史时间线，首次加载 20 条，按 created_at 倒序
- [ ] 历史条目按日期分组，日期变化时插入分割线（灰色横线 + 居中日期标签）
- [ ] 每个 session 组显示 session title + plan 数量 badge
- [ ] 单个 plan 条目：done/total 进度 + 标题，点击展开显示完整任务列表
- [ ] IntersectionObserver 监听底部 sentinel，触底时 loadMorePlans() 追加
- [ ] 当前计划区域和历史时间线之间有视觉分隔
- [ ] `npm run build` 编译通过
