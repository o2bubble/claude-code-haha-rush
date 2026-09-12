# Playwright MCP 浏览器自动化 (playwright-mcp)

给 AI 接入 **Playwright MCP** 的配置型插件——装好后，AI 就能打开浏览器帮你操作网页、填表单、截图、跑 E2E 测试。

## 它做什么

| 项 | 说明 |
|----|------|
| 形态 | `ai-guided`——包里是**配置指导**而非程序本体，安装由 AI 按文档执行 |
| 前置依赖 | **nodejs 插件**（用它的 Node/npm 运行 npx） |
| 实际安装的东西 | 修改 `~/.claude.json`，注册 `playwright` MCP 服务器条目 |
| 生效方式 | 配置写完**重启 GUI** 后，新会话自动带 `mcp__playwright__*` 工具 |

## 使用

1. 先安装 **nodejs** 插件并完成其环境安装（本插件依赖它）
2. 安装本插件，对 AI 说：**"帮我完成 playwright-mcp 插件的配置安装"**
3. AI 会：检测依赖 → 探测你机器上的浏览器（让你选一个）→ 写配置 → 验证 → 询问是否立即重启
4. 重启后新会话直接可用：让 AI"打开 example.com 截个图"试试

## 卸载

AI 按文档从 `~/.claude.json` 移除对应条目（其它内容不动），再重启生效。
