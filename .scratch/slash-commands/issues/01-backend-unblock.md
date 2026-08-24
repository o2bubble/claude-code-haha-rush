# 01 �?后端去拉�?9 个命�?+ 新增 plugin_refresh WS 消息

**What to build:** �?`ideMode.ts` 中：
1. �?`tuiOnlyLocalJsx` 数组中移�?9 个命令：`doctor`, `hooks`, `agents`, `tasks`, `ide`, `tag`, `fast`, `branch`, `reload-plugins`
2. 新增 `plugin_refresh` WS 消息处理�?   - 收到 `{ type: "plugin_refresh" }` 后调�?`refreshActivePlugins()`
   - 重新执行 `getCommands(cwd)` 刷新命令列表
   - 向所有已连接客户端发送更新后�?`{ type: "system", subtype: "slash_commands", commands: [...] }`

**Blocked by:** None

**Status:** completed

- [ ] �?`tuiOnlyLocalJsx` 移除 `doctor`, `hooks`, `agents`, `tasks`, `ide`, `tag`
- [ ] �?`tuiOnlyLocalJsx` 移除 `fast`, `branch`, `reload-plugins`
- [ ] `fast` 命令：加 handler，toggle fast mode 后返回文本确�?- [ ] `branch` 命令：加 handler，fork 会话后返回文本确�? 
- [ ] `reload-plugins` 命令：加 handler，调�?`refreshActivePlugins()` 后返回文本确�?- [ ] 新增 `plugin_refresh` WS 消息 handler
- [ ] 验证：发�?WS 消息后，slash_commands 更新推送到客户�?
**实现说明�?*
- `refreshActivePlugins()` 导入�?`src/utils/plugins/refresh.ts`
- `getCommands(cwd)` 已在 ideMode.ts 顶部调用，复用现有变�?- 去拉黑的 `local-jsx` 命令会走 `renderToString` 降级渲染（已有路径），不需要额外处�?- `fast` �?`branch` �?`local-jsx` 型，`reload-plugins` �?`local` 型（`supportsNonInteractive: false`）——需要在 `tryHandleSlashCommand` 中加专门处理
