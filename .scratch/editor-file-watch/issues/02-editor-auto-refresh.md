# 02 — 编辑器自动检测并刷新外部文件变更

**What to build:** 前端监听 `file_changed` WebSocket 事件，自动刷新已打开且未编辑（clean）的编辑器 tab 内容，脏 tab 显示变更指示器。

**Blocked by:** 01 — 后端广播 file_changed 事件

**Status:** ready-for-agent

- [ ] `useChatBridge.ts` 添加 `file_changed` handler，通知 editorStore
- [ ] 干净 tab：自动 `fileService.readFile()` 刷新内容，`markClean()`
- [ ] 脏 tab：不覆盖内容，在 tab 标题旁显示 "磁盘版本已更新" 图标（hover 提示）
- [ ] 脏 tab 点击图标后：提示用户选择 "放弃本地修改并刷新" 或 "忽略"
- [ ] 其他面板（FileBrowser 等）可选择性订阅该事件刷新文件树
