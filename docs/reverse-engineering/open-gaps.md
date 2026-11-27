# 未对齐缺口（2026-11-27 实测）

> 这份是**给下一次会话直接开工用的**，不是分析记录。
> 测量方法在文末，数字都可以复现。

## 先说清楚：这两项**不是**缺口

| 项 | 状态 |
|---|---|
| `ScheduleWakeup` 工具 | **用户明确不要**（见 [official-version-analysis.md](./official-version-analysis.md) 的「明确不做的」） |
| `Workflow` 工具 | 同上 |

⚠️ **别再当缺口提。** 判它们是不是缺口的依据不在这份文档里，而在
`official-version-analysis.md` 的「### 明确不做的」那张表——**提任何缺口前先读那张表**。

---

## 缺口一：memory 文件 frontmatter 格式对不上 —— ✅ 已处理（2026-11-27）

### 官方 2.1.316 的写法

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary>
metadata:
  type: user | feedback | project | reference
---

<fact>

**Why:** … **How to apply:** …

Link related memories with [[their-name]].
```

**三个特征**：
1. `type` 在 `metadata:` **下面**，不是顶层
2. 类型只有四个：`user` / `feedback` / `project` / `reference`
3. 正文用 `[[name]]` 互链，且明确说「`[[name]]` 暂时匹配不上是**正常的**，
   它标记的是以后值得写的东西，不是错误」

### 我们的现状

`src/memdir/memoryTypes.ts:192-194`（`MEMORY_FRONTMATTER_EXAMPLE`）：

```markdown
---
name: {{memory name}}
description: {{…}}
type: {{user, feedback, project, reference}}     ← 顶层
---
```

读取侧 `src/memdir/memoryScan.ts:61`：

```ts
type: parseMemoryType(frontmatter.type),
```

全文搜 `[[` 在 `src/memdir/` 里 **0 处**——wikilink 完全没实现。

### 后果（这是**行为**差异，不是表述差异）

按新格式写的记忆文件，被我们读到的是 `type: undefined`：

- 不报错、不警告，记忆照样被扫描、照样进索引
- 只是**类型静默丢失** —— 依赖类型的筛选/展示会退化

这正好是手册里判为「值得改」的第一类（**行为差异**），而且属于会静默失败的那种。

### 建议改法

1. **读取兼容两种**（先做这个，风险最低）：
   `frontmatter.metadata?.type ?? frontmatter.type`
2. 提示词（`TYPES_SECTION_*` / `MEMORY_FRONTMATTER_EXAMPLE`）切到新格式
3. 可选：扫描 `[[links]]` 建关系——**但注意官方明说「匹配不上是正常的」**，
   所以这必须是一条弱关系，不能因为它没匹配上就报警
4. 老文件不用迁移：兼容读取会让顶层 `type:` 继续有效

### 改法（已实施）

1. **读取兼容两种**：`memoryScan.ts` 改为
   `parseMemoryType(frontmatter.metadata?.type ?? frontmatter.type)`。
   两者同时存在时以 `metadata.type` 为准。
2. **提示词切到新格式**：`MEMORY_FRONTMATTER_EXAMPLE` 用 `metadata.type`，
   并在示例后补两句：`[[name]]` 互链的用法与「匹配不上是正常的」；
   旧顶层 `type:` 仍可读、新文件写 `metadata.type`。
3. **没有做**：`[[links]]` 的解析建图。官方那条是「标记以后值得写的东西」的
   弱约定，不改变任何行为；先把读写格式对齐，真要建关系时再单独设计。
4. **老文件不迁移**：本机 154 个记忆文件中 147 个用顶层 `type`，兼容读取后全部继续有效。

### 验证（已进测试）

`src/memdir/memoryScan.test.ts`：

- `metadata.type: feedback` → 读出 `feedback`
- 顶层 `type: project` → 读出 `project`
- 两者同时存在 → 以 `metadata.type` 为准
- 缺失 / 非法值 → `undefined`（不猜、不报错）
- 示例文本包含 `metadata:`、`[[` 与「both are read」

**变异验证**：把读取改回只认 `frontmatter.type` → 前两个用例中的两条变红；
还原 → 5 条全绿。

---

## 缺口二：SDK 入口的 system prompt 应该精简 —— ✅ 已处理（2026-11-27）

### 先补上原来缺的那条验证

原文档要求「动手前先抓一条 `-p` 的包」，已抓：

| 请求 | 入口 | 块数 | system 总字符 |
|---|---|---:|---:|
| 官方 `claude.exe -p "say hi"`（2.1.211） | **sdk-cli** | 3 | **6,247** |
| 官方交互式样本（2.1.211） | cli | 3 | 7,089 |
| 官方 SDK 样本（2.1.316） | sdk-cli | 3 | 5,673 |
| 我们 `cli.tsx -p`（改前） | sdk-cli | 3 | **23,292** |

结论：**官方 `-p` 也走 sdk-cli，交互式与 SDK 用的是同一套五节结构**。
所以不存在「只有 SDK 入口该精简」这回事——差异在 body 内容本身。

官方正文只有五个小节（交互式与 SDK 相同）：

```
# Harness
# Session-specific guidance
# Memory
# Environment
# Context management
```

### 采用的做法（用户 2026-11-27 决定）

**结构对齐官方；内容按「保留有用的规则、只压措辞」处理**，不是照搬官方
5.5K 的极简直出——那批编码规则（别过度设计、写完要验证、如实报告等）
每条背后都有真实踩坑，删掉会退化。

- 六个平级小节（`# System` + `# Doing tasks` + `# Executing actions with care`
  + `# Using your tools` + `# Tone and style` + `# Output efficiency`）合并为
  `# Harness` 下的 bullets、两段散文、`## Doing tasks`、
  `## Communicating with the user`。
- 新增 `# Context management`：原来分散在 `# System` 尾句、
  `# Output efficiency` 末段与独立的 `summarize_tool_results` 小节里。
- memory 标题 `# auto memory` → `# Memory`（与 `teamMemPrompts` 一致）。
- 产品特有小节（Language / Output Style / Scratchpad / MCP）保留，排在官方五节之后。
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 位置不变（静态前缀仍可全局缓存）。

### 结果

| | 字符数 | 顶层小节数 |
|---|---:|---:|
| 改前 `getSystemPrompt()` | 21,713 | 12 |
| 改后 `getSystemPrompt()` | **17,860** | **7**（5 官方 + 2 动态可选） |

实际请求 body（含 MCP 说明）19,338 字符 / 3 块。省约 3,850 字符（≈960 tokens）。

剩余差距是刻意的：Memory 6.1K（官方 2.1K）、Harness 7.6K（官方 1.5K）——
保留规则优先于追求官方数字。

### 复现

改前/改后的请求包：`temp/capture/capture_20261127_142553_0003.json`（旧）
与 `capture_20261127_143407_0001.json`（新）。抓法见
[reverse-engineering-guide.md](./reverse-engineering-guide.md)。

> ⚠️ 抓包时 `~/.claude/settings.json` 与项目的 `.claude/settings.local.json`
> **两处**都要临时改 `ANTHROPIC_BASE_URL`（后者优先级更高）；跑完按字节还原始值。

---

## 附：这些数字怎么复现

### 官方一侧

样本就在仓库里：`docs/reverse-engineering/sample_main_2.1.316_sdk.json`

```python
import json
d = json.load(open('docs/reverse-engineering/sample_main_2.1.316_sdk.json', encoding='utf-8'))
total = sum(len(b['text']) for b in d['system'])
print(len(d['system']), 'blocks,', total, 'chars,', len(d['tools']), 'tools')
```

### 我们一侧

`getSystemPrompt()` 直接调不了——它前面有 config 闸门
（`src/utils/config.ts` 的 `configAccess`，`enableConfigs()` 之前读配置会抛
`Config accessed before allowed.`）。**先 `enableConfigs()` 再动态 import**：

```ts
// 放在 temp/ 下（已 gitignore），别提交
import { enableConfigs } from '../src/utils/config.ts'
enableConfigs()
const { getAllBaseTools } = await import('../src/tools.ts')
const { getSystemPrompt } = await import('../src/constants/prompts.ts')
const tools = getAllBaseTools().filter(t => { try { return t.isEnabled() } catch { return true } })
const parts = await getSystemPrompt(tools as any, 'deepseek-v4-flash-vision-exp')
console.log(parts.length, parts.reduce((n, p) => n + p.length, 0))
```

⚠️ 用 `bun --env-file=.env temp/xxx.ts` 跑。直接 `bun` 绝对路径 import 会
找不到模块（路径要相对）。

### 抓一条新包

`scripts/reverse-engineering/proxy_stream.py` 起代理 → 让官方 `claude.exe`
指向它。

⚠️ 实测：本机的 `~/.claude/settings.json` 里 `env.ANTHROPIC_BASE_URL` 会盖掉
命令行环境变量。要抓包得先临时改它，或者用 `CLAUDE_CONFIG_DIR` 指一个隔离
目录（**但隔离目录也实测没过——请求仍然走了 settings 里的地址**，说明还有
别的读取路径，下次要查）。
