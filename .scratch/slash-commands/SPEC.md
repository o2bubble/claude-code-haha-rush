# Slash Command System — Spec

## Problem Statement

用户在 GUI 聊天区输入 `/` 后没有任何命令补全提示。VS Code 扩展有斜杠命令自动补全，但 GUI 完全没有实现。更严重的是，32 个命令被后端硬编码拉黑（TUI-only），用户必须切回终端才能使用 `/plugins`、`/doctor`、`/hooks` 等重要命令。每次安装插件都要中断 GUI 工作流，打开 TUI 执行命令，再回到 GUI 刷新。

## Solution

分三层解决：

1. **命令补全**：输入 `/` 时弹出 React 下拉框，实时过滤可用命令，键盘/鼠标选择后插入
2. **智能路由**：命令按能力重新分为四类（A/B/C/D），分别走 WS 文本、GUI panel 映射、系统终端、不可用提示
3. **终端 fallback**：需要交互的命令 spawn 系统终端（cmd/powershell/git-bash），带 `CLAUDE_CODE_SKIP_PROMPT_HISTORY=true` 环境变量不产生残留 session，终端关闭后自动 `plugin_refresh` 刷新后端

## User Stories

### 命令补全
1. 作为 GUI 用户，我在输入框输入 `/` 时，希望看到可用命令的下拉列表，以便快速找到需要的命令
2. 作为 GUI 用户，我输入 `/pl` 时，希望列表过滤到匹配 "pl" 的命令（如 `/plugins`、`/plan`），以便精确选择
3. 作为 GUI 用户，我希望用方向键 ↑↓ 导航命令列表，Enter 确认选择，以便纯键盘操作
4. 作为 GUI 用户，我希望用鼠标点击命令项来选中，以便偶尔使用鼠标
5. 作为 GUI 用户，我按 Escape 时希望关闭下拉框，以便取消操作
6. 作为 GUI 用户，选中命令后输入框自动插入 `/cmd `（带尾随空格），光标定位在末尾，以便直接输入参数
7. 作为 GUI 用户，如果输入了不在 `/` 末尾的内容（如中间输入），不希望触发命令补全
8. 作为 GUI 用户，插件安装/卸载后，希望命令列表实时更新，以便新命令立即可用

### 命令路由 — A 类（WS 文本）
9. 作为 GUI 用户，我输入 `/doctor` 时，希望看到诊断报告文本，了解当前环境状态
10. 作为 GUI 用户，我输入 `/hooks` 时，希望看到 hook 配置列表
11. 作为 GUI 用户，我输入 `/agents` 时，希望看到 agent 配置
12. 作为 GUI 用户，我输入 `/tasks` 时，希望看到后台任务状态
13. 作为 GUI 用户，我输入 `/ide` 时，希望看到 IDE 集成状态
14. 作为 GUI 用户，我输入 `/tag` 时，希望能管理消息标签
15. 作为 GUI 用户，我输入 `/fast` 时，希望切换快速模式（不需要终端交互）
16. 作为 GUI 用户，我输入 `/branch` 时，希望 fork 当前会话
17. 作为 GUI 用户，我输入 `/reload-plugins` 时，希望刷新已安装的插件

### 命令路由 — B 类（GUI panel）
18. 作为 GUI 用户，我输入 `/plan` 时，希望 PlanPanel 获得焦点，而不是看到终端文本
19. 作为 GUI 用户，我输入 `/diff` 时，希望看到 Monaco diff 视图
20. 作为 GUI 用户，我输入 `/model` 时，希望看到模型切换下拉框
21. 作为 GUI 用户，我输入 `/tasks` 时，希望 TasksPanel 获得焦点

### 命令路由 — C 类（终端 fallback）
22. 作为 GUI 用户，我输入 `/plugins` 时，希望自动打开系统终端运行 Claude Code，在终端中浏览和安装插件
23. 作为 GUI 用户，终端中执行完 `/plugins` 关闭窗口后，希望 GUI 自动刷新命令列表，新装的插件命令立即可用
24. 作为 GUI 用户，终端打开的 Claude Code 不应该在会话列表中残留临时会话
25. 作为 GUI 用户，我输入 `/config` 时，如果终端能提供更完整的设置选项，希望通过终端完成
26. 作为 GUI 用户，终端 fallback 打开的窗口应该自动 cd 到当前工作目录
27. 作为 GUI 用户，如果在终端执行了设置变更（插件、技能、MCP 配置），关闭终端后希望这些变更在 GUI 中生效

### 命令路由 — D 类（不可用）
28. 作为 GUI 用户，我输入 `/exit` 时，希望看到提示"此命令在 GUI 中不可用"，而不是静默失败

### 终端选择
29. 作为 GUI 用户，C 类命令触发的终端应该使用我在设置中选择的终端类型（cmd/powershell/git-bash）
30. 作为 GUI 用户，如果 Git Bash 未安装，希望自动回退到 cmd

## Implementation Decisions

### 命令分类标准

| 类别 | 判定条件 | 处理方式 | 命令数 |
|------|---------|---------|--------|
| A | 信息展示型，可纯文本输出 | 去拉黑，后端加 WS handler 返回格式化文本 | 9 |
| B | GUI 已有对应 panel | GUI 拦截 → 打开/聚焦对应 panel | 4 |
| C | 需要交互式终端 UI | spawn 系统终端 + `SKIP_PROMPT_HISTORY` 环境变量 | 13 |
| D | 进程级/平台专属/无意义 | 显示"此命令在 GUI 中不可用" | 9 |

### WebSocket 协议扩展

**新增入站消息处理（useChatBridge.ts）：**

`system` 消息增加 `slash_commands` subtype：
```
{ type: "system", subtype: "slash_commands", commands: [{ cmd, desc, type }] }
```
handler 写入 `chatStore.slashCommands`。

**新增出站消息（useChatBridge.ts）：**

`plugin_refresh`：GUI 请求后端刷新插件/命令
```
{ type: "plugin_refresh" }
```
后端收到后调用 `refreshActivePlugins()` → 重新 `getCommands(cwd)` → 发送更新后的 `slash_commands`。

### 后端修改（ideMode.ts）

1. 去拉黑 3 个被错杀的命令：`fast`、`branch`、`reload-plugins`
   - `fast`：加 WS handler，toggle 后返回文本确认
   - `branch`：加 WS handler，fork 会话后返回文本确认
   - `reload-plugins`：加 WS handler，调用 `refreshActivePlugins()` 后返回文本确认
2. 去拉黑 6 个信息展示型命令：`doctor`、`hooks`、`agents`、`tasks`、`ide`、`tag`
   - 复用现有 `renderToString` 降级渲染路径（非阻塞命令已支持）
3. 新增 `plugin_refresh` WS 消息处理，调用 `refreshActivePlugins()` + 重发 `slash_commands`
4. C 类和 D 类保持拉黑，但 GUI 侧不依赖后端拒绝——GUI 在命令路由层直接拦截

### GUI 命令路由层

路由层是一个纯函数模块，不依赖 React：

```typescript
type RouteCategory = "A" | "B" | "C" | "D"

interface RouteDecision {
  category: RouteCategory
  action: "ws_text" | "panel" | "terminal" | "blocked"
  panelId?: string       // B 类的目标 panel ID
  terminalType?: string  // C 类传递的终端类型
}

function routeCommand(cmdName: string): RouteDecision
```

B 类映射表：
```typescript
const PANEL_MAP: Record<string, string> = {
  plan: "plan",
  tasks: "tasks", 
  diff: "editor",
  model: "model",
}
```

路由优先级：B > A > C > D。先检查是否有 panel 映射，再检查是否 A 类，再检查是否 C 类，最终 fallback 到 D。

### 命令下拉框（SlashCommandDropdown）

React portal 渲染在 contenteditable 下方：

- 触发条件：输入框内容以 `/` 开头，且光标在 `/` 之后
- 过滤：提取 `/` 到光标位置的文本，filter `chatStore.slashCommands`
- 定位：`getBoundingClientRect()` 获取光标行位置，portal 绝对定位
- 键盘：↑↓ 导航高亮项，Enter 选中，Escape 关闭
- 鼠标：hover 高亮，click 选中
- 选中后：替换 `/partial` 为 `/fullcmd `，聚焦 contenteditable

组件不直接操作 DOM——通过 callback 通知 InputArea 插入文本。

### chatStore 扩展

```typescript
interface SlashCommand {
  cmd: string        // e.g. "plugins"
  desc: string       // e.g. "Manage Claude Code plugins"
  type: string       // "local" | "skill" | "prompt"
}

// ChatState 新增字段
slashCommands: SlashCommand[]
```

### 终端 spawn（Rust 侧）

`open_system_terminal` 扩展参数：

```rust
// 新增参数
claude_launch: Option<bool>,   // 是否启动 Claude
```

当 `claude_launch: true` 时：
- cmd: `cmd /K "cd /d <work_dir> && set CLAUDE_CODE_SKIP_PROMPT_HISTORY=true && claude"`
- powershell: `cmd /c start powershell -NoExit -Command "Set-Location '<work_dir>'; $env:CLAUDE_CODE_SKIP_PROMPT_HISTORY='true'; claude"`
- git-bash: `& git-bash.exe --cd=<work_dir> -c "CLAUDE_CODE_SKIP_PROMPT_HISTORY=true claude; exec bash"`

新增 `wait_for_terminal` 命令或直接在前端用轮询检测终端窗口关闭。

### 终端退出后刷新

流程：
```
终端关闭 → GUI 检测（进程退出或窗口关闭）
  → 发送 WS { type: "plugin_refresh" }
  → 后端 refreshActivePlugins() + getCommands(cwd)
  → 后端推送 { type: "system", subtype: "slash_commands", commands: [...] }
  → GUI chatStore 更新 slashCommands
  → 下拉框命令列表实时更新
```

不重启 IDE 后端——只刷新插件和命令注册表。

### 安全考虑

- `CLAUDE_CODE_SKIP_PROMPT_HISTORY=true` 确保终端会话不写磁盘，不留任何残留
- 命令下拉框的过滤输入不执行任何代码，纯文本匹配
- D 类命令不发送到后端，前端直接拒绝并显示提示
- 终端只 cd 到工作目录，不传 session ID，两个进程互不干扰

## Testing Decisions

### 测试原则
- 只测试外部行为，不测试实现细节
- 使用最高层接缝：WS 协议层、UI 事件层、Tauri invoke 层
- 优先复用现有测试模式

### 接缝与测试方式

| 接缝 | 测试方式 | 断言内容 |
|------|---------|---------|
| WS 协议 | mock WS → send → 断言 chatStore | slashCommands 正确存储；plugin_refresh 触发 reload |
| 命令路由（纯函数） | 单元测试，遍历所有命令 | 每个命令返回正确的 RouteCategory |
| `/` 检测 + 下拉 | 模拟 contenteditable input 事件 | 下拉框显示/隐藏；过滤正确 |
| 终端 spawn | mock Tauri invoke | 参数包含 CLAUDE_CODE_SKIP_PROMPT_HISTORY |
| 终端退出 → 刷新 | mock 进程退出事件 | WS plugin_refresh 消息已发送 |

### 优先测试
1. 命令路由纯函数（零依赖，最容易测，覆盖全部 36 个命令）
2. WS 协议（mock WebSocket，测试数据流）
3. 终端 spawn 参数正确性

## Out of Scope

- C 类命令的 GUI 原生实现（如 PluginPanel、DoctorPanel）——这是未来工作，当前只提供终端 fallback
- D 类命令中的 `/login` `/logout` `/upgrade` 等——GUI 框架下无意义，不做适配
- 命令参数的自动补全（如 `/plugin install <tab>` 列出可安装的插件）
- 命令历史记录
- 自定义用户命令/skill 的 GUI 编辑界面

## Further Notes

### 与 VS Code 扩展的关系
VS Code 的 `/skills` 列表误标 prompt 型命令为 TUI-only——实际上它们在 IDE 模式完全可用。本次分类以实际能力为准，不以 VS Code 的标记为准。

### 命令数据流
```
ideMode.ts (WS connect)
  → system/subtype=slash_commands
    → useChatBridge 接收
      → chatStore.slashCommands
        → InputArea useEvent 消费
          → SlashCommandDropdown 渲染
```

### UI 参考
命令下拉框的视觉风格参考 VS Code 的 SlashAutocomplete overlay——简要命令名 + 灰色描述文字，匹配当前 GUI 的 Segoe UI + 浅色主题。
