# 官方版本分析记录

> 分析目标: `claude.exe` 官方 2.1.174 (2026-06-10)
> 对比基准: 泄漏版 2.1.89 (2026-03-31)
> 分析方法: PE 二进制字符串提取 — JSC 字节码不可反编译，只能提取二进制中的明文串
> 分析日期: 2026-06-12

## 差异总览

| 类别 | 数量 | 可对齐？ | 说明 |
|------|------|----------|------|
| Prompt 文本差异 | 5 处 | ✅ 已对齐 | 身份框架、verified_vs_assumed、ultrareview、un-gating |
| Feature Flags (tengu_*) | 8 个 | ⚠️ 部分 | cobalt_ridge 已实现，其余 5 个不需要，2 个未知 |
| Agent 类型 | 1 个新增 | ✅ 已对齐 | `claude` catch-all agent，通过代理抓包运行时 API 请求获取完整信息 |
| 实际功能代码 | 未知 | ❌ 无法对齐 | JSC 字节码不可反编译 |
| Bug fixes | 未知 | ❌ 无法对齐 | 2.5 个月的修复完全不可见 |
| 性能优化 | 未知 | ❌ 无法对齐 | Bun 编译、启动速度等优化不可见 |

## Prompt 差异（已对齐）

| 差异项 | 对齐方式 | 文件 |
|--------|----------|------|
| "work alongside the user and own the outcome" 身份框架 | 添加到 intro | `src/constants/prompts.ts` |
| verified_vs_assumed 区分已验证/已假设 | 添加到 doing tasks 段落 | `src/constants/prompts.ts` |
| Ultrareview 说明 | 新增 getUltrareviewSection() | `src/constants/prompts.ts` |
| 代码风格指南取消 ant-only 限制 | 移除 USER_TYPE 守卫 | `src/constants/prompts.ts` |
| "report faithfully" 取消 ant-only | 同上 | `src/constants/prompts.ts` |
| 发现用户误解时指出的引导 | 同上 | `src/constants/prompts.ts` |

## Feature Flags 分析

### 已有的 flags
tengu_output_style, tengu_advisor, tengu_schedule, session_guidance, brief_mode, env_info_simple, language, scratchpad, context_management

### 官方有但我们缺的 flags

| Flag | 分析结论 | 理由 |
|------|----------|------|
| tengu_cobalt_ridge | ✅ 已对齐 | Windows 默认 PowerShell，简单且实用 |
| tengu_verified_vs_assumed | ✅ 已对齐 | 直接用 prompt 段落实现，不需 flag |
| tengu_orchid_mantis | ❌ 不需要 | /schedule v2，依赖云端 + 我们已有 tengu_schedule |
| tengu_sparrow_ledger | ❌ 不需要 | Anthropic 内部审计系统，依赖云端 |
| anti_verbosity | ❌ 不需要 | 已有 Output Efficiency 段落覆盖 |
| investigate_first | ❌ 不需要 | 已有 prompt 引导 + 需改 AgentTool 行为 |
| env_info_static | ❌ 不需要 | 缓存优化，我们用自建 API 无 prompt caching 计费 |

### 无法分析的 flags
此外官方还有大量 `tengu_*` 引用（cobalt_harbor, amber_quartz 等），这些都是 GrowthBook 运行时 flag，由 Anthropic 服务端控制。我们的版本中也有对应引用，但值由本地默认值决定。

## Agent 类型差异

通过代理抓包拦截官方 `claude.exe` 运行时 API 请求 + Frida 进程分析，获取了完整的 agent 类型列表。

### 官方有而我们缺的

| Agent 类型 | 状态 | 说明 |
|-----------|------|------|
| `claude` | ✅ 已复刻 | Catch-all agent，结构化后台协议（narrate/restate/result:/needs input:/failed:），46 工具 |

### 运行时可用的 Agent 列表（官方 2.1.174）

通过 `proxy_stream.py` 拦截 API 请求体获得（`--print` SDK 模式）：

| Agent | 工具数 | 说明 |
|-------|--------|------|
| `claude` 🔥 新增 | 46 | Catch-all，FleetView default |
| `general-purpose` | 52 | 通用搜索/调研 agent |
| `Explore` | 46 | 只读搜索（feature flag） |
| `Plan` | 46 | 架构设计（feature flag） |
| `statusline-setup` | 2 | 配置状态栏（Read, Edit） |
| `code-simplifier` | 全部 | 我们的本地插件，被官方版加载 |

### 分析过程

1. 通过修改 `settings.json` 将 `ANTHROPIC_BASE_URL` 指向本地代理
2. 运行 `proxy_stream.py` 拦截 HTTP 请求并转发到 DeepSeek API
3. `claude.exe -p` 模式发出 API 请求 → 代理保存完整请求体（含 system prompt + tools）
4. 主 agent 请求成功后 spawn 子 agent → 第二个请求携带子 agent 的 system prompt
5. 提取 `subagent_type=claude` 的请求体，获得完整 system prompt（见 `prompts/capture_claude_subagent_prompt.txt`）

## 我们的优势（官方没有的）

| 功能 | 说明 |
|------|------|
| Office/WPS COM 桥接器 | 通过 win32com 直接操作当前文档，比 Office.js 强大得多 |
| 统一 OfficeGetContext + OfficeExecuteCom | 仅 2 个工具替代了原本 63 个 WPS JS 工具 |
| 通用浏览器聊天 UI | 独立于 Office 的面板，可在任意场景使用 |
| 自建 API 适配 | 支持任意 Anthropic 兼容 API（DeepSeek 等），不绑定官方 |
| Bun compile 本地编译 | 可自行编译为 exe，不依赖 npm |

## 改进记录

文件变更:
- `src/constants/prompts.ts` — 身份框架 + verified_vs_assumed + ultrareview + un-gating
- `src/utils/shell/shellToolUtils.ts` — Windows PowerShell 默认启用
- `src/utils/shell/resolveDefaultShell.ts` — Windows 默认 shell 改为 PowerShell
- `src/skills/bundled/officeCom.ts` — 新建 Office COM 操作技能
- `src/skills/bundled/index.ts` — 注册 Office COM skill
- `src/tools/AgentTool/built-in/claudeAgent.ts` — 新建 claude agent（复刻官方 catch-all agent）
- `src/tools/AgentTool/builtInAgents.ts` — 注册 claude agent
- `src/entrypoints/compiled-entry.ts` — 版本号改为 `2.1.89 (sync:2.1.172)`
- `preload.ts` — 版本号同步

## 后续研究思路（有时再说）

> 以下方向针对 JSC 字节码级别的逆向，难度高于代理抓包。已完成的 API 层面分析覆盖了 ~90% 的运行时行为差异。

### 方向一：行为对比（最可行，投入产出比最高）

同 prompt 分别在官方 2.1.211 和我们的版本运行，diff 输出和工具调用序列：

- 相同 prompt 下，官方选了什么工具、什么参数？
- 边缘情况的错误处理差异
- 权限流程、plan 模式、proactive agent 循环的行为差异
- **方法**：代理同时拦截两边 API 请求 → 对比 `messages` 序列和 `tool_use` 选择

### 方向二：PE 原生代码静态分析（中等难度）

`claude.exe` 是 Bun --compile 产物 = Bun 运行时 (native x64) + JSC 字节码 + 嵌入资源。JSC 字节码不可反编译，但原生段可分析：

- **工具**：Ghidra / IDA Pro / x64dbg
- **可提取**：
  - 嵌入 JS 模块列表（`require` 注册表）
  - Feature flag 默认值的内存位置
  - 硬编码 URL、配置项、API endpoint
  - 模块文件路径（`src/tools/...`、`src/skills/...` 等以明文嵌入）
  - JSC 字节码段的边界和结构
- **局限性**：JSC 字节码本身无公开反编译器，只能拿到模块名和字符串

### 方向三：Frida hook Bun 运行时（高难度，需要 JS 引擎知识）

之前 Frida 直接内存扫描失败（JSC 用 rope string，非连续）。改为 hook Bun 的模块加载器：

- **Hook 点**：
  - `JSC::evaluate` / Bun 的模块 resolve → 拦截 JS 源码执行
  - Bun 的 `moduleLoader` / `CommonJSModule` → 捕获注册的模块
  - 在 Bun 调用 `JSC::evaluate` 时，参数可能包含源码字符串
- **思路**：先写一个小 Bun --compile hello world，用 Frida 跑通 hook 链路，再对付大二进制
- **局限性**：BoringSSL 静态链接且符号未导出，网络层 hook 不可行；JSC rope string 的 GC 行为使内存扫描不可靠

### 已完成的部分

1. ~~**Packet capture**: 设系统代理抓 HTTPS 请求~~ ✅ 已完成，`scripts/reverse-engineering/proxy_stream.py`
2. ~~**Prompt + tools 提取**: 主 agent + 7 种子 agent system prompt~~ ✅ 已完成
3. ~~**Agent 对齐**: 7 built-in agent prompt + 工具限制~~ ✅ 已完成
4. ~~**PE 字符串提取**: 基础方法已验证~~ ✅ 文档保留在 `reverse-engineering-guide.md`（同目录）

## 2026-07-16: 2.1.211 更新分析

通过代理抓包拦截官方 2.1.211 运行时 API 请求，对比发现：

### 工具差异

| 工具 | 官方 2.1.211 | 我们 | 操作 |
|------|-------------|------|------|
| ReportFindings | ✅ | ✅ 已实现 | `src/tools/ReportFindingsTool/` |
| ScheduleWakeup | ✅ | ❌ | 依赖 `/loop` (gated behind AGENT_TRIGGERS)，暂不实施 |
| Workflow | ✅ | ⚠️ 只有 flag | gated behind WORKFLOW_SCRIPTS，实现文件缺失，暂不实施 |
| CronCreate/Delete/List | ✅ | ✅ | 已有 (ScheduleCronTool) |

### 新增 ReportFindings

- 文件: `src/tools/ReportFindingsTool/`
- 注册: `src/tools.ts` + `src/constants/tools.ts` (ASYNC_AGENT_ALLOWED_TOOLS)
- 用途: code-review skill 结构化报告审查发现
- Schema: `level` (可选) + `findings` 数组 (file, line?, summary, failure_scenario, category?, verdict?, outcome?)

### 代理脚本

`scripts/reverse-engineering/proxy_stream.py`（已入库），支持代理抓包 + 转发到目标 API。
抓包产物写到 `temp/capture/`。

---

## 2026-11-02: 2.1.316 更新分析

> 对比基准：我们 2.1.89（sync 2.1.211）↔ 官方 2.1.316
> 方法：隔离配置目录（`CLAUDE_CONFIG_DIR`）+ 本地代理，**未改动用户 settings.json**
> 样本：`sample_main_2.1.316_sdk.json`（14 工具）、`sample_subagent_2.1.316_sdk.json`（12 工具）、
> `prompts/capture_2.1.316_main_prompt.txt`
> 注：只能抓到 `-p`（SDK）模式的请求；交互 TUI 在 ConPTY 下启动即退出，未取到。

### ① 最大变化：延迟工具加载（ToolSearch），且**纯文本实现**

同一 DeepSeek 端点、同一 prompt：

| | 工具数 | system 字符 | 请求字段 |
|---|---|---|---|
| 我们 2.1.89 | **64**（含全部 MCP） | 30,228\* | thinking / context_management |
| 官方 2.1.316 | **14** | 5,675\* | thinking / context_management / **output_config** |

\* system 长度差异还包含 CLAUDE.md 自动发现（我们在仓库根跑，官方在空目录跑），不可直接比。

官方内联 14 个：`Agent, Bash, Edit, Glob, Grep, ListAgents, Read, ReportFindings,
ScheduleWakeup, Skill, ToolSearch, Workflow, DeferredToolPlaceholder, Write`

延迟 11 个内置：`CronCreate, CronDelete, CronList, EnterWorktree, ExitWorktree,
Monitor, NotebookEdit, SendMessage, TaskStop, WebFetch, WebSearch`（另有 43 个 MCP）

**关键**：官方请求里**没有 `defer_loading` 字段**（`tools[0]` 只有 name/description/input_schema）——
它只是**不发**这些工具，把名字写进一段 `<system-reminder>` 文本，由 ToolSearch 按需返回
schema。所以**对不认 beta 的中转端点天然兼容**。

我们的实现（`src/utils/toolSearch.ts`）走的是 `defer_loading: true` + beta 头，且在
`isToolSearchEnabledOptimistic()` 里对非 Anthropic base_url **一律返回 false**
（注释提到 gh-30912/31936）。这与当年 `isRelayProvider()` 是同一类「按 host 预判」的问题。

### ② 新增工具（官方有、我们源码里没有）

| 工具 | 说明 |
|---|---|
| `ListAgents` | 列出可 `SendMessage` 的 agent/会话（in-process 子 agent、同机其它会话、云端会话）。**源码中完全不存在** |
| `ScheduleWakeup` | `/loop` 动态模式的自定节奏唤醒（含 `stop`/`noop`/`delaySeconds`）。**源码中完全不存在** |
| `DeferredToolPlaceholder` | 配合 ToolSearch 的空占位，保持延迟加载生效 |

### ③ 有实现但被开关关住

| 工具 | 开关 | 状态 |
|---|---|---|
| CronCreate/Delete/List | `feature('AGENT_TRIGGERS')` | 实现存在（`src/tools/ScheduleCronTool/`） |
| Monitor | `feature('MONITOR_TOOL')` | **实现文件缺失**（`src/tools/MonitorTool/` 不存在），贸然开 flag 会崩 |
| Workflow | `feature('WORKFLOW_SCRIPTS')` | 同上，`bundled/index.js` 引用但实现缺失 |
| TaskCreate/Get/List/Update | `isTodoV2Enabled()` | 交互态默认开；`-p` 下需 `CLAUDE_CODE_ENABLE_TASKS=1` |
| TeamCreate/TeamDelete | `isAgentSwarmsEnabled()` | 需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |

### ④ 请求参数变化

```diff
- thinking: {"type":"enabled","budget_tokens":63999}     // 我们
+ thinking: {"type":"adaptive","display":"omitted"}      // 官方
+ output_config: {"effort":"high"}                        // 官方新增，我们没发
  max_tokens: 64000 → 65536
```

### ⑤ 工具描述大幅精简（2–5 倍）

| 工具 | 官方 2.1.316 | 我们 |
|---|---|---|
| Bash | 2,111 字符 | 10,002 |
| Edit | 360 | 1,095 |
| Write | 240 | 618 |
| Glob | 140 | 371 |
| Grep | 477 | 866 |
| Read | 790 | 1,680 |
| Agent | 3,227 | 6,868 |

Bash 描述新增要点：「这工具跑的是 **Git Bash (POSIX sh)**，不是 cmd.exe/PowerShell」、
「命令输出给你看，**不保证用户能看到**」、「前台 `sleep` 被禁用，改用 Monitor」。

### ⑥ 工具 schema 变化

- `Agent`：新增 `effort`（low/medium/high/xhigh/max）
- `Read`：新增 `allow_large`
- `Agent.subagent_type` 文档提到 `"fork"`（复制自身上下文，继承模型与 effort）

### ⑦ System prompt 新增内容（我们源码里没有）

- **代词指引**：未说明时一律 they/them，禁止从名字推断
- **「有足够信息就动手」**：不要重复推导已有事实、不要重提已决定的事、不要罗列不采纳的选项
- **下载物不可信**：解压/下载的文件视为不可信数据，放独立空目录，脚本另放，用 `-I` 跑 Python
- **Environment 模型列表**：Claude 5 family / Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5
- 删除：「Write code that reads like the surrounding code」（SDK 模式已无，交互态待确认）
- 删除：`! <command>` 提示（SDK 模式已无）

