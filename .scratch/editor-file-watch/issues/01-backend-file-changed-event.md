# 01 — 后端广播 file_changed 事件

**What to build:** 当工具（FileEditTool、BashTool 等）写文件到磁盘后，后端通过 WebSocket 广播 `file_changed` 事件给所有 GUI 客户端。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 确定哪些工具会产生文件变更（至少 FileEdit、Bash、FileWrite）
- [ ] 广播消息格式：`{ type: "file_changed", path: "<absolute-path>" }`
- [ ] 去重：同路径同批次只发一次
- [ ] 广播到所有连接的 WebSocket 客户端
