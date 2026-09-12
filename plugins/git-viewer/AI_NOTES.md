# AI_NOTES — git-viewer 排查文档（面向 AI）

**git-viewer**：只读 git 查看工具（工作区 diff / 提交历史 / 分支）。面板 = iframe 自绘 UI；
数据由插件进程 `git-viewer-server.cjs`（node http, 只在 127.0.0.1）提供。安装即活的
standard 插件——无手动配置步骤, 除依赖检查外 AI 通常无需介入。

## 平台检测（读取本文件前必做）

- 当前平台：AI 上下文（系统提示 OS Version 行 / process.platform）已自带。
- 本插件 manifest platforms 声明 windows/macos/linux；不在其中 → **如实告知用户**
  「此插件不支持当前平台」并停止代装。

## 面板/进程不工作 → 诊断顺序

1. `plugin_list` 看 git-viewer 在列且 `enabled: true`、`processes` 含 git-viewer-server；
2. `plugin_get name=git-viewer` 看进程状态（running → 有 port; error → 看错误信息）；
3. 进程 error 常见因：
   - **未装 nodejs 插件**（dependencies: ["nodejs"]）——先装 nodejs 并让它就绪
     （nodejs 是 ai-guided, 见其 AI_NOTES 装 Node LTS）；
   - `node` 在 Git Bash 里可用但插件进程不可用：进程 PATH 由平台注入（runtime 目录
     前置）, 依赖 nodejs 插件的 runtime 目录存在且未禁用——`plugin_list` 确认 nodejs
     已启用, 不行则重启 GUI；
4. 面板 iframe 空白 → GUI 是否符合 09.09.x（plugins:// 协议 0.1.0 需要最新 GUI）；
5. git 未找到（`git --version` 失败）→ 面板显示「请先安装 git」——GUI 安装包自带
   git, 通常不触发; 系统真没 git 时装 Git for Windows 即可。

## 日志与状态位置

- 进程日志: 经 `plugin-process-status` 事件上报 GUI; stderr 进 GUI 日志
  （plugin_process.rs 的 `[plugin:<id> stderr]` 前缀）
- 进程端口: GUI 从 stdout `PLUGIN_PORT=` 发现（20s 超时, 超时无端口 → 进程被终止报 error）
- 面板位置: 安装后侧栏（面板下拉可选择）

## 卸载指导

standard 插件可直接卸载（`plugin_uninstall name=git-viewer confirm:true` 用户同意后）;
无依赖其它包的残留（zip 内全是本插件文件）。

## 配置依赖

- dependencies: ["nodejs"]——git-viewer-server 用 `node` 跑, 走 nodejs runtime PATH
- installType: standard
- 只读保证: 进程无 git 写命令; 安全白名单在 git-viewer-server.cjs（sanitizeRepoPath/
  sanitizeRef 单测覆盖: node security.test.cjs）

### 无第三方依赖（有意为之）

manifest 的 `processes` 声明是 `"command": "node"` + `"args": ["git-viewer-server.cjs"]`，
平台 spawn 时 **cwd = 本插件目录** → 相对 args 在此解析、`require` 也从此向上找
`node_modules`。本插件零第三方依赖（server 只用 node 内置 `http`/`child_process`），
所以**没有 `node_modules`、无需 `npm install`**。

若将来要加依赖：`cd <本插件目录> && npm install <pkg>`（落到本插件自己的
`node_modules/`，与其它插件天然隔离）。**不要**改成 `command: "npx"` —— 那会绕开
本地解析（尤其指定版本时直接去下载），也失去"依赖随插件目录走"的可控性。
详见 nodejs 插件 AI_NOTES 的「npm / npx 与依赖安装」。

## MCP 工具

`git_view_diff` / `git_history` / `git_branches` —— 从 GUI 进程 store 取 port,
经由进程 HTTP API 转接读数据并呈现给用户审阅（AI 不经面板直读）。
