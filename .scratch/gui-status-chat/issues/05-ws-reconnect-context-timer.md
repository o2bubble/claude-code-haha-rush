# 05 — WebSocket 自动重连 + 上下文窗口实时更新

**What to build:** 后端重启时 GUI 自动重连 WebSocket，上下文窗口 token 计数实时刷新。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 断线时检测后端端口（可能已换端口）
- [x] 端口不变时也能强制重连
- [x] 指数退避重试：1s → 2s → 4s → ... → 30s
- [x] 重连成功时重置退避 + 状态栏提示
- [x] 后端 500ms 定时器在 busy 时推送 context_window
- [x] 输出 token 使用累计值（getTotalOutputTokens）而非单次 API 响应值
