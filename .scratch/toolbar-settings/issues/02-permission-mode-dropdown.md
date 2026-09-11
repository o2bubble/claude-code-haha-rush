# 02 — Toolbar 权限模式下拉

**What to build:** 在顶部工具栏添加权限模式下拉菜单，5 种模式，选择后通过 WebSocket 发送给后端。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 5 种权限模式：Default、Accept Edits、Plan Mode、Bypass、Don't Ask
- [ ] 鼠标 hover 显示模式说明 tooltip
- [ ] 通过 EventBus `CHAT_STATE_CHANGED` 读取当前 `permissionMode`
- [ ] 选择后通过 WebSocket 发送 `set_permission_mode`（useChatBridge 新增方法）
- [ ] 后端响应 `permission_mode_changed` → 更新 chatStore → UI 同步
- [ ] UI 样式：紧凑 pill 按钮，当前模式高亮
