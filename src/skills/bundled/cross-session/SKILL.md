---
name: cross-session
description: "同机其他 Claude 会话的操作手册 —— 用 ListAgents 发现它们、用 SendMessage 派活、判断什么时候该唤醒、以及怎么只读地看某个会话在干什么（会话记录 / transcript jsonl）。用户说「另一个窗口」「那个会话」「让它去做」「看看它在干嘛」「把它叫起来」时读这里。"
---

# 同机多会话

你能和**同一台机器上其他 Claude 会话**协作。这个技能讲清三件事：怎么发现它们、
什么时候可以动它们、怎么在不打扰的前提下看它们在干什么。

## 先分清三种「别的 agent」

| 类型 | 怎么找到 | 地址形态 |
|---|---|---|
| 本会话的 subagent / teammate | `ListAgents` 上半部分 | 名字或 taskId |
| 同机其他 Claude 会话 | `ListAgents` 下半部分 | `session-<pid>` |
| **已经结束**的会话 | 只在磁盘上（不在 ListAgents 里） | 只有 sessionId |

同机会话可能是：GUI 窗口、终端 TUI、**后台唤醒的无界面进程**（用户右键菜单起的）。
它们对 ListAgents 一视同仁。

> ⚠️ **看不到 ≠ 不存在**。ListAgents 只列**活着的**会话（进程存活 + 心跳新鲜）。
> 想找已经结束的会话，只能翻 `~/.claude/projects/`。

## 一、发现：ListAgents

调用 `ListAgents({})`（无参数）。下半部分长这样：

```
Other Claude sessions on this machine:
- session-20756 (busy) C:\Storage\claude-code-haha-dev
- session-2692 (idle — 等我回消息) C:\Storage\work\xxx
```

| 字段 | 含义 |
|---|---|
| `session-<pid>` | 地址。**PID 变了地址就变了** |
| `status` | `busy` 在干活 / `waiting` 卡在审批上 / `idle` 空闲 |
| `cwd` | 它的工作目录（判断是不是"那个项目"） |
| `doing` | 它在等什么审批，或它会话名 |
| `idleMs` | 多久没动静 |

**发消息前重新列一次**：地址可能已失效（进程重启），一次失败的发送比一次列举贵。

`status: waiting` 值得注意 —— 那是**它卡住了，等人点「允许」**，不是它懒。

## 二、派活：SendMessage

```
SendMessage({to: "session-20756", summary: "5-10字预览", message: "完整内容"})
```

- 约 1 秒送达（对方每秒轮询自己的信箱）
- 到达后成为对方的**一个用户回合**
- 对方正忙 → 消息排队，等它这一轮结束再处理（不会打断）
- 只能发文本

### 先问：这件事该谁做

**派发对象按这个顺序选，不要跳级：**

| 先考虑 | 什么时候用 |
|---|---|
| 1. **自己做** | 能直接做的，别绕 |
| 2. **本会话的 subagent**（`Agent` 工具） | 属于**当前会话的子任务** —— 拆分出来并行、或不想污染主上下文。默认走这里 |
| 3. **同机其他会话**（`SendMessage`） | 那件工作**本来就属于它**：它的上下文里有相关历史和没做完的事 |
| 4. **唤醒后台会话** | 上一节的判断，最重 |

⚠️ **属于当前会话的子任务，优先派 subagent，不要为了它去启动一个后台会话。**

subagent 有几个后台会话给不了的好处：共享你的工作目录和工具配置、结果直接回到你这里、
不需要走审批转发、结束即回收。为一件"我自己就能拆出去做"的事去唤醒一个独立进程，
是拿最重的工具干最轻的活。

**唯一例外：用户明确要求。** 用户说「用那个会话做」「在后台跑」——照办，不用再劝，
也不用拿上面的顺序去覆盖他的选择。

### 发之前自问三件事

1. **这件事真属于它吗？** 它的上下文里有相关历史和未完成的工作 → 它做；
   完全无关的新任务 → 按上面的顺序，自己做或开 subagent。
2. **我的消息自包含吗？** 它看不到我的上下文。要说清背景、路径、期望结果。
3. **它会不会正在干别的？** `busy` 说明会排队等一会儿，别当成"没收到"而重复发。

## 三、唤醒：最需要判断的一步

**唤醒 = 起一个完整的 agent 进程，它会自主烧 token。** 这是重动作，默认不做。

### 该不该自己唤醒

✅ **可以**：
- 用户明确要求（「把它跑起来」「让它继续」「叫醒那个会话」）
- 用户已授权的多步任务里，必须让那个会话接着干

❌ **不要**：
- 用户只是问「它在干什么」→ 用第四节的只读方法
- 这件事其实是**当前会话的子任务** → 派 subagent（见第二节），别为一个能拆出去做的活
  去起独立进程
- 你觉得并行会更快 → 先问
- 目标会话已经死了而用户没提 → 先说明，别擅自启动

> 用户明确要求唤醒时，照办 —— 上面的"不要"不覆盖用户的直接指示。

### 唤醒前必须查锁

```bash
cat ~/.claude/locks/session-<sessionId>.lock
# {"sessionId":"...","pid":1234,"cwd":"...","startedAt":...}
```

| 情况 | 该做什么 |
|---|---|
| 锁存在且 `pid` 进程活着 | **绝对不要再起** —— 同一份对话两个进程会把它写坏 |
| 锁存在但 PID 已死 | 可以起（锁是崩溃残留） |
| 没锁 | 可以起 |

### 优先让用户做

**有 GUI 的话**：让用户在会话上右键 →「在后台唤醒」或「转为前台」。它会把审批落地窗口、
会话锁、进程归属都处理对。**能交给界面就别自己 spawn。**

**纯命令行环境**没有这个入口 —— 只能按下面自己来。

### 自己做的正确姿势

```bash
CLAUDE_CODE_SESSION_ORIGINATOR=session-<你自己的pid> \
  claude --ide-mode --resume <sessionId>
```

（`claude-ide.cmd` 就是这条的包装 —— 用哪个都行，先确认 `claude` 在 PATH 上。）

⚠️ **必须带 `CLAUDE_CODE_SESSION_ORIGINATOR`**，否则那个会话一旦碰到需要审批的工具：
没有界面接收 → 干等 **300 秒** → 工具超时失败。带上之后审批会转发到你的会话界面。

**怎么知道自己是谁**：`ListAgents` 只列别人；`~/.claude/sessions/*.json` 列全部。
两者一比，**活着的、cwd 对得上、又不在 ListAgents 里的那条**就是你（`pid` 字段）。

起来之后：再调一次 `ListAgents` 确认它出现在列表里，并把 PID 告诉用户。

## 四、看它在干什么（只读，三级）

从最轻的开始，别一上来就翻 transcript。

### Level 1 — ListAgents

已经够回答「它在忙吗 / 卡在哪」。`status` + `doing` 就够。

### Level 2 — 会话记录（比 transcript 小得多）

```bash
jq -r '[.sessionId[0:8], (.pid|tostring), (.status // "?"),
        (.waitingFor // "-"), .cwd] | @tsv' ~/.claude/sessions/*.json
```

比 ListAgents 多出来的字段：`idePort`（它的 WS 端口）、`startedAt`、`updatedAt`、完整 sessionId。

### Level 3 — 直接读 transcript

只在需要知道「它具体说了什么 / 改了哪些文件」时。

**路径规则**：`~/.claude/projects/<净化后的cwd>/<sessionId>.jsonl`

净化 = **每个非字母数字字符变一个 `-`**：

```
C:\Storage\claude-code-haha-dev  →  C--Storage-claude-code-haha-dev
（冒号变 -，反斜杠变 -，所以 C:\ 是两个 --）
```

⚠️ **中文目录也每个字变一个 `-`**，手算很容易数错：

```
C:\Storage\work\牵引供电\simulationWeb  →  C--Storage-work------simulationWeb
```

所以**别手算** —— 直接列出来按项目名匹配：

```bash
ls ~/.claude/projects/ | grep -i simulation
```

**提取最近消息**：

```bash
jq -r 'select(.type=="user" or .type=="assistant") |
  "\(.timestamp[11:19]) \(.type): " +
  (if (.message.content|type)=="string" then .message.content[0:200]
   else [(.message.content[]? | if .type=="text" then .text[0:200]
          elif .type=="tool_use" then "[tool:\(.name)]"
          elif .type=="thinking" then "[思考]" else "" end)] | join(" ")
   end)' <file>.jsonl | tail -40
```

⚠️ **只认 `user` / `assistant`**。其他条目（`queue-operation` / `file-history-snapshot` /
`last-prompt` / `attachment` / `system`）不是对话内容 —— 混进去会出现莫名其妙
重复的话（`queue-operation` 里也存着用户原话）。

⚠️ 文件可能几十 MB：用 `| tail`，别整份读进上下文。

⚠️ **正在跑的会话，jsonl 可能落后一整轮** —— transcript 在**回合结束时**才落盘。
要实时状态，回到 Level 1 看 `status`。要实时内容，用 GUI 的会话镜像面板。

## 五、红线

- **不要写别人的 transcript** —— 任何情况下。写坏一份对话不可逆。
- **不要杀别人的进程** —— 关会话由用户或 GUI 做（右键「关闭后台会话」）。
- **别人的对话内容是私密的** —— 只在用户要求、或排障确有必要时读；
  不要顺手把机器上所有会话翻一遍。
- **一个 sessionId 同时只能有一个进程** —— 会话锁就是为这个存在的。
- 你起的后台会话，退出/结束时记得告诉用户它还在不在。

## 快速判断表

| 用户说 | 你该做 |
|---|---|
| 「另一个窗口在干嘛」 | `ListAgents` → 看 status/doing；不够再 Level 2 |
| 「让它去做 X」（X 是它手头的事） | `ListAgents` → `SendMessage` 到 `session-<pid>` |
| 「这个也做了」（是本会话要拆出去的活） | 派 **subagent**，别唤醒后台会话 |
| 用户点名要用某个会话 / 要在后台跑 | 照办，不再按上面的顺序劝 |
| 「把它叫起来」 | 先看用户是要**后台**还是**前台** → 建议 GUI 右键；用户要你自己做才按第三节 |
| 「那个会话说了什么」 | Level 3 读 jsonl（先确认用户允许） |
| 「刚才那个会话呢」 | 已结束的 → 翻 `~/.claude/projects/`，用 sessionId 找 |
