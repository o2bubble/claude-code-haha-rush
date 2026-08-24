# 06 — InputArea 暴露 insertAtCursor 接口

**What to build:** `InputArea.tsx` 组件暴露 `insertAtCursor(text)` 方法，供外部（右键菜单等）向聊天输入框插入文本。

**Blocked by:** None — 05 依赖此项

**Status:** ready-for-agent

- [ ] InputArea 通过 `useImperativeHandle` + `forwardRef` 暴露 `insertAtCursor(text: string)` 
- [ ] 或：通过 EventBus 事件 `CHAT_INSERT_TEXT` 接收插入请求
- [ ] 插入后光标移到插入文本之后
- [ ] 如果输入框为空：直接 set 内容，光标在末尾
- [ ] 如果输入框有内容：在当前光标位置插入，保留前后内容

**实现说明：**
- EventBus 方案更符合架构（跨面板通信），不需要 ref 透传
- 新增 Event: `chat.insertText`，payload `{ text: string }`
- InputPanel 订阅该事件，在 InputArea 中处理
