# 08 �?终端退出后刷新 + 命令发送流�?
**What to build:** C 类命令的完整流程：检测命�?�?spawn 终端 �?检测终端关�?�?发�?plugin_refresh�?
**Blocked by:** 04 (命令路由), 07 (终端 Claude 启动)

**Status:** completed

- [ ] `ChatInputPanel.tsx` �?`App.tsx` �?`handleSend` 中增加路由检测：
  - 在发送消息前检查文本是否以 `/cmd` 开�?  - 调用 `routeCommand(cmdName)` 获取路由决策
  - B 类：不发送文本，改为打开对应 panel
  - C 类：不发送文本，�?`invoke("open_system_terminal", { workDir, claudeLaunch: true })`
  - D 类：不发送文本，显示 toast 提示"此命令在 GUI 中不可用"
  - A 类：正常发送文本到后端（走现有 sendMessage 路径�?- [ ] C �?spawn 后监控终端关闭：
  - Tauri invoke 返回后（同步或通过事件）检测终端退�?  - 调用 `requestPluginRefresh()` 发�?WS 消息
  - 显示 toast "命令列表已刷�?
- [ ] 验证：C 类命令触发终�?�?终端关闭 �?slashCommands 更新

**实现说明�?*
- 路由检测在 `handleSend` 中执行，�?WS sendMessage 之前
- B �?panel 激活通过 `eventBus.emit` + `ensureGroupVisible` + `setActiveTab`
- Tauri 检测终端关闭：可用 `command.spawn()` 返回�?Child handle，或用简�?polling
