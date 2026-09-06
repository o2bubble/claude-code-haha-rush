# GUI 架构图 (Architecture Map)

> 本文档是**架构地图**：先看系统全景（§0），再用分层地图（§1）导航到各层深入。它是当前系统的结构快照，不是功能开发记录。
> 需要子系统的详细数据模型/协议/历史修复 → 查 `docs/architecture-reference.md`（参考附录，保留原 §1-§43 细节）。
> 技术栈：Tauri 2 + React + Bun · 单仓库：前端 `gui/src/`，Rust 后端 `gui/src-tauri/src/`，CLI 引擎根目录 `src/`，更新器 `updater/`，安装器 `installer/`。

---

## 0. 系统全景 (System Overview)

```
┌──────────────────────────── 桌面 GUI (Tauri 2 窗口) ────────────────────────────┐
│                                                                                │
│  WebView (React)                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │ 表现层  LayoutRenderer · 面板(编辑器/终端/聊天/桌面/笔记/…) · Toolbar ·   │  │
│  │         StatusBar · ContextMenu · 浮动窗口(FloatingRenderer)             │  │
│  │ 状态层  Store 单例 (chat/layout/settings/desktop/…，模块级，无 React      │  │
│  │         Context) → EventBus 广播                                        │  │
│  │ 通信层  EventBus(窗口内) ⇄ DataBus(跨窗口/多实例) ⇄ WebSocket(唯一后端连接)│  │
│  └───────────────┬──────────────────────────────────────────────────────────┘  │
│                  │ Tauri IPC (invoke / emit / listen)                          │
│  ┌───────────────┴──────────────────────────────────────────────────────────┐  │
│  │ Rust 后端  lib.rs 注册 ~90 个 command · settings.rs · db.rs(SQLite) ·     │  │
│  │         mcp.rs(内嵌 MCP 服务器,动态端口 13920+) · update.rs(更新) ·        │  │
│  │         diagnostics.rs(运行环境诊断) · notes.rs(笔记)                     │  │
│  └───────────────┬──────────────────────────────────────────────────────────┘  │
└──────────────────┼─────────────────────────────────────────────────────────────┘
                   │ spawn (注入 profile env)
┌──────────────────┴─────────────────────────────────────────────────────────────┐
│ IDE 后端  claude.exe --ide-mode (每工作区一个进程)                              │
│    └── WebSocket ws://127.0.0.1:<port>/ws   ←── GUI 唯一数据源                  │
└──────────────────┼─────────────────────────────────────────────────────────────┘
                   │ HTTPS / HTTP
        ┌──────────┴──────────────┬───────────────┬───────────────┐
    AI API                   更新/技能服务器       记忆 MCP        云镜像
   (ANTHROPIC_BASE_URL)   (96:8765 / 云:8765)   (40020/40021)    (备选更新源)
```

**关键数据流**：后端（`claude.exe`）是唯一 WebSocket 源 → `useChatBridge` 收消息 → 调 Store 变更 → Store 发 EventBus → 组件 `useEvent` 重渲染；子窗口（Leaf）无 WS，数据经 DataBus 桥接镜像。写数据走 Tauri `invoke` → Rust 命令（设置/DB/MCP/更新/诊断）。

---

## 1. 分层地图 (Layer Map)

| 层 | 职责 | 关键模块 | 深入 |
|----|------|----------|------|
| **前端表现层** | 布局树渲染、面板、UI 组件、i18n | `LayoutRenderer` `Toolbar` `panelDefs.tsx` `stores/*` | §2 |
| **前端通信层** | 窗口内事件、跨窗口数据、后端 WS、跨面板命令 | `serviceBus.ts` `dataBus*.ts` `useChatBridge.ts` | §3 |
| **Tauri 后端层** | Tauri 命令、设置持久化、SQLite、内嵌 MCP、更新、诊断 | `lib.rs` `settings.rs` `db.rs` `mcp.rs` `update.rs` `diagnostics.rs` | §4 |
| **后端集成层** | 后端生命周期、会话、权限、AI 网关兼容、Profile 环境 | `backendService.ts` `chatSession.ts` `claude-profile.ts` `api/claude.ts` | §5 |
| **外部服务层** | 更新/技能服务器、记忆 MCP、笔记、反馈 | `updateService.ts` `skillMarketplace.ts` `notes.rs` | §6 |
| **数据与持久化** | 工作区分层设置、多实例、窗口状态、SQLite | `settings.rs` §4.2 分层、`data.db` | §7 |
| **关键功能模块** | 超级桌面、消息虚拟滚动、命令面板、技能 | `desktop/*` `MessageList.tsx` `useCommandPalette` | §8 |
| **横切关注** | 设计规则、环境注入、ripgrep 分发、字体缩放、主题系统 | `utils/` `windowsPaths.ts` `themeUtils.ts` `tokens.css` | §9 |
| **构建与分发** | 构建管线、安装器、更新分发 | `scripts/build.ts` `installer/setup.iss` | §10 |

---

## 2. 前端表现层 (Presentation)

### 2.1 布局系统 (Layout)

- **数据模型** `types/layout.ts`：`LayoutNode = SplitNode | TabGroup`，加 `FloatingWindow`（CSS 浮动面板）与 `TauriWindow`（原生子窗口）——三者都是布局一等公民。
- **树结构**：`SplitNode{ direction, children, sizes }` 递归；`TabGroup{ tabs, activeTabId, tabStyle, visibility }`。
- **图标是序列化键**：`IconKey` 字符串（非 ReactNode），`iconFor(key)` 映射组件 → 布局持久化直接透传图标。
- **单一事实源**：`layoutStore` 的 `getTree()` 同步读取；显隐走 `hideGroup/ensureGroupVisible`，禁止条件渲染。
- **布局预设**：`LAYOUT_PRESETS` 注册表（default/chat/dense）+ `applyLayoutPreset(id)`；工具栏 `LayoutPresetDropdown`（缩略图预览 + 确认弹窗）。
- **布局模式**（`layoutMode` store，全局 + DataBus 同步）：工具栏 `Grid3x3` 进入布局编辑态——每面板右上角绿色浮动 chip（拖动/分割四向/浮动/关闭/更多菜单）、分割线加宽 + 双箭头抓柄、面板绿色 outline + 拖拽高亮、顶部横幅 + `Esc` / 右下角「完成布局」胶囊退出。纯呈现层：拖拽/分割/浮动复用 `layoutStore` 现有操作，零新接口。
- **复合组（compound group）**：`TabInstance.children` 承载合并进来的面板——`mergeIntoTab` 把源 tab 合并进目标 tab（首次合并图标变 `compoundGroup`，源是复合组则展开全部子面板），子面板可拖拽排序（`moveChild`）。**自动解散**：`removeChildFromCompound`/`moveChildBetweenTabs`/`removeChildFromFloatingTab` 移出后剩 ≤1 个子面板 → 复合组自动解散且图标/标题回归该面板（不残留 `compoundGroup` 图标）。**手动解散**：右键菜单「解散分组」`dissolveCompoundGroup` 把复合 tab 拆成同组 N 个独立 tab（保留活动子面板，`children < 2` 时禁用）。
- **折叠（collapse）与图标栏**：activity 风格组点活动图标 `toggleGroupCollapse`（expanded ↔ collapsed，只改 `visibility` 不动 sizes）。折叠组渲染成固定图标栏（宽 48/高 35，`flex:0 0 auto`，高度稳定不自移）；`SplitView.showDivider` **不因 collapsed 隐藏**——折叠组后面的分隔条照常渲染，否则兄弟面板在该 split 内失去唯一可拖手柄。图标按钮 `flexShrink:0`（空间不足不被压间距）；`IconOverflowBar` 用 `ResizeObserver` 量可用空间，放不下的 tab 收进末尾「…」菜单（点击切过去，保留 ReorderHandle 拖拽重排）。

### 2.2 面板系统 (Panels)

- 注册：`panelDefs.tsx` 单一数据源，启动时 `App.tsx`/`FloatingApp.tsx` 遍历 `registerPanel()`。
- `PanelDefinition{ id, title, icon, defaultView, views[], userManaged }`；`userManaged: false` 的系统面板（settings/help/update/diagnostics/ask-question…）不出现在面板下拉、不持久化。
- 每个面板可有多个 `view`，布局树通过 `panelId` 映射到面板 → 渲染活动 view。

### 2.3 状态存储 (Store 单例清单)

全部为模块级单例，变更时发 EventBus（sticky 供新订阅者拿现值）。**Store 禁止 I/O**（文件/HTTP/异步归组件或 hook）。

| Store | 数据 | 事件 |
|-------|------|------|
| `chatStore` | 消息/会话/流式/权限/上下文 token | `CHAT_STATE_CHANGED` |
| `layoutStore` | 布局树 + 浮动/原生窗口 | `LAYOUT_TREE_CHANGED` `LAYOUT_FLOATING_CHANGED` |
| `settingsStore` | `AppSettings`（工作区/服务器/布局/收藏…） | `SETTINGS_CHANGED` |
| `terminalStore` | 终端条目 | `TERMINAL_CHANGED` |
| `planStore` / `planHistoryStore` | 当前计划 / SQLite 历史 | `PLAN_UPDATED` `PLAN_HISTORY_CHANGED` |
| `editorStore` | 打开的文件标签（Monaco） | `EDITOR_CHANGED` |
| `desktopStore` | 超级桌面数据（SQLite 持久化） | `DESKTOP_CHANGED` |
| `subAgentStore` / `statusMsgStore` | 子代理 / 状态栏消息 | `SUB_AGENTS_CHANGED` / 订阅 |

### 2.4 渲染与交互

- `LayoutRenderer` 递归渲染布局树；`FloatingRenderer` 覆盖层渲染浮动窗口；子窗口 `FloatingApp` 经 Bridge 镜像。
- 核心组件：`Toolbar`（权限/模型下拉、布局预设、Profile、面板/终端、更新、帮助、**诊断**、设置）、`StatusBar`（消息日志）、`ContextMenu`（右键菜单）、`EditorPanel`(Monaco+文件预览)、`TerminalPanel`(xterm.js 多标签)、`FileBrowserPanel`、`MessageList`（虚拟滚动）。
- **i18n** `i18n/{zh,en}.ts`：`t(key)` 点分路径 + `{param}` 替换；`useT()` 语言切换重渲染。
- **字体缩放**：CSS 变量 `--font-scale`，UI 文本用 `calc(var(--font-scale,1) * Xpx)`；≤10px 工具尺寸/编辑器/等宽不缩放。
- **消息区增强**：左侧时间线 `TimeLineBar`（按天分桶省略静默日、悬停展开 350ms 防抖、拖动秒级定位；右侧滚动条易误触故放左）+ 每条消息时间显示（今天时分/跨天带日期，随 `messageTimeline` 开关）。上下文告警 `ContextWarningPopover`：已用百分比 ≥ 阈值（默认 90）时状态栏进度条上方弹浮动提示（带箭头、关闭 ✕、去设置），触发时进度条脉冲 + 数字变红；状态机纯函数 `utils/contextWarning.ts`（idle/showing/dismissed，设置 `contextWarningEnabled/Percent`）。
- **划词工具栏** `SelectionToolbar`（设置 `msgSelectionToolbar`，默认开）：消息容器内划词弹出浮动条——「发送到聊天」/「复制」/「📂 路径下拉」。路径用 `pathDetector.ts` 检出：`findPathsWithWorkspace(text, workDir)` **先转义工作区路径中的空格**（`escapePathSpaces` 用占位符替换，防含空格工作区被拆成两个路径）→ PATH_REGEX（含分隔符才匹配）→ 还原去重；相对路径按工作区根解析 + 规范化。📂 展开列表逐项调 `open_in_explorer`，**打开前存在性检查**——路径不存在弹「路径不存在」toast（不开资源管理器）。交互契约：点击工具栏内不因 `selectionchange` 清空关闭（守卫：记录最近 mousedown 是否在工具栏内），点外部/Esc/滚动关闭。
- **ErrorBoundary**（`ErrorBoundary.tsx`，面板级包裹）：普通错误一次性自动重试；**瞬时 hydration 错**（#300/#310，message 含 "server-rendered HTML"/"Hydration failed"）静默重试最多 2 次（间隔递增）才落手动 fallback。⚠️ hooks 必须全部在组件提前 return 之前——条件 hooks（数量随状态变化）在 prod minify 后即表现为 #300/#310（EditorPanel 案例）。

---

## 3. 前端通信层 (Communication)

### 3.1 EventBus（窗口内，强制）

- 唯一跨面板通道（`serviceBus.ts`/`useService.ts`/`events.ts`）。禁止自定义 subscribe/notify。
- `eventBus.emit(Ev, payload, { sticky })`；组件 `useEvent(Ev)` 订阅（重渲染）/ `useEventHandler`（副作用）。
- **Sticky 事件**（chat/layout/settings/plan…）新订阅者立即拿现值；瞬态事件（toast）不 sticky。

### 3.2 DataBus（跨窗口）

- 子窗口（Leaf）无 WS、无后端，Store 全部由 DataBus 镜像（`dataBusLeaf.ts`）；Hub 侧 `dataBusHub.ts` 把 EventBus 事件重发布到 DataBus。
- **四通道自动路由**（按 topic 前缀）：Stream（`chat.delta.*` RAF 帧合并）· State（sticky，同值跳过）· Bulk（一次性大载荷）· Command（`cmd.*` 立即）。
- 握手：Leaf `hello{subscriptions}` → Hub `init{snapshots}` → Leaf `ready`；5s 心跳，15s 无响应清理；关闭发 goodbye。
- 设计规则：**单窗口走 EventBus，跨窗口走 DataBus**；Hub/Leaf 组件代码完全相同（对 UI 透明）。

### 3.3 WebSocket 协议（GUI ↔ 后端，唯一数据源）

- 连接：`ws://127.0.0.1:<port>/ws`，断线指数退避重连（1s→30s）。
- **入站**（`useChatBridge` dispatch）：`stream_event`（流式增量→追加消息/工具）、`assistant/user/result/error`、`tool_progress`、`session_list/session_loaded/current_session`、`control_request`（权限/AskUserQuestion）、`tasks_*`（后台任务/子代理）、`context_window`（**窗口用量显示的唯一属主**：`used_tokens` + 会话累计 `session_*_tokens`：input/output/cache_read/cache_creation；`session_loaded` 不再清零用量字段，`remaining_percentage` 未知时保持旧值防闪 0）、`file_edit`（AI 写盘→`FILE_CHANGED`）、`permission_mode_changed`。
- **出站**：`user`（带 `session_id`）、`control_response`、`interrupt`、`list/load/new/delete_session`、`kill_task`、`set_permission_mode` 等。
- **CommandRegistry**：跨面板动作走 `commands.execute()`，组件禁止直接 import WS；`useChatBridge` 集中注册所有 WS 命令。
- **流式看门狗**：后端以 `CLAUDE_ENABLE_STREAM_WATCHDOG=1` 启动（5min 无块超时），防挂死流卡死会话。

### 3.4 消息列表虚拟滚动（§8.2）

见 §8.2 —— 全量 `@tanstack/react-virtual` 虚拟化，替换旧的 20 条渲染窗口。

---

## 4. Tauri 后端层 (Rust)

### 4.1 命令注册

`lib.rs` 用 `tauri::generate_handler![...]` 注册约 90 个 `#[tauri::command]`。分域：
- **设置**：`get/save_app_settings`、`save_permission_mode`、`save_window_state`
- **文件**：`read/write/save/delete/rename_path`、`read_bytes`、`copy_file`、`open_in_explorer`
- **工作区/后端**：`bind_workspace`、`get_ide_port`、`restart_ide_backend`、`get_cli_workspace`
- **Profile**：`list/switch/create/delete_model_profile`、`set_default_profile`
- **DB**：`db_*`（plan/desktop/history）· **笔记**：`note_*`
- **MCP**：`mcp_response`、`get_mcp_port` · **更新**：`update.*` · **诊断**：`run_env/network/workspace_diagnostics`
- **技能/翻译**：`get_skills_dir`、`install_skill/package`、`delete_skill`、`run_cli_print`

### 4.2 设置持久化 (settings.rs) — 全局 + 工作区分层

- 配置存 Claude Code 自身的配置文件，`gui` 顶层键（引擎 `.passthrough()` 容忍未知键，读改写保留引擎键）。
- **全局基线** `~/.claude/settings.json`（主题/语言/服务器/权限/workspaces 列表）；**工作区覆盖** `<W>/.claude/settings.local.json`（布局/窗口状态/`favoriteSessionIds`）。有效值 = 全局 merge 工作区，工作区胜出。
- **`save_target_path(bound_wd, scope)`**：workspace 作用域且未绑定 → 丢弃（不污染全局）；默认工作区也是普通工作区。`save_app_settings`/`save_window_state` 用真实进程绑定 `bound_work_dir()`（空=未绑定），防启动默认布局覆盖。
- **merge 字段**：`merge_workspace_overrides` 合并工作区覆盖（含 layoutTree/quickPrompts/favoriteSkills/favoriteSessionIds/窗口状态…）。
- **多实例**：每进程绑定一个工作区，`BOUND_WORK_DIR` 进程级解析工作区上下文；未绑定前返回纯全局基线。

### 4.3 SQLite (db.rs / notes.rs)

- 工作区数据 `<W>/.claude/data.db`（plans/desktops/desktop_items/desktop_connections/desktop_history）；`ensure_db()` 切工作区自动重开。
- 笔记用户级 `~/.claude/notes/notes.db`（notes/tags/note_tags/note_associations，跨工作区共享）。
- 依赖 `rusqlite`(bundled) + `base64`。

### 4.4 内嵌 MCP 服务器 (mcp.rs)

- 内嵌在 GUI 进程：TCP 监听**动态端口**（13920 起首个空闲，多实例各自一个）→ 收 HTTP/JSON-RPC → emit `mcp-request` Tauri 事件 → JS `mcpBridge` 分发到 Store → `mcp_response` 回 oneshot channel → HTTP 响应。
- 端口注册进工作区 `<W>/.mcp.json`（`get_mcp_port` 暴露）；`start_mcp_server` 在 setup 最先启动。
- 服务：超级桌面 17 工具、笔记 9 工具。**注册规则**：GUI 开发的 user-scope MCP 写 `~/.claude.json` 根 `mcpServers`（标准双文件模式；`settings.json` 根 `mcpServers` 是旧单文件模式残留，启动时自动迁移到 `~/.claude.json`）。

### 4.5 运行环境诊断 (diagnostics.rs)

工具栏听诊器按钮 → 浮动面板一键体检，按 4 类展示每项 通过/警告/失败/不适用 徽章 + 明细，支持重新检测 + 复制报告。

- **架构**：纯函数检查层（测试接缝，`settings.rs` 同款单测）+ 薄编排采集 + 异步 command（阻塞工作放 `std::thread::spawn` + mpsc，不卡异步运行时）。
- **环境**：安装变量（`CLAUDE_CODE_HAHA_HOME`/`GIT_BASH_PATH`/PATH/作用域/组件，注册表经 `reg.exe` 读）· Profile 环境文件（目录位置/激活解析/内容校验/注入，`resolve_active_profile()` 与后端共用）。
- **后端服务**：进程状态/端口/WS（数据来自前端运行时状态，纯 TS 分类函数）。
- **工作区**：绑定/局部设置/会话 DB（只读打开，损坏→失败）。
- **网络连通**：内网更新服务器 + 云服务器（HTTP）+ MCP（读本实例动态端口）+ API BaseURL（TCP，不碰凭据）；「内网不通+云通」时面板给「切换到云服务器」一键按钮（持久化两 URL + 自动重探）。
- **一键修复**（诊断面板按分类给出）：
  - 「修复环境与 Profile」→ `fix_environment_vars` + `fix_profiles`。前者按纯函数 `plan_var_fix`（Write/Remove/Keep，单测接缝）规划动作：`CLAUDE_CODE_HAHA_HOME`/`CLAUDE_CODE_GIT_BASH_PATH` 归位 + PATH 按安装目录实际存在的组件补全（根/bin/git\usr\bin/git\bin/python/python\Scripts），且 **git\usr\bin 提到 PATH 最前**（防 WSL bash 截胡）；写 **HKCU 用户级**——注册表用 `%CLAUDE_CODE_HAHA_HOME%` 引用（`REG_EXPAND_SZ`，Windows 构建进程环境时自动展开、安装目录迁移跟随），进程用展开值；**Remove 分支清理废弃旧值**（如安装目录缺少 bash.exe 时删除用户级残留 `CLAUDE_CODE_GIT_BASH_PATH`——残留旧值优先于系统级被 Windows 读取，永久干扰 SHELL/bash 解析；PATH 修复幂等，无实际变化不重写注册表/进程）。后者检测激活无效（指向不存在/缺凭据/未激活）时自动切到第一个有凭据 profile，写 `~/.claude/.env.active` + 工作区 `active-profile` 双标记（读侧优先级一致）。有改动后提示重启 GUI/IDE 生效（用户级对已运行进程不生效）。
  - 「重启 IDE 后台」→ `fix_restart_ide_backend`（杀残留 `--ide-mode` 进程 + 按当前工作区重启）。它是 fire-and-forget（不刷新前端 `BackendService._state`），面板修复按钮随后调 `BackendService.start()` 重新 poll 新端口并刷新状态，避免"看起来没重启成功"。
  - **失败即诊断**：后端状态进入 `error`（含启动超时）时前端自动 `activatePanel("diagnostics")`（5s 防抖 + 面板已开跳过），用户不用找入口。

### 4.6 更新系统 (update.rs) — 见 §6.1

---

## 5. 后端集成层 (Backend Integration)

### 5.1 后端生命周期 (backendService.ts)

- `BackendState{ status: stopped/starting/running/error, port, workDir, error }`。
- 启动：`bind_workspace` → 快速轮询（3s）`get_ide_port` → 失败 `restart_ide_backend` + 全轮询（30s）→ `running`。
- **防孤儿**：spawn 后立即登记 PID；退出 `taskkill /F /T`；`spawning` 守卫防重启循环。
- **首启差异**：首次不预启动（等选工作区拿正确 workDir）；老用户 setup 预启动 + 快速轮询命中。
- 前端 `WORKSPACE_BOUND`（sticky，bind 返回即触发，不等后端端口）→ 立即 `reloadSettings` + 恢复布局。

### 5.2 会话管理

- `resetSession()` 统一清空消息/计划/终端/子代理 + 重置 sessionId/tasks/token —— 建会话/载会话前必调。
- 每条 `user` 消息带 `session_id`，后端不一致时轻量 `switchSession()`（防竞态建重复会话）。
- 自动载入最近会话（`autoLoadLatestSession`）；原子恢复 `setMessages()` 一次替换（防闪烁）。
- 会话收藏 `favoriteSessionIds`：工作区作用域，`partitionSessions` 纯函数分区（活跃/过期/普通）。

### 5.3 权限 / AskUserQuestion

- 协议：后端 `control_request{request_id, request:{...}}` → 前端 `control_response{request_id, allowed, updatedInput}`（字段扁平，非嵌套）。
- `AskUserQuestion`：设 `pendingControlRequest` → 浮窗 → `respondToPermission` → 清理。
- 权限模式持久化：`permissionMode` 必须进 TS AppSettings（否则周期布局保存覆盖回 default）+ `save_permission_mode` 即时写盘；`permission_mode_changed` 有竞态守卫（后端 init 广播 default 时忽略已保存的非默认）。

### 5.4 AI 网关兼容性（CLI 引擎 src/services/api/claude.ts）

- **Anthropic 兼容端点光谱**：DeepSeek `/anthropic` = 原生协议复刻（零改动）；qnaigc/one-api 系 = 转换代理（Anthropic→OpenAI 转换器常缺新字段）。按最弱转换器做通用兼容，不 per-model。
- **thinking 块剥离**：`stripThinkingFromAssistantMessages` 发送前剥离 assistant 消息里的 thinking/redacted_thinking 块——GLM 等模型响应总带 thinking 块存进 history，重放被网关拒（`content[0].type类型错误`→502）；对 Anthropic 官方无害（本就不该重放）。tool_use/tool_result 多数网关认，不剥。
- **能力互斥**：`thinking` 块（modelSupportsThinking）与 `reasoning:{effort}`（modelSupportsReasoning，DeepSeek 式）互斥，由 profile 能力 env 决定走哪条（勾选入口见 §5.5）；final guard 保证 `max_tokens > thinking.budget_tokens`（3P 端点硬校验）。
- **TPM 预占限流陷阱**：one-api 系网关按「非缓存输入 + max_tokens」**预占**限流额度（非实际计量）——profile 的 MAX_TOKENS 给实际需要的量（16-32K），别按模型上限给；太小则长编辑截断分多轮反而重放大上下文。

### 5.5 Profile 环境 (claude-profile.ts ↔ lib.rs)

- **Profile 文件统一用户级**：只认 `~/.claude/.env.profiles/*.env`（全局共享，跨项目列表一致）。旧版曾按「IDE 脚本项目根→工作区→用户级」碰运气复用已存在目录，导致 profile 散落各项目、跨项目找不到；启动 `migrate_legacy_profiles()` 自动把旧位置 `*.env` 复制到用户级（同名不覆盖，旧目录保留不删）。
- **激活标记（各工作区独立）**：解析优先工作区 `<work_dir>/.claude/active-profile`（GUI 切换写入，per-workspace 记忆，互不覆盖）→ `~/.claude/.env.active`（CLI 兼容兜底）→ 兜底第一个 profile。写读路径必须一致——历史 bug：`switch_model_profile` 写工作区标记但 `resolve_active_profile` 读安装根，导致工作区标记成死代码、全局 `.env.active` 被各工作区互相覆盖。
- **`resolve_active_profile()` 共享解析器**（后端 `apply_active_profile` 与诊断共用，杜绝兜底漂移）。
- `MANAGED_KEYS`（17 键）TS/Rust 单一来源，clear-then-rewrite 防残留；switch 写工作区 `settings.local.json` env + 工作区/用户双标记，default 写用户 `settings.json` env + 标记。
- **模型能力声明（profile 勾选，告别手写 env）**：ProfileDialog 自定义 provider 表单提供「模型能力」勾选（thinking / adaptive_thinking / effort / max_effort / reasoning），勾选自动写三个 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL_SUPPORTED_CAPABILITIES` env；编辑回读（`parseCapabilities`）。后端 `get3PModelCapabilityOverride` 按它判定 `modelSupportsThinking/Reasoning/Effort`，GUI 工具栏据此显示思考/effort 档位。不勾 = 后端按模型名默认判断。编辑已有 profile 时按钮显示「保存」（`editingId` 区分），新建显示「创建」。

---

## 6. 外部服务层 (External Services)

### 6.1 更新系统 (update.rs + release-platform)

- **8 组件**（gui/claude/bun/updater/tools/python/git/extensions）选择性更新；比较本地 `manifest.json` hash vs 服务器 manifest（不在运行时算文件 hash）。
- **未安装组件"显示但不打扰"**：后端 `needs_update = !installed || local_sha != remote_sha` 会把"从未安装"与"真过期"混为一谈；前端 `groupComponents()` 三分组——**updates**（已装且 sha 变）/ **optIn**（未装）/ **upToDate**（已最新）。未装组件进面板独立「可选安装」区（`installSelected` 手动装，**不自动勾选、不亮红点**）；工具栏红点只认已装组件的真更新（`hasRealUpdate`）。
- 服务器 `release-platform`（8765，intranet 96 主 / 云 123.56.66.84 备）：`/api/updates/latest`、`/download`、`/upload`。upload 以提交的 manifest 为准，缺失组件 zip 自动从上一版本复制（按名字）；manifest 用 `curl -F "manifest=<file"` 上传保 UTF-8（`--form-string "$(cat)"` 会被 Git Bash 转 GBK 乱码）。
- **GUI 自更新**：`prepare_gui_update` 下载新 exe → 写 `%TEMP%/claude-update.json` → `launch_updater_and_exit` 启动 `Update.exe` 存根（换文件 + 重启）。前端 `handleRestart` **复用已下载的暂存**（不重新下载）。
- **非 GUI 组件**：`download_and_install_component` 直接写；`PermissionDenied` → `install_via_stager`（提权 Update.exe）。
- 异步 off 主线程（thread+mpsc，10s 超时，`no_proxy()`）；manifest 版本数值排序。
- 更新器 `Update.exe` 也是托管组件（`updater.zip`），换 exe 前杀所有 GUI 实例 + 孤儿 `--ide-mode` 后端。

### 6.2 技能市场 (skillMarketplace.ts + skills-server)

- 服务器 FastAPI 8765：`/api/packages`（列表/详情/下载/翻译），上传需 `X-API-Key`；intranet 96 + 云双部署。
- GUI `SkillsPanel` 双标签：已安装（收藏/搜索/翻译）/ 在线库（卡片、一键安装 `install_skill/package`）。
- 翻译：服务器存 `translations/zh.json` → 安装时 merge 进 `<W>/.claude/skills-i18n.json` → SkillDialog 显示中文描述。

### 6.3 记忆 MCP / 笔记

- **记忆 MCP**（轻量版，FastAPI）：无 embedding（关键词+标签+importance），`apply_tag_mapping` LLM 归一化；intranet `40020/mcp` / 云 `8080/mcp`。
- **笔记**（内置 `notes.rs`）：`~/.claude/notes/notes.db`，Markdown + Milkdown 编辑器、标签、作用域、加权关联；9 个 MCP 工具经内嵌 MCP 服务器调用。

### 6.4 反馈 (feedbackService.ts + skills-server)

- Toolbar 🐛 → 浮窗 `FeedbackDialog` → `POST /api/feedback`（multipart：类型/消息/版本/截图）。匿名（不记 IP/UA）；截图服务端校验 magic bytes + 10MB 上限 + UUID 文件名。
- 管理页 `static/admin.html`：状态过滤/展开/改状态（需 API key）。

---

## 7. 数据与持久化 (Data & Persistence)

### 7.1 工作区管理

- `AppSettings.workspaces[]` 持久化列表 + `workDir` 当前；迁移：workspaces 空时从 workDir 填充。
- 启动流程：首启 → WelcomeWizard（7 步）→ 选工作区；老用户 `--workspace <path>` 直绑 / `autoEnterRecentWorkspace` 自动进最近 / 否则工作区选择器。
- `bind_workspace`：设进程绑定 → 建 `<W>/.claude/data.db` → 注册 MCP（动态端口）→ spawn 后端 → 记录 `recentWorkspaces`（幂等）。

### 7.2 多实例（一个工作区/进程）

- 每 `claude-code-gui.exe` 完全隔离：独立后端、Store、per-workspace DB、动态 MCP 端口。
- **同工作区并发协调**：`<W>/.claude/gui-instance.lock`（写 PID + OpenProcess 查存活，崩溃自动接管）——重复绑定同一工作区的实例跳过自动载入最近会话，不同工作区互不影响。首个实例判定曾用全局命名互斥量（win32 `CreateMutexW`，已被锁文件取代）。
- **未绑定前不读全局 workDir 工作区**（防闪现他人数据）：`get_app_settings` 未绑定返回纯全局；desktops 在 `BACKEND_PORT_READY` 后从绑定工作区 DB 载入；前端 `reloadSettings()` 在 bind 后重取。
- 窗口标题显示工作区 basename，工具栏工作区 chip —— 多实例可区分。

### 7.3 窗口状态

- `AppSettings.window{X,Y,Width,Height,Maximized}`；恢复在 Rust `setup()`（set_position/set_size/maximize，无闪烁）；保存 `save_window_state`（resize+moved 防抖 500ms）。
- `save_app_settings` 保留 Rust state 中的窗口字段（防 JS 快照 null 覆盖）。

### 7.4 编辑历史

- 每个编辑经 VS Code 插件记到 `~/.claude/projects/<slug>/edit-history.jsonl`（JSONL，带 diff + `gitCommit` hash）。回顾/撤销/清空均基于它。

---

## 8. 关键功能模块 (Feature Modules)

### 8.1 超级桌面 (Super Desktop)

无限画布面板：9 种内容类型（text/table/chart/graphic/ref/filegroup/image/form/drawing），拖拽连线、多桌面标签、粘贴/拖放、AI 经 MCP 访问。

- **数据**：`desktopStore`（desktops/items/connections，SQLite 防抖保存）+ `desktopHistoryStore`（每桌面 100 步快照，undo/redo，不 import desktopStore 防循环）+ `selectionStore`（画布本地临时选择）。**跨 GUI refetch 保留本地视口**：`fetchDesktops` 重建 desktops 时保留本地已有桌面的 panX/panY/zoom + 网格设置（视口是本地交互态，服务端记录可能比本地旧——500ms 防抖未落库/他窗并发），仅 items/connections/name 跟随服务端，否则用户刚做的缩放/平移会被打回（"闪回"）。
- **画布**：CSS transform（`translate scale`，无库），光标中心缩放（0.1-5x，原生 wheel `{passive:false}`），指针捕获拖拽。
- **连线**：4 锚点、几何吸附、`ConnectionOverlay` SVG 在 transform 外（避免裁剪）。
- **graphic 图形**：支持 **Mermaid 文本**（`GraphicContent.mermaid` 字段，mermaid.js 懒加载完整渲染、主题跟随、双击编辑、AI 直接写 Mermaid 建/改图、搜索按文本匹配）；旧 nodes/edges 结构化图兼容保留。渲染/缩放/判别集中 `utils/graphicContent.ts` 纯函数。
- **MCP**：17 工具经内嵌 MCP；`DesktopSummary` 轻量快照（无 content 载荷）供 AI 决策。
- **桌面项查看器**：右键弹浮窗/开原生窗口，双向同步；`@ref{desktop-item:type/uuid}` 发送到聊天，点击激活面板 + 平移动画定位。

### 8.2 消息列表虚拟滚动 (MessageList)

全量 `@tanstack/react-virtual` 动态高度虚拟化：DOM 有界（viewport + overscan 8），会话再长也流畅；底部锚定增长（新消息只向下追加，顶部不动）。

- **跟随/解锁契约**：任何上滚立刻 `followRef=false`（不抢回底部）；回到真底部（2px 内）恢复跟随；内容收缩守卫区分"工具输出折叠"与"用户上滚"。
- 行测量：`estimateHeight` 粗估 + `measureElement`/ResizeObserver 校正（流式工具输出增长自动重测）；`animateIn` 只给最新消息淡入。

### 8.3 命令面板 (useCommandPalette)

F1/Ctrl+Shift+P：面板/AI 命令/会话按 `utils/recentUsage.ts`（localStorage MRU，纯函数测试）排序；新增「设置」kind 经 DataBus `settings.navigate` 跳转设置分类。工具栏搜索按钮 + 子窗口同接。

### 8.4 技能面板与 SkillDialog

浏览/搜索/调用技能命令：点技能 → 浮窗 `SkillDialog`（contentEditable + `@ref` chip）→ 发送给代理。收藏 `favoriteSkills`（settings）；在线库安装走技能市场。翻译异步化（`run_cli_print` + `cli-translate-result` 事件）。

### 8.5 笔记面板 (NotesPanel)

作用域树（`domain:rust` 层级）、Milkdown 编辑器（ProseMirror 命令）、2s 防抖差异保存、标签归一化（LLM 驱动）、`@ref{note:id|title}`。

### 8.6 无人值守守护 (guard.rs + guardBridge)

Toolbar 盾牌按钮 → 风险确认弹窗（模型自评不可靠/无自动上限/权限挂起/格式不兜底/自主执行，风险自担）→ 守护模式：每个回合（队列/手动/续发）结束后**先验收再放行下一条队列消息**，验收通过且队列空自动退出，未完成自动续做。设计见 `.scratch/guard-mode/PRD.md`（grilling 定稿）。

- **架构**：Rust 裁决 + 前端执行。`guard_reduce(state, event) -> (state, actions[])` 纯函数裁决器（唯一重 seam，单测覆盖全部决策：状态流转/`DONE|完成`/`NOTDONE|未完成`/格式异常解析/异常连击暂停/队列放行/超时）；Rust 守护线程事件驱动 + 30s 心跳（ask 态 5 分钟无回复 → 暂停+提示），免疫 WebView 定时器节流；前端 `guardBridge` 上报回合结束（带最后 assistant 文本+队列长度）、执行裁决动作（发验收/继续消息、放行队列、退出/暂停）。
- **验收时机（防撞 busy）**：上报只认权威结束信号 `result`/`status:ready`（watcher 轮询兜底，2s 去重）。`error` 消息导致的中途 `streaming→false` 复位**不上报守卫**——后端原 turn 可能仍 busy，过早 SendAccept 会被拒；上报时过滤 `Error:` 开头的 assistant 文本（`findLastReportableAssistant`）——后端错误绝不会被当成验收回复解析（否则连续 2 次格式异常即误暂停）。
- **队列协作**：守卫激活期间 `maybeDrain` 自动消化被拦截（防跳过验收），裁决放行（`ReleaseNext`）时绕过一次；切会话自动停守卫。
- **状态**：off / watching（工作中不插话）/ asking（验收中）/ paused（异常）。守卫消息以 user 消息 + `【守护系统】` 前缀写入会话历史可 review。

---

## 9. 横切关注 (Cross-cutting)

### 9.1 关键设计规则

1. **单窗口 EventBus / 跨窗口 DataBus**；两条系统并存（Hub 适配器桥接）。
2. **Sticky 事件**：新订阅者需即时拿现值的状态用 sticky。
3. **Store 都是模块级单例**，无 React Context/Redux；Store 无 I/O。
4. **WS 消息统一经 `useChatBridge`** → Store 变更 → EventBus → 组件重渲染。
5. **布局树是面板可见性的唯一事实源**，禁止条件渲染。
6. **跨面板动作走 CommandRegistry**，组件不直接 import WS。
7. **外部文件变更走 `FILE_CHANGED` 事件**（后端 `file_edit` 广播）。
8. **`userManaged:false` 系统面板不持久化**（`serializeLayout` 剔除）。
9. **子窗口是 Store 镜像，不是独立客户端**（无 WS/后端）。
10. **TauriWindow 是一等布局类型**，持久化 + 启动重建 + 关闭清理（`floating-window-closed` 事件 → `removeTauriWindow`）。
11. **图标是序列化 `IconKey` 字符串**（非 ReactNode）。
12. **字体缩放**：用户可读文本用 `calc(var(--font-scale,1) * Xpx)`。
13. **GUI user-scope MCP 注册到 `~/.claude.json` 根 `mcpServers`**（标准双文件；`settings.json` 根 `mcpServers` 残留由启动迁移自动搬走）。
14. **窗口尺寸恢复在 Rust `setup()`**（无闪烁）；`save_app_settings` 保留 Rust 窗口字段。
15. **自更新必须用存根进程**（Windows 不能覆盖运行中的 exe）；post-install hook 非致命。
16. **Stream 通道 RAF 帧合并**（60 token/s 不产生 3600 IPC/min）。
17. **主题预设 4 档**（light/dark/dark-a/dark-b）：暗色判定统一走 `themeUtils.isDarkTheme`，禁止硬编码 `=== "dark"` 导致新预设被误判成亮色。

### 9.2 环境注入 (system-reminder)

- `gui_context`：每次后端进程注入"运行在 GUI 桌面客户端"，附 `~/.claude/gui-agent-guide.md` + `gui-ref-system.md` 指引。
- **强制中文思考**：走系统提示（非 system-reminder，模型更服从），`CLAUDE_CODE_GUI_FORCE_CHINESE` env 触发。
- 文档自动复制：`spawn_ide_backend` 拷三份 docs 到 `~/.claude/`。

### 9.3 ripgrep 分发

编译 exe 不内嵌 `vendor/ripgrep/`（运行时解析）。`getRipgrepConfig` 顺序：`{exe}/bin/rg.exe`（tools 组件）→ `vendor/ripgrep/<arch>-win32/` → 系统 rg。`rg.exe` 留在 `bin/` 供更新系统管理。

### 9.4 Git Bash 解析 (windowsPaths.ts)

`findGitBashPath`：`CLAUDE_CODE_GIT_BASH_PATH`（`expandEnvVars` 展开 `%VAR%`）→ 存在即用 → 否则 `which('bash')`。`SHELL` 设为真实 bash 路径（防 WSL 遮蔽）。安装器写 REG_EXPAND_SZ。

### 9.5 主题系统 (Theme)

- **预设 4 档**：`light` / `dark`（兼容旧值，视觉等同 `dark-b`）/ `dark-a`（深蓝专业 A）/ `dark-b`（高级深灰 B）。设置面板 `settings.theme` 写入 → `App.tsx` `normalizeTheme()` 后设 `document.documentElement.dataset.theme`。
- **暗色判定单一来源**：`utils/themeUtils.ts` `isDarkTheme()`/`normalizeTheme()`（`DARK_THEMES = [dark, dark-a, dark-b]`），xterm/Monaco/图表/各组件选色统一走它。
- **token 覆盖**：`tokens.css` 亮色在 `:root`，暗色两套（`[data-theme="dark"]/[data-theme="dark-b"]` 与 `[data-theme="dark-a"]`）——bg/fg/accent/语义色/阴影全走 CSS 变量，深色下组件不再各自硬编码颜色。
- **原生控件主题化**：Chromium UA 给 button/input/textarea/select-option 设显式黑字 + 白底（覆盖 body 继承）→ 全局规则强制跟随：`button{color:var(--fg-primary)}`、`input,textarea{color+bg}`、`select option` 主题化；`color-scheme: light/dark` 让 Chromium 把未显式定制的原生控件（数字微调/单选框/日期）按主题渲染。

---

## 10. 构建与分发 (Build & Distribution)

### 10.1 构建管线 (scripts/build.ts)

```
bun run scripts/build.ts [--rebuild] [--quick] [--gui-only] [--components a,b,c] [--release 2026.MM.DD.N]
```
11 步：装依赖 → 编译 `claude.exe`（bun compile）→ `cargo tauri build --no-bundle`（GUI，含前端）→ 更新器 → 运行时（bun/scripts）→ 扩展（COM bridge/记忆 MCP）→ CLI 工具 → Python 3.12 → PortableGit → IDE 扩展 + 启动脚本 →（`--release`）manifest + 8 组件 zip 到 `dist/release/<version>/`。
`--gui-only`（配合 `--quick --release`）：只重打 `gui.zip`，其余 7 组件 zip 从上一 release 目录复制复用，并强制用 `target/release` 最新 gui exe——只改 GUI 时秒级发布（跳过 python/git 等大组件重复压缩）。
`--components <a,b,c>`（`--release` 时）：显式指定重建/重打的组件（如 `claude,gui`），其余组件复用上一 release 目录 zip 与现有 dist 产物（产物已存在则保留），未选组件不强构建（跳过 cargo/bun compile）。发布只改动的组件时用，避免全量重复压缩。
`--notes "..."`：**发布必须带**——release_notes 按 `\n\n---\n\n` 累积拼接上一版 manifest，但裁到**最新 5 条**（`MAX_RELEASE_NOTES=5`，本版在前）；忘传则当版没有自己的 note（只剩历史）。note 条目按惯例带日期标题（`## 2026.MM.DD.N — 摘要`）。

### 10.2 dist/ 布局

```
dist/  claude-code-gui.exe · Update.exe · claude.exe · bun.exe · manifest.json · *.cmd
       bin/(rg/fd/jq/yq/shellcheck) · scripts/ · python/ · git/ · extensions/ · release/<v>/
```

### 10.3 安装器 (installer/setup.iss)

- **双模式**：为所有用户（Program Files，提权，SYSTEM env/HKLM）/ 仅为当前用户（LocalAppData，免提权，USER env/HKCU）。
- 写入 `CLAUDE_CODE_HAHA_HOME`（REG_SZ）+ `CLAUDE_CODE_GIT_BASH_PATH`（REG_EXPAND_SZ）+ PATH 条目（根/bin/git\usr\bin/python）。
- 组件：core（固定）/ gui / gitbash / git / python（可选）。
- CLAUDE.md `@-reference` 注入：`@python-env.md` / `@office-bridge.md` 一行引用（不内联正文）。

---

## 附录：相关文档

| 文档 | 内容 |
|------|------|
| `docs/architecture-reference.md` | **详细参考附录**：各子系统数据模型/协议/机制/历史修复（架构图的细节版） |
| `docs/gui/gui-agent-guide.md` | AI 操作 GUI 手册 + 面板/MCP 参考（运行时拷到 `~/.claude/`） |
| `docs/gui/ref-system.md` | `@ref` 语法（8 类型）+ MCP 集成 |
| `docs/system-reminder.md` | 40+ attachment 类型参考 |
| `CLAUDE.md` | 仓库导航 + 命令 + 环境变量 |
| `.scratch/runtime-diagnostics/` | 运行环境诊断的 PRD + tickets |
