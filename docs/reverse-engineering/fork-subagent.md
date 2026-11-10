# Fork 子代理：完整研究记录

> 研究日期：2026-11-03
> 目标：搞清楚官方 2.1.316 的 `FORK_SUBAGENT` 是什么、能不能开、开了会怎样
> 结论：**能力已打通并实测跑通，正式构建默认未开启**

---

## 一、它是什么

一句话：**普通子代理是「新开一个员工」，fork 是「克隆一个你」**。

```
普通子代理：
父 [...............]                    ← 完整历史
      ↓ 手写一个「自包含」prompt         ← 这步很费劲，而且必然丢细节
子 [prompt]                             ← 从零开始，只看到你写的

fork：
父 [...............]                    ← 完整历史
      ↓ 原样复制 + 末尾追加一句指令
子 [父的全部历史][指令]                  ← 它知道你查过什么、试过什么、排除了什么
```

### 它解决的核心问题

官方在 Agent 工具描述里自己写了这段成本分析：

> A fresh agent costs more than it looks. It knows only what you put in the
> prompt, and you see only the summary it sends back — **both handoffs drop
> detail, and neither of you can tell what the other missed.**

fork 直接消灭了「两次交接」：子代理看得到你的全部上下文，所以不用写长 prompt。

---

## 二、实现（本地源码里本来就有）

`src/tools/AgentTool/forkSubagent.ts`（211 行）是完整实现，不是猜的：

| 函数 | 作用 |
|---|---|
| `buildForkedMessages()` | 构造 fork 的对话前缀（含 cache 对齐逻辑） |
| `buildChildMessage()` | 那 10 条硬规则 + 输出模板 |
| `isInForkChild()` | 递归防护（扫描 boilerplate 标签） |
| `buildWorktreeNotice()` | worktree 隔离提示 |
| `FORK_AGENT` | 合成 agent 定义（`tools:['*']` + `model:'inherit'` + `permissionMode:'bubble'`） |

启动路径也完整（`AgentTool.tsx:325`）：

```ts
const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType)
const isForkPath = effectiveType === undefined
```

**不需要反编译。** 反编译是「没有源码时」才做的事。

---

## 三、真正的巧思：prompt cache

这是 fork 设计里最精妙的部分：

```
所有 fork 子代理的请求前缀 = 父对话的逐字节副本
                             ↓
                     命中同一份 prompt cache
                             ↓
                只有末尾那句指令是新的（要付费）
```

`buildForkedMessages()` 为此做了两件事：

1. **保留完整的父 assistant 消息**（包括所有 tool_use、thinking、text）
2. **给每个 tool_use 补一个完全相同占位结果**

```ts
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
```

第 2 步是为了满足 API 的「每个 tool_use 必须有 tool_result」约束，
**同时保证所有 fork 的字节前缀一致**。

### 一个必须知道的限制

fork 子代理**看不到父级正在进行的工具调用的真实结果** —— 它看到的是那句占位符。

fork 是「上下文的分叉点」，不是「工具结果的复制」。这是为 cache 一致性做的取舍。

---

## 四、实测：DeepSeek 端点支持吗

### ① prompt cache 命中率

按 fork 的真实消息结构测试（父对话 → assistant 带 tool_use → 占位 tool_result + 各自指令）：

| fork | input | cache_read |
|---|---|---|
| fork-1（首个） | 9,106 | 0 |
| fork-2 | **147** | **8,960** |
| fork-3 | **146** | **8,960** |

**98.4% 命中**，三个 fork 合计省 66%。而且**没有手动设 `cache_control`**，端点自动做的。

### ② 缓存失效边界

| 改动 | 缓存 |
|---|---|
| 尾部（指令） | ✅ 命中 |
| 中间改一个词 | ❌ 全价 |
| 开头改一个词 | ❌ 全价 |

这就是源码反复强调 "byte-identical prefix" 的原因 —— **没有容错空间**。

### ③ thinking 签名回放

fork 会原样复制父级的 thinking 块：

```
父级：thinking=1（signature 36 字符）+ tool_use=1
fork 回放（原样带签名）  → OK
对照（移除 thinking）    → OK
```

DeepSeek 端点对 thinking 块**比官方宽松**，带不带都不报错。

---

## 五、打开开关需要补什么（已全部修复）

### 1. `commands.ts` —— 缺失命令模块会启动崩溃

`peers` / `fork` / `buddy` 三个目录在泄漏源码里**不存在**（被剥掉的正是未启用特性
对应的命令）。开关一开：

```ts
const forkCmd = feature('FORK_SUBAGENT')
  ? require('./commands/fork/index.js').default   // ← MODULE_NOT_FOUND，启动即崩
  : null
```

**修复**：改成 `optionalRequire`，只降级该命令，其余照常。

> ⚠️ fork 的**能力**走 Agent 工具（省略 `subagent_type`），不依赖 `/fork` 命令。

### 2. `forkSubagent.ts` —— 门控把 GUI 误判成「非交互」

```ts
if (getIsNonInteractiveSession()) return false
```

TUI 会调 `setIsInteractive()`，但 **GUI 走 `--ide-mode` 绕过 main.tsx，从不调用**
→ `STATE.isInteractive` 保持默认 `false` → fork 在 GUI 里永远静默失效。

**现象**：子代理拿到的是普通 prompt（4,527 字符），而不是父级 fork prompt（29,151）。

**修复**：用 `CLAUDE_CODE_IDE=1`（`ideMode.ts:3415` 设置）区分。

```ts
if (getIsNonInteractiveSession() && process.env.CLAUDE_CODE_IDE !== '1') {
  return false
}
```

### 3. `QueryEngine.ts` —— `renderedSystemPrompt` 从未被赋值

fork 要靠这个值复用父级**逐字节**的 system prompt，否则重建的字符串可能与父级
不同 → prompt cache 全废。原先只有 TUI 的 `REPL.tsx` 写它，GUI 这条路径从未写。

而且 `QueryEngine.ts:497` 那个 context 是**重建字面量**（不是展开），
漏字段会静默丢失 —— **两处都要补**。

### 4. `UserForkBoilerplateMessage.tsx` —— 渲染组件被剥掉

终端 TUI 渲染 `<fork-boilerplate>` 块用的。补一个最小实现（折叠成一行摘要）。
GUI 走自己的渲染路径，不受影响。

---

## 六、`/fork` 命令：官方有两套

从官方 exe 二进制里提取到的定义：

```js
fleetFork: {
  open: () => TE() && !De(i.IS_DEMO),
  whenOpen:   [prn, mrn, ...[]],   // /fork(会话复制) + /subtask
  whenClosed: [frn]                // /fork(后台 agent)
}
```

| 命令 | 说明 | 出现条件 |
|---|---|---|
| `/fork <directive>` | 起一个后台 agent，继承完整对话 | fleet 关闭 |
| `/fork [prompt]` | 把对话复制成新的后台会话，留在这里继续 | fleet 开启 |
| `/subtask <task>` | 派一个带完整上下文的子代理，结果回到这里 | fleet 开启 |

**保持原样是有意的选择**：`/fork` 是命令层的便利，`Agent` 工具路径才是能力层。
官方自己都还在演进这块语义，贸然实现很快会对不上。

另外注意：`/fork` 目前是 `/branch`（会话级分叉）的别名：

```ts
// src/commands/branch/index.ts
aliases: feature('FORK_SUBAGENT') ? [] : ['fork'],
```

---

## 七、递归保护

fork 子代理的工具池里**保留着 Agent 工具**（否则工具定义不同，cache 就废了）。
所以需要运行时防护：

```ts
if (queryScope === 'agent:builtin:fork' || isInForkChild(messages)) {
  throw new Error('Fork is not available inside a forked worker.')
}
```

`isInForkChild` 靠扫描 boilerplate 标签识别 —— 就是 `buildChildMessage()` 里
那段「STOP. READ THIS FIRST. You are a forked worker process...」。

### 官方给 fork 的 10 条硬规则（摘要）

```
1. 系统提示说 "default to forking" 的，忽略它 —— 你是 fork
2. 不要对话、提问、建议下一步
3. 不要评论、加元信息
4. 直接用工具
5. 如果改了文件，提交并在报告里给 commit hash
6. 工具调用之间不要输出文字
7. 严格待在指令范围内
8. 报告控制在 500 词内
9. 响应必须以 "Scope:" 开头
10. 报告结构化事实，然后停
```

---

## 八、当前状态与开关

### 代码状态

四处修复已提交（`2f11f67`），但**正式构建默认未开启**。

### 如何开启

```bash
bun build --compile --feature=FORK_SUBAGENT --outfile=claude.exe src/entrypoints/compiled-entry.ts
```

Bun 1.3.13 实测：

```bash
bun run t.ts                            → OFF
bun build --outfile=o.js t.ts           → OFF
bun build --feature=FORK_SUBAGENT ...   → ON
```

### ⚠️ 开启前必须知道的影响

```ts
const forceAsync = isForkSubagentEnabled()
```

**一打开，所有子代理都转后台**，不只是 fork。意味着：

- 让 Claude「读 5 个文件总结一下」→ 立即返回，然后等通知
- 后续推理要等子代理完成才能继续

对「经常一口气要结论」的用法，这可能**降低体验**。

---

## 九、测试方法上的两个坑

### 单线程代理会堵死

测并行行为时，第一个连接卡在 `sleep` 会堵住后续所有请求。
必须用 `http.server.ThreadingHTTPServer`。

### 项目级 settings 会覆盖 `--settings`

`.claude/settings.local.json` 里的 `ANTHROPIC_BASE_URL` 会**覆盖**
`--settings` 传的值（`applyConfigEnvironmentVariables()` 会
`Object.assign(process.env, settings.env)`）。

想用代理抓包，只能改那个文件（记得先备份），或者用独立 `CLAUDE_CONFIG_DIR`。

---

## 十、验证清单（全部通过）

| 检查 | 结果 |
|---|---|
| prompt cache 同前缀命中 | **98.4%**（9,106 → 147 tokens） |
| 缓存失效边界 | 中间/开头改动即失效 ✓ |
| thinking 签名原样回放 | 通过（移除也不报错） |
| GUI fork 门控 | `isForkPath=true gate=true` |
| system prompt 继承 | **父级**（修复前是「重算」） |
| GUI 后台任务事件 | `task_started` + `task_progress` 正常 |
| CLI 启动（开关打开） | 正常，`--version` 可输出 |
