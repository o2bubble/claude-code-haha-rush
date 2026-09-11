# 13 — WS 集成 + @ref 扩展

**What to build:** WebSocket handlers 和 ReferenceType 扩展

**WS (useChatBridge.ts):**
- [ ] `handlers["data_registry_list"]` → 调用 `getAllDataSources()` → send 结果
- [ ] `handlers["data_registry_query"]` → 调用 `queryData(itemId, key)` → send 结果
- [ ] `handlers["data_registry_operation"]` → 调用 `executeOperation(itemId, op, params)` → send 结果
- [ ] 注册命令 `DESKTOP_QUERY_DATA` (commands.register) 供其他面板调用

**@ref 扩展:**
- [ ] `reference.ts`: ReferenceType 添加 `"desktop"` 和 `"desktop-item"`
- [ ] `referenceParser.ts`: KNOWN_TYPES 添加新类型
- [ ] `referenceActions.ts`: openReference 添加 desktop/desktop-item 分支（激活桌面面板 + 定位 item）

**"发送到 Agent" 功能:**
- [ ] itemToText() 工具函数：按 content.type 格式化内容为文本
- [ ] `commands.execute("SEND_MESSAGE", itemToText(item))` 发送到聊天
