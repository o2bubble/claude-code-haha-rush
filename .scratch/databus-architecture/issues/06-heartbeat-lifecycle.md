# 06 — 心跳 + Leaf 生命周期管理

**What to build:** Hub 每 5 秒向所有 Leaf 发送 ping。Leaf 每收到 ping 立即回复 pong。Hub 连续 3 次（15 秒）未收到该 Leaf 的 pong → 将其标记为 dead → 从订阅路由表移除 → 停止向其推送数据。Leaf 侧若发现自己收不到 ping（意味着 Hub 可能重启或路由异常），主动重连（重新走 hello→init→ready 握手）。

完成后，关闭子窗口或子窗口崩溃后，Hub 自动清理其订阅，不会继续向死窗口推送数据。重新打开子窗口能正常恢复。

**Blocked by:** 02 — Bridge 桥接 + 初始化握手

**Status:** ready-for-agent

- [ ] Hub 侧每 5 秒通过 Bridge 发 ping `{ type: "ping" }`
- [ ] Leaf 侧收到 ping 立即回复 pong `{ type: "pong" }`
- [ ] Hub 侧追踪每个 Leaf 的最后 pong 时间戳
- [ ] 连续 3 次 ping 无 pong 回复 → 标记 dead → 清理订阅路由
- [ ] Leaf 15 秒内没收到 ping → 认为连接断开 → 降级重试 → 重新握手
- [ ] Leaf 主动关闭窗口 → 发 goodbye 信号 → Hub 立刻清理（不走超时）
- [ ] 清理后不向该 Leaf 推送任何数据
- [ ] Hub 日志记录窗口加入/离开/超时事件
