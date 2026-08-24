# 官方版本逆向分析操作手册

> 目标: 从官方 `claude.exe` 提取运行时信息（agent 类型、系统提示词、工具列表等）
> 方法: HTTPS 代理抓包（最有效）+ PE 二进制字符串提取
> 最新分析版本: 2.1.211 (2026-07-16)

## 环境准备

```bash
# 依赖
pip install frida  # 可选，用于内存分析
```

官方 exe 路径: `temp/claude.exe`（~241 MB，Bun --compile 产物）

## 方法一：代理抓包（最有效）

### 原理

官方 `claude.exe` 启动后会向 `ANTHROPIC_BASE_URL`（从 `~/.claude/settings.json` 读取）发 POST 请求，请求体 JSON 包含 `system`（系统提示词）、`tools`（工具列表含 agent 类型）、`messages`（用户消息）。

拦截这个请求体就能拿到完整的运行时信息。

### 操作步骤

**1. 启动代理脚本**

```bash
# temp/proxy_stream.py — 拦截 + 转发到真实 API
python temp/proxy_stream.py
```

代理会在 `127.0.0.1:8899` 监听，把收到的每个请求保存为 `temp/capture_{timestamp}_{seq}.json`，然后转发到 DeepSeek API。

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

捕获的文件在 `temp/capture_*.json`。关键字段：
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
| 转发报错 418/502 | Host header 或自定义 header 问题 | 清除 x- 前缀的 header 再转发 |
| 子 agent 没 spawn | prompt 不够明确 | 明确说 "Use Agent tool with subagent_type=xxx" |
| Frida 找不到字符串 | JSC 内部用 rope string，非连续内存 | 放弃 memory scan，用代理抓包 |

## 方法二：Frida 内存分析（备选）

### 适用场景
- 不想消耗 API 额度时快速扫描
- 已知字符串在二进制中的位置

### 脚本
- `temp/frida_hook.py` — Hook WriteFile/fwrite/printf 捕获 stdout
- `temp/frida_dump.py` — 扫描内存找系统提示词
- `temp/frida_dump2.py` — 支持 UTF-16 扫描（JSC 字符串编码）
- `temp/frida_ssl_capture.py` — Hook SSL_write 捕获明文 HTTP 请求（BoringSSL 静态链接，未导出符号）

### 局限性
- JSC 内部字符串存储是非连续的（rope string），`Memory.scanSync` 找不到
- BoringSSL 静态链接且符号未导出，`SSL_write` hook 不到
- 不如代理抓包可靠

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
| `scripts/reverse-engineering/proxy_stream.py` | HTTPS 代理抓包 + DeepSeek 转发 |
| `docs/reverse-engineering/prompts/capture_*_prompt.txt` | 提取的 6 种子 agent system prompt |
| `docs/reverse-engineering/sample_main_26tools.json` | 主 agent `-p` 模式请求样本 |
| `docs/reverse-engineering/sample_claude_subagent.json` | claude 子 agent 请求样本 |
| `docs/reverse-engineering/sample_main_interactive_29tools.json` | 主 agent 交互模式请求样本 |
| `docs/reverse-engineering/capture_claude_subagent_tools.json` | claude 子 agent 工具 schema |
| `docs/reverse-engineering-guide.md` | 本文件 — 逆向操作手册 |
| `docs/official-version-analysis.md` | 版本差异分析报告 |

### `temp/` 目录（gitignored）

| 文件 | 用途 |
|------|------|
| `claude.exe` | 官方 2.1.211 二进制 (241 MB) |
| `python-full.exe` | 嵌入式 Python 运行时 (25 MB) |
| `captured_full.json` | 最后一次成功捕获的完整 API 请求体（已丢失，方法见本指南） |
| `claude_agent_prompt.txt` | 历史：提取到的 claude agent system prompt（已移至 docs/） |
