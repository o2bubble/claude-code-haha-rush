# GUI 配置文件体系 (Config Files) — 标准双文件模式

本 GUI 运行的 claude.exe 遵循**官方标准双文件模式**。判断"配置该放哪、改了为什么没生效"时，先读这篇。第三方 MCP 工具/agent 按官方路径自动写的配置，在这里**都能生效**。

## 两条主线

| 文件 | 角色 | 存什么 |
|------|------|--------|
| `~/.claude/settings.json` | **用户设置** | permissions、env、model、hooks、enabledPlugins、pluginConfigs；GUI 的 `gui` 顶层键（主题/语言/服务器/工作区列表/布局） |
| `~/.claude.json` | **全局运行时配置** | 启动计数、userID、projects trust、**user-scope MCP 服务器（`mcpServers`）**、theme、editorMode、feature tracking |

> 第三方工具用 `claude mcp add --scope user` 或直接写 `~/.claude.json` 的 MCP 配置，本系统**正常读取**。`~/.claude.json` 不是被忽略的文件——它是全局配置本体。

## 文件一览（真实生效位置）

| 文件 | 归属 | 存什么 | 谁写 |
|------|------|--------|------|
| `~/.claude/settings.json` | 用户级 | 用户设置（permissions/env/model/hooks）+ `gui` 键 | GUI 设置面板 / `/config` / 手动 |
| `~/.claude.json` | 用户级 | 全局运行时配置 + **user-scope MCP** | 引擎自动 / `claude mcp add --scope user` |
| `<WORK_DIR>/.claude/settings.local.json` | 工作区 | 布局 / 窗口状态 / 会话收藏 / Profile env 注入 | GUI 自动 |
| `<WORK_DIR>/.mcp.json` | 工作区 | **project-scope MCP 服务器**（super-desktop 自动注册在这；后端读取） | GUI 自动 / `claude mcp add --scope project` |
| `~/.claude/skills/` | 用户级 | 用户技能（GUI 技能安装目标） | `install_skill` / 技能市场 |
| `<WORK_DIR>/.claude/skills/` | 工作区 | 工作区技能 | 手动 |
| `<WORK_DIR>/.claude/data.db` | 工作区 | plans / desktops / desktop_items（SQLite） | GUI |
| `~/.claude/notes/notes.db` | 用户级 | 笔记（跨工作区共享） | GUI |
| `~/.claude/.env.profiles/*.env` | 用户级 | Profile 环境（全局共享） | Profile 管理 |
| `<WORK_DIR>/.claude/active-profile` → `~/.claude/.env.active` | 双标记 | 激活的 Profile（写读路径必须一致） | `switch_profile` |

## 我要改 X，去哪个文件？

| 想改 | 去 |
|------|-----|
| 权限规则 / 默认模型 / env / hooks | `~/.claude/settings.json`（想共享给团队 → `<WORK_DIR>/.claude/settings.json`） |
| 布局 / 窗口状态 / 会话收藏 | `<WORK_DIR>/.claude/settings.local.json`（GUI 自动，别手动改） |
| 添加 user-scope MCP 服务器 | `~/.claude.json` 根 `mcpServers`（`claude mcp add --scope user`） |
| 添加 project-scope MCP 服务器 | `<WORK_DIR>/.mcp.json`（`claude mcp add --scope project`） |
| 安装 / 删除技能 | `~/.claude/skills/`（用户级）或 `<WORK_DIR>/.claude/skills/`（工作区） |
| 切 Profile / 注入环境变量 | GUI `switch_profile`（写 `~/.claude/.env.profiles/` + 双激活标记） |

## 常见坑与修复

### 坑 1：MCP 写了但工具没挂载
- user-scope MCP 必须在 `~/.claude.json` 根 `mcpServers`；project-scope 在 `<WORK_DIR>/.mcp.json`。
- 写在 `<WORK_DIR>/.claude/settings.local.json` 的 `mcpServers` 后端**不读**——那是 GUI 的布局设置文件，不是 MCP 配置。
- **旧版单文件模式**（曾把 user-scope MCP 写进 `~/.claude/settings.json` 根 `mcpServers`）启动时已自动迁移到 `~/.claude.json`；若看到 settings.json 里还有 `mcpServers`，是迁移前的手动残留，可挪到 `~/.claude.json`。
- 改完 MCP 需重启 IDE 后台（工具栏诊断 → 重启后端）或重启 GUI 才会重新挂载。

### 坑 2：改 settings.json 后不生效
- `~/.claude/settings.json` 里 `gui` 键由 GUI 管理；引擎键由后端**启动时**读取。改完需重启 GUI/后端。
- 工作区级设置优先于用户级（merge 时工作区胜出）；未绑定工作区时只有纯全局基线。

## 加载优先级（低 → 高）

```
~/.claude/settings.json (用户全局) → <WORK_DIR>/.claude/settings.json (项目共享) → <WORK_DIR>/.claude/settings.local.json (项目本地)
```

后加载覆盖先加载。GUI 的 `gui` 键存在用户级 `settings.json`；工作区覆盖存 `settings.local.json`。`~/.claude.json` 是独立的全局运行时配置，与 settings 合并使用。

## 调试提示

- 后端每次 spawn 会把内置文档自动拷到 `~/.claude/`：`gui-agent-guide.md` / `gui-ref-system.md` / `gui-config-files.md`（本文件）。内容与 GUI 版本同步，改错会覆盖。
- 环境变量 / Profile / 网络排查看 GUI 工具栏「运行环境诊断」面板，一键修复。
- Profile 只认 `~/.claude/.env.profiles/*.env`，别在项目目录建 `.env.profiles` 碰运气。
