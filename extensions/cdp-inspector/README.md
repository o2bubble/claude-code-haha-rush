# CDP Inspector — MCP Server

Chrome/Edge 浏览器实时渲染检查器，通过 MCP 协议让 Claude Code 直接读取浏览器中页面的真实 DOM 结构、计算后样式、控制台日志等。支持所有 Chromium 内核浏览器。

> 注：本工具独立运行于 Claude Code 主进程之外，通过 stdio MCP 协议通信。

## 为什么需要

前端框架（React/Vue/Angular）编译后，浏览器中的实际 DOM 结构和 CSS 类名往往与源码不一致（CSS Modules hash、Tailwind 编译、组件嵌套层级等）。AI 只看源码容易推断错误，这个工具让它能直接"看到"浏览器渲染的真实结果。

## 前置条件

浏览器必须以远程调试模式启动（Chrome / Edge / 任何 Chromium 内核浏览器均可）：

```bash
# Windows — Chrome
chrome.exe --remote-debugging-port=9222

# Windows — Edge
msedge.exe --remote-debugging-port=9222

# macOS — Chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# macOS — Edge
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge --remote-debugging-port=9222

# Linux — Chrome
google-chrome --remote-debugging-port=9222

# Linux — Edge
microsoft-edge --remote-debugging-port=9222
```

首次启动需要关闭所有 Chrome 窗口，否则不会生效。

## 配置

### 方式一：用户级配置（推荐，任何工作目录都有效）

在 `~/.claude/settings.json` 中添加（路径需使用绝对路径）：

```json
{
  "mcpServers": {
    "cdp-inspector": {
      "command": "bun",
      "args": ["/绝对路径/claude-code-haha-dev/extensions/cdp-inspector/entry.ts"]
    }
  }
}
```

在仓库根目录执行以下命令自动配置：

```bash
bash bin/cdp-setup.sh      # macOS / Linux
.\bin\cdp-setup.ps1        # Windows PowerShell
cdp-setup                  # 如果 bin/ 在 PATH 中
```

### 方式二：项目级配置（仅当前项目有效）

在项目根目录的 `.mcp.json` 中添加：

```json
{
  "mcpServers": {
    "cdp-inspector": {
      "command": "bun",
      "args": ["./extensions/cdp-inspector/entry.ts"]
    }
  }
}
```

## 工具列表

| 工具 | 参数 | 作用 |
|------|------|------|
| `cdp_pages` | — | 列出浏览器所有打开的标签页 |
| `cdp_inspect` | `selector`, `pageId?` | 获取元素的真实 outerHTML + 属性（支持 CSS 选择器和 XPath） |
| `cdp_styles` | `selector`, `pageId?` | 获取元素的计算后样式（所有 CSS 属性，支持 XPath） |
| `cdp_box` | `selector`, `pageId?` | 获取元素的盒模型信息（content/padding/border/margin，支持 XPath） |
| `cdp_console` | `limit?`, `pageId?` | 读取浏览器控制台日志（含异常、网络警告） |
| `cdp_evaluate` | `expression`, `pageId?` | 在页面上下文中执行 JS 代码并返回结果 |

## 使用示例

在和 Claude Code 对话时，AI 可以调用这些工具：

```
# CSS 选择器 — 查看 body 的真实 DOM
→ cdp_inspect("body")

# XPath — 查找没有 class/id 的元素
→ cdp_inspect("//button[@aria-label='提交']")
→ cdp_styles("//div/span[2]")

# 查看 .card 组件的计算后样式
→ cdp_styles(".card")

# 查看控制台错误
→ cdp_console(20)

# 查看根元素字体大小
→ cdp_evaluate("getComputedStyle(document.documentElement).fontSize")
```

## 文件结构

```
cdp-inspector/
├── cdpClient.ts   # CDP WebSocket 客户端（连接浏览器，发送命令，缓冲日志）
├── tools.ts       # 6 个 MCP 工具的定义和实现
├── mcpServer.ts   # MCP stdio server（JSON-RPC 通信）
├── entry.ts       # 入口脚本
└── README.md      # 本文件
```

## 一键脚本

项目 `bin/` 目录下提供了快捷脚本，无需手动配置：

```bash
# 一键启动浏览器（自动检测 Chrome/Edge 路径）
.\bin\cdp-browser.cmd          # Chrome
.\bin\cdp-browser.cmd edge     # Edge

# 一键创建/合并 .mcp.json
.\bin\cdp-setup.cmd
```

## 依赖

无需额外安装。使用 Bun 内建的 `WebSocket` 和 `fetch`，以及项目已有的 `@modelcontextprotocol/sdk`。

## 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `Cannot connect to browser` | 浏览器未以调试模式启动 | 关掉所有浏览器窗口，重新以 `--remote-debugging-port=9222` 启动 |
| `No open pages found` | 浏览器启动了但没有打开任何网页 | 打开目标网页 |
| `No element matching '.xxx'` | 选择器在当前页面不存在 | 用 `cdp_evaluate("document.querySelector('.xxx')")` 确认元素是否存在；或尝试 XPath：`cdp_inspect("//div[@id='app']")` |
