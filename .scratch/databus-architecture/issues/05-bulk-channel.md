# 05 — Bulk 通道 + Session 历史 & 文件加载

**What to build:** 实现 Bulk 通道处理一次性大负载 topic：`chat.session.loaded`（切会话的完整消息历史，可达数百条至上千条）、`editor.fileContent`（文件内容）、`plan.history`（Plan 历史分页）、`subagents.transcript`（子代理对话记录）。一次性发送，暂不实现分块传输。

完成后，用户可以在子窗口中切换 session → 完整消息历史正常加载显示。在子窗口中打开文件 → 文件内容正常渲染。

**Blocked by:** 03 — Leaf Store 镜像 + ChatMessages 子窗口可用

**Status:** ready-for-agent

- [ ] Bulk 通道与 Stream/State 通道并发隔离，大负载不阻塞流式文本
- [ ] `chat.session.loaded` 推送 → Leaf 完整替换消息列表
- [ ] `editor.fileContent` 推送 → Leaf Editor 面板渲染文件内容
- [ ] `plan.history` 推送 → Leaf PlanPanel 显示历史记录
- [ ] `subagents.transcript` 推送 → Leaf SubAgentPanel 显示对话记录
- [ ] `cmd.plan.history.load` 命令：Leaf 请求 → Hub SQLite 查询 → Bulk 推送结果
- [ ] `cmd.subagent.transcript` 命令：Leaf 请求 → Hub WS → 后端返回 → Bulk 推送结果
- [ ] 大负载消息携带 `mergeId`，幂等写入不会重复
