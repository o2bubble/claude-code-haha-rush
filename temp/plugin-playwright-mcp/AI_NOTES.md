# AI_NOTES — playwright-mcp 排查文档（面向 AI）

本插件是**配置型** ai-guided 插件：为 AI 配置 Playwright MCP 服务器（浏览器自动化）。
用户安装后（市场安装只放入文档骨架），由你（AI）按本文档完成实际配置。

## 你的任务：完成 MCP 配置安装

目标 = 在 `~/.claude.json` 顶层 `mcpServers` 里写入 `playwright` 条目，
使新会话具备 `mcp__playwright__*` 工具（浏览器导航/点击/填表/截图/快照）。

### 第 0 步：前置检测（nodejs 依赖）

本插件 dependencies 含 `nodejs`——先验证其运行时可用：

1. `plugin_list` 确认 nodejs 已装且 enabled
2. 验证 node 真能跑：`node --version`（应 ≥ 18；MCP 需要 npx）和 `npm --version`
3. 若 Bash 找不到 node → nodejs 插件的 runtime 未就绪：读其 AI_NOTES
   （`plugin_docs name=nodejs`）先完成它的环境安装，再回来

### 第 1 步：幂等检测（已配置且能用 → 跳过）

1. 读 `~/.claude.json`（Python: `json.load`），查 `mcpServers.playwright` 是否存在
2. 若存在 → 快速验证可用性：`npx @playwright/mcp --version`（120s 超时）
   - 成功 → **整个安装跳过**，`plugin_set_status(name="playwright-mcp", status="ready", detail={...})` 并告知用户已配置
   - 失败（npx 报错/超时）→ 继续，重写配置
3. ⚠️ **改 `~/.claude.json` 必须用 Python round-trip**：
   ```python
   import json
   d = json.load(open(r'<home>/.claude.json', encoding='utf-8'))
   d.setdefault('mcpServers', {})['playwright'] = {...}
   json.dump(d, open(r'<home>/.claude.json', 'w', encoding='utf-8'),
             ensure_ascii=False, indent=2)
   ```
   禁止用 PowerShell `Get-Content | Set-Content` 字符串替换——会以错误编码写回，
   毁掉文件里的中文（曾发生事故）。改前先备份：`Copy-Item ~/.claude.json ~/.claude.json.bak-playwright`

### 第 2 步：浏览器探测与选择

探测本机已装的浏览器（按顺序检查存在性）：
- Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`
  （及 `C:\Program Files (x86)\...`）
- Edge: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（Windows 预装, 几乎必有）
- 其它 chromium 系按 `LOCALAPPDATA` 下常见路径探

**用 AskUserQuestion 让用户选**，选项只列探测到的浏览器（如 Chrome / Edge）。
用户未响应或超时 → **默认 Edge**（Windows 预装, 优先级最高）。
浏览器名对应 MCP 参数 `--browser chrome|msedge`（chromium 系均可）。

### 第 3 步：写入配置

```json
"playwright": {
  "command": "npx",
  "args": ["@playwright/mcp", "--browser", "<用户选的: chrome|msedge>"]
}
```

写入 `~/.claude.json` 顶层 `mcpServers`（round-trip 见第 1 步，保留其它所有键）。
写完用 `json.load` 重新读一遍确认合法 JSON 且中文完好。

### 第 4 步：验证

- `npx @playwright/mcp --version` 成功输出版本号（如 `Version 0.0.x`）→ 配置本身 OK
- 首次运行 npx 会现场下载包（可能 30-60s），属正常；失败先查网络/代理
- （可选，仅当用户不想用系统浏览器时）`npx playwright install chromium`
  下载 ~130MB 内置 chromium——**默认跳过**，系统浏览器够用

### 第 5 步：上报 + 刷新生效（无需重启）

1. `plugin_set_status(name="playwright-mcp", status="ready", detail={
     "browser": "<选定>", "config": "~/.claude.json mcpServers.playwright",
     "verify": "npx @playwright/mcp --version → 0.0.x"})`
2. **生效方式（主路径）：告诉用户运行 `/mcp-refresh`**（或用户让你刷新时你发该
   slash 命令）。机制：配置读取有 freshness watcher（fs.watchFile 监听
   `~/.claude.json` mtime），外部写入会被自动拾取进缓存；`/mcp-refresh` 重读
   全部 scope 配置并对新服务器建立连接——新会话无需重启即带
   `mcp__playwright__*` 工具。
3. **备用：重启**。若 `/mcp-refresh` 后工具仍未出现（watcher 边缘时序/缓存
   异常），询问用户"是否立即重启 GUI？"→ 同意后调 `app_relaunch`
   **confirm:true**（调用即结束本会话，必须是最后一步动作）。
   `/mcp-refresh` 可用时优先用它——重启体验重且终止会话。

## 故障模式与诊断

### 1. 「重启了但没有 mcp__playwright__ 工具」
- `plugin_list` 看本插件 enabled
- 用 Python 重新读 `~/.claude.json` 确认 `mcpServers.playwright` 还在
  （可能被其它工具写丢了 → 按第 3 步重写）
- `npx @playwright/mcp --version` 手动验证；报错看是网络（下载失败）还是参数

### 2. 「工具在但调用报错连接失败」
- MCP 由 `npx` 现场拉起——npx 首次下载慢会超时；重试一次通常就好
- `--browser` 指定的浏览器被卸载了 → 重跑第 2/3 步换一个

### 3. 「npx 不存在」
- nodejs 插件 runtime 未就绪或 PATH 未注入 → 读 `plugin_docs name=nodejs` 排查

### 4. 「.claude.json 被写坏（中文乱码/解析失败）」
- 有备份 `~/.claude.json.bak-playwright` → 恢复后改用 Python round-trip 重写
- 无备份 → 手工重建该条目；其它键丢失需用户从会话记忆辅助恢复（预防此事故 =
  严格按第 1 步 round-trip + 改前备份）

### 5. 「卸载被拒绝」
- 本插件无 GUI 反查依赖，正常可卸；卸载本插件**不会**自动移除 ~/.claude.json
  里的 playwright 条目——卸载指导见下

## 日志与状态位置
- 配置落点：`~/.claude.json` 顶层 `mcpServers.playwright`（全局 scope, 所有项目可用）
- 备份：`~/.claude.json.bak-playwright`
- npx 缓存：`%LOCALAPPDATA%/npm-cache/_npx/`

## 卸载指导（ai-guided）
1. Python round-trip 从 `~/.claude.json` 的 `mcpServers` 删除 `playwright` 键
   （改前同样备份）
2. `plugin_set_status(name="playwright-mcp", status="not_ready")`（内存态自然过期）
3. 引导用户重启 GUI（同第 5 步）生效

## 配置依赖
- dependencies: ["nodejs"]——npx 跑在其 runtime 上
- installType: ai-guided
- 版本兼容：Node ≥ 18（nodejs 插件 LTS 满足）；Playwright MCP 经 npx 拉最新
