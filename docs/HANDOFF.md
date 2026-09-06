# Handoff — Claude Code GUI 开发 · 2026-09-06（main @1415619）

> 跨机器 / 跨会话继续用。当前状态以 git 为准；架构细节在 `docs/ARCHITECTURE.md`；本文件不含凭据——服务器账号/密码在 **Memory MCP**（`server_96.md`）、发布 API Key 在 `temp/release_*.py`（gitignore，不入库）。

## 当前状态

- **分支**: `main`；remote 同步（gitee `main` = `1415619`；GitHub `99362fe` = sync from main @1415619，已触发 Codemagic mac 构建）。
- **主题**: 本批 = **GUI 插件系统 T0-T5 全链路**（通信重命名 → manifest 骨架 → 贡献面板 → 后台进程 → 贡献命令/事件 → 平台化发布）+ **云 server 部署 + demo 插件上传**。
- **插件系统里程碑**:
  - T0 `0a0f48e`（事件名类型化/来源标记/plugin.* 命名空间）+ 全对称重命名 `cda7f14`（eventBus→windowBus 等）
  - T1 `ba7ba3f`（manifest 解析 + scanPlugins 容错）· T2 `6339773`+`00aaac4`（registerPluginPanels + Tauri 读目录）· T3 `623e678`（spawn/PLUGIN_PORT/kill + Worker 面板）· T4 `fcaf7d1`（命令调色板 + 事件转发）· T5 `6dea696`（插件包 + 市场集成）
  - T5 code-review 修复 `1415619`（reloadPlugins 单一入口 / rerenderPanel 覆盖注册 / urllib 上传脚本 / 样式共享）
- **server 部署（云）**: `123.56.66.84:8765`（ECS `i-2ze2rouoikcqrlbseu8a` / cn-beijing）已跑 T5 代码（type 字段 + plugin 校验分叉）；**demo-widget** 插件包已上传（type=plugin，市场可搜）。96 server（内网）**未部署 T5**（用户决定后面再说）。

## 决策留痕表

### 决策：GUI 插件系统走「混合双轨 + 平台化共享 + GUI 自己读目录」
- 为什么：用户希望后续功能通过插件补充（面板/行为/后台进程）；GUI 与 claude.exe 引擎两进程，GUI 不能读 ~/.claude/plugins，必须 GUI 自己发现 %APPDATA%/claude-code-gui/plugins/。
- 影响：PRD（`.scratch/gui-plugin-system/PRD.md`，gitignore 不入库）+ tickets.md T0-T6。

### 决策：通信机制不做整体重构，只做 T0 三处前置准备
- 为什么：审计确认 dataBus/bridge 握手/心跳是活代码；为"未来插件"重写健康核心是负收益。只做插件直接撞上的：来源标记(origin)、事件名收窄（值联合，错拼报错）、命名空间订阅（plugin.*）。
- 影响：T0 `0a0f48e` + `crossWindowBus.publish` 支持 origin。

### 决策：通信标识符全对称重命名（eventBus→windowBus 等）
- 为什么：eventBus vs dataBus 都叫 bus（一个窗内一个跨窗）且 commands(注册表)/Commands(枚举) 仅大小写——命名混乱。
- 影响：`cda7f14`；**踩坑**：sed/perl -i 全局替换损坏 197 文件 UTF-8（中文乱码），回退后 python bytes 级替换重做（见不可再生资料）。

### 决策：插件后台进程注册进 Worker 面板 + 完整生命周期
- 为什么：插件进程不能黑盒自跑，用户要在 Worker 面板看到/管理（状态点/端口/kill/restart）。
- 影响：T3 `623e678`—plugin_process.rs + pluginProcessBridge + WorkerPanel section；状态机 stopped|starting|running|error|killed；第一版崩溃不自动重启。

### 决策：T0 收窄后插件命名空间用 windowBus.onRaw/emitRaw 出口
- 为什么：T0 把 windowBus.on/emit 收窄为 Events 枚举值联合——插件动态 topic（plugin.<name>.*）无法进枚举 → 编译报错。选项：raw 通道（推荐）/插件只走 crossWindowBus（命令有 state 去重坑）/放宽为 string（丧失 T0 保护）。
- 影响：T4 `fcaf7d1` — windowBus.onRaw/emitRaw；命令双写 emitRaw + crossWindowBus.publish；事件转发只发 crossWindowBus（主窗/浮窗统一 subscribe）。

### 决策：T5 插件包复用技能市场 server（/api/packages 加 type 字段）
- 为什么：POST /packages（require_auth）+ GET /packages + download 现成；DB 加 type 列 ALTER 迁移（存量 skill 默认）；上传按 type 分叉校验（plugin→根 plugin.json+pluginName；skill→SKILL.md 不变）。
- 影响：T5 `6dea696` server(routes/models) + Rust install_plugin_package + GUI PluginMarketPanel + scripts/publish-plugin.py。

### 决策：T5 code-review 修复（双轴审查后）
- 为什么：Standards 轴（publish-plugin.py 用 requests 非 stdlib 与实战版矛盾 / 重扫三份复制 Shotgun Surgery / find_*_root 三胞胎 / 样式复制）+ Spec 轴（同名重装面板不更新 — registerPanel dup 保护静默忽略 / 浮窗即活缺口）。
- 影响：`1415619` — reloadPlugins() 单一入口(_reloading 防重入) + FloatingApp 订阅 PANEL_REGISTRY_CHANGED + panelRegistry.rerenderPanel(覆盖注册) + find_marker_root(收编三胞胎) + marketplaceStyles 共享 + type union。

### 决策：云 server 部署用 workbench（阿里云 CLI），SSH 密码退居二线
- 为什么：SSH channel 慢（需 90s+ 超时），workbench（凭证 AK 模式 + 免密 ECS）更稳。client 安装：`irm https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.ps1 | iex` → `~/.workbench/config.json` 直接写（AK 模式，格式见 skill 文档）。
- 影响：workbench CLI（C:\Program Files\workbench\workbench.exe）+ `~/.workbench/config.json`；`workbench exec -i <instance-id> -c "cmd"`；实例 i-2ze2rouoikcqrlbseu8a / cn-beijing。

### 决策：服务器 API key 经 DB 生成（无法反推 bootstrap 一次性的 sk-）
- 为什么：registry.db 存 key_hash（SHA256），原文只在首次启动打印。复用 bootstrap_api_key 逻辑 insert 新 key（label=deploy-demo）。
- 影响：demo-widget 上传用 `sk-83fa26adf065482fa8b7b522ee02cb37665a45e1cd955e1d`（服务器 DB）。

## 不可再生资料

### sed/perl -i 会破坏 UTF-8（重要教训）
- **类型**：调查结论
- **来源**：命名重构时用 perl/sed -i 全局替换后，197 文件非 ASCII（中文/box 装饰符/em-dash）全损坏（UTF-8→CP1252）；tsc/vitest 仍通过（损坏局限字符串/注释，ASCII 标识符完好）。
- **关键内容**：Git Bash 下 `sed -i`/`perl -pi -e` 重写文件会破坏多字节 UTF-8。可靠做法：python 读 bytes、只做 ASCII token 替换、写回 bytes（绝不 decode/encode 非 ASCII 区）。验证：逐文件比对非 ASCII 高字节序列与 HEAD 一致。
- **对下轮价值**：任何大范围标识符/字符串替换必须用 bytes 级；审查用 python 字节验证而非终端（GBK 终端误报）。

### .ps1 脚本中文编码坑
- **类型**：调查结论
- **来源**：replace-gui-test.ps1 含中文注释后 PS 5.1 读报 ParserError（无 BOM UTF-8 被按 ANSI/GBK 读）。
- **关键内容**：Windows PowerShell 5.1 读 .ps1 需 UTF-8 with BOM 才能解析中文；稳妥做法：.ps1 只用纯 ASCII。

### 云 server SSH 慢的真因 = channel 超时太短
- **类型**：调查结论
- **来源**：ssh 连接认证 OK 但 exec channel 20s 超时 → 一度以为限流/fail2ban；改用 90s connect + 120-240s channel 超时后成功（单次连 OK 13.9s 建立 channel）。
- **对下轮价值**：SSH channel 慢不是故障——域外固定 timeout 不足；workbench 是更稳通道。

### T3 的 kill/wait 竞态（进程生命周期关键坑）
- **类型**：调查结论（code-review 发现）
- **来源**：T3 实现后 code-review。
- **关键内容**：管理线程 child.wait() 返回后若无条件设 error 会：①用户 kill 后 error 覆盖 killed；②restart 时旧 wait 线程可能在新 spawn 后删掉新 pid。修复：wait 后核对 registry 中 current_pid（== 本 spawn pid 才处理）与 current_status（已是 killed 不覆盖、不 remove）。
- **对下轮价值**：进程生命周期/Rust 后台线程的 kill/restart 与 wait 竞态审查必需；核 token 用"current pid/status 校验"。

### removePanelsFromTree 的 compound 剪枝 bug
- **类型**：调查结论（调试发现）
- **来源**：T2 布局清理实现。
- **关键内容**：cleanGroup 用 `tabs.length === node.tabs.length` 判断"无变化"——但 compound tab children 被剪枝时 tabs 数量不变 → 返回旧引用。修复：加 changed 标记（`kept !== t`）。
- **对下轮价值**：递归清理/过滤判断"是否有变化"用引用/字段比对，不用长度。

### .scratch/ 被 gitignore（PRD 不入库）
- **类型**：环境事实
- **关键内容**：`.scratch/gui-plugin-system/PRD.md` 及 T5-plugin-packages.md 是 gitignore（`git add .scratch` 报 ignored）；本地资料不入库。tickets.md（仓库根）入库。

## 热数据（近用，脚本直接复制）

### Git 状态
**branch** `main` · remote 已同步（gitee @1415619 · GitHub @99362fe sync）

```
1415619 fix(gui): 插件系统 T5 code-review 修复 — 重扫单一入口/面板覆盖注册/上传脚本stdlib
6dea696 feat(gui): 插件系统 T5(平台化发布) — 插件包 + 市场集成(复用技能市场 server)
fcaf7d1 feat(gui): 插件系统 T4(贡献命令+事件订阅) — 调色板插件命令组 + 事件转发桥
623e678 feat(gui): 插件系统 T3(后台进程) — spawn/PLUGIN_PORT/kill + 生命周期 + Worker 面板注册
00aaac4 feat(gui): 插件系统 T2(贡献面板) — registerPluginPanels + Tauri 读插件目录 + 双窗接线
ba7ba3f feat(gui): 插件系统 T1 骨架 — manifest 解析 + 目录条目扫描 + 容错
0a0f48e feat(gui): 插件系统 T0 前置准备 — 事件名类型化/来源标记/命名空间订阅/僵尸清理
cda7f14 refactor(gui): 通信机制命名重命名 — 消除窗内/跨窗歧义
```

**工作区未提交改动：**
```
M gui/src-tauri/gen/schemas/desktop-schema.json  # cargo check 生成（CRLF 噪声，无内容差异，不提交）
M gui/src-tauri/gen/schemas/windows-schema.json  # 同上
```

**注意**：scripts/publish-plugin.py 已改 urllib（请求 stdlib）；本地 python 曾缺 requests（远程验证用 urllib 版成功）。

### 发布版本 (dist/release)
- 2026.09.04.9: bun.zip, claude.zip, extensions.zip, git.zip, gui.zip, manifest-upload-ascii.json, manifest.json, python.zip, server.zip, tools.zip, updater.zip
- 2026.09.04.8-.5: 类似（bun/claude/extensions/git/gui/python/server/tools/updater + manifest）
- （本批 T0-T5 是 GUI 前端+server 改动——**尚未发布**；发布时需 gui.zip 重建（含插件系统前端 + Rust）+ server 已云部署 T5）

### 测试基线
- GUI 前端 `node node_modules/vitest/vitest.mjs run` **437 通过**（T0 398 → T1 +14 → T2 +3 → T3 +2 → T4 +10 增量）· `node node_modules/typescript/bin/tsc --noEmit` 干净。
- Rust `cargo check` 通过（gui/src-tauri）；server（Python FastAPI）无单测（本机无 fastapi）。

### 构建命令
- GUI：`cd gui/src-tauri && cargo tauri build --no-bundle`（默认 release）
- 发布：`bun run scripts/build.ts --release YYYY.MM.DD.N --components gui[,claude,...] --notes "## <标题>..."`
- 本机替换：`replace-gui-test.ps1`（仓库根 untracked——管理员运行，杀 GUI→备份 exe→复制新→重启；**助手运行在 GUI 内不能自行执行**）
- 上传脚本：`python scripts/publish-plugin.py --manifest meta.yaml --zip my.zip --api-key sk-xxx [--host URL]`（urllib, 无第三方依赖）

## 待办

- **T6 真机验收**（PRD §9 / tickets T6）：
  - 编译新 GUI exe（含 T5）→ 替换 → 打开「插件市场」→ 装 demo-widget → 面板/命令/进程验证
  - 后台进程 kill/重启/GUI 退出杀进程（无孤儿）
  - 停用/卸载 → 面板从布局移除（**"卸载→清理布局"未实现**——T5-plugin-packages.md §6 待后续）
- **96 server 部署 T5**：用户决定"先云后 96"——96（192.168.186.96:8765 内网，本机不通）待部署。
- **发布**：T0-T5 改动已提交但未构建发布（Windows gui.zip + mac Codemagic 已触发但未发布）。
- **插件市场相关**：
  - 插件市场面板 userManaged 默认 true（可从面板下拉开关）；工具栏插件命令入口留后续
  - 浮窗内插件面板/命令需要新浮窗才可见（已订阅 PANEL_REGISTRY_CHANGED，安装后已开浮窗需重扫——已修 reloadPlugins）
  - demo-widget 上传的 API key 在服务器 DB（可复用/新生成）

## 环境 / 测试数据

- **云 server**: `123.56.66.84:8765`（已部署 T5；ECS `i-2ze2rouoikcqrlbseu8a` / cn-beijing / root 密码 fyrbfmwZS61@）
- **Workbench**: 已装（C:\Program Files\workbench\workbench.exe）；config ~/.workbench/config.json（AK 模式，AccessKey LTAI5t7ZUH7vm5drxWcDPXgB）；`workbench exec -i i-2ze2rouoikcqrlbseu8a -c "cmd"`（--timeout 长）
- **96 server**: `192.168.186.96:8765`（内网，未发 T5；账号/密码在 Memory MCP `server_96.md`）
- **GitHub**: `o2bubble/claude-code-haha-rush`（private）；push 需 `-c http.proxy= -c https.proxy=` 绕过死代理（17891）
- **发布 API Key**: `sk-mattpocock-skills-2026`（在 temp/release_*.py）；**插件市场 API key**: `sk-83fa26adf065482fa8b7b522ee02cb37665a45e1cd955e1d`（demo-widget 用，服务器 DB 生成——**不入 temp/release_*.py，需从 DB 查/重新生成**）
- **构建**: `bun run scripts/build.ts`

## 冷数据索引

**文档**: `docs/ARCHITECTURE.md` · `docs/macos-port.md` · `docs/macos-build-playbook.md` · `docs/macos-upgrade-guide.md` · `docs/agents/issue-tracker.md` · `docs/agents/domain.md`
**.scratch（gitignore，本地）**: `gui-plugin-system/PRD.md`（插件系统完整 PRD——9 决策、§5.1/5.1b/5.2/5.3、§9 验收、§10）· `gui-plugin-system/T5-plugin-packages.md`（打包/上传/安装链路）
**代码（插件系统）**: `gui/src/services/pluginRegistry.ts`（manifest 解析/activeManifests/reloadPlugins/前缀工具）· `pluginPanelBridge.tsx`（registerPluginPanels）· `pluginProcessBridge.ts`（进程状态桥）· `pluginCommandBridge.ts`（命令双写+事件转发）· `gui/src/stores/panelRegistry.ts`（registerPanel + rerenderPanel）· `gui/src-tauri/src/plugin_process.rs`（spawn/kill/restart）+ `lib.rs`（install_plugin_package/find_marker_root/list_plugin_manifests）· `gui/src/components/chat/PluginMarketPanel.tsx` + `marketplaceStyles.ts` · `scripts/publish-plugin.py`
**其他关键**: `gui/src/services/windowBus.ts`（onRaw/emitRaw 插件出口）· `gui/src/utils/commandPaletteLogic.ts`（plugin kind）· `gui/src/components/useCommandPalette.ts`（插件命令组）· `gui/src/FloatingApp.tsx`（PANEL_REGISTRY_CHANGED 订阅）

## Suggested skills

- **handoff-compact** — 会话压缩规范
- **code-review** — 大改动双轴 review（T5 已用：Standards + Spec 平行子代理）
- **tdd** — 新 store/reducer 逻辑先写测试
- **diagnosing-bugs** — 状态脱钩/流式问题排查
- **implement** — 接续按 tickets 实现（T6 剩真机验收）
