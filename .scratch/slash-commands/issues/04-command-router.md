# 04 �?命令路由层（纯函数模块）

**What to build:** 新建 `gui/src/utils/commandRouter.ts`，纯函数，输入命令名 + 类型，返回路由决策�?
**Blocked by:** None（无依赖，纯逻辑�?
**Status:** completed

- [ ] 导出 `RouteCategory` 类型：`"A" | "B" | "C" | "D"`
- [ ] 导出 `RouteDecision` 接口：`{ category, action: "ws_text" | "panel" | "terminal" | "blocked", panelId?, terminalType? }`
- [ ] 导出 `routeCommand(cmdName: string, cmdType?: string): RouteDecision`
- [ ] B 类映射表：`{ plan: "plan", tasks: "tasks", diff: "editor", model: "model" }`
- [ ] C 类列表：`[plugins, config, memory, doctor, hooks, sandbox, btw, session, mobile, passes, feedback, privacy-settings, ultrareview, think-back, remote-env, rate-limit-options, terminal-setup, thinkback-play]`
- [ ] D 类列表：`[exit, login, logout, upgrade, chrome, desktop, output-style, install-github-app, install, stickers, add-dir]`
- [ ] A 类列表（剩余的所有已知命令默认为 A�?- [ ] 路由优先级：B > C > D（不在任何列�?= A�?
**实现说明�?*
- 完全无副作用的纯函数，可单独单元测试
- 命令名匹配用 `toLowerCase()` 处理别名（后端传来的 cmd 已是规范名）
- A 类不需要显式列表——不�?B/C/D 中即�?A
