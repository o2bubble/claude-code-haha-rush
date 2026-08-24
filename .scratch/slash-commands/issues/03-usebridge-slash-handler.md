# 03 �?useChatBridge 处理 slash_commands �?plugin_refresh

**What to build:** `useChatBridge.ts` 中：
1. `system` message handler 增加 `slash_commands` subtype 处理 �?`updateChatState({ slashCommands })`
2. `send()` 函数增加 `plugin_refresh` 消息类型
3. 导出 `requestPluginRefresh()` 函数供其他模块调�?
**Blocked by:** 02 (需�?chatStore.slashCommands 字段)

**Status:** completed

- [ ] `handlers["system"]` 增加 `slash_commands` subtype 分支�?  - `msg.subtype === "slash_commands"` �?`updateChatState({ slashCommands: msg.commands })`
- [ ] `send()` switch case 增加 `"plugin_refresh"` �?`msg.type = "plugin_refresh"`
- [ ] 导出 `requestPluginRefresh()` 函数
- [ ] 验证：mock system 消息 �?chatStore.slashCommands 已更�?
**实现说明�?*
- 后端通过 WebSocket 发送的格式：`{ type: "system", subtype: "slash_commands", commands: [{ cmd, desc, type }] }`
- 后端连接时自动发送一次，插件刷新后再发送一�?