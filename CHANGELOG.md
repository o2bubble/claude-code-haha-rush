# 开发日志

## v0.3 方向（草案）

基于官方最新版 Claude Code + 社区 vibecoding 工具的优秀实践，对泄露版源码做功能性升级。

### 上游同步

- 追踪 Claude Code 官方发行版的新增工具和 API 变更
- 合并官方 bug 修复和性能优化
- 评估官方新增的 agent / skill / hook 机制变化

### 竞品参考

- **Cursor**: inline 编辑预览、diff 级 accept/reject、多文件并行编辑
- **Windsurf (Codeium)**: Cascade 流式 agent 工作流、上下文自动发现
- **Cline**: 更丰富的 MCP 生态、自定义 system prompt 管理、checkpoint 恢复
- **Aider**: 结构化编辑模型（search/replace）、编辑基准测试体系
- **GitHub Copilot**: agent mode 的多步推理链、workspace 感知
- **Codex (OpenAI)**: 终端原生 agent、sandbox 执行、多模型路由
- **Devin / OpenHands**: 全自主 agent 循环、sandbox 隔离执行

### 可能的迭代方向

| 方向 | 说明 |
|------|------|
| 编辑体验升级 | inline diff 预览、逐块 accept/reject、多文件并行修改 |
| Agent 能力增强 | 更长的自主执行链、子 agent 并行调度、checkpoint/回退 |
| MCP 生态扩展 | 更多内置 MCP server、社区市场集成、动态 tool 注册 |
| 上下文管理 | 自动文件发现、项目级 RAG、更智能的 compaction |
| 多模型协作 | 不同模型分派不同任务（thinking model + editing model）、成本路由 |
| Sandbox | 隔离执行环境、容器化运行、安全审批分级 |
| 协作功能 | 多会话协同、review 工作流、PR 自动生成 |

> 这是一个长期迭代方向，具体实现视优先级和可行性逐步推进。

---

## v0.2 里程碑总结

基于 Claude Code 2026-03-31 泄露源码的本地修复版，三插件（VS Code / IntelliJ / VS）组成完整的 IDE 开发体验。

**修复量**: 23 commits，30+ 文件修改  
**时间线**: 2026-05-28 → 2026-05-30

### 核心修复（5 项跨插件 Bug）

| 问题 | 修复 |
|------|------|
| Bun 进程泄漏（15GB+ 内存） | `taskkill /F /T /PID` 同步等待 + exit handler |
| Emoji 插入多余换行 | cursor 位置保存 + `range.insertNode()` |
| Windows 中文输出乱码 | UTF-8 → GBK → UTF-16LE 三路解码 |
| 命令输出滚回顶部 | `.tool-body` 内部容器同步置底 |
| 断线重连打断按钮残留 | `streaming: false` 伴随 disconnect 事件 |

### 新增功能

- **AskUserQuestion IDE 支持**：多选/单选模态窗口，三插件 Bridge 层 `updatedInput` 传递
- **文件路径点击打开**：消息中 `<code>` 内路径可点击，相对路径自动解析项目根
- **代码块一键复制**：悬停显示 Copy 按钮，事件委托避免 innerHTML 序列化丢失
- **Thinking 实时更新**：计时器每秒刷新 + token 估算数随流式追加同步更新

### 工具链集成

- **codegraph MCP** — 代码知识图谱，`~/.claude/settings.json` 配置
- **claude-mem** — 全自动记忆系统，Worker 后台 + 新会话 hook 注入
- **Superpowers** — 社区技能包（brainstorming / code-review / TDD 等）
- **personal-setup/SETUP.md** — 完整复现指南（API 配置、MCP 坑、npm 代理、SSH、构建命令）

### 最终版本

| 插件 | 版本 |
|------|------|
| VS Code | 0.2.22 |
| IntelliJ | 0.2.7 |
| Visual Studio 2022/2026 | 0.2.7 |

### 架构笔记

- 三插件共享 webview 前端（`media/webview/`），差异仅在 Bridge 层（TS / Kotlin / C#）
- MCP 配置陷阱：`settings.json` 优先于 `.claude.json`，codegraph 自动配置需手动迁移
- Gradle wrapper 9.0（WSL Java 21）；MSBuild 18（VS 2026 Community）；Bun runtime
- webview JS 事件绑定需用委托模式，`innerHTML` 序列化会丢失直接事件处理器

---

## 2026-05-30

### AskUserQuestion IDE 支持

模型调用 `AskUserQuestion` 工具时，IDE 插件现在会弹出多选/单选模态窗口，支持预览区和备注输入。此前该工具仅在 TUI 模式下可用。

- 新建 `ask-question.js` 叠加层组件
- Bridge 层新增 `updatedInput` 传递（TypeScript / Kotlin / C#）
- 三插件统一支持

### UX 增强：消息交互

- **文件路径点击打开**：消息中 `<code>` 内的文件路径可直接点击，在 IDE 编辑器中打开对应文件
- **代码块一键复制**：所有代码块悬停即显示 Copy 按钮
- **相对路径自动解析**：点击 `src/utils/Shell.ts` 等相对路径时，bridge 自动拼入项目根路径

### Thinking 计时/token 实时更新

- 思考块 header 中的计时器每秒刷新
- Token 估算数随文本流式追加同步更新
- 使用事件委托 + CSS hover，避免 innerHTML 序列化丢失事件

### 跨插件 Bug 修复

- **僵尸进程**：Bun crash 后旧进程未杀干净，改为 `taskkill /F /T /PID` 同步等待 + 所有插件 exit handler 加杀进程
- **Emoji 插入**：contenteditable 光标位置保存 + flex-shrink 固定标签栏 + `range.insertNode()` 替换换行
- **中文乱码**：UTF-8 → GBK(CP936) → UTF-16LE 三路解码回退，覆盖 cmd/PowerShell/bash/WSL
- **工具输出滚动**：`.tool-body` 内部滚动容器同步置底，不再丢到顶部
- **断线重连后打断按钮残留**：`streaming: false` 伴随断开连接事件重置

### 工具链

- **codegraph MCP**：代码知识图谱，加速代码理解。配置 MCP server + permissions
- **claude-mem**：全自动记忆系统。Worker 后台记录，新会话注入历史上下文
- **Superpowers**：社区技能包，提供实用 slash commands 和 agents
- `personal-setup/SETUP.md`：完整环境复现指南，含 API 配置模板、MCP 配置坑（settings.json 优先于 .claude.json）、npm 代理、SSH 配置、三 IDE 插件构建命令

### 插件版本

| 插件 | 版本 |
|------|------|
| VS Code | 0.2.22 |
| IntelliJ | 0.2.7 |
| Visual Studio 2022/2026 | 0.2.7 |

---

## 2026-05-29

### IntelliJ Platform 插件

- 新增 IntelliJ IDEA 插件，与 VS Code / VS 插件共享 webview 前端
- JCEF WebView bridge 重写，支持 WebSocket 直连
- SendFile / SendSelection / AddToChat 右键菜单动作

### VS Code 插件基础设施

- WebSocket 分片重组修复
- Polling bridge 降级方案
- 选区预览组件（SelectionPreview）
- 流式输出 + 重连健壮性改进

---

## v0.2 早期（05-04 → 05-28）

### 源码修复与启动

Claude Code 2026-03-31 泄露源码无法直接运行，需要修复多个启动路径阻塞点：

- **ColorDiff 原生模块缺失**：替代为 TypeScript stub，映射到 `src/native-ts/color-diff/`
- **缺失模板文件**：添加 `verify.md`、`filePersistence/types.ts`、`ultraplan/prompt.txt` 等 stub 文件
- **Enter 键无响应**：`modifiers-napi` 缺失导致 `isModifierPressed()` 崩溃，改为 try-catch 兜底
- **启动跳过 Setup**：`preload.ts` 无条件设置 `LOCAL_RECOVERY=1`，移除该默认值
- 配置 Bun 运行时，告别 Node.js

### VS Code 插件 v0.1.x → v0.2.x

**v0.1.x**（首个可用的 IDE 插件）：
- WebSocket 通信层 + 流式输出
- 权限对话卡片（Bash / Edit / Read 工具审批）
- 会话管理（创建 / 切换 / 删除）
- 上下文文件展示

**v0.2.x**（UI 重设计 + 稳定性）：
- 全新 webview UI（`design_s1/` 设计稿 → `app-new.js` 实现）
- Terminal streaming 降级修复
- 粘贴富文本自动清除格式
- 国际化支持（en / zh-cn）
- 会话自动恢复（模型/Profile 切换后重连）
- `partial_assistant` 覆盖 `tool_use` 块的竞态修复
- IDE 模式跳过 session memory compaction，始终走 API 路径

**v0.2.x 打磨**（30+ 个小修）：
- Auto-resume session after model/profile switch restart
- GBK 编码解码 Windows 命令输出
- Thinking delta 避免全量 DOM 重建（直接 DOM 更新）
- Markdown 渲染表格/列表/代码块样式
- 历史分页渲染裁剪修复
- Plan panel 在 compaction 后刷新
- Permission 按钮用 locale 数据而非硬编码
- 粘贴/选取 chip 不再产生多余空行
- 终端流式输出在 debounce 时使用最新数据
- `interruptCurrentTurn` 空操作 guard

### Visual Studio 2022/2026 插件

- 全新 VSSDK 插件，基于 WebView2
- CS Bridge 消息层（`ClaudeChatWindowControl`）
- NuGet 包：Newtonsoft.Json / MessagePack / WebView2
- 支持 VS 2022 (v17) 和 VS 2026 (v18)
- WebView2 bridge 多路回退：`postMessage` / `AddHostObjectToScript` / `chrome.webview`
- Window close → kill backend process
- `taskkill /T` 杀完整进程树

### CDP Inspector MCP Server

独立 MCP 服务器，将 Chrome DevTools Protocol 暴露为 Claude Code 可调用的工具：

- 核心工具：`cdp_screenshot`、`cdp_click`、`cdp_type`、`cdp_scroll`、`cdp_select`、`cdp_hover`、`cdp_wait`、`cdp_focus`、`cdp_reload`、`cdp_network`
- Edge 浏览器支持 + XPath 选择器
- Windows/Linux/macOS 启动脚本（`cdp-browser.cmd` / `cdp-setup.sh`）
- CDP 连接死锁修复 + MCP 命令去重
- Win10 兼容性 + UTF-8 编码修复

### Edit History 功能

- 每次文件编辑生成 unified diff，JSONL 格式持久化到 `~/.claude/projects/<slug>/edit-history.jsonl`
- 支持 `回顾` / `撤销` / `清空` 等自然语言触发
- IDE 上下文注入编辑历史指令
- 兼容 CLI 和 IDE 模式

### 基础设施

- `kill-claude.cmd`：批量杀掉所有残留 bun/node 进程
- `codegraph-cleanup`：清理 codegraph 过期锁文件
- 中文 README + 架构图 + Windows 启动说明
- 编辑历史相关 CLAUDE.md 指令

---

## 2026-05-31

### IDE 模式 Hook 支持

IDE 模式此前完全没有 Hook 机制，导致 claude-mem 等依赖 Hook 的插件在 IDE 模式下无法工作。根因是 `ideMode.ts` 不调用 `processSessionStartHooks`，也不触发 `UserPromptSubmit`、`Stop` 等事件。

#### 新增 Hook 接入

在 `src/entrypoints/ideMode.ts` 中补齐了 4 个关键 Hook：

| Hook | 触发位置 | 说明 |
|------|----------|------|
| SessionStart | `runIdeMode` 启动时 + `handleResumeSession` | 启动 Worker、加载插件 Hook、注入跨会话上下文 |
| UserPromptSubmit | `handleUserPrompt` | 每次用户发消息时通知插件记录会话数据 |
| Stop | SIGTERM/SIGINT | 进程退出时做会话总结 |
| Compact (SessionStart) | 共享 `compact.ts` 路径 | 已通过 `compactConversation` 间接支持 |

PreToolUse / PostToolUse 本身就走共享的 `toolExecution.ts` 路径，无需额外改动。

#### 绕过 Hook 注册 Bug

claude-mem 等插件的 `hooks.json` 中部分 event（`UserPromptSubmit`、`PostToolUse`、`Stop`）经过 `loadPluginHooks` → `registerHookCallbacks` 后丢失，仅 `SessionStart` 能被注册到 `STATE.registeredHooks`。原因与插件 hook 的 `matcher` 字段处理有关（上游源码 bug）。

临时方案：新增 `runClaudeMemHook()` 辅助函数，直接 `spawn` 调用 claude-mem worker，绕过整个 Hook 注册系统。所有失败路径静默降级，不影响 IDE 后端正常运行。

#### claude-mem 兼容性

- 记忆记录（`user_prompts`、`sdk_sessions` 写入）：✅ 正常工作
- 智能摘要（SDK 子进程）：⚠️ DeepSeek Anthropic 兼容层与 claude-mem parser 不兼容，SDK session 被 poisoned
