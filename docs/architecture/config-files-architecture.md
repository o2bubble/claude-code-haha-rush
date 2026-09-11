# Claude Code 配置文件体系

## 文件一览

| 文件路径 | 归属 | 主要存储内容 | 谁在写 |
|----------|------|-------------|--------|
| `~/.claude.json` | **运行时状态** | 启动计数、userID、OAuth token、project trust、MCP 服务器(user/local)、主题、各种 feature tracking | Claude Code 自动写入 |
| `~/.claude/settings.json` | **用户设置** | permissions、hooks、model、plugins、plugin MCP 的 user_config（API key 等）、env、sandbox | `/config` 或手动编辑 |
| `<项目>/.claude/settings.json` | **项目共享设置** | 同上，但这个文件可以提交 git 共享给团队 | `/config --scope project` |
| `<项目>/.claude/settings.local.json` | **项目本地设置** | 同上，但被 gitignore，不会提交 | `/config --scope local` |
| `<项目>/.mcp.json` | **项目 MCP 服务器** | MCP 服务器启动配置（command/args/url/headers） | `claude mcp add --scope project` |

---

## 关键区分

### 全局配置 vs 用户设置

```text
~/.claude.json          ←→   $HOME/.claude.json
~/.claude/settings.json ←→   $HOME/.claude/settings.json
```

如果 `~/.claude/settings.json` **已经存在**，启动时 `getGlobalClaudeFile()` 会自动把运行时状态也写进 `settings.json`，形成"单文件模式"。

```
// src/utils/env.ts:14-20
if (existsSync(join(claudeDir, 'settings.json'))) {
  return settingsPath   // 单文件：运行时状态也写进 settings.json
}
// 否则
return join(homedir(), '.claude.json')   // 双文件：分开写
```

### MCP 的三种写入路径

| 操作 | 去哪个文件 |
|------|-----------|
| `claude mcp add --scope user` | `~/.claude.json` (GlobalConfig.mcpServers) |
| `claude mcp add --scope local` | `~/.claude.json` (projects[path].mcpServers) |
| `claude mcp add --scope project` | `<项目>/.mcp.json` |
| 插件 MCP 的 `user_config` | `~/.claude/settings.json` (pluginConfigs[pluginId].mcpServers) |

### settings.json 的 SettingsJson schema 主要字段

```text
apiKeyHelper       — 认证脚本路径
env                — 环境变量
permissions        — allow/deny/ask 规则 + defaultMode + additionalDirectories
model              — 覆盖默认模型
hooks              — 工具执行前后触发的脚本
sandbox            — 沙箱设置
cleanupPeriodDays  — 对话记录保留天数
respectGitignore   — 文件选择器行为
attribution        — commit/PR 署名
defaultShell       — bash / powershell
statusLine         — 自定义状态栏
enabledPlugins     — 启用的插件
extraKnownMarketplaces — 额外插件市场
pluginConfigs      — 插件 MCP 的 user_config
autoMemoryEnabled  — 自动记忆开关
```

### .claude.json 的 GlobalConfig 主要字段

```text
numStartups / userID / firstStartTime   — 启动元数据
oauthAccount                            — 登录态
projects[path]                          — 每个项目的 trust/approval/MCP 配置
mcpServers                              — user scope 的 MCP 服务器
theme / editorMode / diffTool           — UI 偏好
tipsHistory / onboarding / migrations   — 使用进度跟踪
各种 feature tracking 计数器
```

---

## 速查：我要改 X，去哪个文件？

| 我想改… | 修改方式 | 写到 |
|---------|---------|------|
| 权限规则 (allow/deny/ask) | `/permissions` | `settings.json` 或 `settings.local.json` |
| 默认模型 | `/model` 或 `/config` | `settings.json` |
| Hooks | 手动编辑 | `settings.json` |
| 插件开关 | `/plugin install/uninstall` | `settings.json` (enabledPlugins) |
| 插件 MCP 的 API key 等 | 插件 UI 或手动 | `settings.json` (pluginConfigs) |
| 添加 MCP 服务器 (user) | `claude mcp add --scope user` | `~/.claude.json` |
| 添加 MCP 服务器 (project) | `claude mcp add --scope project` | `<项目>/.mcp.json` |
| 沙箱设定 | `/config` | `settings.json` |
| 环境变量 | `/config` | `settings.json` |
| 主题 | `/theme` | `~/.claude.json` |
| 编辑器模式 (normal/vim) | `/config` | `~/.claude.json` |

---

## Settings 加载优先级（低 → 高）

```text
plugin baseline → userSettings → projectSettings → localSettings → flagSettings → policySettings
(~/.claude/)     (用户全局)      (项目共享)        (项目本地)      (CLI --settings) (企业管控)
```

低优先级的先加载，高优先级的覆盖。`policySettings`（企业管控）永远是最高优先级。
