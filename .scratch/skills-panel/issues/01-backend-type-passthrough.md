# 01 — 后端 command type 透传

**What to build:** `ideMode.ts` 的 `broadcastSlashCommands` 将 command.type 透传给前端，不再硬编码 `"local"`。

**Status:** completed

- [x] `commands.map(c => ({ type: c.type || 'local' }))` 替换 `type: 'local'`
- [x] SkillsPanel 按 `c.type === "prompt" || c.type === "skill"` 过滤

**实现说明:**
- `mcp-refresh` 等 IDE 内置命令保持 `type: 'local'`
- 重启后端生效
