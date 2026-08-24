# 03 — Leaf Store 镜像 + ChatMessages 子窗口可用

**What to build:** Leaf 窗口的 ChatStore 改为镜像模式——不连 WebSocket，数据全部来自 DataBus（从 BridgeIn 流入）。Hub 侧 WS Adapter 改为发布到 DataBus topic 而非直接调 Store mutator（保持现有 Store 结构不变，只是 WS Adapter 的消息处理改为 `dataBus.publish("chat.message", msg)` 方式）。ChatMessages 面板在 Leaf 中能完整渲染真实聊天消息，支持流式文本增量实时显示。

完成后，用户右键 ChatMessages 标签 → "Open in New Window" → 一个独立的 Tauri 窗口显示真实聊天消息，实时流式文本正常推进。

**Blocked by:** 02 — Bridge 桥接 + 初始化握手

**Status:** ready-for-agent

- [ ] Leaf ChatStore 镜像只读，通过 DataBus subscribe 接收数据
- [ ] Hub WS Adapter 重构：stream_event / assistant / user / result / error 等消息 → `dataBus.publish()` 到对应 topic
- [ ] Hub WS Adapter 订阅 `cmd.*` topic，收到后发送 WS 消息
- [ ] ChatMessages 面板在 FloatingApp 中注册为真实组件（非 placeholder）
- [ ] Leaf 窗口显示当前完整会话消息列表
- [ ] Leaf 窗口流式文本增量（text_delta / thinking_delta）实时渲染
- [ ] Leaf 窗口消息内容块（tool_use / tool_result）正常显示
- [ ] 子窗口 token 消耗栏同步更新
- [ ] 切 session 后 Leaf 消息列表同步更新
- [ ] 从主窗口右键 tab → "Open in New Window" → 子窗口正常显示
