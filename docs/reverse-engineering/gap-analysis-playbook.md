# 差异挖掘手册 —— 从"抓到数据"到"找到能改的东西"

> 抓包方法见 [reverse-engineering-guide.md](./reverse-engineering-guide.md)（怎么拿到请求体）。
> 这篇讲**拿到之后怎么挖**：哪些差异值得改、哪些是噪音、以及四个真正见效的搜索模式。
>
> 来源：2026-11-04 一次完整的挖掘会话（15 个提交，system prompt 从 30003 → 22678 字符）。

---

## 一、先立规矩：什么算"值得改"

抓到官方请求后会发现**几百处**差异。没有判据就会陷入两个坑：改了一堆没用的，
或者因为差异太多干脆放弃。

### 三类差异，只有第一类值得动手

| 类型 | 例子 | 处理 |
|---|---|---|
| **行为差异** | 官方说"别 amend，commit 没发生"、我们没有 | ✅ 补 |
| **效率差异** | 同一句话写了 3 遍、死代码注入 | ✅ 删 |
| **表述差异** | 官方 "Reads up to 2000 lines"、我们 "Reads up to ${MAX_LINES_TO_READ}" | ❌ 忽略 |

**判据一句话**：这条改完，模型的行为会变吗？会 → 值得；只是换个说法 → 不值得。

### 三类差异的识别信号

- **行为差异**：出现了「不要 X」「必须 Y」「先做 Z」这类祈使句，而我们的版本没有
- **效率差异**：同一段意思在本文件/其他文件里出现两次；或者代码里引用了本构建不存在的功能
- **表述差异**：数字被变量化了、句子顺序不同、分段方式不同

---

## 二、四个搜索模式（按性价比排序）

这四个模式覆盖了本次挖掘中**全部 15 个提交**。

### 模式 1：句子级全量比对（找行为差异）

**最有效**。把官方每个工具描述拆成句子，逐句在我们的描述里找。

```python
import json, re, glob
ours = json.load(open(抓到的请求, encoding='utf-8'))
off  = json.load(open('docs/reverse-engineering/sample_main_2.1.316_sdk.json', encoding='utf-8'))
o = {t['name']: t for t in ours['tools']}
f = {t['name']: t for t in off['tools']}

def sents(t):
    return [s.strip() for s in re.split(r'(?<=[.。])\s+|\n', t or '') if len(s.strip()) > 30]

for n in sorted(set(o) & set(f)):
    anorm = re.sub(r'\s+', ' ', o[n].get('description') or '')
    for s in sents(f[n].get('description')):
        if re.sub(r'\s+', ' ', s)[:45] not in anorm:
            print(f'[{n}] {s[:140]}')
```

**读结果的诀窍**：输出会有一堆"缺失"，但**大部分是误报** —— 因为官方把多条信息
写在一句里，我们拆成了多句。逐条人工过一遍，只挑真正缺的。

实测产出：fork 递归指引、Skill 名称用法、子代理 CLAUDE.md 提示。

### 模式 2：跨位置重复检测（找效率差异）

同一件事同时写在 **system prompt** 和**工具描述**里 —— 这是最肥的一块。

```python
def sents(t):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+|\n', t) if len(s.strip()) > 80]

tools_text = "\n\n".join(t.get('description') or '' for t in ours['tools'])
tools_norm = re.sub(r'\s+', ' ', tools_text.lower())
for s in sents(system_text):
    if re.sub(r'\s+', ' ', s)[:50].lower() in tools_norm:
        print('重复:', s[:150])
```

**注意**：逐字重复很少见，**语义重复更常见**。这次实测逐字重复 0 条，
但改用"同一主题"人工排查后找出了：

- 专用工具偏好清单（system 版 791 字符 vs Bash 描述版）
- Agent 何时该用（system 版 443 字符 vs Agent 描述版）
- ultrareview 说明（system 里讲了，但命令根本没启用）

**人工排查的信号**：读 system prompt 某一段时想"这个我不是刚在工具描述里见过吗"。

### 模式 3：死代码检测（找效率差异）

代码里引用了**本构建不存在的功能**。

```python
# 1. 列出 system prompt 里提到的功能关键词
probes = ['ultrareview','workflow','ScheduleWakeup','artifact','chrome','kairos',
          'daemon','voice','teleport','bridge']
for k in probes:
    n = system_text.lower().count(k.lower())
    if n: print(f'{k}: {n} 次')

# 2. 逐个确认这些功能在本构建是否真的可用
#    —— 关键：看它的 gate 条件
```

**这次的典型案例**：

```ts
// 注入 system prompt 的代码：无条件
function getUltrareviewSection() { return `...495 字符...` }

// 而命令本身的 gate：
export function isUltrareviewEnabled() {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_review_bughunter_config')?.enabled === true
}
// 我们没有 GrowthBook → 永远 false → 命令不出现，但说明每轮都在注入
```

**通用判据**：`A 无条件注入` + `B 有 gate 且 gate 永假` = 死代码。
修法是让 A 和 B 用**同一个 gate**，而不是直接删（这样将来启用时自动生效）。

### 模式 4：同主题多条合并（找效率差异）

同一个原则被拆成好几条独立规则，每条还带着跨主题的尾巴。

**识别信号**：连续几条规则的**主语相同**，只是宾语不同。

这次的例子：

```
Don't add features, refactor code, or make "improvements"…      (318)
Don't add error handling, fallbacks, or validation…             (285)
Don't create helpers, utilities, or abstractions…               (332)
```

主语都是"别加东西"，宾语分别是功能/错误处理/抽象 → 合成一条（476 字符，省 459）。

**顺带**：合并时注意每条末尾的"跨主题尾巴" —— 第一条塞了注释规则、
第三条塞了"三行重复好过过早抽象"。后者其实是第二条的补充，应该跟第二条走。

---

## 三、怎么量效果

**别凭感觉说"省了"** —— 抓一份请求，数一遍。

```python
import json, glob, re
ours = json.load(open(最新抓包, encoding='utf-8'))
sys_text = "\n\n".join(b.get('text','') for b in ours['system'])
print('system 总计:', len(sys_text))

for p in re.split(r'\n(?=# )', sys_text):
    print(f'{p.splitlines()[0][:44]:46s} {len(p)}')

tool_total = sum(len(t.get('description') or '') for t in ours['tools'])
print('工具描述合计:', tool_total)
```

**做法**：改之前抓一份存下来，改完再抓一份，同一段代码跑两遍，对比数字。

本次实测节省：

| 项 | 改前 | 改后 |
|---|---|---|
| system prompt | 30,003 | **22,785** |
| 工具描述 | 13,739 | 13,672 |
| **合计** | **43,742** | **36,457** |

system prompt 是主战场（-24%），工具描述基本持平 —— 因为中间一边精简
一边补了新行为指引。**别只盯总数**：分项看才知道收益从哪来。

---

## 四、验证纪律（血的教训）

### 教训 1：修的地方 ≠ 出错的地方

这次做「Edit 找不到匹配时兜底试转义互换」，我把逻辑加在
`FileEditTool.ts` 的 not-found 分支里。单测全绿、代码看着也对 —— 但**完全不生效**。

原因：真正的匹配入口是 `utils.ts` 的 `applyEditToFile()`，那里匹配失败时
**静默返回原内容**，根本走不到 not-found 分支。

**怎么发现的**：端到端实测（让模型真的发一个带 `\u4e2d` 的 Edit），
返回的是 `utils.ts` 里那句 `String not found in file`，不是我加的新文案。

**纪律**：
- 单测要打**真正的入口函数**，不是打"我以为的入口"
- 改完必须端到端跑一次，看现象对不对

### 教训 2：先证明测试会红

新加的测试如果永远通过，等于没加。做法：**临时把修复改回去**，
确认测试失败，再恢复。

```bash
cp src/xxx.ts /tmp/bak.ts
# 把修复改回旧行为
npx vitest run path/to/test.ts     # 期望：失败
cp /tmp/bak.ts src/xxx.ts
```

这次有 3 组测试这样验证过（心跳语义、prefill 阈值、已读 scope）。

### 教训 3：验证用的二进制要对

中间一度用**已安装的旧 claude.exe** 测新改的源码，得出"改动不生效"的错误结论。
`-p` 模式跑的是源码没问题，但 GUI 连的是安装目录的二进制。

**纪律**：改完先确认 `--version` 和源码一致，或者明确用 `bun --preload ./preload.ts src/entrypoints/cli.tsx`。

---

## 五、环境层面还能挖什么

除了 prompt，官方二进制里还有这些**没系统扫过**：

| 层面 | 怎么扫 | 产出 |
|---|---|---|
| 环境变量 | `re.findall(rb'CLAUDE_CODE_[A-Z0-9_]{3,40}', exe)` | 992 个，其中 153 个像"用户可调" |
| CLI 参数 | `re.findall(rb'\.option\(["\'](--?[a-z][a-z0-9-]+)', exe)` | 101 个，48 个我们没有 |
| 斜杠命令 | `re.findall(rb'type:"(?:local\|local-jsx\|prompt)",name:"([a-z0-9_-]+)"', exe)` | 100 个，41 个我们没有 |
| 错误文案 | 搜 `Instead,` / `must not` / `Do not` | 找官方防了哪些坑 |

**筛选原则**：官方 992 个环境变量里，大多数是内部实验开关。
只挑满足两条的：① 名字像用户可调（`MAX_*` / `TIMEOUT` / `DISABLE_*`）；
② 能找到它的描述或错误文案（说明是真的功能，不是 A/B 变量名）。

实测有收获的例子：`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`、
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` —— 两个都是真实功能上限，
我们有实现但没接这两个变量。

---

## 六、什么时候该停

三个停止信号，出现任意一个就收手：

1. **连续两轮没有实质产出** —— 只有表述差异，没有行为/效率差异
2. **开始改表述** —— 想把我们的措辞改得和官方一模一样，那是噪音
3. **风险 > 收益** —— 要删的句子看着像"废话"，但说不准模型是不是靠它才不去做某事

本次在第三类上踩过一次：合并「可逆性」段时删掉了一句
"consider the context, the action, and user instructions"。这句确实没操作性，
但**万一它是某个行为的关键触发词**，删了就会退化。这类改动要靠实际用几天验证。

**建议节奏**：攒 10~15 个提交发一版，用几天看有没有退化，再继续。
一次性改太多会分不清是哪一条导致的。
