// ── pluginDocs — 插件系统 AI 文档（plugin_docs MCP 工具内容）──
// 面向 AI 的插件开发/排查指南，内置常量零网络依赖。与 .scratch/gui-plugin-system
// 的 PRD 保持概念一致；更新 PRD 时同步本文件。

export const PLUGIN_DOCS = `# Claude Code GUI 插件系统 — AI 指南

面向 AI 的插件开发/安装/排查参考。人类向教程见插件市场里任一官方插件的 README
（或本仓库 \`plugins/_template/README.template.md\`）。

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
- contributes.skills（可选）: [{ "name": "my-skill", "path": "skill" }] ——
  把插件内的技能目录**链接**进 \`~/.claude/skills/\`。
  ⚠️ 这不是"能力注册" —— 技能就是 \`SKILL.md\` + 附属文件的目录，
  AI 侧（claude.exe）只扫 \`~/.claude/skills\`（+ managed + 项目级），**不扫插件目录**，
  所以必须放到那里。
  - 宿主在**每次插件重扫**时做**幂等同步**：插件在 → 链接在（缺了补、指向错了重建）；
    插件不在 → 链接清掉。用户手删了、插件被挪走，下次重扫自愈
  - **链接**（Windows junction / unix symlink）而非复制 → 插件目录是唯一来源：
    改插件里的技能文件立刻生效，不会留旧副本
  - 约束：\`name\` 只允许字母数字与 \`-_.\`（防路径穿越）；
    \`path\` 必须是插件目录内的相对路径；目标目录须含 \`SKILL.md\`
  - ⚠️ **技能在会话启动时扫描** —— 装完要**新开会话**才看得到（与面板/命令"立刻可见"不同）
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
- \`dependencies\`: \`["nodejs"]\` —— 依赖的插件名单。**四条实际作用**：
  1. **安装校验**（市场一键安装 / AI 代装**两条路径同一套**）：依赖**未安装** → 提示用户
     （市场给「一并安装依赖」选项；AI 路径直接拒绝并列出，让 AI 先装）
  2. **依赖就绪校验**：依赖**装了但没就绪**（如 nodejs 的 runtime 未下载）→ 也提示
     （否则本插件装上却跑不起来，用户只看到「插件坏了」而看不到真因）
  3. **卸载反查**：有启用中的插件依赖它时，拒绝卸载（先卸依赖方）
  4. **展示**（市场卡片、详情页「依赖 xxx」）
  ⚠️ **runtime 是否注入与依赖无关** —— 所有启用插件的 \`runtimes\` 目录都全局注入 PATH；
  \`dependencies\` 管的是「依赖是否可用」而不是「能力授予」
- \`platforms\`: \`["windows","macos","linux"]\` —— 缺省/空 = 全平台
- \`category\`: \`tool\` | \`integration\` | 自定义非空字符串（市场筛选用）
- \`icon\`: 必须是合法 IconKey（源码见 \`gui/src/types/layout.ts\`）；**写非法值不报错、
  静默兜底成 grid3x3**（曾见插件写 "compass" 显示成九宫格）。常用 "package"。
  ⚠️ **新插件要挑一个没被别的插件用过的** —— 拿现有插件的 manifest 当模板时最容易
  漏改这一项，结果是两个插件图标一模一样（用户一眼就看出来）。
  查已用：逐个 \`plugin_get\` 看已装插件的 icon（**别跑 \`grep plugins/*/plugin.json\`** ——
  用户环境只有安装目录、没有源码仓库）
- \`settings\`: 插件设置声明（轻量 JSON Schema：type/title/default/options 等），
  设置面板按插件分组渲染

## 生命周期

- 安装: 市场一键装（zip 下载解压校验）或手动放目录 → 重扫即活（无需重启）
- 重扫: 扫描 plugins/ → 解析 plugin.json（容错，坏文件跳过）→ 过滤禁用列表 →
  注销消失插件的面板/进程 → 注册面板/命令/事件转发 → 启动 startOn=workspace_bound
  的进程（幂等: 已在跑的不动; 未绑定工作区时留到绑定后）→
  **同步插件贡献的 skill 链接**（见下）
- 禁用: settings.disabledPlugins 记 pluginName，目录不动；面板/命令注销 + 后台进程停
  （启用即恢复, 进程随之拉起）；**该插件的 skill 链接也会被摘掉**（禁用 = 技能不可用）
- 卸载: **跑 beforeUninstall hook（若声明）** → 杀插件进程 → 删 plugins/<pluginName>/ →
  清宿主侧残留（plugins-settings/<name>.json 全局+工作区、plugins-data/<name>/）→ 重扫
  → 插件若声明了 needsRestart 则**由前端提示用户**（可拒绝）
- GUI 退出: 杀全部插件进程（无孤儿）

### 技能链接同步（\`contributes.skills\`）

**每次重扫都会跑一遍幂等同步**（不是"安装时建一次"）：

| 情况 | 行为 |
|---|---|
| 插件在、链接不在 | 建（**缺了补**） |
| 链接指向错了（插件被挪过） | 重建 |
| 插件已卸载/禁用 | **摘掉链接**（含悬空的） |
| 链接已正确 | 不动（省一次系统调用，也避免目录抖动） |

- 链接**指向插件目录** → 插件目录是唯一来源：改插件里的技能文件立刻生效
- 只动**指向插件目录**的链接：用户自己建的（如指向 \`~/.agents/skills\`）不碰
- 失败**不阻断**插件加载（只写诊断），所以"插件正常但技能没出现"是可能的
  —— 排查见下方清单第 8 条

### 卸载/清理 hook（\`beforeUninstall\`）—— 声明式脚本

插件在**自身目录之外**留下的东西（外部数据、系统资源、要通知的外部服务），宿主
无从知晓，只能由插件自己声明怎么清：

\`json
{
  "beforeUninstall": "cleanup.cjs",
  "needsRestart": true
}
\`

- **执行者 = 宿主，不是插件进程** —— 卸载时插件进程可能已经死了，所以 hook 必须是
  **声明式脚本**（不能是"叫插件自己做"）
- **解释器**：\`.js/.cjs/.mjs\` → \`bun\`；\`.py\` → \`python\`。
  两者都是 **GUI 安装包自带**的运行时（零前置条件）——
  别用 node：那要靠 nodejs 插件，hook 是基础能力不该依赖另一个插件。
  其它扩展名**直接被拒**（不让 manifest 决定"用什么程序执行什么文件"）。
- **参数经环境变量**（不用命令行，避免转义问题）：
  \`CLAUDE_PLUGIN_NAME\` / \`_DIR\`（即将被删，只读）/ \`_DATA_DIR\`（宿主管理的插件数据目录，卸载时自动清）/ \`_WORKSPACE\`
- **超时 15 秒**，**失败绝不阻断卸载**（只记 warn 并在结果里回报，前端提示"清理可能不完整"）
- 脚本路径必须是**插件目录内的相对路径**（绝对路径 / \`..\` 穿越会被忽略）

### "需要重启"（\`needsRestart\`）

卸载后宿主进程里可能还有已加载的状态（PATH、环境变量、缓存的 manifest）——
声明 \`needsRestart: true\` 后，卸载完成时**前端会问用户**是否现在重启。

⚠️ **只有声明才提示**：大多数插件（清设置、删目录）不需要重启，每次都弹会很烦，
也会让用户对提示脱敏。用户**可以拒绝**（那就下次自己重启）——
重启会中断当前 AI 会话，不能替用户决定。

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
8. **技能没出现（\`contributes.skills\` 声明的）?** 按序查：
   1. 插件**在列且启用**（禁用的插件技能会被摘掉）
   2. 目标目录有 \`SKILL.md\`，且 \`path\` 是插件内相对路径
   3. 宿主有没有真的建链 —— 看
      \`%APPDATA%/com.claudecode.gui/skill-diag.json\`（每次重扫写一次：
      \`result.linked\` 是成功清单、\`result.errors\` 是失败原因）。
      ⚠️ 这个文件是**故意保留**的诊断输出 —— 前端 \`console.*\` **不进 GUI 日志**，
      所以失败信息只在这里能看到
   4. **技能在会话启动时扫描** —— 装完/修完要**新开会话**才看得到（与面板/命令
      "立刻可见"不同）
   5. 手工验证：\`dir %USERPROFILE%\\.claude\\skills\` 看有没有以该技能名命名的
      \`<JUNCTION>\` 条目；**删它要用 \`rmdir\`**（或 Node 的 \`fs.rmdirSync\`）——
      资源管理器/ \`rd /s\` 会**连带删掉插件目录里的真实文件**
9. **"功能没生效"但代码明明写对了?** 先证伪「跑的是旧二进制」再读代码：
   - 用户装的 GUI 可能**低于该功能发布的版本**（本项目开发循环是
     改代码 → 构建 → 发版 → 用户装，中间有多个断点）
   - **别用"搜 exe 里的前端字符串"来判断** —— 前端资源是压缩嵌入的，
     字符串可能搜不到（**只能是假阴性**，搜到=有，搜不到≠没有）
   - 可靠的判据：**行为**。挑一个该功能独有的可见副作用（如它写的诊断文件、
     它建的链接、它发的日志），看它有没有发生

## 请求宿主动作（host actions）

插件进程**开不了窗口** —— 需要窗口时（浮窗、覆盖层、提示条）要在 HTTP 响应里
**请求宿主代开**。两种来源：

| 来源 | 形态 | 例子 |
|---|---|---|
| MCP 工具调用的响应 | \`{ ..., "host": [动作] }\` | 鼠标键盘插件每次操作请求 \`open-indicator\` |
| \`/__command\` 命令的响应 | 同上 | 截屏插件请求 overlay |

动作形如 \`{ kind: "<动作名>", payload: {...} }\`。已支持的 kind（宿主侧
\`pluginPanelBridge.tsx\` 的 \`dispatchPluginUplink\` 是权威清单）：

- \`open-indicator\` / \`move-indicator\` / \`close-indicator\` —— **置顶小浮标**
  （约 300×132，不进任务栏、**不抢焦点**）。payload: \`{src, params, x?, y?, width?, height?}\`
  （缺省位置 = 主屏右下角）。适合"AI 正在做什么 + 一个停止入口"这类常驻小窗。
  ⚠️ 窗口标题带**宿主 PID**（\`indicator::<插件名>::<PID>\`）—— 插件要按标题找回它
  （读屏幕矩形等）时必须拼上 \`CLAUDE_PLUGIN_HOST_PID\`，否则多开时会拿到**别的实例**的窗口。
- \`open-overlay\` 等 —— 覆盖层（截屏插件用；详见其源码）

要点：
- **已存在就不要再请求开**（\`open\` 是"关掉重建"，重复请求会让窗口闪）——
  插件可先自己探测（如按标题 FindWindow）
- **窗口不会给插件返回信息** —— 页面与进程通信走**插件自己的 HTTP 端口**（页面从
  \`params\` 拿到端口后轮询）；窗口几何（位置/尺寸）也要插件自己从进程侧查 Win32
- 派发是**逐个 try** 的：某个动作失败不影响后续动作，失败会记 console

## MCP 工具

**安装/卸载 AI 可以直接做**（不是"只能用户操作"）—— 各有自己的门禁：

| 工具 | 用途 | 门禁 |
|---|---|---|
| \`plugin_list\` | 已装插件 + enabled/disabled + manifest 摘要 + \`aiStatus\` | — |
| \`plugin_get\` | 单插件完整 manifest JSON | — |
| \`plugin_docs\` | 本文档；传 \`name\` 返回该插件的 AI_NOTES.md | — |
| \`plugin_install\` | 从市场按 slug 安装（**仅 standard** —— ai-guided 会拒绝并让你按文档自己装） | 先**依赖校验**（未装/未就绪都会拒绝并说明） |
| \`plugin_uninstall\` | 卸载插件 | ⚠️ **必须在对话里得到用户明确同意**后才可传 \`confirm:true\`；有依赖方时拒绝 |
| \`plugin_set_status\` | 上报 ai-guided 插件的环境状态（\`ready\`/\`not_ready\`/\`error\`） | 内存态，GUI 重启即清空 → 需重新验证再报 |

**禁用**仍是纯用户操作（设置里的 disabledPlugins），AI 无对应工具。

**卸载的收尾**：返回里可能带 \`needsRestart\`（该插件声明了"卸载后需重启"）与
\`hookWarning\`（\`beforeUninstall\` 没跑成 —— 卸载已完成但清理可能不完整）。
**这两个都要转告用户**：前者问他要不要现在重启（用户同意才调 \`app_relaunch\`），
后者如实说明。

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
