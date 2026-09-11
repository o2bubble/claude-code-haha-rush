# Playwright MCP — 浏览器自动化

让 Claude Code 拥有真实的浏览器：导航页面、点击元素、填写表单、截图、执行 JS，并基于视觉反馈自主调试前端代码。

## 为什么需要它

纯文本版的 Claude Code 只能读/写代码——它不知道代码在浏览器里究竟渲染成什么样。加了 Playwright MCP 之后，Claude 可以：

- **看到真实渲染结果** — `browser_snapshot` 获取可访问性树，`browser_take_screenshot` 拍全页截图
- **操纵页面** — `browser_navigate`、`browser_click`、`browser_type`、`browser_select_option`
- **验证交互行为** — 点击 → 看结果 → 修代码，无需人工切换窗口
- **调试自动化** — 配合 verifier agent 做端到端验证

## 安装

### 方式一：一键脚本（推荐）

```powershell
./bin/playwright-setup.ps1          # 项目级 → Chrome
./bin/playwright-setup.ps1 -Edge    # 项目级 → Edge
./bin/playwright-setup.ps1 -User    # 用户级 → Chrome（所有项目生效）
./bin/playwright-setup.ps1 -User -Edge  # 用户级 → Edge（所有项目生效）
```

脚本会自动：
1. 检测目标浏览器是否已安装
2. 将 playwright 添加到 MCP 配置
3. 打印下一步指引

### 方式二：手动配置

**第一步：安装浏览器**

```bash
npx playwright install chrome    # Chrome
npx playwright install msedge    # Edge
```

**第二步：添加 MCP 配置**

项目级（仅本项目生效），在项目根目录创建/编辑 `.mcp.json`：

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--browser", "chrome"]
    }
  }
}
```

> 用 Edge 的话把 `"chrome"` 改成 `"msedge"`。

用户级（所有项目生效），编辑 `~/.claude/settings.json`，在 `mcpServers` 下加上面同样的条目。

**第三步：重启 Claude Code**

## 可用工具

配置成功后，Claude Code 会获得以下工具（前缀 `mcp__playwright__`）：

| 工具 | 作用 |
|------|------|
| `browser_navigate` | 打开 URL |
| `browser_snapshot` | 获取页面可访问性树（结构化快照） |
| `browser_take_screenshot` | 截图（png/jpeg，支持全页） |
| `browser_click` | 点击元素（支持双击、右键） |
| `browser_type` | 在输入框中输入文本 |
| `browser_fill_form` | 批量填写表单 |
| `browser_select_option` | 下拉选择 |
| `browser_hover` | 悬停 |
| `browser_drag` | 拖拽 |
| `browser_press_key` | 按键 |
| `browser_evaluate` | 执行 JavaScript |
| `browser_console_messages` | 读取控制台消息 |
| `browser_network_requests` | 查看网络请求列表 |
| `browser_network_request` | 查看单个请求详情 |
| `browser_tabs` | 管理标签页（新建/切换/关闭） |
| `browser_wait_for` | 等待文本出现/消失 |

## 验证

在 Claude Code 里试一句：

```
帮我把浏览器打开 http://localhost:3000 然后截图看看长什么样
```

如果 Claude 可以调用 `browser_navigate` + `browser_take_screenshot` 并返回截图，就说明配置成功了。

## 常见问题

### `browserType.launch: Executable doesn't exist`

说明浏览器没装，运行：

```bash
npx playwright install chrome    # Chrome
npx playwright install msedge    # Edge
```

### `npx @playwright/mcp` 下载很慢

可以切换到国内镜像或手动安装：

```bash
npm install -g @playwright/mcp
```

然后把配置里的 `"command": "npx"` 改成 `"command": "playwright-mcp"`，`"args"` 去掉 `@playwright/mcp` 只保留 `["--browser", "chrome"]`。

### 没有 GUI 的服务器

Playwright 支持 headless 模式（默认就是），不需要显示器。如果是纯 CLI 环境，加 `--headless` 参数。

## 扩展用法

### Verifier Agent

可以用 Playwright 创建自动验证 agent，让 Claude 在写完前端代码后自动打开浏览器检查效果。详见 `src/commands/init-verifiers.ts`。

触发命令：

```
/init-verifiers
```

选择 Playwright 类型的 verifier，提供 dev server 信息即可。
