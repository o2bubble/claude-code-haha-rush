# 04 — 底部状态栏消息日志

**What to build:** 底部状态栏改为可展开的消息面板，记录后端生命周期和 WebSocket 事件。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 收起状态显示最新消息，展开查看完整历史（最多 100 条）
- [x] 非 error 消息 5 秒后自动消失回到空状态
- [x] error 消息永久保留直到用户查看
- [x] 点击外部自动收起
- [x] 后端启动/连接/失败/停止事件写入消息日志
- [x] WebSocket 连接/断开事件写入消息日志
