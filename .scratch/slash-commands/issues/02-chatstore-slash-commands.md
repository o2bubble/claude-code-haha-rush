# 02 �?chatStore 新增 slashCommands 字段

**What to build:** `chatStore.ts` �?`ChatState` 新增 `slashCommands: SlashCommand[]` 字段，用于存储后端推送的可用命令列表�?
**Blocked by:** None

**Status:** completed

- [ ] 定义 `SlashCommand` 接口：`{ cmd: string, desc: string, type: string }`
- [ ] `ChatState` 新增 `slashCommands: SlashCommand[]`，默�?`[]`
- [ ] `updateChatState()` 支持更新 slashCommands
- [ ] 验证：通过 `getChatState().slashCommands` 可读�?
**实现说明�?*
- 接口定义可放�?`chatStore.ts` 文件内，不单独建类型文件
- `type` 字段值：`"local"` | `"skill"` | `"prompt"`（来自后端）
