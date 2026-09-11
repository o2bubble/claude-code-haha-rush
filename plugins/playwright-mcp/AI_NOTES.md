# AI_NOTES — playwright-mcp 排查文档（面向 AI）

本插件是**配置型** ai-guided 插件：为 AI 配置 Playwright MCP 服务器（浏览器自动化）。
用户安装后（市场安装只放入文档骨架），由你（AI）按本文档完成实际配置。

## 平台检测（读取本文件前必做）

- 先确认当前平台：AI 上下文（系统提示 OS Version 行 / `process.platform`）已自带，
  如果你不知道该跑 `node -p process.platform`（`win32`→Windows、`darwin`→macOS、`linux`→Linux）。
- 本插件 manifest `platforms: ["windows","macos","linux"]`——全平台支持。
- **浏览器探测路径与默认值按平台不同**（见第 2 步）；其余步骤（依赖检测/配置写入/
  验证/刷新）全平台通用。

## 你的任务：完成 MCP 配置安装

目标 = 在 `~/.claude.json` 顶层 `mcpServers` 里写入 `playwright` 条目，
使新会话具备 `mcp__playwright__*` 工具（浏览器导航/点击/填表/截图/快照）。

### 第 0 步：前置检测（nodejs 依赖）

本插件 dependencies 含 `nodejs`——先验证其运行时可用：

1. `plugin_list` 确认 nodejs 已装且 enabled
2. 验证 node 真能跑：`node --version`（应 ≥ 18；MCP 需要 npx）和 `npm --version`
3. 若 Bash 找不到 node → nodejs 插件的 runtime 未就绪：读其 AI_NOTES
   （`plugin_docs name=nodejs`）先完成它的环境安装，再回来。
   ⚠️ **macOS/Linux 注意**：nodejs 插件在 unix 上 node 在 `runtime/bin/node`，
   用绝对路径验证（详情见其 AI_NOTES 第 6 步），不要断言"直接 node 可用"。

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
   禁止用 PowerShell/字符串替换——会以错误编码写回，毁掉文件里的中文（曾发生事故）。
   改前先备份：`shutil.copy2`（或 `cp ~/.claude.json ~/.claude.json.bak-playwright`）。

### 第 2 步：浏览器探测与选择（⚠️ 按平台）

探测本机已装的浏览器（按顺序检查存在性，只列探测到的）：

- **Windows**：
  - Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`
    （及 `C:\Program Files (x86)\...`）
  - Edge: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（预装, 几乎必有）
- **macOS**：
  - Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  - Edge: `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`
  - Safari: `/Applications/Safari.app`（Safari 驱动有限, 一般不选, 仅列出）
- **Linux**：
  - Chrome: `/usr/bin/google-chrome` / `/usr/bin/google-chrome-stable`
  - Chromium: `/usr/bin/chromium` / `/usr/bin/chromium-browser`
  - Edge: `/opt/microsoft/msedge/msedge`（微软 Linux 版）

**用 AskUserQuestion 让用户选**，选项只列探测到的（Chrome / Edge / Chromium…）。
用户未响应或超时 → **默认浏览器（下述）**：
- Windows → **Edge**（预装, 优先级最高）
- macOS → **Chrome**（用户最常见）
- Linux → **Chromium**（开源包默认）

**`--browser` 参数值（MCP 参数名, 全平台一致）**：`chrome` / `msedge` / `chromium`。
探测到什么就映射成对应值传入。注意：Safari 不在 MCP 支持列表（`webkit` 另一套参数）,
一律用 chromium 系。

### 第 3 步：写入配置

```json
"playwright": {
  "command": "npx",
  "args": ["@playwright/mcp", "--browser", "<用户选的: chrome|msedge|chromium>"]
}
```

写入 `~/.claude.json` 顶层 `mcpServers`（round-trip 见第 1 步，保留其它所有键）。
写完用 `json.load` 重新读一遍确认合法 JSON 且中文完好。

> **为什么用 `npx` 而不用 `npm install -g @playwright/mcp`**——不要"顺手改好一点"：
> 在本 GUI 生态里，插件 runtime 的 npm 其 `prefix` 默认 = **node 所在目录**
> （即 `plugins/nodejs/runtime/`），全局装会落进插件目录内部 → 插件更新/卸载时
> 随目录一起被清掉。`npx` 的缓存与 prefix 无关、与用户已有的 npx 缓存共享
> （同版本复用，不重复下载），且自带版本隔离。**保持 npx。** 详见 nodejs 插件
> AI_NOTES 的「npm / npx 与依赖安装」。

### 第 4 步：验证

- `npx @playwright/mcp --version` 成功输出版本号（如 `Version 0.0.x`）→ 配置本身 OK
- 首次运行 npx 会现场下载包（可能 30-60s），属正常；失败先查网络/代理
- （可选，仅当用户不想用系统浏览器时）`npx playwright install chromium`
  下载 ~130MB 内置 chromium——**默认跳过**，系统浏览器够用

**大件落点（排查/清理/磁盘告警时必知）**：

| 内容 | 位置 | 体积 |
|------|------|------|
| 浏览器二进制 | Windows `%LOCALAPPDATA%/ms-playwright`；macOS `~/Library/Caches/ms-playwright`；Linux `~/.cache/ms-playwright` | 每个 chromium ~130MB，装多个可达 **700MB+** |
| MCP 包本体 | npx 缓存（见「日志与状态位置」） | ~40MB |

关键性质：**两者都在插件目录之外、与 npm prefix 无关** —— 插件更新/卸载**不会**动它们，
用户级共享（多项目多插件复用同一份）。这套机制由 playwright 自身管理（`PLAYWRIGHT_BROWSERS_PATH`
环境变量可重定向），不是本插件的产物。清理磁盘时**不要**误删 npx 缓存或浏览器目录
（删了下次要重新下 700MB+）。
- ⚠️ **macOS 首次运行注意**：如选中系统 Chrome，需允许 Chrome 访问“全新浏览器
  数据目录”（弹一次系统授权）——如实告知用户这是系统行为, 不是安装故障。

### 第 5 步：上报 + 刷新生效（无需重启）

1. `plugin_set_status(name="playwright-mcp", status="ready", detail={
     "browser": "<选定>", "config": "~/.claude.json mcpServers.playwright",
     "verify": "npx @playwright/mcp --version → 0.0.x"})`
2. **生效方式（主路径）：调 `chat_send_command(text="/mcp-refresh")`**——
   该工具把命令预填进用户聊天输入框（用户审阅后回车即发, 不自动发送）。
   机制：配置读取有 freshness watcher（fs.watchFile 监听 `~/.claude.json`
   mtime），外部写入会被自动拾取进缓存；`/mcp-refresh` 重读全部 scope 配置
   并对新服务器建立连接——**无需重启**, 当前会话即可用 `mcp__playwright__*`。
3. **备用：重启**。若刷新后工具仍未出现（watcher 边缘时序/缓存异常），
   询问用户"是否立即重启 GUI？"→ 同意后调 `app_relaunch`
   **confirm:true**（调用即结束本会话，必须是最后一步动作）。

## 故障模式与诊断

### 1. 「刷新了但没有 mcp__playwright__ 工具」
- `plugin_list` 看本插件 enabled
- 用 Python 重新读 `~/.claude.json` 确认 `mcpServers.playwright` 还在
  （可能被其它工具写丢了 → 按第 3 步重写）
- `npx @playwright/mcp --version` 手动验证；报错看是网络（下载失败）还是参数

### 2. 「工具在但调用报错连接失败」
- MCP 由 `npx` 现场拉起——npx 首次下载慢会超时；重试一次通常就好
- `--browser` 指定的浏览器被卸载了 → 重跑第 2/3 步换一个
- **macOS**：检查是否允许 Chrome 启动（首次授权弹窗没点掉 → 浏览器起不来）

### 3. 「npx 不存在」
- nodejs 插件 runtime 未就绪或 PATH 未注入 → 读 `plugin_docs name=nodejs` 排查
  （unix 上注意其 `runtime/bin/node` 绝对路径）

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
- npx 缓存：Windows `%LOCALAPPDATA%/npm-cache/_npx/`；macOS/Linux `~/.npm/_npx/`
- 浏览器二进制（最大件，可达 700MB+）：Windows `%LOCALAPPDATA%/ms-playwright`；
  macOS `~/Library/Caches/ms-playwright`；Linux `~/.cache/ms-playwright`

## 卸载指导（ai-guided）
1. Python round-trip 从 `~/.claude.json` 的 `mcpServers` 删除 `playwright` 键
   （改前同样备份）
2. `plugin_set_status(name="playwright-mcp", status="not_ready")`（内存态自然过期）
3. 引导用户重启 GUI（同第 5 步）生效

## 配置依赖
- dependencies: ["nodejs"]——npx 跑在其 runtime 上
- installType: ai-guided
- platforms: ["windows","macos","linux"]
- 版本兼容：Node ≥ 18（nodejs 插件 LTS 满足）；Playwright MCP 经 npx 拉最新
