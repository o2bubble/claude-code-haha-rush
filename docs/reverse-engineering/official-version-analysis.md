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
5. 提取 `subagent_type=claude` 的请求体，获得完整 system prompt（`temp/claude_agent_prompt.txt`）

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
4. ~~**PE 字符串提取**: 基础方法已验证~~ ✅ 文档保留在 `docs/reverse-engineering-guide.md`

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

`temp/proxy_stream.py` 已重建，支持 HTTPS 代理抓包 + DeepSeek 转发。
