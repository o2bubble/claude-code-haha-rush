# 02 — 子代理面板优化

**What to build:** 子代理面板显示代理类型和任务描述，transcript 消息分页加载，更新时保留名称。

**Blocked by:** None — can start immediately

**Status:** done

- [x] Transcript 消息默认只显示最后 20 条，滚动到顶部加载更多
- [x] 滚动位置保持稳定（同消息列表方案）
- [x] 轮询新消息时自动展开 + 滚动到底部
- [x] 代理列表显示类型名称（Explore/general-purpose）和任务描述
- [x] task_progress/task_completed 不再回退 agentName 为 "agent"
