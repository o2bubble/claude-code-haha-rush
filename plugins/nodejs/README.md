# Node.js 运行时环境 (nodejs)

GUI 插件生态的**基础设施插件**——为插件后台进程与 AI 的 Bash 提供 Node.js LTS 运行时。

## 它做什么

| 项 | 说明 |
|----|------|
| 形态 | `ai-guided`——包里不含 Node 本体，安装后由 **AI 按排查文档引导**下载 |
| 安装位置 | 本插件目录内的 `runtime/`（单版本平铺） |
| PATH | **仅程序内部**——插件进程与 AI 会话自动可用 `node`，系统环境变量零改动 |
| 卸载 | 卸载本插件 = 连带删除 Node，卸载前需先卸载依赖它的插件 |

## 使用

1. 插件市场安装本插件（只是放入文档骨架）
2. 对 AI 说：**"帮我完成 nodejs 插件的环境安装"**——AI 会读取 AI_NOTES.md，检测架构、下载 Node LTS（含国内镜像 fallback）、解压验证、上报就绪状态
3. 完成后：AI 会话里 `node --version` 直接可用；依赖插件声明 `"command": "node"` 的后台进程直接启动

## 给插件作者

依赖本环境：manifest 里声明 `"dependencies": ["nodejs"]`，进程命令写 `"command": "node"`（无需写绝对路径——平台已把 runtime 注册进程序内部 PATH）。

**依赖第三方包**时二选一，都与其它插件天然隔离：

| 模式 | 做法 | 落点 |
|------|------|------|
| 本地依赖 | `cd <插件目录> && npm install <pkg>` | 插件自己的 `node_modules/`，随插件目录走 |
| npx（推荐） | 进程命令写 `"command": "npx"` + args | npx 共享缓存，插件目录零依赖 |

> playwright-mcp 即 npx 模式：`{"command": "npx", "args": ["@playwright/mcp", ...]}`。

⚠️ 两点别踩：
- **别在 `<plugins 根>/` 里装包** —— 那里的 `node_modules` 是所有插件的共享 fallback，会导致版本冲突。装依赖一律进具体插件目录。
- **`npm install -g` 默认落进 runtime 内部**，会随插件更新/卸载一起丢。需要全局 CLI 时用 `--prefix` 指到插件目录外（详见 AI_NOTES 的「全局安装」节）。
