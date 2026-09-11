// ── pluginDocs — 插件系统 AI 文档（plugin_docs MCP 工具内容）──
// 面向 AI 的插件开发/排查指南，内置常量零网络依赖。与 .scratch/gui-plugin-system
// 的 PRD 保持概念一致；更新 PRD 时同步本文件。

export const PLUGIN_DOCS = `# Claude Code GUI 插件系统 — AI 指南

面向 AI 的插件开发/安装/排查参考。人类向教程见插件市场 demo-widget 的 README。

## 目录布局

- 安装位置: \`%APPDATA%/com.claudecode.gui/plugins/<pluginName>/\`（Tauri app_data_dir）
- 每个插件一个目录，目录名 = plugin.json 的 pluginName
- 依赖文件: \`plugin.json\`（必须）、\`README.md\`（可选，给人看，详情页正文）、
  \`AI_NOTES.md\`（可选，给 AI 看，排查文档——AI 排查该插件故障时 plugin_docs name=<name> 会返回它）

## plugin.json 最小骨架

\`\`\`json
{
  "pluginName": "my-plugin",
  "displayName": "我的插件",
  "version": "0.1.0",
  "contributes": {
    "panels":   [{ "id": "main", "title": "主面板", "panelKind": "in-main", "userManaged": true }],
    "commands": [{ "id": "my.cmd", "title": "我的命令", "onInvoke": "action" }],
    "events":   ["chat.stateChanged"]
  }
}
\`\`\`

字段要点:
- pluginName: 必填非空，决定安装目录名与全部命名空间（plugin:<name>:<id> 前缀）
- contributes 全部可选；panels[].panelKind ∈ in-main | floating（第一版等价，均可开浮窗）
- contributes.events 只接受 GUI Events 枚举值（如 chat.stateChanged, backend.stateChanged），
  未知名被静默忽略
- 进程声明（可选）: "processes": [{ "id": "srv", "command": "node",
  "args": ["server.cjs"], "env": {}, "startOn": "workspace_bound" }]
  **command 与 args 必须分开** —— 平台用 \`Command::new(command)\` 直接 spawn，
  不经 shell 解析；写成 \`"command": "node server.js"\` 会去找名为
  \`node server.js\` 的可执行文件而失败。
  args 中的相对路径在 **cwd = 本插件目录** 下解析（脚本放插件目录内）。
  进程 id 全局形式为 plugin:<pluginName>:<declId>；进程需在 stdout 打印
  PLUGIN_PORT=<port> 声明服务端口（GUI 据此标记 running）

其余可选字段（按需声明，不写即默认）:
- \`installType\`: \`standard\`（默认，包里即程序本体）| \`ai-guided\`（包里是指导，
  无运行时，只能 AI 按 AI_NOTES.md 执行安装）
- \`runtimes\`: \`[{ "id": "node", "path": "runtime" }]\` —— 声明本插件提供的
  运行时目录，平台注册进程序内部 PATH（插件进程 + AI 会话可用，系统环境零污染）。
  path 必须是插件目录内相对路径。该目录视为**安装产物**，插件更新时跨覆盖保留。
- \`dependencies\`: \`["nodejs"]\` —— 依赖的插件名单（安装时校验、卸载时反查防呆）
- \`platforms\`: \`["windows","macos","linux"]\` —— 缺省/空 = 全平台
- \`category\`: \`tool\` | \`integration\` | 自定义非空字符串（市场筛选用）
- \`icon\`: 必须是合法 IconKey（见 gui/src/types/layout.ts）；**写非法值不报错、
  静默兜底成 grid3x3**（曾见插件写 "compass" 显示成九宫格）。常用 "package"
- \`settings\`: 插件设置声明（轻量 JSON Schema：type/title/default/options 等），
  设置面板按插件分组渲染

## 生命周期

- 安装: 市场一键装（zip 下载解压校验）或手动放目录 → 重扫即活（无需重启）
- 重扫: 扫描 plugins/ → 解析 plugin.json（容错，坏文件跳过）→ 过滤禁用列表 →
  注销消失插件的面板/进程 → 注册面板/命令/事件转发 → 启动 startOn=workspace_bound
  的进程（幂等: 已在跑的不动; 未绑定工作区时留到绑定后）
- 禁用: settings.disabledPlugins 记 pluginName，目录不动；面板/命令注销 + 后台进程停
  （启用即恢复, 进程随之拉起）
- 卸载: 杀插件进程 → 删 plugins/<pluginName>/ → 重扫
- GUI 退出: 杀全部插件进程（无孤儿）

## 排查清单（面板没出现/命令缺失/进程没起）

1. **目录存在?** plugin_list 看已装列表；目录名必须等于 pluginName（大小写敏感）
2. **plugin.json 合法?** plugin_get 看解析结果；JSON 语法错/缺 pluginName → 扫描跳过
   （GUI 日志有 [pluginRegistry] warn）
3. **被禁用?** plugin_list 的 disabled 字段；启用 = 从 settings.disabledPlugins 移除
4. **面板 userManaged?** userManaged:false 的面板不进图标栏/下拉（系统面板，如详情页）
5. **进程状态?** plugin_get 的 processes 字段；starting 卡住 = 没打印 PLUGIN_PORT；
   error = 启动即退（看进程 stderr）
6. **命令没进调色板?** commands[].id 会加前缀 plugin:<name>:<id>；onInvoke 是触发名
7. **改了 plugin.json 没生效?** 重扫由安装/启停触发；手动改文件后需触发重扫（重装或
   禁用再启用）

## MCP 工具

- plugin_list: 已装插件 + enabled/disabled + manifest 摘要
- plugin_get: 单插件完整 manifest JSON
- plugin_docs: 本文档
- 安装/卸载/禁用属用户操作（市场面板），AI 不直接执行删除

## 市场发布（服务端）

- 上传: POST {registry}/api/packages （X-API-Key 头, type=plugin 表单字段,
  manifest=YAML 字符串, skills=zip 文件字段）
- zip 根必须含 plugin.json 且 pluginName 非空；README.md / AI_NOTES.md 同根可选
- 列表: GET {registry}/api/plugins （与技能列表 /api/packages 分离, 按 type 过滤）
- 上传脚本: scripts/publish-plugin.py

## AI_NOTES.md 模板（发布时帮作者填写）

作者发布插件时，AI 应主动提议按此模板生成 AI_NOTES.md（zip 根，UTF-8）。
要点：写给 AI 排查用，不是给人看的——聚焦"AI 拿到什么信号、按什么顺序查"，
不写营销介绍。建议 ≤ 4KB。

**下面是最小骨架**。本仓库有更全面的模板（含章节选用表、ai-guided 分步安装、
幂等检测、依赖落点、诊断顺序等实战沉淀）：\`plugins/_template/AI_NOTES.template.md\`。
在源码仓库内开发插件时优先用那份；用户环境无仓库时用本骨架即可。

\`\`\`markdown
# AI_NOTES — <插件名> 排查文档

<一句话：这个插件是什么、声明了哪些贡献（面板/命令/事件/进程）>

## 第三方插件安全审查（未受信任包, 必做）

- 市场未签名插件（无 Ed25519 官方签名验证通过）会以「未受信任」徽标展示,
  且只能 AI 安装。AI 收到安装指令后**必须先安全审查**:
  1. \`plugin_get\` 读 manifest → 检查 processes 声明(命令执行)/settings/依赖/网络
  2. 读包内 README.md / AI_NOTES.md → 看它做什么、往哪连、写什么
  3. 若 zip 可解压源码, 审查关键代码: 发起网络请求/文件写入/命令 exec 的点
  4. 用 AskUserQuestion 让用户确认「继续/取消」, 如实呈现风险(有恶意迹象=取消)
- 用户确认后才能执行文档指导的配置/安装步骤。官方签名包(受信任)可直接装, 跳过。

## 平台检测（读取本文件前必做）

- 先确认当前平台：AI 上下文（系统提示 OS Version 行 / process.platform）已自带,
  无需额外工具——如果你不知道就跑 \`node -p process.platform\`（win32→windows,
  darwin→macos）。
- 本插件的 manifest platforms 声明了支持列表；你所在平台若不在其中,
  **直接如实告知用户"此插件不支持当前平台"并停止**, 不要尝试代装。
- 各平台方法不同时, 用"## Windows ## / ## macOS / ## Linux ##"分节;
  相同部分不重复（写在分节外）。分节里只写差异步骤 + 查验点。

## 故障模式与诊断

### 1. <用户可感知的症状，如"装了但面板没出现">
- 先查什么（应调用的工具/字段，如 plugin_list 的 enabled）
- 可能原因 → 对应处理

### 2. <下一个症状>
- ...

## 日志与状态位置
- 安装目录: %APPDATA%/com.claudecode.gui/plugins/<pluginName>/
- 进程: <有 processes 声明时写明各进程 id 与健康标志；无则写"不产生后台进程">
- 其它信号: <stderr 去向、stdout 约定（如 PLUGIN_PORT=）、GUI 日志关键字等>

## 配置依赖
- dependencies: <列出依赖插件及缺失时的表现；无依赖则写"无">
- installType: standard | ai-guided（ai-guided 必须写清楚 AI 该执行的安装/卸载步骤）
- platforms: <声明支持平台; 未声明=全平台>
- 版本兼容: <API 版本要求或宿主版本限制；无则删去本行>
\`\`\`

好的 AI_NOTES 特征：症状从用户视角描述（不是内部机制）、每条给出可执行的
排查动作、诚实地写"X 是预期行为不是故障"。
`;
