# 官方版本逆向分析操作手册

> 目标: 从官方 `claude.exe` 提取运行时信息（agent 类型、系统提示词、工具列表等）
> 方法: 代理抓包（最有效）+ PE 二进制字符串提取
> 最新分析版本: 2.1.211 (2026-07-16)

## 环境准备

`proxy_stream.py` **只用 Python 标准库，无需安装任何依赖**。

官方 exe 自行准备，放 `temp/claude.exe`（~241 MB，Bun --compile 产物）。
**`temp/` 不入 git** —— 该文件历史上被清理过，仓库里现在没有，需要时从官方安装包取。

> 抓包产物也写到 `temp/capture/`（同样不入 git），不会污染仓库。

## 方法一：代理抓包（最有效）

### 原理

官方 `claude.exe` 启动后会向 `ANTHROPIC_BASE_URL`（从 `~/.claude/settings.json` 读取）发 POST 请求，请求体 JSON 包含 `system`（系统提示词）、`tools`（工具列表含 agent 类型）、`messages`（用户消息）。

拦截这个请求体就能拿到完整的运行时信息。

### 操作步骤

**1. 启动代理脚本**

```bash
# 拦截 + 转发到真实 API（默认目标 DeepSeek，可用 --target 改）
python scripts/reverse-engineering/proxy_stream.py
```

代理在 `127.0.0.1:8899` 监听，把每个 POST 请求保存为
`temp/capture/capture_{timestamp}_{seq}.json`，然后转发到目标 API。

**2. 修改 settings.json 指向代理**

```bash
# settings.json 的 env 段里的 ANTHROPIC_BASE_URL 要改成 http://127.0.0.1:8899
# 注意：直接 set $env:ANTHROPIC_BASE_URL 没用，settings.json 优先级更高
```

**3. 运行官方 exe**

```bash
temp/claude.exe -p "你的prompt"
```

**4. 分析捕获的 JSON**

捕获的文件在 `temp/capture/capture_*.json`。关键字段：
- `system` — 系统提示词（数组，每个 block 的 `text` 字段）
- `tools` — 工具列表，其中 `name: "Agent"` 的工具描述里包含所有可用 agent 类型
- `messages` — 对话历史

**5. 恢复 settings.json**

```bash
# 改完后记得还原
cp ~/.claude/settings.json.bak ~/.claude/settings.json
```

### 获取子 Agent 系统提示词

主 agent 的 system prompt 不含 agent 类型专属内容。要拿到某个 agent 类型的 system prompt（如 `claude`），需让主 agent **真正 spawn 一个子 agent**：

```bash
# prompt 里明确要求用 Agent tool spawn 特定类型
temp/claude.exe -p "Use Agent tool with subagent_type=claude to say hello, then report back"
```

主 agent → API 请求 (capture_1.json) → 响应 → 主 agent 调用 Agent tool → spawn 子 agent → 子 agent 发 API 请求 (capture_2.json) → **capture_2.json 的 system 字段就是子 agent 的完整 system prompt**

子 agent 的请求特征：
- `tools` 数量比主 agent 少（如 46 vs 52）
- `system` 长度不同（子 agent 更短，不含 harness 等公共部分）
- 请求头含 `cc_is_subagent=true`

### 常用 Prompt

```bash
# 获取主 agent 完整信息
temp/claude.exe -p "say hi"

# 获取 claude agent 的 system prompt
temp/claude.exe -p "Use Agent tool with subagent_type=claude to say hello once, then report back"

# 获取 general-purpose agent 的 system prompt
temp/claude.exe -p "Use Agent tool with subagent_type=general-purpose to say hello once, then report back"
```

### 已知坑

| 问题 | 原因 | 解决 |
|------|------|------|
| 代理没抓到请求 | settings.json 里 ANTHROPIC_BASE_URL 没改 | 直接改 settings.json 的 env 段 |
| 改了 settings.json **仍**抓不到 | 工作区 `.claude/settings.local.json` **优先级更高**（项目级覆盖全局） | 一并改它，或临时改名移走 |
| 转发报错 418/502 | Host header 或自定义 header 问题 | 清除 x- 前缀的 header 再转发 |
| 子 agent 没 spawn | prompt 不够明确 | 明确说 "Use Agent tool with subagent_type=xxx" |
| Frida 找不到字符串 | JSC 内部用 rope string，非连续内存 | 放弃 memory scan，用代理抓包（见方法二） |
| **抓包目录被删后拿不到新数据** | 代理启动时创建的目录，删了它不会重建，写入静默失败 | 跑之前先 `mkdir -p` 那个目录 |
| **改了源码但抓包没变化** | 测的是**安装目录的旧二进制**（GUI 连的是那个），不是源码 | 用 `bun --preload ./preload.ts ./src/entrypoints/cli.tsx` 跑源码；或先确认 `--version` |
| **单条请求超时** | 代理是单线程时，第一条卡住会堵死后续 | 用 `ThreadingHTTPServer`（`proxy_stream.py` 已用） |
| 改了配置好了几秒又变回去 | 项目的 `.claude/settings.local.json` 与 `--settings` 同时生效，后者被覆盖 | 只改一个来源 |

### 分析层面的坑

抓包本身没问题、但**结论**容易错的地方：

| 现象 | 容易得出的错误结论 | 正确做法 |
|------|------|------|
| 官方描述里一堆句子"我们缺" | "我们少了很多功能" | 多数是**拆句方式不同**。逐条人工核对，只挑真缺的 |
| 系统提示比官方长 5 倍 | "官方精简了我们啰嗦" | 先量**分段**，找出最大的那一块再判断 |
| 某个功能在 system prompt 里有说明 | "这功能是启用的" | 去查**它自己的 gate 条件** —— 可能永远不启用 |

详细方法论见 [gap-analysis-playbook.md](./gap-analysis-playbook.md)。

## 方法二：Frida 内存分析 —— **已判定不可行，不要重试**

试过四个方向，**全部失败**，脚本本身也没保留（曾在 `temp/`，已随临时目录清理）：

| 尝试 | 结果 | 原因 |
|---|---|---|
| Hook `WriteFile` / `fwrite` / `printf` 抓 stdout | ❌ | 输出走 Bun 内部缓冲，不经过这些点 |
| `Memory.scanSync` 找 system prompt | ❌ | JSC 用 **rope string**，长字符串在内存中非连续 |
| UTF-16 变体扫描 | ❌ | 同上，编码不是问题所在 |
| Hook `SSL_write` 抓明文 HTTP | ❌ | BoringSSL **静态链接 + 符号未导出** |

→ 想拿运行时信息，**直接用方法一的代理抓包**。

## 方法三：PE 二进制字符串提取（静态分析）

### 原理
Bun --compile 产物里，JS 代码被编译为 JSC 字节码不可反编译，但**字符串常量、配置项、错误信息等仍以明文嵌入 PE 文件**。

### 操作

```python
import re
with open('claude.exe', 'rb') as f:
    data = f.read()

# 提取所有可打印字符串
strings = re.findall(b'[\x20-\x7e]{8,}', data)

# 过滤有意义的内容
for s in strings:
    try:
        text = s.decode('ascii')
        if text.startswith('You are') or 'agent' in text:
            print(text)
    except:
        pass
```

### 可提取的信息类型
| 信息 | 成功率 | 说明 |
|------|--------|------|
| 系统提示词（部分） | ⚠️ 中等 | JSC 会拆分长字符串，可能需要拼接 |
| Agent 类型名 | ✅ 高 | `general-purpose`、`explore`、`plan` 等 |
| Feature flag 名 | ✅ 高 | `tengu_*` 系列 |
| API endpoint | ✅ 高 | `https://api.anthropic.com` 等 |
| 工具名 | ✅ 高 | 所有工具注册名 |
| 模型名 | ✅ 高 | `claude-sonnet-4` 等 |
| JSC 字节码 | ❌ 不可 | 无法反编译 |

## 文件清单

### 仓库内（已提交）

| 文件 | 用途 |
|------|------|
| `scripts/reverse-engineering/proxy_stream.py` | 代理抓包 + 转发（**唯一保留的工具**） |
| `docs/reverse-engineering/prompts/capture_*_prompt.txt` | 提取的 6 种子 agent system prompt |
| `docs/reverse-engineering/sample_main_26tools.json` | 主 agent `-p` 模式请求样本（26 工具） |
| `docs/reverse-engineering/sample_main_interactive_29tools.json` | 主 agent 交互模式请求样本（29 工具） |
| `docs/reverse-engineering/sample_claude_subagent.json` | claude 子 agent 请求样本（15 工具） |
| `docs/reverse-engineering/capture_claude_subagent_tools.json` | claude 子 agent 工具 schema |
| `docs/reverse-engineering/official-version-analysis.md` | 版本差异分析报告 |
| `docs/reverse-engineering/reverse-engineering-guide.md` | 本文件 |

### `temp/` 目录（gitignored，需自行准备）

| 文件 | 用途 |
|------|------|
| `claude.exe` | 官方二进制（~241 MB）。**当前不存在**，需从官方安装包取 |
| `capture/` | 抓包产物（`proxy_stream.py` 自动创建） |
| `mitm_anthropic_capture.py` | mitmproxy addon（若装了 mitmproxy 可作真 HTTPS MITM 用；**默认环境未安装**） |
