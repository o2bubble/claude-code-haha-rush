# 01 — DataBus 核心 + Topic 路由 + Stream 通道

**What to build:** 从零实现统一的 `dataBus.subscribe()` / `dataBus.publish()` API，注册完整的 Topic 树，内部按 topic 前缀自动路由到 Stream/State/Bulk/Command 四条通道。Stream 通道实现 RAF 帧内合并——同一帧内多个 delta 拼成一批、一次发送。组件调 `dataBus.subscribe("chat.delta.text", fn)` 即可工作，不区分本地还是远端。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `dataBus.subscribe(topic, handler)` API 可用，支持通配符（`chat.*`）
- [ ] `dataBus.publish(topic, payload)` API 可用
- [ ] Topic 树完整注册（chat/tool/terminal/plan/subagents/editor/files/desktop/settings/workers/status/cmd）
- [ ] 内部 Topic Router 按前缀路由到 4 条逻辑通道
- [ ] Stream 通道：`chat.delta.*` / `terminal.delta.*` 归入 RAF 合并通道
- [ ] Stream 合并策略：每帧（requestAnimationFrame）合并同 topic payload → 一帧一次 emit；无数据帧不 emit
- [ ] `chat.delta.text` / `chat.delta.thinking` 拼接文本 + 保留最大 index
- [ ] `chat.delta.json` / `tool.progress` / `chat.context` 保留最后一条
- [ ] 单窗口内 publish → subscribe 链路通畅（无需 IPC）
