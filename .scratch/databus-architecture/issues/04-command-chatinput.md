# 04 — Command 通道 + ChatInput 子窗口可用

**What to build:** 实现 Command 通道——`cmd.*` topic 从 Leaf 通过 Bridge 路由到 Hub 执行者。ChatInput 面板在 Leaf 窗口中完全可用：输入文字发送消息、点击打断按钮、响应权限确认弹窗（allow/deny/always）。实现乐观更新：interrupt 和 send 操作本地立即生效，后端确认后幂等跳过。

完成后，用户可以在子窗口中：打字发送消息、看到流式回复、点击打断按钮、在弹出的权限确认中做选择——和主窗口完全一样的体验。

**Blocked by:** 03 — Leaf Store 镜像 + ChatMessages 子窗口可用

**Status:** ready-for-agent

- [ ] Command 通道：`cmd.*` topic 从 Leaf → BridgeIn → Tauri emit → BridgeOut → Hub DataBus → WS Adapter
- [ ] ChatInput 面板在 FloatingApp 中注册为真实组件
- [ ] Leaf 输入框可打字发送消息，Hub WS 正确转发
- [ ] Leaf 打断按钮可触发 interrupt，后端停止生成
- [ ] 打断乐观更新：Leaf 本地 `chat.streaming` 立即设 false → 后端确认后幂等
- [ ] 发送乐观更新：Leaf 本地立即显示 user message → 后端确认后不变
- [ ] Leaf 权限弹窗正常工作：control_request 广播到 Leaf → 用户选择 → `cmd.permission.respond` 回传
- [ ] AskQuestionOverlay 在 Leaf 中正常工作
- [ ] ChatStatusBar（连接状态、context 百分比、tokens）在 Leaf 中正常显示
- [ ] Slash 命令下拉在 Leaf 输入框中可用
