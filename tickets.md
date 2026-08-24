# Tickets

## Done: ripgrep 分发修复 + GUI Profile 上下文窗口 (2026-08-03)

### T1. ripgrep 编译产物丢失 → 多级查找

- [x] 根因：`bun build --compile` 不 embed `vendor/ripgrep/x64-win32/rg.exe`（非 import 资源），`USE_BUILTIN_RIPGREP` 未设时默认走 builtin 分支 → 编译产物找不到 rg → fallback 普通 grep
- [x] `src/utils/ripgrep.ts` — builtin 查找顺序：`{exe}/bin/rg.exe`（安装后 `{app}\bin`，bin/tools 更新组件）→ `vendor/ripgrep/<arch>-win32/rg.exe`（dev）→ 系统 PATH rg（兜底，不退化到 grep）
- [x] rg.exe **不放** claude.exe 同级（避免脱离更新组件，更新服务按组件管理）
- [x] `scripts/build.ts` — `mkdirSync(DIST_BIN)` 修复（dist/bin 缺失时 copyFileSync 报误导性 ENOENT）

### T2. GUI Profile 创建页 — MAX_CONTEXT_TOKENS 设置

- [x] 自定义 Profile：新增「上下文窗口」输入框（默认 1000000），替代硬编码
- [x] 预设模板（DeepSeek/Qwen）：新增可选「上下文窗口」覆盖，留空用模板默认（DeepSeek 1000000 / Qwen 256000）
- [x] `resetCreateForm` 重置新字段；Typecheck 通过

### T3. 全链路编译验证

- [x] `bun run scripts/build.ts` 全链路通过（claude.exe + GUI + Updater + Python 3.12 + 扩展）
- [x] Python zip 损坏修复：重新下载完整版 31MB（华为云镜像，原 18MB 截断）
- [x] 编译后 exe 实测：`bin/rg.exe` 旁路命中 + 系统 rg fallback 均正确

---

## Done: 会话恢复加载 + 自动滚动修复 (2026-08-03)

### T1. chatStore 批量替换 messages

- [x] 新增 `setMessages(msgs)` — 一次性替换整个消息数组 + 单次 emit（替代逐条 `addMessage` 的 N 次渲染），并重置 `streaming`
- [x] 不破坏现有 `addMessage` 流式路径

### T2. session_loaded 改用 setMessages

- [x] `useChatBridge` `session_loaded` handler 用 `setMessages(merged)` 替代逐条循环 → 会话恢复一次到位，initial-load instant scroll 正确触发

### T3. MessageList 滚动守卫

- [x] `ChatMessagesPanel` 传 `key={sessionId}` → 会话切换时 remount，滚动状态全部重置（修复"5→N 不触发 instant scroll"问题）
- [x] initial-load effect 在 double-rAF 后重置 `initialLoadRef` + 重设 `wasAtBottomRef=true`
- [x] 流式 effect 增加 `!initialLoadRef` + `wasAtBottomRef` 双重守卫：加载期间不 smooth、用户上滚阅读不被拽回
- [x] `setMessages` 重置 `streaming`（跨会话流式状态不残留）

---

## Done: Profile 链路统一 — claude-profile 对齐 GUI 写入方式 (2026-08-02)

### T1. claude-profile switch 双写（项目级）

- [x] `scripts/claude-profile.ts` — `switch` 同时写 `.claude/profile.env`（launcher --env-file）+ `.claude/settings.local.json` env（引擎消费）+ `.claude/active-profile` + `~/.claude/.env.active`
- [x] 保留 settings.local.json 非 managed 字段（如 `disabledMcpjsonServers`）不被覆盖
- [x] 实测验证：切 pro / 切回 flash 均正确重写 env + 同步两个 active marker

### T2. claude-profile default 双写（用户级）

- [x] `default` 同时写 `~/.claude/settings.json` env（引擎用户级源）+ `~/.claude/profile.env`（launcher）+ `~/.claude/.env.active`
- [x] 清理逻辑从"前缀匹配"改为精确 `MANAGED_KEYS` 清单，避免误清/漏清
- [x] 实测验证：settings.json env / profile.env / marker 三者同步

### T3. 共享 managed-keys 清单（单一来源）

- [x] 新增 `MANAGED_KEYS` 常量（TS + Rust 各一份，注释互指保持同步），含 `CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD`（原 Rust 清单漏项）
- [x] Rust 抽取 `apply_profile_env_to_settings()` helper，消除 `switch_model_profile` / `set_default_profile` 两处重复数组
- [x] Rust `cargo check` 通过，无 dead code

### T4. GUI/Rust 侧对齐

- [x] `switch_model_profile` 额外写 `~/.claude/.env.active`（同步 CLI marker）
- [x] `set_default_profile` 修正：从写 GUI appdata settings.json env 改为写引擎 `~/.claude/settings.json` env + `~/.claude/profile.env` + `~/.claude/.env.active`（原写入目标引擎不消费，是失效配置）
- [x] `apply_active_profile` marker 回退链统一：项目 `.claude/active-profile` → `~/.claude/.env.active` → 首个可用 profile
- [x] `list` 项目级显示改为读 settings.local.json（引擎消费源）

**关联 spec**: `.scratch/profile-chain-unify/PRD.md`

---

## Done: 构建系统重构 + 96 部署 + 向导优化 (2026-07-30)

### T1. Build Script — 构建系统重构

- [x] `scripts/build.ts` — 从 8 步扩展为 10 步，新增 GUI/Updater cargo build + `--rebuild` / `--quick` 标志
- [x] Python: 嵌入式 zip → 官方 `python-3.12.10-amd64.zip`（华为云镜像），完整版自带 pip/tkinter
- [x] Git: 系统 Git 逐个拷贝 → `PortableGit.zip` 直接解压（155 MB），完整 MSYS2 环境
- [x] dist 新布局: 核心 exe 放根目录（`claude-code-gui.exe`, `Update.exe`, `claude.exe`, `bun.exe`），`.cmd` 放根，`bin/` 仅 CLI 工具
- [x] `gui/src-tauri/src/update.rs` — 清理 dead code（ComponentInfo 未用方法、write_local_manifest、未用变量）

### T2. 96 服务器 — 双服务部署

- [x] WSL Docker 构建 `claude-memory` + `claude-release-platform` 镜像 → push 到 `192.168.186.96:5000`
- [x] 96 上 docker compose 启动: `claude-memory` (40020/40021) + `claude-release-platform` (8765)
- [x] 数据持久化: bind mount `/data/claude-memory/` + `/root/claude-release-data/`

### T3. Memory 迁移 — 云 → 96

- [x] 通过代理从云服务器 API 导出全部 16 条记忆
- [x] 转存到 96 MCP 服务（14 条，含服务器信息、项目架构、部署流程、CI 规范等）

### T4. WelcomeWizard — 服务区域选择

- [x] 新增 Step 5 "选择服务区域"（内网默认 → 96，公网 → 云服务器）
- [x] `App.tsx` `handleWizardComplete` 根据选择写入 `skillRegistryUrl` + `updateServerUrl`
- [x] i18n `zh.ts` / `en.ts` 新增 `wizard.server*` + `wizard.doneServer` keys

### T5. Installer — 环境变量 + 组件拆分

- [x] 新增 `CLAUDE_CODE_HAHA_HOME` 系统环境变量，PATH 全部基于 `%CLAUDE_CODE_HAHA_HOME%`
- [x] 新增 `gui` 组件（桌面应用 + 自动更新），可选安装
- [x] `[Run]` tkinter profile 脚本仅在无 GUI 时执行（`Components: python and not gui`）
- [x] 移除 scripts PATH（.cmd wrapper 已在根目录）
- [x] 新增 Python 3.12 组件描述

### T6. 源码默认值 — 云 → 96

- [x] `gui/src-tauri/src/lib.rs` — `default_skill_registry_url` / `default_update_server_url` → 96
- [x] Rust 迁移逻辑: `localhost` 或 `123.56.66.84` → 自动迁移到 96
- [x] `settingsStore.ts` / `feedbackService.ts` / `updateService.ts` / `skillMarketplace.ts` — 回退值 → 96

---

## Done: Update System — 选择性增量更新 (2026-07-30)

PRD: `.scratch/update-system/PRD.md`

### T1. Server — 更新分发 API

**What to build:** release-platform 新增 `/api/updates/*` 路由。

**Blocked by:** None

- [x] `server/updates.py` — `GET /api/updates/latest`, `GET /api/updates/{version}/components/{component}/download`, `POST /api/updates/{version}/upload`
- [x] `main.py` — 注册 router + 创建 `updates-store/` 目录
- [x] 项目重命名: `skills-server` → `claude-code-gui-release-platform`
- [x] `docker-compose.yml` — 更新容器名 + 挂载 updates-store
- [x] 部署到 123.56.66.84 并验证

### T2. Rust — 更新核心模块

**What to build:** `gui/src-tauri/src/update.rs` 提供 manifest 管理、hash/timestamp 对比、下载安装。

**Blocked by:** T1

- [x] `update.rs` — `RemoteManifest`, `LocalManifest`, `ComponentInfo`, `PostInstallHook` 类型
- [x] `check_for_updates(base_url)` — GET manifest → 对比本地 → `UpdateCheckResult`
- [x] `download_and_install_component()` — 下载 zip → 解压 → 替换文件 → 执行 post_install hook
- [x] `prepare_gui_update()` — 下载 GUI exe → 写 `%TEMP%/claude-update.json`
- [x] `launch_updater_and_exit()` — 启动 Update.exe → exit(0)
- [x] `get_local_manifest()` / `get_install_dir_path()` — 前端查询用
- [x] `sha256` 计算 (依赖 `sha2 = "0.10"`)
- [x] 目录最新 mtime 遍历 + ISO 8601 时间戳对比
- [x] Post-install hooks: `Script` (zip 内 .bat) + `Command` (内联命令)，执行失败不阻塞更新
- [x] `lib.rs` — 注册 module + 6 个 commands，`AppSettings` 加 `update_server_url`

### T3. Update.exe — GUI 自更新 stager

**What to build:** 独立 Rust 二进制，无 Tauri 依赖，`windows-subsystem = "windows"`。

**Blocked by:** None

- [x] `updater/Cargo.toml` + `updater/src/main.rs`
- [x] 读 `%TEMP%/claude-update.json` → 等 2s → rename old exe → copy new → 重启 GUI
- [x] 额外文件拷贝 (FileCopyInstruction 列表)
- [x] 错误日志写 `%TEMP%/claude-update-error.log`

### T4. Frontend — 更新面板 + 服务层

**What to build:** GUI 更新 UI — 工具栏按钮 → 浮动面板 → 检查/选择/下载。

**Blocked by:** T2

- [x] `updateService.ts` — `checkForUpdates()`, `downloadAndInstall()`, `prepareGuiUpdate()`, `launchUpdater()`
- [x] `UpdatePanel.tsx` — 7 状态机: idle/checking/available/downloading/needsRestart/upToDate/error
- [x] 组件 checkbox 列表 + 大小显示 + post_install hook ⚡ 提示
- [x] `Toolbar.tsx` — 下载按钮 + `openUpdateFloat()` (模式同 `openSettingsFloat`)
- [x] `panelDefs.tsx` — 注册 `update` 面板 (userManaged: false)
- [x] `icons.tsx` — 添加 `update` (Download icon)
- [x] `App.tsx` — 启动后 5s 后台静默检查 + StatusBar 提示
- [x] i18n — `zh.ts` + `en.ts` 完整翻译 (30+ keys)

### T5. Memory MCP — 轻量化改造 + 云部署

**What to build:** 去 PyTorch/sentence-transformers/numpy，搜索退化为关键词+标签，标签归一化改 LLM 驱动。部署到 123.56.66.84。

**Blocked by:** None

- [x] `embeddings.py` — 纯 Python cosine similarity，无本地模型 (loaded=False)
- [x] `search_engine.py` — 无语义搜索时 text 60% + importance 30% + tag 10%
- [x] `store.py` — 去 numpy，embedding 列可选，`_pack_embedding` 纯 struct
- [x] `normalize.py` — 去 embedding 聚类，改为 `apply_tag_mapping(mapping={...})`
- [x] `server.py` — embedder 可选 (None-safe)，startup 不强制加载模型
- [x] `api.py` — embedder 可选，`/api/tags/normalize` 接受 mapping 参数
- [x] `requirements.txt` — 去掉 `sentence-transformers` / `numpy`，pin `mcp==1.28.1`
- [x] `Dockerfile` — 去 PyTorch wheel / model/，镜像 1.8GB → 248MB
- [x] Docker Compose — bind mount `/data/memory:/data`
- [x] 部署到 123.56.66.84 (MCP 8080, API 40021) 并验证

### T6. Memory — 多关键词分词搜索

**What to build:** `search_by_text` 从整串 LIKE 改为分词 OR + 匹配数排名。

**Blocked by:** T5

- [x] `store.py:search_by_text` — 中文/英文分词，单 token LIKE，标题命中 +10/内容 +5，按 keyword_score DESC 排序
- [x] 部署到云端并验证 "git commit MR auto-deploy" 等长查询

## Pending: 更新系统后续 (2026-07-30)

### T7. Release — 发布流程标准化

**What to build:** 标准化的版本发布上传流程（手动触发，不需要脚本自动化）。

**Blocked by:** T1, T3

- [ ] 确定版本号规则 (YYYY.MM.DD 或 YYYY.MM.DD.N)
- [ ] 从 dist/ 收集 7 个组件 → 计算 hash/timestamp → 生成 `manifest.json`
- [ ] 创建各组件 zip (单 exe 的单独打包，目录的整体压缩)
- [ ] 编写 `post_install` hooks (如有数据库迁移/环境变量修改)
- [ ] `POST /api/updates/{version}/upload` 上传 manifest + 组件 zips
- [ ] `Update.exe` 随版本一起分发 (复制到 dist/ 根目录)

### T8. Error Reporter — 更新错误上报

**What to build:** 更新过程中的错误上报到现有 feedback API，附带 update version + component name + error message。

**Blocked by:** T4

- [ ] Rust `download_and_install_component` — 失败时 `POST /api/feedback` 自动上报
- [ ] UpdatePanel — 下载失败后显示 "报告问题" 按钮
- [ ] Update.exe — 失败时写 `claude-update-error.log` + 下次启动时检测并上报
- [ ] release-platform — feedback 列表增加 `source: "update"` 过滤

---

## Done: 服务器选择 UI 增强 — 用途说明 + 连接检测 (2026-07-31)

### T9. WelcomeWizard StepServer — 服务用途说明

- [x] 新增 `wizard.serverUsedFor` 提示条：明确服务器只用于自动更新、在线技能库、问题反馈
- [x] 更新 `wizard.serverDesc` 中英文描述，点明三项服务用途
- [x] `skills.registryUrl` → "服务地址"，`registryUrlDesc` 同步说明三项用途

### T10. WelcomeWizard StepServer — 异步连接可用性测试

- [x] `testServerConnection(baseUrl, 3000)` — fetch `/api/packages` + AbortController 3s 超时
- [x] `StepServer` 组件挂载时并行检测两个服务器，状态流转: idle → testing → available/unavailable
- [x] 每个服务器卡片显示实时状态文字（检测中... / 已连接 / 不可达），颜色绿/红/灰区分
- [x] 连接失败不影响选择，用户仍可选中不可达的服务器

### T11. 回退 URL 修正 — cloud → 96

- [x] `SettingsPanel.tsx` — `skillRegistryUrl` fallback `123.56.66.84` → `192.168.186.96`
- [x] `FeedbackDialog.tsx` — admin URL fallback 同上

**Modified Files**: `WelcomeWizard.tsx`, `zh.ts`, `en.ts`, `SettingsPanel.tsx`, `FeedbackDialog.tsx`

---

## Done: Office COM Bridge 审查 + 修复 (2026-07-31)

### T12. Bridge 死代码清理 + Bug 修复

- [x] `bridge.py` — 1326→243 行，删除 40+ 未使用的 Excel/Word/PPT 辅助函数，METHODS dict 只保留 `get_context` + `execute_code`
- [x] 删除死代码：`safe_call`、`make_range_str`、stderr no-op
- [x] `word_find_replace` — 加 `find.Wrap = 0`（wdFindStop）防替换死循环
- [x] `word_document_new` — 返回文档名（对齐 `excel_workbook_new`）
- [x] `ppt_write_text` / `ppt_format_shape` — 加 ActiveWindow null guard

### T13. TS 编译错误 + 功能补全

- [x] `OfficeGetContext` / `OfficeExecuteCom` — 补 `maxResultSizeChars`（10k/50k）+ `renderToolUseMessage`
- [x] `OfficeExecuteCom.prompt()` — 从 `''` 改为 `comPrompt`（AI 调用 ExecuteCom 也能看到 bridge 指南）
- [x] `ensureProc` — pythonPath → python → python3 fallback，全失败抛清晰错误
- [x] 两个 tool schema — 加 `pythonPath?: string` 可选参数
- [x] Bridge 重启检测 — 返回结果注入 `_bridgeRestarted` 标记，提示 AI 重新 GetContext

### T14. 文档 + 安装器更新

- [x] `office-bridge.md` — 加 pythonPath 参数说明 + Bridge 重启注意事项
- [x] `setup.iss` — `InjectOfficeBridge` 从 addpath if 块内移出，不选 PATH 也能注入
- [x] `comPrompt` — 删硬编码 Python 路径（AI 从 CLAUDE.md 上下文推断）

**Modified Files**: `bridge.py`, `office-com-tools-backend.ts`, `office-bridge.md`, `setup.iss`



---

## Done: 构建系统 + 更新清单 + 安装器增强 (2026-07-31)

### T15. Build — 解压修复 + codegraph 清理

- [x] Python/Git zip 解压：`Expand-Archive` → .NET `ZipFile::ExtractToDirectory`（大文件 OOM 修复）
- [x] 移除 `codegraph-cleanup.cmd/.ts`（个人用脚本，不进 dist）
- [x] 移除 `extensions/general_ui/`（已有完整 GUI 项目）
- [x] 清理：`claude.cmd.bak`、`personal-setup/SETUP.md`
- [x] `.gitignore` 加 `__pycache__/`

### T16. Build — 更新清单生成

- [x] `--release <version>` flag：控制是否生成 manifest + 组件 zip
- [x] 7 组件清单：gui/claude/bun（完整 SHA256）+ tools/python/git/extensions（元数据 SHA256）
- [x] 元数据 hash：`(相对路径:文件大小)`排序后 SHA256，仅 stat 不读内容（快）
- [x] 输出到 `dist/release/<version>/` + `dist/manifest.json`（installer 引用）

### T17. Rust update.rs — 目录组件 SHA256 对齐

- [x] `ComponentInfo::Dir` 从 `updated_at` 改 `sha256`（与 Exe 统一）
- [x] 新增 `compute_dir_metadata_hash()`（与 build.ts 同算法）
- [x] 删除 `get_dir_latest_mtime` / `dir_needs_update` / `parse_iso8601_for_cmp`
- [x] 内容不变 hash 不变，不再误触发更新

### T18. Installer — manifest 安装 + 翻译修复

- [x] `[Files]` 加 `manifest.json` → `{app}\manifest.json`（updater 读本地版本）
- [x] `FileCopy` → `CopyFile`（过时 API）
- [x] `ChineseSimplified.isl` 补 5 个缺失消息

**Modified Files**: `build.ts`, `update.rs`, `build.ps1`, `setup.iss`, `ChineseSimplified.isl`, `.gitignore`

---

### T1. Super Desktop — 新增 Table 可编辑表格 Block

**What to build:** 第 9 种桌面 block 类型，轻量级可编辑表格（纯 React，无第三方依赖）。

**Blocked by:** None

- [x] `types/desktop.ts` — 新增 `TableColumn`, `TableRow`, `TableContent` 类型，`ItemContentType` + `"table"`
- [x] `TableItem.tsx` — 新组件：点击单元格编辑，Tab/Enter/方向键导航，双击列头改名，± 按钮增删行/列，每行 × 按钮删除
- [x] `DesktopItemView.tsx` / `DesktopItemViewer.tsx` — import + `case "table"`
- [x] `CanvasToolbar.tsx` — `addTable()` + `"+ 表格"` 按钮
- [x] `mcpBridge.ts` — `desktop_create_item` type enum + `"table"`，content type auto-inject，description 加表格文档
- [x] i18n — `desktop.table` + `canvas.addTable` 中英文
- [x] Docs — `gui-agent-guide.md` 9 block types，表格内容参考 + MCP 示例；`ARCHITECTURE.md` 类型表加 Table 行

### T2. 权限模式持久化修复 — 重启后不再回到默认

**What to build:** 修复工具栏权限模式选择后重启丢失、回到 "默认" 的 bug。

**Blocked by:** None

- [x] 根因：后端每次启动广播 `permission_mode_changed: "default"`，handler 无条件写磁盘覆盖用户选择
- [x] `permission_mode_changed` handler → 移除 `updateSettings` + `save_permission_mode`，仅更新 chatState
- [x] Toolbar `SET_PERMISSION_MODE` command → 立即 persist（chatState + settings + Rust disk），再 send 到后端
- [x] WS `onopen` → 同步读 `getSettings().permissionMode`，非 default 时 send 到后端并更新 chatState
- [x] 不需要再异步 `invoke("get_app_settings")`，直接用 TS 内存中的 settings

### T3. 主窗口尺寸持久化

**What to build:** 主窗口 resize 后尺寸保存到磁盘，重启时自动恢复。

**Blocked by:** None

- [x] TS `AppSettings` — 新增 `windowWidth?: number`, `windowHeight?: number`
- [x] Rust `AppSettings` — 新增 `window_width: Option<f64>`, `window_height: Option<f64>`（serde rename + default）
- [x] Rust `save_window_size` command — 写入 `AppSettings` + 持久化到磁盘
- [x] `App.tsx` — 启动时 `useEffect` 读取保存尺寸 → `getCurrentWindow().setSize(new LogicalSize(w, h))`
- [x] `App.tsx` — resize 事件监听 + 500ms 防抖 → `save_window_size` Rust command（避免走完整 `saveSettings` 往返）

### T4. desktop-item Ref 导航修复 — 短 ID 匹配 + 选中状态 + 类型图标

**What to build:** 修复 AI 生成的 `@ref{desktop-item:table/73c131d7}` 点击无法定位/选中目标 block 的问题。

**Blocked by:** None

- [x] `panToItem` — UUID 前缀匹配 `i.id.startsWith(itemId)`，返回 `string | null`（解析后的完整 ID）
- [x] `panToItem` — 内置 `setSelection(new Set([item.id]))`，所有调用者自动获得选中行为
- [x] `DESKTOP_ITEM_SELECTED` handler — 简化为 `panToItem` + `setHighlightedItemId`
- [x] `ReferenceLink.tsx` — `desktop-item:contentType/uuid` 按 content type 显示不同 emoji（📝📊📈🧩🎨📋🔗🖼️📦📌）

## Active: System Reminder 注入 — 中文思考 + GUI 环境上下文 (2026-07-29)

通过 `<system-reminder>` 机制向 AI 注入环境信息和行为指令。详见 `docs/system-reminder.md`。

**涉及文档**（已创建）:
- `docs/system-reminder.md` — system-reminder 机制全解（40+ 类型）
- `docs/ref-system.md` — @ref 引用系统语法与使用指南
- `docs/gui-agent-guide.md` — AI 在 GUI 中的操作手册

**注入内容设计**:

强制中文思考（toggle 开启后每轮注入，全英文提示词避免上下文语言混乱）:
```xml
<system-reminder>
When reasoning and thinking internally, you MUST use Chinese (中文).
All internal analysis, logic, and planning must be in Chinese.
This does NOT affect the language used when responding to the user.
</system-reminder>
```

GUI 环境上下文（检测到 GUI 模式后注入一次，短摘要 + 按需读文档）:
```xml
<system-reminder>
You are running inside the Claude Code GUI desktop client (Tauri 2 + React).
The user interacts via a graphical interface with multiple panels — not a terminal.

When you see @ref{...} syntax in user messages, these are reference links pointing
to resources in the GUI. Read docs/ref-system.md to understand how to parse and
act on them — you can read referenced files, inspect desktop items, or navigate
to panels as needed.

You may also emit @ref{...} links in responses. The GUI renders them as clickable
chips, letting the user quickly open files, switch panels, or focus desktop items.

Key panels: file browser, code editor (Monaco), terminal (xterm.js),
Super Desktop canvas (8 block types, MCP tools), skills, plans, sessions.

For environment details and MCP tool reference: read docs/gui-agent-guide.md
</system-reminder>
```

- [ ] **T1. GUI — 设置面板 + 持久化** — SettingsPanel Chat 分类加 `强制中文思考` toggle（Label + FieldHint 描述）；`settingsStore.ts` / `zh.ts` / `en.ts` 加 `forceChineseThinking: boolean` 字段 + label + desc；`Rust lib.rs` AppSettings 加 `force_chinese_thinking: bool`（`#[serde(default)]`）
- [ ] **T2. 后端 — `force_chinese` attachment + 注入** — `src/utils/messages.ts` 新增 `force_chinese` attachment type；当检测到 GUI + 设置开启时，在用户消息后注入 system-reminder；参考现有 `todo_reminder` 等 case 的实现模式
- [ ] **T3. 后端 — `gui_context` attachment + 注入** — `src/utils/messages.ts` 新增 `gui_context` attachment type；检测到 GUI 模式（`isIDE`）时注入一次 GUI 环境上下文；内容引用文档路径（`docs/ref-system.md`, `docs/gui-agent-guide.md`）
- [ ] **T4. 后端 — GUI 检测 + 设置读取** — 确保 `ideMode.ts` 能正确检测 GUI 模式并触发 T2/T3 的 attachment 注入；设置项通过现有 WS/IDE 通信链路传递到后端

## Done: 编辑器 — 文件删除后 Tab 状态处理 (2026-07-29)

- [x] **T1. `editorStore` — 新增 `deleted` 字段 + `markDeleted()`** — `f3f69b9`
- [x] **T2. `FileTree` — 删除后 emit `FILE_CHANGED`** — `f3f69b9`
- [x] **T3. `EditorPanel` — 已删除文件视觉标记** — `f3f69b9`

## Done: FileTree 删除二次确认 (2026-07-29)

- [x] **ConfirmOverlay 组件** — 替换 `window.confirm()`，React 风格浮层确认对话框 — `f3f69b9`
- [x] **i18n** — `files.deleteConfirm` 中英文 — `f3f69b9`

## Active: 双轴 Review 修复 (2026-07-28)

Code Review 发现的缺陷修复，详见 `.scratch/code-review-2026-07-28/` (无，直接在 tickets 跟踪)。

- [x] **Rust unwrap 消除** — 4 处 `.lock().unwrap()` 改为 match/if-let 处理 poisoned mutex，1 处在 Exit handler 保留
- [x] **iconForPanel 重写** — 硬编码映射 → `getPanel()?.icon ?? Icons.default`，一劳永逸消除映射错误和缺失面板
- [x] **refreshIcons 浮窗覆盖** — `restoreLayout()` 中对 `floatingPanels` + `tauriWindows` 也调 `refreshIcons()`
- [x] **ARCHITECTURE.md 同步** — 补全 Rust 命令表（+12 个新命令）+ 修正 `ExplorerPanel.tsx` → `FileBrowserPanel.tsx` + 修复第 86 行格式错乱
- [x] **registerPanel 加 warn** — `panelRegistry.ts` 重复注册时 `console.warn` 提示
- [x] **XSS dangerouslySetInnerHTML** — 📝 已记录，暂不处理 (WebView2 禁脚本 + AI 输出来源可信)

---

## Done (2026-07-27): 工具栏增强 + 面板自动隐藏 + 技能翻译

- [x] **工具栏 Git 分支** — `get_git_branch` Rust 命令，读取 `.git/HEAD`，显示 `⎇ branch`，非 git 仓库隐藏
- [x] **工具栏会话名** — 显示当前 session title，切换会话实时更新
- [x] **工具栏硬刷新** — `window.location.reload()`，一键重载 GUI
- [x] **面板图标整理** — Skills/Sessions 不再共用 History，6 个 Box 默认图标替换为独立图标（Sparkles/LayoutDashboard/HelpCircle/Monitor/UserCog/Folder），`refreshIcons()` 启动时从 panelRegistry 刷新持久化布局的过期图标
- [x] **面板自动隐藏** — `removeTab()` 后若 group 为空且非 `editor-area`，自动 `hideGroup()`，侧边栏/底部栏关闭最后一个面板自动收起
- [x] **技能翻译** — SkillsPanel "翻译"按钮 → `run_cli_print` Rust 命令通过 stdin 跑 CLI headless → 解析 JSON → 保存 `.claude/skills-i18n.json` → 下次自动加载
- [x] **技能翻译细节** — 不生成 session（`CLAUDE_CODE_SKIP_PROMPT_HISTORY=true`）、括号计数法提取 JSON、错误位置提示、命令名/中文标题双行显示、已有翻译显示"重新翻译"

---

## Done (2026-07-27): Profile 管理向导 — GUI 创建/切换/删除/默认 Profile

- [x] **ProfileDialog 组件** — 列表页 + 新建向导（预置 DeepSeek/Qwen + 自定义）+ 删除确认
- [x] **Rust 命令** — `create_profile`（写 .env 文件 + COMMON_DEFAULTS）、`delete_profile`（删文件）、`set_default_profile`（写 settings.json env 段）
- [x] **Toolbar 按钮** — User 图标，点击打开浮动窗口（460×400），再次点击置顶
- [x] **预置模板** — DeepSeek v4 Pro/Flash、Qwen 3.6 Plus，只需填 API Key
- [x] **自定义 Profile** — 手动填写 Profile 名、Base URL、Model、Token
- [x] **设为默认** — 写用户级 `~/.claude/settings.json`，跨工作区生效
- [x] **MCP Bridge 启动修复** — `startMcpBridge()` 移到 App.tsx 工作区启动时调用，不再依赖 Super Desktop 面板

---

## Done (2026-07-27): Settings Panel 重构 — 分类导航 + 新设置项 + 智能保存

- [x] **SettingsPanel 分类布局** — 左侧导航（基础/文件管理/终端/编辑器/聊天/超级桌面）+ 右侧表单，蓝色高亮当前
- [x] **现有设置迁移** — 语言/工作目录→基础，隐藏文件→文件管理，终端上限→终端
- [x] **智能保存** — 仅 `workDir` 变更重启后端，其余 `saveSettings()` 即时生效
- [x] **编辑器设置** — 字体大小 (10–24)、Tab 宽度 (2/4/8)、自动换行 toggle → MonacoEditor 实时消费
- [x] **聊天 Enter 行为** — send (Enter 发送 Shift+Enter 换行) / newline (Enter 换行 Ctrl+Enter 发送)
- [x] **文件排序** — 按名称/类型，目录优先，FileTree 排序消费
- [x] **终端字体大小** — xterm.js 创建时读取
- [x] **Rust AppSettings** — 6 个新 Option 字段 + Default impl，存量配置兼容
- [x] **i18n** — 中英文 18 个新 key

---

## Done (2026-07-24 傍晚): Super Desktop — 连线修复 + 工具栏增强 + 框选

- [x] **连线不可见 bug** — ConnectionOverlay SVG 在 transform div 内 + `overflow: hidden` 裁剪。移到外部 + 屏幕坐标转换
- [x] **锚点拖拽优化** — 热区 wrapper 改为独立圆点（`pointerEvents` 不拦截 title bar），拖拽时隐藏锚点
- [x] **工具栏重写** — +Form / Fit(自动适配视口) / Snap(网格对齐) / Clear(两步确认) / Undo↶ / Redo↷
- [x] **操作历史 (undo/redo)** — 全部操作入栈，连续拖拽/缩放合并为一，深度 100，SQLite 持久化跨 session，UUID 不变
- [x] **网格对齐 (snap-to-grid)** — 松手吸附 `gridSize`，新 item 位置也对齐
- [x] **循环依赖修复** — `desktopHistoryStore` ↔ `desktopStore` 解除，函数改为参数传入 `DesktopStateLike`
- [x] **框选 (box-select)** — 空区域拖拽 = 框选 rubber band (AABB 碰撞)，Space/中键 = 平移，Delete 批量删除，右键批量菜单，多选一起拖拽
- [x] **框选 stale closure 修复** — `handleMouseUp` deps 加 `desktop.items`

Spec: `.scratch/workspace-management/issues/`

- [x] 01. Rust + TS `AppSettings` 加 `workspaces` 字段，存量自动迁移
- [x] 02. `WorkspaceSelector` 组件 — 列表/选中/删除/新建/启动
- [x] 03. `App.tsx` 启动流程改造 — 总是先选工作区再启动后端
- [x] 04. `SettingsPanel` 加"切换工作区"按钮

---

## Done (2026-07-21): GUI 文件浏览器 — 基本文件操作

- [x] Rust `create_path` / `delete_path` / `rename_path` 命令（lib.rs）
- [x] `fileService.ts` 新增 `createPath` / `deletePath` / `renamePath` 方法
- [x] `FileTree.tsx` 重写：工具栏（新建文件/文件夹/刷新）、右键菜单（重命名/删除）、内联重命名编辑
- [x] i18n 中英文 keys 补全（`files.*` 9 个）

---

## Done (2026-07-21): GUI 会话管理 — 删除确认 + 批量删除

- [x] 删除确认弹窗（替换 Tauri WebView2 无效的 `confirm()`）
- [x] 批量选择模式：复选框 + sticky 底栏 + 批量删除
- [x] 新建/删除会话后自动刷新列表
- [x] i18n 中英文 keys 补全（`sessions.*` 10 个）

---

## Done (2026-07-21): GUI 启动优化 — 异步后端启动

- [x] `restart_ide_backend` 改为背景线程启动，立即返回（不阻塞 IPC 线程）
- [x] `startInternal` 只轮询端口，不调 `restart_ide_backend`（`.setup()` 已启动）
- [x] 启动时 UI 不卡死

---

## Done (2026-07-21): GUI 布局交互 — 布局编辑模式

- [x] `layoutMode` 全局模块 (`gui/src/stores/layoutMode.ts`)
- [x] `SplitButton` 去掉 hover 交互，仅布局编辑模式下显示
- [x] `Toolbar` 新增 Grid3x3 图标按钮切换布局编辑模式
- [x] `SplitButton` 外层 div `pointerEvents: none` 修复右侧点击拦截问题

---

## Done (2026-07-21): GUI 删除确认 + 批量删除

- [x] SessionPanel 删除确认弹窗（替换 WebView2 无效的 confirm()）
- [x] 批量选择模式：复选框 + sticky 底栏 + 批量删除
- [x] 新建/删除会话后自动刷新列表
- [x] i18n 中英文 keys

---

## Done: 面板可见性重构 — 三态统一 + i18n + 聊天区分割

面板 visibility 三态、国际化中文/英文切换、ChatPanel 拆分为消息区+输入区布局系统上下分割。

---

## Done (2026-07-22): GUI 工具卡片增强

- [x] Session 重载保留 tool_use 块 — `session_loaded` handler 的 `extractContent()` 现提取 `tool_use` 类型 block
- [x] 工具卡片折叠/展开交互统一 — 所有工具 header 统一点击 toggle，`▲`/`▶` 指示器一致
- [x] Write/Edit 工具卡片显示语法高亮 diff — highlight.js 按文件扩展名检测语言，红底-绿底+对比，Write 显示新增内容
- [x] `<system-reminder>` 内容过滤器 — `stripSystemReminder()` 正则去掉系统提示词，应用到消息正文、工具输出、diff 内容

---

## Active: Terminal Panel — Agent 命令输出到终端

**目标**: Agent 执行 Bash/Powershell 等命令时，不只在聊天消息里展示工具卡片，而是实时渲染到底部终端面板（xterm.js），聊天区命令输出默认折叠。

### Ticket 1: useChatBridge 接入 terminalStore

**文件**: `gui/src/components/chat/useChatBridge.ts`（修改）

在 WebSocket 消息处理中，拦截 Bash/Powershell 工具的执行生命周期，写入 terminalStore：

- [ ] `content_block_start`（line 147-163）：当 `content_block.name` 包含 "bash" 或 "powershell" 时调用 `terminalStore.startCommand(toolName)`
- [ ] `content_block_stop`（line 193-199）：此时 tool.input 已完整解析，从中提取 `command` 字段更新 terminalEntry；同时调用 `terminalStore.finishCommand(null)` 标记命令结束（exitCode 待定）
- [ ] `tool_progress`（line 241-256）：`appendOutput(msg.data.fullOutput || msg.data.output)`
- [ ] `user` handler `tool_result`（line 366-384）：匹配到 bash 工具的结果时，尝试从 content 中提取 exit code，调用 `finishCommand(exitCode)`
- [ ] import `{ startCommand, appendOutput, finishCommand }` from terminalStore

**验证**: 在 GUI 中让 agent 执行任意 bash 命令，底部终端面板应实时显示命令 + 输出 + exit code

### Ticket 2: 聊天区工具卡片默认折叠

**文件**: `gui/src/components/chat/MessageItem.tsx`（修改）

终端面板已经展示完整输出，聊天消息里的工具卡片改为简洁模式：

- [ ] Bash/Powershell 工具的卡片默认折叠（不展示命令和输出的 pre 块）
- [ ] 只显示一行摘要：图标 + 工具名 + 命令摘要 + 状态（运行中/完成/错误）
- [ ] 点击可展开查看完整命令和输出（兼容查看历史）
- [ ] 其他工具（Read/Write/Grep 等）保持当前渲染方式不变

**验证**: Agent 执行命令后，聊天区只显示一行精简的工具卡片，终端面板有完整输出

### Ticket 3: 终端面板增强

**文件**: `gui/src/components/TerminalPanel.tsx`（修改）

- [ ] 右上角添加清除按钮（× 或垃圾桶图标），调用 `terminalStore.clear()`
- [ ] 自动滚动到底部（新输出到达时 scrollToBottom）
- [ ] 终端面板 resize 时自动 fit（已有 ResizeObserver，确认工作正常）

**验证**: 清除按钮清空终端；新命令输出自动滚动到底部

---

## Active: GUI Service Bus — 数据协同 + 面板互操作 + 后台管理

Spec: `.scratch/gui-services/PRD.md`

### Ticket 1: EventBus + CommandRegistry 核心

**文件**: `gui/src/services/serviceBus.ts`（新建）

- [ ] `EventBus` 类：`on<T>(event, handler) → unsubscribe`, `emit<T>(event, data)`，支持 sticky（保留最近值，新订阅者立即收到）
- [ ] `CommandRegistry` 类：`register(command, handler) → unsubscribe`, `execute(command, ...args)`，同名命令后者覆盖前者
- [ ] 模块级单例导出：`export const eventBus = new EventBus()`, `export const commands = new CommandRegistry()`
- [ ] `gui/src/services/events.ts`：事件名称常量 + 类型定义
- [ ] `gui/src/services/commands.ts`：命令名称常量 + 参数类型定义

**验证**: 可以在 console 手动 `eventBus.emit(...)` / `commands.execute(...)` 验证

### Ticket 2: React hooks — useEvent / useCommand

**文件**: `gui/src/services/useService.ts`（新建）

- [ ] `useEvent<T>(event)`：订阅事件，返回最近值，事件触发时自动 re-render
- [ ] `useEventHandler<T>(event, handler)`：订阅事件执行副作用，组件卸载时自动取消
- [ ] `useCommand(command, handler)`：组件内注册命令处理函数，卸载时自动注销
- [ ] Sticky 事件：`eventBus.emit("backend.portReady", port, { sticky: true })`，后来订阅者立即收到

**验证**: 在 Toolbar 中试用 `useEvent` 订阅事件，验证 re-render

### Ticket 3: BackendService — 统一 IDE 后端管理

**文件**: `gui/src/services/backendService.ts`（新建）

- [ ] 封装 `get_ide_port` + `restart_ide_backend` Rust IPC 调用
- [ ] 状态机：`stopped → starting → running`（或 error）
- [ ] `start(workDir?)`：启动 IDE 后端（轮询端口，最多 30s）
- [ ] `stop()`：终止后端进程（Rust `restart_ide_backend` 已有 kill 逻辑）
- [ ] `restart(workDir?)`：stop → start
- [ ] 状态变更通过 `eventBus.emit("backend.stateChanged", ...)` 广播
- [ ] 端口就绪时 `eventBus.emit("backend.portReady", { port }, { sticky: true })`
- [ ] `useBackendService()` hook：返回当前状态

**验证**: 替换 `useChatConnection` 功能，`ChatMessagesPanel` + `ChatInputPanel` 改用 `useBackendService`

### Ticket 4: 面板迁移至 Service Bus

**文件**: 现有面板组件（修改）

每轮一个面板，渐进迁移：
- [ ] 4a. **Toolbar**：按钮 onClick 改用 `commands.execute("layout.toggleLeft")` 等
- [ ] 4b. **ChatInputPanel**：注册 `"chat.focusInput"` / `"chat.send"` / `"chat.interrupt"` 命令
- [ ] 4c. **ChatMessagesPanel**：改用 `useBackendService` 获取 port，移除 `useChatConnection`
- [ ] 4d. **SessionPanel**：切会话后 `commands.execute("chat.focusInput")`；发布 `"session.changed"` 事件
- [ ] 4e. **SettingsPanel**：改工作目录后 `commands.execute("backend.restart")`；发布 `"settings.changed"`
- [ ] 4f. **FileBrowserPanel**：注册 `"files.reveal"` 命令（定位文件路径）
- [ ] 4g. **LayoutStore** 集成：注册 `"layout.toggleLeft"` / `"layout.expand"` / `"layout.collapse"` 命令

**验证**: 每轮迁移后功能不退化

### Ticket 5: Worker Panel — 后台进程管理页面

**文件**: `gui/src/components/chat/WorkerPanel.tsx`（新建）

- [ ] 订阅 `eventBus` 显示后端状态（stopped/starting/running/error + port + workDir）
- [ ] 订阅 `chatStore` 显示 agent 任务列表（当前 `TasksPanel` 的增强版）
- [ ] 任务分组：活跃/已完成/失败
- [ ] 操作按钮：终止任务、重启后端
- [ ] 注册到 Activity Bar（左侧栏新增 "Workers" tab）

**验证**: 启动 app 后 Workers 面板显示 "IDE Backend: running · Port 4889"

---

## Backlog: Windows Bash 中文乱码

MSYS2 bash 在 `LANG=zh_CN.UTF-8` 下对原生 Windows 程序（ping.exe 等）的 GBK 输出做有损转码，非 ASCII 字节被替换为 U+FFFD。

**根因**: MSYS2 运行时在 `LANG=zh_CN.UTF-8` 时对 `>` 重定向和 pipe 的输出做 GBK→UTF-8 有损转换。
- 当前 shell 已受影响：在 MSYS2 终端和 GUI 中 ping 均乱码
- VS Code 扩展同样受影响（实测确认）
- 已在 Shell.ts 中用 `LANG=C LC_ALL=C` 修复并通过 `exec()` 验证 ✅
- 该改动在恢复 GUI 文件时被误删

**修复方案**: `src/utils/Shell.ts` spawn env 中加 `LANG='C' LC_ALL='C'`
+ `src/utils/fsOperations.ts` `decodePlatformOutput` 用 FFFD 对比法

## 进度

| Ticket | 状态 | 依赖 |
|--------|------|------|
| T1. useChatBridge 接入 terminalStore | pending | - |
| T2. 聊天区工具卡片默认折叠 | pending | T1 |
| T3. 终端面板增强 | pending | T1 |
| 1. EventBus + CommandRegistry | pending | - |
| 2. React hooks | pending | 1 |
| 3. BackendService | pending | 1, 2 |
| 4. 面板迁移 | pending | 1-3 |
| 5. Worker Panel | pending | 1-4 |

## Done: 面板可见性重构 — 三态统一

**目标**: 消除 `collapsed` 布尔 + `sizes[index]` 双轨状态，合并为 `TabGroup.visibility: "expanded" | "collapsed" | "hidden"`。

**当前问题**:
- `collapsed` 标志和 `sizes[index] <= 0` 各管各的，`hideGroup`/`ensureGroupVisible`/`toggleGroupCollapse`/`toggleGroupVisibility` 四处互相踩脚
- SplitView 里 `isCollapsedActivity()` 同时检查两处，新 bug 容易引入

**设计**:
```
expanded → 正常渲染，占 split 分配的尺寸
collapsed → activity style: 仅 48px 图标栏，空间还给兄弟
hidden → 完全不渲染 (SplitView return null)
```

- [ ] 1. `gui/src/types/layout.ts`: `TabGroup.collapsed?: boolean` → `visibility?: "expanded" | "collapsed" | "hidden"` (默认 `"expanded"`)
- [ ] 2. `gui/src/stores/layoutStore.ts`:
  - 删 `toggleGroupCollapse`, `toggleGroupVisibility`，新增 `cycleGroupVisibility(groupId)` — collapsed→hidden→expanded 循环 (activity 风格); tabs 风格 collapsed⇄expanded
  - `hideGroup`/`ensureGroupVisible` 改为读/写 `visibility`
  - 删 `toggleLeftPanel`/`toggleRightPanel`/`toggleBottomPanel`，改为调用 `cycleGroupVisibility`
- [ ] 3. `gui/src/components/LayoutRenderer.tsx`:
  - `isCollapsedActivity()` → `getVisibility(child)` 返回 `"expanded" | "collapsed" | "hidden"`
  - SplitView: `hidden` → return null; `collapsed` → flex: 0 0 auto (48px)
  - IconBtn onClick: 始终调 `cycleGroupVisibility(groupId)`
- [ ] 4. `gui/src/components/Toolbar.tsx`: `toggleLeftPanel` → `cycleGroupVisibility`

**影响文件**: `types/layout.ts`, `stores/layoutStore.ts`, `components/LayoutRenderer.tsx`, `components/Toolbar.tsx`

---

## Done (2026-07-16): content_hash — Agent 侧变更检测

- [x] `store.py`: schema v2, `content_hash` 列 (SHA256 of title+content)
- [x] INSERT/UPDATE 自动计算 hash，v1→v2 migration + 旧数据回填
- [x] `server.py`: `memory_search`/`memory_get` tool description 提及 `content_hash`
- [x] `docs/agents/memory-mcp.md`: `memory_search` 节加 hash 比对优化
- [x] `skills/recall.md`: 加 "比对 hash 跳过重复读取" 优化提示
- [x] 部署到 96 + 验证 API 返回 `content_hash`

---

## Done (2026-07-16): MCP Transport: SSE → Streamable HTTP

- [x] 诊断 -32602 "Invalid request parameters" 根因: SSE 初始化竞态条件
- [x] 迁移 `server.py` 从 SseServerTransport 到 StreamableHTTPSessionManager (stateless=True)
- [x] 修复 Starlette 路由 307 重定向: Router(redirect_slashes=False) + class 包装 + Route+Mount 双路由
- [x] 更新 `scripts/memory-setup.ts` 远程模式: `type: 'sse'` → `type: 'http'`, URL 示例 `/sse` → `/mcp`
- [x] 更新 `~/.claude/settings.json` MCP config: type=HTTP, url=/mcp
- [x] 部署到 96 服务器 + 验证 initialize 返回 200

---

## Done (2026-07-16): Memory Web UI — 记忆卡片点击白屏

- [x] 诊断: D3 子图 `renderSubGraph` 中 peer node ID 用 `target_id || source_id` 导致 incoming 关联取到当前记忆 ID → D3 把字符串当节点 → 无限重渲染 → 白屏 + 200 errors
- [x] 修复 `MemoryDetail.jsx`: 用 `a.direction === 'incoming' ? a.source_id : a.target_id` 正确识别对端节点
- [x] 修复 `MemoryDetail.jsx`: 过滤边（移除引用不存在节点的边），zero-size guard
- [x] 修复 `d3-graph.js`: `renderSubGraph` 添加 edge-to-node 校验 + try-catch + 补回丢失的 `const link =`
- [x] 部署到 96 服务器 + 验证 0 errors, 详情面板正常渲染

---

## Done (2026-07-16): 编辑表单空白 + 编辑状态泄漏 + 详情面板加宽

- [x] `MemoryDetail.jsx`: `useState` 初始化只跑一次，切记忆后 `form` 和 `editing` 不更新 → `useEffect` 监听 `m?.id` 自动重置
- [x] 编辑状态下点其他记忆 → 自动退出编辑，显示新记忆的阅读模式
- [x] 详情面板宽度 380px → 600px

---

## Done (2026-07-16): 侧边栏筛选器无法清空

- [x] 标签点击改为 toggle（再点取消）
- [x] 搜索框加 ✕ 清空按钮
- [x] 任意筛选激活时显示"清除全部筛选"按钮
- [x] 激活的标签高亮（accent 背景）

---

## Done (2026-07-16): Memory Web UI — Code Review 修复

Code review 对比设计原型 `memory-explorer.html` 发现的偏离项。PRD: `.scratch/memory-web-redesign/PRD.md`

- [x] i18n: 12 处硬编码中文迁入 locale + 补充缺失 key
- [x] 颜色系统: 9 处硬编码色 → CSS 变量 + D3 主题适配
- [x] Markdown 渲染 + content refs 展示
- [x] 详情面板 D3 子图
- [x] 关联编辑 + Scope global bug + 排序清理

---

## Done (2026-07-16): 搜索匹配优化 — 文本搜索 + 综合相关度 + 图谱筛选高亮

- [x] `store.py`: 新增 `search_by_text()` LIKE 文本搜索
- [x] `search_engine.py`: hybrid 评分公式加入文本匹配 (30%)，输出 `relevance` 替代 `_score`
- [x] `MemoryList.jsx`: 展示综合相关度百分比
- [x] `api.py`: `/api/graph` 支持 filters，返回 `highlighted_ids`
- [x] `GraphView.jsx`: 读取 filters 并传递给 D3
- [x] `d3-graph.js`: `renderGraph` 支持 highlightedIds，非匹配节点 dim (opacity 0.15)
- [x] 部署 96 + 验证

---

## Done (2026-07-16): memory_update MCP tool + remember skill 优化

- [x] `server.py`: 新增 `memory_update` tool (id + title/content/type/scope/tags/importance)
- [x] `/remember` skill: 多角度搜索 → 三桶分类 (MERGE/ASSOCIATION/CREATE) → 主动关联
- [x] `/recall` skill: 强调先搜再干 + 记忆作为参考而非教条
- [x] `docs/agents/memory-mcp.md`: 补充 memory_update 文档
- [x] 部署 96 + 安装本地 skills

---

## Done (2026-07-16): 官方 2.1.211 逆向分析 + ReportFindings 实现

- [x] 下载官方 claude.exe 2.1.211 (241.6 MB)
- [x] 重建 `temp/proxy_stream.py` 代理脚本 (含 auth-to-DeepSeek 转发)
- [x] 修复 `.claude/settings.local.json` 覆盖问题 → 成功拦截 API 请求
- [x] 提取系统提示词 (6.9K)、26 tools、agent 类型 (6)、system reminders (24K)
- [x] 对比分析: Workflow (不可实施)、ScheduleWakeup (依赖 /loop→AGENT_TRIGGERS)、ReportFindings (可实施)
- [x] 实现 `src/tools/ReportFindingsTool/` (constants + prompt + tool + UI)
- [x] 注册到 `src/tools.ts` + `src/constants/tools.ts`
- [x] 更新 `docs/official-version-analysis.md`
- [x] 捕获子 agent (claude) 系统提示词 — 4.1K, 15 tools, `cc_is_subagent=true`
- [x] `claudeAgent.ts`: prompt 对齐 2.1.211 (身份行、classifier、agent 消息安全、emoji 禁止等 6 处)
- [x] `claudeAgent.ts`: 工具集限制 — `disallowedTools` 排除 Cron×3 + Task×4 + TodoWrite (共 8 个)

---

## Done (2026-07-16): Agent prompt 统一对齐 2.1.211

官方 2.1.211 的所有子 agent 末尾统一追加了三块内容（我们只对齐了 claudeAgent）：

- [x] 抽取共享 `shared.ts` — AGENT_IDENTITY + AGENT_MESSAGES_DISCLAIMER + AGENT_NOTES
- [x] `generalPurposeAgent.ts`: 对齐 + 加反委托规则
- [x] `exploreAgent.ts`: 加共享 suffix（base 已更优，不覆盖）
- [x] `planAgent.ts`: 加共享 suffix
- [x] `claudeCodeGuideAgent.ts`: 加共享 suffix

## Done (2026-07-16): 新增 code-simplifier built-in agent

官方有 code-simplifier agent（15 tools，4.3K prompt）但我们没有。现有 `/simplify` 是 skill，不是 built-in agent。

- [x] 创建 `src/tools/AgentTool/built-in/codeSimplifierAgent.ts`
- [x] 注册到 `builtInAgents.ts`
- [x] 对齐: 共享 suffix

---

## Done (2026-07-17): Git 打包增强 — 完整 Git Bash + Git 仓库操作

用户反馈安装后的 Git "太残了" — `git fetch/push/pull` 全部报错，缺少 `libexec/git-core/`。

- [x] `build.ts`: Git 打包大升级
  - 新增 `mingw64/libexec/git-core/` 复制 (72 files, 排除 Avalonia/.NET GUI 肥肉)
  - `mingw64/bin` 扩充: git-upload-pack, git-receive-pack, git-lfs, curl, git-credential-manager 等
  - `usr/bin` 从 62 → 137 工具: ssh/scp/sftp/openssl/less/perl + 全部 msys-*.dll
  - 文件逐行容错复制，跳过锁定的 GCM 文件
- [x] `setup.iss`: 组件拆分
  - `gitbash`: Git Bash 环境 — shell + Unix 命令行工具
  - `git`: Git 仓库操作 — git push/pull/fetch 等
  - PATH 逻辑更新: gitbash → usr/bin + bin; git → mingw64/bin
- [x] dist/git: 52 MB → 185 MB, 功能完整

---

## Done (2026-07-17): CLAUDE_CODE_GIT_BASH_PATH → 系统环境变量

用户环境变量 VS Code 读不到。

- [x] `setup.iss`: `HKCU\Environment` → `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
- [x] 新增 `SystemEnvKey` 常量

---

## Done (2026-07-17): Office COM Bridge — AI 使用指南 + 安装注入

有的大模型不会用 Office COM 桥。

- [x] `extensions/office/office-bridge.md`: 134 行 AI 操作指南
  - 两工具说明 (OfficeGetContext / OfficeExecuteCom)
  - 预定义变量表 (xl, wd, ppt, apps, Dispatch, RGB, result)
  - Excel/Word/PPT 常用操作速查 (各 5-6 个场景)
  - 使用流程: 先 GetContext → 再 ExecuteCom
- [x] `bin/inject-office-bridge.cmd`: 独立安装脚本
  - 复制 office-bridge.md 到 `~/.claude/`
  - 注入 `@office-bridge.md` 到 CLAUDE.md (防重复)
- [x] `build.ts`: 加 `inject-office-bridge.cmd` 到 dist/bin 复制列表
- [x] `setup.iss`: 新增 `InjectOfficeBridge` 过程，安装时自动注入

---

# Tickets: MCP 服务器注册 — Claude Code 调用 Super Desktop 工具

将 Super Desktop 的 MCP 服务器注册到 Claude Code，让 agent 可以通过 MCP 协议读写桌面上的 items。

3 个 ticket，按依赖顺序。Work the frontier: 01 和 02 独立可并行，03 依赖 02。

## 01. Fix mcpBridge extractToolName — 处理 tools/call 分发

**What to build:** 修复 `gui/src/services/mcpBridge.ts` 的 `extractToolName` 函数，使其正确处理 MCP 协议标准 `tools/call` method。当前只处理 `tools/list` 和 `initialize`，其余返回空字符串导致所有工具调用失败 "Unknown tool"。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `tools/call` method 从 `params.name` 提取工具名并正确分发
- [ ] `tools/list` 和 `initialize` 行为不变
- [ ] Agent 可通过 MCP 调用任意已注册工具（如 `desktop_summary`）

## 02. MCP 服务器固定端口

**What to build:** 将 `gui/src-tauri/src/mcp.rs` 的 `TcpListener::bind("127.0.0.1:0")` 改为固定端口 `127.0.0.1:13920`，使 Claude Code 的 `.mcp.json` 能指向已知地址。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `start_mcp_server` 监听固定端口 13920
- [ ] 端口不可用时给出清晰错误提示（而非静默失败）
- [ ] `get_mcp_port` 命令仍能正常返回端口号

## 03. 创建 .mcp.json 注册 Super Desktop MCP

**What to build:** 在项目根目录创建 `.mcp.json`，注册 `super-desktop` MCP 服务器，type 为 `http`，URL 指向固定端口。Claude Code 启动时自动发现并连接。

**Blocked by:** 02 (需要固定端口才能写 URL)

**Status:** ready-for-agent

- [ ] `.mcp.json` 包含 `super-desktop` 服务器配置
- [ ] URL 正确指向 `http://127.0.0.1:13920/mcp`
- [ ] Agent 在工具列表中能看到 16 个 `desktop_*` 工具

---

# Tickets: DataBus — 多窗口统一数据总线

Spec: `.scratch/databus-architecture/PRD.md`

7 个 ticket，按依赖顺序。Work the frontier: 01 无阻塞可立即开始。

## 01. DataBus 核心 + Topic 路由 + Stream 通道

**What to build:** 实现统一的 `subscribe`/`publish` API，注册 Topic 树，内部按前缀自动路由到 Stream/State/Bulk/Command 通道。Stream 通道实现 RAF 帧内合并。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `dataBus.subscribe(topic, handler)` + `dataBus.publish(topic, payload)` API
- [ ] Topic 树 + 前缀路由 → 4 通道自动分派
- [ ] Stream 通道：`chat.delta.*` / `terminal.delta.*` RAF 合并，无数据帧不 emit
- [ ] 单窗口内 publish → subscribe 链路通畅（无需 IPC）

## 02. Bridge 桥接 + 初始化握手

**What to build:** Tauri Event 桥接层。Hub→Leaf 广播数据，Leaf→Hub 回传命令。hello→init(snapshots)→ready 握手协议。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] BridgeOut/BridgeIn Tauri Event 收发
- [ ] hello 握手：Leaf 发 `{ windowId, subscriptions }`
- [ ] init 响应：Hub 收集 sticky 快照一次性回推
- [ ] Hub 维护 Leaf 订阅路由表
- [ ] `create_floating_window` URL hash 传 IDE 端口

## 03. Leaf Store 镜像 + ChatMessages 子窗口可用

**What to build:** Leaf ChatStore 改为镜像模式，数据来自 DataBus。WS Adapter 改为 publish 到 DataBus topic。ChatMessages 面板在 Leaf 中渲染真实消息，流式文本实时显示。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Leaf ChatStore 镜像只读
- [ ] Hub WS Adapter 消息处理 → `dataBus.publish()` 
- [ ] WS Adapter 订阅 `cmd.*`，收到后发 WS
- [ ] ChatMessages 在 FloatingApp 注册为真实组件
- [ ] 子窗口：消息显示 + 流式渲染 + token 栏同步 + session 切换同步

## 04. Command 通道 + ChatInput 子窗口可用

**What to build:** `cmd.*` topic 从 Leaf 路由到 Hub WS Adapter。ChatInput 面板在 Leaf 中完全可用。乐观更新：interrupt 和 send。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Command 通道：`cmd.*` Leaf → Hub WS
- [ ] ChatInput 在 FloatingApp 注册为真实组件
- [ ] 子窗口：发送消息 + 打断 + 权限弹窗 + AskQuestionOverlay
- [ ] 打断/发送乐观更新

## 05. Bulk 通道 + Session 历史 & 文件加载

**What to build:** 一次性大负载 topic（session 消息历史、文件内容、plan 历史、子代理对话）。与 Stream 通道并发隔离。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Bulk 通道：并发隔离，不阻塞 Stream
- [ ] `chat.session.loaded` / `editor.fileContent` / `plan.history` / `subagents.transcript`
- [ ] `cmd.plan.history.load` / `cmd.subagent.transcript` 请求→响应链路

## 06. 心跳 + Leaf 生命周期管理

**What to build:** 5 秒 ping/pong，3 次超时清理死 Leaf。Leaf 主动关闭发 goodbye。Leaf 重连重新握手。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 5 秒 ping/pong + 15 秒超时清理
- [ ] goodbye 信号 → 立刻清理
- [ ] Leaf 断线重连 → 重新握手
- [ ] Hub 日志记录窗口生命周期

## 07. 全部面板子窗口化 + CSS 浮动迁移

**What to build:** 剩余全部面板在 Leaf 可用。CSS 浮动面板（AskQuestion/SkillDialog）改为 Tauri 原生窗口。

**Blocked by:** 04, 05, 06

**Status:** ready-for-agent

- [ ] SessionPanel / PlanPanel / TasksPanel / EditorPanel / FileBrowser / TerminalPanel
- [ ] SubAgentPanel / SuperDesktop / SettingsPanel / WorkersPanel / SkillsPanel / SkillDialog
- [ ] AskQuestionFloating → Tauri 原生窗口
- [ ] SkillDialogFloating → Tauri 原生窗口
- [ ] 所有面板 dock 回主窗口正常

## Done (2026-07-27): Quick Prompt Panel — 快捷提示词面板

- [x] **QuickPromptPanel 组件** — 左键点击直接发送，右键菜单（发送/插入到输入框/编辑/删除）
- [x] **Inline 新建/编辑表单** — 面板内展开，title + prompt textarea，无需弹窗
- [x] **数据持久化** — `QuickPrompt` 类型存入 `AppSettings.quickPrompts`，跨会话保留
- [x] **面板注册** — `quick-prompts` panel，左侧边栏，Toolbar Panels 下拉可见
- [x] **i18n** — 中英文 `quickPrompts.*` 13 个 key

---

## Done (2026-07-27): 桌面 Block 弹窗查看 + 代码高亮 + 双向同步 + 文件树增强

- [x] **DesktopItemViewer** — 右键任意 block → "Open in Floating Tab" / "Open in New Window"，7 种 block 类型全支持，窗口 title 携带 itemId 避开 Tauri label 限制
- [x] **TextItem 代码语法高亮** — 统一 Plain/Markdown/24 语言下拉框，highlight.js 渲染，Markdown 内代码块也高亮
- [x] **contentEditable 修复系列**：
  - 点击输入框失焦 → canvas onClick→focus() + DesktopItemView onClick→bringItemToFront 交互元素跳过
  - Space 键被拦截 → 全局 keydown 排除 `isContentEditable`
  - Enter 换行丢失 → 强制 `<br> + \u200B`，extractText 识别 DIV/P 块
  - 双层滚动条 → contentEditable 去掉 overflow:auto
  - 轮询覆盖编辑 → TextItem 改为 ref-based 同步（聚焦时跳过）+ DesktopItemViewer 改为 EventBus 订阅
  - 输入防抖保存 → 600ms debounce + blur 即时保存
- [x] **Desktop DataBus 双向同步** — `notifyDesktopChanged()` 发布到 DataBus，Leaf 编辑回传到 Hub，`syncDesktopsFromBus` 防循环（仅 EventBus 不 DataBus），dataBusLeaf stubs 实现
- [x] **Editor 自动激活** — `activatePanel(panelId)` 查找面板（主树/浮动/窗口），展开隐藏 group + 聚焦 tab，找不到则在默认 group 新建。`editorStore.openFile` 调用覆盖所有入口
- [x] **语言检测扩充** — 80+ 扩展名 → 40+ Monaco 语言，含特殊文件名（Dockerfile/Makefile/.env 等）
- [x] **文件树右键菜单** — 复制绝对/相对路径/文件名、粘贴文件、打开资源管理器、打开终端、发送到超级桌面（子菜单选桌面，文件夹→FileGroupItem 可展开树，文件→RefItem）
- [x] **消息工具栏** — 助手消息气泡底部 Copy / → Desktop 按钮，→ Desktop 弹桌面列表，消息以 Markdown TextItem 发送到画布
- [x] **工具卡片文件路径可点击** — Read/Edit 文件路径渲染为 ClickableFilePath，点击读文件并打开编辑器，路径移到折叠区外始终可见
- [x] **ContextMenu 子菜单** — `ContextMenuItem.children` 支持级联子菜单，hover 右侧展开
- [x] **布局持久化过滤** — `EPHEMERAL_PANELS` 集合排除临时面板（desktop-item-view），serialize/deserialize 均过滤
- [x] **Tauri 新命令** — `open_in_explorer`（Win/Mac/Linux）、`copy_file`（含递归目录复制）

## Done: 启动引导 + 窗口/权限持久化修复 (2026-07-29)

### T1. 权限模式竞态修复

**问题**: 重启后权限模式显示 "default"，尽管 settings.json 里保存的是 "bypassPermissions"。

**根因**: 后端在 WebSocket 连接初始化时广播 `permission_mode_changed: "default"`（`ideMode.ts:3002`），此消息异步到达 GUI 时覆盖了 `onopen` 中刚恢复的保存值。

**修复** (`useChatBridge.ts`):
- `permission_mode_changed` handler 检测竞态：如果后端发来 "default" 但 settings 中保存的是非默认值 → 忽略 default 广播，重新发送保存的模式给后端。

### T2. 窗口尺寸恢复 — 从 JS setSize 迁移到 Rust setup()

**问题**: 重启后窗口尺寸不恢复为保存的 1920x1009。

**根因**: JS `setSize()` 在窗口创建后才执行（先 1200x800 后 resize 到 1920x1009），存在闪烁和时序竞态。

**修复**:
- **Rust** (`lib.rs`): `setup()` 中读取 `windowWidth`/`windowHeight`，在窗口显示前调用 `window.set_size(LogicalSize::new(w, h))`，无闪烁
- **JS** (`App.tsx`): 删除 `_initialSizeRestored` guard 和 `setSize` 恢复逻辑，仅保留 resize 事件监听器（500ms debounce）用于持久化

### T3. 窗口尺寸 null 修复

**问题**: 关闭 GUI 后 `windowWidth`/`windowHeight` 被写成 `null`。

**根因**: 两条持久化路径冲突——`save_window_size`（专用，更新 Rust state）和 `save_app_settings`（通用，从 JS 取全量设置可能含 null）互相覆盖。

**修复**:
- **Rust** (`lib.rs`): `save_app_settings` 改为接收 `State<Mutex<AppSettings>>`，保留 Rust state 中的 `window_width`/`window_height`，即使 JS 发来 null 也不覆盖
- **JS** (`App.tsx`): 首次启动无保存尺寸时立即捕获当前尺寸 + `save_window_size`，确保 JS 内存不为 null

### T4. Settings 面板清理

- 删除 "工作目录" 输入框和浏览按钮（`workDir` 改由 WorkspaceSelector 独占管理）
- 删除 `pickFolder()`、`restartBackend()`、`oldWorkDir` ref 等不再使用的代码
- `handleSave` 简化，移除 workDir 变更检测和重启逻辑

### T5. IDE 后端启动时机修复

**问题**: 后端在 Rust `setup()` 中无条件启动，使用 settings.json 中的旧 `workDir`——用户还没选工作区。

**修复**:
- **Rust** (`lib.rs`): 首次启动（`is_first_launch == true`）时跳过 `setup()` 中的后端预启动
- **JS** (`backendService.ts`): 首次轮询缩短至 3s（原 30s），快速失败后重启后端使用选中工作区

### T6. Welcome Wizard — 首次启动引导

**新增** `WelcomeWizard.tsx` — 6 步向导，替换孤立的 `FirstLaunchWizard.tsx`：

| Step | 内容 |
|------|------|
| 0 | 选择语言（zh/en，立即生效） |
| 1 | 调整字体大小（80%-150% 滑块 + 实时预览） |
| 2 | 配置 AI 模型（跳过/选择已有/创建 DeepSeek 或 Custom） |
| 3 | 强制中文思考（开关 + 实验性警告） |
| 4 | 界面布局介绍（纯 HTML/CSS 三栏示意图） |
| 5 | 配置摘要 + "完成"按钮 |

**关键设计**:
- 配置只在 "完成" 时持久化（`isFirstLaunch: false` 写入 disk），中途关闭不残留
- Wizard overlay 在 `key={langKey}` div 外，切换语言不丢失步骤状态
- 背景为不透明 `var(--bg-root)`，完全遮罩底层主界面
- 新增 `wizard.*` i18n keys ~50 个（zh.ts + en.ts）

### T7. Profile 创建与切换集成

- `StepProfile` 调用 `list_model_profiles` 加载已有配置
- DeepSeek 模式：API Key + 模型复选框 → `create_profile` 批量创建
- Custom 模式：完整自定义（名称/URL/模型/Token）
- `handleWizardComplete` 调用 `switch_model_profile` 激活选中配置

### Modified Files

| File | Change |
|------|--------|
| `gui/src-tauri/src/lib.rs` | 窗口尺寸恢复、`save_app_settings` 保留窗口字段、首次启动跳过后端预启动 |
| `gui/src/App.tsx` | 首次启动分支显示 Wizard、`handleWizardComplete`、窗口尺寸 seed |
| `gui/src/services/backendService.ts` | 首次轮询 3s 超时 |
| `gui/src/components/chat/useChatBridge.ts` | 权限模式竞态修复 |
| `gui/src/components/chat/WelcomeWizard.tsx` | **新增** — 6 步引导向导 |
| `gui/src/components/chat/FirstLaunchWizard.tsx` | **删除** — 孤立的旧向导 |
| `gui/src/components/chat/SettingsPanel.tsx` | 删除 workDir 设置项 + 清理死代码 |
| `gui/src/i18n/zh.ts` | 新增 `wizard.*` ~50 keys |
| `gui/src/i18n/en.ts` | 新增 `wizard.*` ~50 keys |
| `tickets.md` | 本条目 |

---

## Done: 帮助面板 — 首次引导 + 快捷参考 (2026-07-31)

Spec: `.scratch/help-panel/PRD.md`

### T1. HelpPanel 组件 + i18n

- [x] `gui/src/components/chat/HelpPanel.tsx` — 新建：两列自适应网格布局（工具栏 / 面板），每项显示图标+名称+说明
- [x] `gui/src/i18n/zh.ts` — 新增 `help.*` keys（标题 + 工具栏16项 + 面板13项 + 首次提示）
- [x] `gui/src/i18n/en.ts` — 对应的英文翻译

### T2. 面板注册 + Toolbar 按钮

- [x] `gui/src/services/panelDefs.tsx` — 注册 `help` panel（userManaged: false）
- [x] `gui/src/utils/icons.tsx` — 添加 `help` 图标（HelpCircle）
- [x] `gui/src/components/Toolbar.tsx` — 新增 `openHelpFloat()` + `?` 按钮（位置：反馈左边）

### T3. 首次启动自动弹出

- [x] `gui/src/App.tsx` — `handleWorkspaceLaunch` 后 2s 延迟调用 `openHelpFloat()`

---

## Done: 窗口位置 + 最大化持久化 (2026-07-31)

### T4. 窗口位置 + 最大化状态持久化

- [x] Rust `AppSettings` — 新增 `window_x: Option<f64>`, `window_y: Option<f64>`, `window_maximized: bool`
- [x] Rust `save_window_size` → `save_window_state` — 扩展参数 x, y, maximized
- [x] Rust `setup()` — 恢复顺序：最大化时跳过位置/尺寸恢复，非最大化先恢复位置再尺寸
- [x] Rust `save_app_settings` — merge 时保留所有窗口状态字段
- [x] TS `AppSettings` — 新增 `windowX`, `windowY`, `windowMaximized`
- [x] TS `App.tsx` — 启动 seed 位置和最大化状态；persist handler 同时监听 resize + onMoved（500ms 防抖），最大化时不存 x/y

## Done: Edit History — gitCommit 字段 (2026-07-31)

### T5. edit-history.jsonl 加 git commit hash

- [x] `src/utils/editHistory.ts` — 新增 `getGitHeadHash()` 解析 `.git/HEAD`
- [x] JSONL 条目新增 `gitCommit` 字段（HEAD hash 或 null）
- [x] `getEditHistoryPrompt()` — 更新 prompt 描述，新增 reset 场景用法

---

## Bug: `/to-spec` / `/grill-me` 等 skill 命令报 ReferenceError (2026-08-01)

**现象**: TUI 下执行 `/to-spec`、`/grill-me` 等斜杠命令时：

```
ReferenceError: commandName is not defined
```

**影响范围**: 所有从 `~/.claude/skills/` 加载的 skill 命令（`to-spec`、`grill-me`、`to-tickets` 等）

**排查情况**:
- 源码搜索所有 `commandName` 引用，均为正常声明（`const`/`let`/参数）
- `parseSlashCommand()` 返回 `ParsedSlashCommand`，`commandName` 字段正常定义
- `findCommand()` / `hasCommand()` / `getCommand()` 参数签名正确
- `SkillTool.ts` 的 `commandName` 提取逻辑无问题
- 重新 `bun build --compile` 后依然报错，排除二进制过期

**根因** (2026-08-02 定位):
`src/utils/processUserInput/processSlashCommand.tsx:873` — `getMessagesForPromptSlashCommand()` 的参数是 `command`（无 `commandName` 变量），但函数体内 `markSlashLoaded(commandName)` 引用了未声明的 `commandName`。该分支仅在 `command.disableModelInvocation === true` 时执行，因此只有带 `disable-model-invocation: true` 的 skill（to-spec、grill-me、to-tickets 等）触发 ReferenceError。此前源码搜索误导性成功，是因为其他函数（`processSlashCommand` 外层、`SkillTool.ts`）都有正常声明。

**修复**: `markSlashLoaded(commandName)` → `markSlashLoaded(command.name)`（与同文件 line 883/891 一致）。已用 harness 验证：修复前复现 ReferenceError，修复后返回正常 SlashCommandResult；普通 skill（无 disableModelInvocation）不受影响。claude.exe 已重新编译。

**Status:** fixed (2026-08-02)

---

## Spec: IDE 后台会话（Ctrl+B 等效功能）(2026-08-01)

**目标**: GUI 支持类似 TUI Ctrl+B 的后台会话功能：当前 agent 转到后台继续执行，用户可以继续在同 session 里发新消息。

**关键发现**:
- TUI 的 Ctrl+B 功能由 `useSessionBackgrounding` hook + `startBackgroundSession()` 实现（`src/screens/REPL.tsx:2525-2577`）
- IDE 模式 (`ideMode.ts`) 完全没有暴露 background session 接口
- `BG_SESSIONS` 是 `bun:bundle` 的 `feature()` 控制的功能标志，需要确认是否已启用
- `startBackgroundSession()` 依赖完整的 REPL 上下文（messages, systemPrompt, toolUseContext 等），需要评估在 IDE 模式下如何传递

**需要探索的方向**:
1. `BG_SESSIONS` flag 在当前编译是否启用
2. `ideMode.ts` 需要新增什么 WS handler 来接收 background 命令
3. 如何从 IDE 模式调用 `startBackgroundSession()`（参数依赖 REPL state）
4. 前端 UI：工具栏按钮 / 快捷键触发，后台任务状态在 TasksPanel 显示
5. 后台完成后的通知机制（已有 `tasks_updated` WS 消息）

**Status:** pending — spec needed

---

# Tickets: ChatSession 加深 — 聊天域纯 reducer + 薄 runner (候选 1)

来源: `.scratch/chat-reduce/PRD.md`(2026-08-04,状态 ready-for-agent)。把 WS→UI 适配器(useChatBridge, 837 行)加深为纯 `chatReduce` + 薄 `ChatSession` runner,行为零变更,引入 vitest 测试。

Work the **frontier**: 线性链,从上到下。

## T1 — 纯聊天域 reducer 模块 + vitest 基础

**What to build:** `gui/src/chat/` 纯模块(types / chatReduce / sessionMerge / planExtract / effects 类型),加 vitest 基础设施与邻域 store `_reset()`。chatReduce 对全部 wire 场景 fold 出与当前 bridge 语义一致的 `nextState + effects`,由 `chatReduce.test.ts` 覆盖验证——这是本仓库第一批自动化测试。

**Blocked by:** None — can start immediately

**Status:** done (2026-08-04)

- [x] chatReduce 是纯函数(不 import 任何 store/WS),独占 ChatState,返回 `{ nextState, effects[] }`
- [x] sessionMerge 迁移自 useChatBridge 489-552 行合并去重逻辑,语义不变
- [x] planExtract 收敛 TodoWrite 提取(TodoWrite/TaskCreate,流式与非流式)
- [x] `chatReduce.test.ts` 覆盖 ~20 种 wire 场景(message_start/content_block_delta/stop/result/status/tool_progress/assistant/session_loaded/session_list/task_*/permission_mode_changed/file_edit 等)
- [x] terminalStore/planStore/subAgentStore 加 `_reset()`;`bun vitest run` 绿(28 测试)

## T2 — ChatSession runner + facade 换接(行为零变更)

**What to build:** `gui/src/chat/chatSession.ts` runner(WS 生命周期/reconnect 退避/消息队列/send wire 编码/fold 分发/effects 落地/命令注册),`useChatBridge.ts` 变薄 facade。app 照常运行,调用点零改动,plan 提取 ×3 与死代码收敛清理。

**Blocked by:** T1

**Status:** done (2026-08-04)

- [x] chatSession 可实例化并导出 singleton;命令注册(SET_PERMISSION_MODE/SEND_MESSAGE/DESKTOP_QUERY_DATA)初始化一次
- [x] useChatBridge hook 返回形状不变(`sendMessage/respondToPermission/interrupt/compact/listSessions/loadSession/newSession/deleteSession`)
- [x] 10 个裸函数 + `send()` 导出全保留,10 个调用点零改动;dataBusHub 动态 import send 正常
- [x] `tsc` 通过 + vite build 通过(手动 GUI 回归清单留待运行时验证)

## T3 — effects runner 集成测试 + 回归收尾

**What to build:** effects runner 用真实 store(`_reset()` 隔离)做集成测试;重连退避、消息队列、leaf 模式 dataBus fallback 覆盖;回归收尾确认死代码已清。

**Blocked by:** T2

**Status:** done (2026-08-04)

- [x] `effects.test.ts` 绿:terminal.start/append/finish、plan.update/save、subagent.upsert/transcript/clear、emit.fileChanged 落地正确
- [x] 消息队列 flush、leaf 模式 `cmd.*` fallback、resume_session one-shot 有测试覆盖(chatSession.test.ts)
- [x] `bun vitest run` 全绿(43 测试,3 文件);plan 提取 ×3 收敛进 planExtract

---

# Tickets: Panel interface — icon ReactNode→IconKey(候选 6 延后部分)

来源: 2026-08-04 架构自省候选 6 的**延后切片**(安全切片 resolveTabRender + appRef 删除已完成并提交 ce2379a;icon 重构因触及 ~20 个调用点、风险高,单独开票)。报告: `C:\Users\SZH\AppData\Local\Temp\architecture-review-20260804-144657.html` 候选 6 卡片。

## T1 — Panel/tab icon 从 ReactNode 改为可序列化的 IconKey

**What to build:** 让布局持久化不再需要 strip/rebuild ReactNode 图标。`TabInstance.icon`(types/layout.ts:74)目前是 `React.ReactNode`,导致 serializeTab 必须剥掉、deserializeTab/refreshIcons 重建。改为一个可序列化的 icon 键(`IconKey` 字符串,映射到组件),使持久化直通。

**Blocked by:** None — can start immediately

**Status:** done (2026-08-04)

- [x] `TabInstance.icon` 与 `PanelDefinition.icon` 改为 `IconKey`(types/layout.ts 定义字符串联合,utils/icons.tsx 的 `Icons: Record<IconKey, ReactNode>` + `iconFor()`)
- [x] `serializeTab` 直通 icon 键;`deserializeTab` 带 registry 兜底;`refreshIcons` 缩成 `refreshTitles`(删掉 strip/rebuild 舞蹈)
- [x] ~25 个调用点全覆盖:createDefaultTree、setTabIcon、复合组合并(removeChildFromCompound/moveChildBetweenTabs/mergeIntoTab)、createFloatingFromTab/createTauriWindowFromTab、LayoutRenderer/FloatingRenderer/Toolbar/FloatingApp/SuperDesktopCanvas。行为零变更(GROUP_ICON_POOL 键化,profile 浮动 tab 保留 User 图标 → 新增 `user` 键)
- [x] `layoutStore.test.ts` round-trip 测试 ×5(默认树/复合组自定义图标键/复合组浮窗重启存活/ReactNode 对象兜底/无 icon 字段兜底)
- [x] `bunx tsc --noEmit` 干净 + `bun vitest run` 52 全绿

**附带修复(测试暴露的预存 bug):** `deserializeLayout` 的 ephemeral 过滤用 `!getPanel(t.panelId)?.userManaged` — 复合组 tab(`panelId=""`)的 `getPanel("")` 为 undefined → `!undefined`=true → 含复合组的浮窗在重启后永远被丢弃。已改为与 `serializeLayout` 一致的 `=== false` 语义(`isEphemeralTab`)。

**风险提示:** 复合组合并(addTabToFloating/mergeIntoTab/removeChildFromCompound)与拖拽相关 icon 处理最多变,优先在这些路径上做回归。若中途发现拖拽/合并逻辑依赖 icon 身份,暂停并回滚该 hunk,只保留纯替换。

---

# Tickets: 消息列表渲染窗口封顶

来源: 2026-08-05 会话。用户提出长会话消息列表渲染性能问题,现状 `MessageList.tsx` 流式时 `displayCount` 直接跳到整条会话长度(`setDisplayCount(newLen)`),长会话后 DOM 挂着全部消息,每次流式 tick 重渲染整棵列表 → 掉帧/内存涨。方案: 窗口封顶(自动增长封顶,手动展开不封)。T2(工具输出块折叠)延后,另行开票。

Work the **frontier**: any ticket whose blockers are all done.

## T1 — 消息列表只渲染最近 N 条(窗口封顶)

**What to build:** 长会话不再整条渲染。消息列表始终只渲染最新 100 条(`MAX_RENDERED`,DOM 有界)——会话超过上限后,旧消息从渲染窗口顶部滑出,但滚动到顶部或点 "Load earlier" 可分页加载(无 cap,可看全量历史)。流式仍自动跟到最新;手动上滑仍停止自动跟随;用户已手动展开的窗口不被新消息收缩(读旧历史时内容不跳动)。

**Blocked by:** None — 可立即开始

**Status:** done (2026-08-05)

- [x] `messageWindow.ts` 纯函数:`PAGE_SIZE=20` / `MAX_RENDERED=100` / `computeDisplayCount(prev, prevLen, newLen, pageSize, maxRendered)` / `expandDisplayCount(prev, newLen, pageSize)`;MessageList 改为调用
- [x] 自动增长(流式 `newLen === prevLen + 1`)封顶:`min(newLen, max(prev, min(MAX_RENDERED, newLen)))` — 未超上限跟到最新,超上限停在 100,已手动展开的窗口不收缩(读旧历史不跳动)
- [x] 会话加载(`prevLen 0 → newLen > 0`)仍只渲染 `min(PAGE_SIZE, newLen)`,批量变化 clamp 到会话长度
- [x] 手动展开(顶部 `scrollTop < 80` 触发 + "Load earlier" 按钮)不加 cap,每次 +PAGE_SIZE 直到全量
- [x] 流式自动跟随、上滑停止跟随、session 切换重置 三个既有行为保持(逻辑未动,仅 displayCount 计算换纯函数)
- [x] `messageWindow.test.ts` 新增 9 条单测(空/加载/流式超上限/未超上限/手动展开收缩保护/批量 clamp/expand 分页)全绿;`bunx tsc --noEmit` 干净 + `bun vitest run` 62 全绿

---

# Tickets: 消息列表窗口冻结（读旧历史时流式不位移）

来源: 2026-08-05 code-review 发现。T1 封顶合入后,尾部窗口 `slice(-displayCount)` 每次流式 tick 从顶部滑掉一条——长会话(>100 条)用户在流式中上滑读旧历史时,屏幕内容会位移。改 `[start, end)` 窗口模型:底部锚定最新,上滑冻结 start。依赖已合入的 `messageWindow.ts` 纯函数。

Work the **frontier**: any ticket whose blockers are all done.

## T1 — 消息列表上滑读旧历史时冻结窗口

**What to build:** 会话超过渲染窗口上限(100 条)、用户在 assistant 流式时上滑读旧历史,新消息不再把正在看的内容从顶部挤掉。消息列表从尾部计数窗口改为显式 `[start, end)` 窗口:底部时锚定最新(`end = newLen`, `start = max(0, end - MAX_RENDERED)`,流式自动跟随不变);用户上滑(`wasAtBottomRef === false`)后 `start` 冻结——旧消息保持原位,新消息在远端累积,屏幕内容零位移;回到底部(按钮/滚到底)恢复锚定最新。

**Blocked by:** None — 可立即开始(基于已合入的 `messageWindow.ts` 纯函数 + T1 封顶)

**Status:** done (2026-08-05)

- [x] `messageWindow.ts` 新增 `MessageWindow {start,end}` + `bottomWindow` / `expandWindowBackward` / `bottomExtent` 三个纯函数;`MessageList` 改为维护 `[start, end)` 窗口(渲染用 `frozenWin ?? {start: max(0, len-displayCount), end: len}`)
- [x] 底部跟随:`start = max(0, end - displayCount)`(displayCount 仍由 `computeDisplayCount` 封顶),流式自动跟随、上滑停止跟随、session 切换重置 三个既有行为不变
- [x] 上滑(刻意,scrollTop 递减)→ 冻结当前窗口 `{start, end}` 状态;新消息在窗口外累积,屏幕内容零位移
- [x] 回到底部("回到底部"按钮或滚近底部)→ 解除冻结 + `bottomExtent` 重锚最新,冻结解除
- [x] 手动展开(滚到顶 / "Load earlier" 按钮)冻结态走 `expandWindowBackward`(end 不动),底部态走 `expandDisplayCount`,互不破坏
- [x] `messageWindow.test.ts` 新增 7 条(bottomWindow 2 / expandWindowBackward 2 / bottomExtent 3)全绿;`bunx tsc --noEmit` 干净 + `bun vitest run` 70 全绿

**说明:** 冻结时新消息不被渲染(窗口停在冻结时刻的 `end`),回到底部才重新包含——与主流聊天 UI「上滑看历史时尾部隐藏,回底显示最新」一致。冻结窗口内最后一条若在冻结时仍在流式,其内容仍会更新(同引用)。

**审查修复(2026-08-05, code-review 后合并):** `bottomWindow` 改用 `size` 参数并被 `resolveWindow(frozen, len, displayCount)` 组合(渲染/滚动两处调用,消除内联重复);`computeDisplayCount` 流式分支复用 `bottomExtent`;解冻块抽 `unfreeze()`、冻结态展开抽 `expandWindow()`(展开时同步 `displayCount`,冻结期展开的窗口解冻后不再塌回 100);新增 `resolveWindow` 单测直接验证核心声明(冻结时 newLen 增长窗口不动)。vitest 73 全绿。

---

# Tickets: 消息队列（AI 思考中发送 → 排队 → 自动逐条消化）

来源: `.scratch/msg-queue/PRD.md`。前端持有队列,按会话持久化;AI 忙(`streaming`/compacting)时发送入队、空闲自动逐条消化(每条独立回合);打断→暂停、按钮恢复;常驻列表(内部滚动,上方固定最大高度/输入区右侧撑满容器高度),两种布局位置(输入框上方/输入区右侧,设置可配)。原型见 `gui/src/prototypes/MsgQueuePrototype.tsx`(DEV 下 `#proto/msgqueue`,可丢弃)。

Work the **frontier**: any ticket whose blockers are all done.

## T1 — 队列 store: 状态机 + 按会话持久化

**What to build:** 一个前端队列 store,持有按会话分的排队消息与 `auto/paused` 状态机。状态:每会话 `{ messages: [{id,text}], autoSend }`,默认 `auto`。行为:打断→`paused`;按钮恢复 `auto`;队列排空+新消息入队→`auto`;**应用重启→恢复的队列一律 `paused`**(绝不自动发)。持久化按会话存(如 localStorage `msgQueue:{sessionId:[...]}` 或工作区设置文件,须支持突然关闭软件后恢复),重启加载队列但状态为 `paused`。上限 20(默认),超出拒绝入队并提示"队列已满"。

**Blocked by:** None — 可立即开始

**Status:** done (2026-08-11)

- [x] `msgQueueState.ts` 纯状态机 + `msgQueueStore.ts`(每会话 `{messages, autoSend}` / enqueue / drainNext / interrupt / resume / setOrder / removeAt / clear / updateText)
- [x] 状态机:默认 auto;打断→paused;排空+新入队→auto;恢复按钮
- [x] 持久化:localStorage 按会话读写;启动加载队列但一律 `paused`
- [x] 上限 20(可配),满则拒绝 + "队列已满"提示(与无会话区分)

## T2 — 发送路径接线（busy 入队 / 空闲立即发 / 消化 / 立即发送 / 打断联动）

**What to build:** 把队列接进真实发送流。`InputArea`/`sendMessage`:AI 忙(`streaming`)时发送→入队(不发 WS);空闲→立即发。消化:回合结束(`streaming`→false)且 `auto` 且队列非空→自动发下一条(`send("user")`,每条独立回合),内部处理 compacting 结束信号与后端短暂仍 busy 的拒绝重试。单条"立即发送":auto→提到队首;paused→提到队首+恢复 auto。打断(`interrupt`)→队列置 paused,停止自动发;打断后新消息走正常立即发送、队列保持 paused。仅对当前活跃会话消化。

**Blocked by:** T1

**Status:** done (2026-08-11)

- [x] `sendMessage` 分支:busy→enqueue / idle→立即发
- [x] 消化触发:回合结束自动发下一条;busy 拒绝按 error 信号重试(吞错误气泡、不重复入消息流)+ 12s 看门狗
- [x] 立即发送按钮逻辑(auto 提队首 / paused 提队首+恢复 auto,空闲即消化)
- [x] interrupt 联动:置 paused;打断后新消息立即发、队列保持 paused
- [x] 仅活跃会话消化(setActiveSession 随 sessionId 同步)

## T3 — 队列列表 UI 组件（常驻 + 内部滚动 + 行操作）

**What to build:** 常驻队列列表组件(不折叠)。头部:时钟图标 + `N 条排队中` + 自动/暂停切换 + 清空。主体内部滚动,**高度按位置区分**:TOP 固定最大高度(默认 180px),RIGHT 撑满外层容器高度(flex,无固定最大高度)——由组件接受 `pos` 决定。行:序号徽标 + 单行截断预览(悬停 title 显示全文) + 操作(⚡立即发送 / ↑↓ 改序 / ✎编辑 / ✕移除)。空队列→占位提示。编辑走**弹窗**(非内联,展开全文编辑)。改序也支持拖拽(可选)。

**Blocked by:** T1

**Status:** done (2026-08-11)

- [x] 列表组件 + 内部滚动(高度按 pos 区分:top 最大 180 / right flex 撑满)
- [x] 头部(计数 + auto/paused 切换 + 清空)
- [x] 行(序号 + 截断预览 + ⚡↑↓✎✕)
- [x] 编辑弹窗(非内联)
- [x] 空态占位

## T4 — 两种布局位置（上方 / 输入区右侧）+ 位置设置持久化

**What to build:** 队列列表两种布局位置,用户可选,设置持久化。TOP(默认):列表在**聊天输入框上方**(聊天区底部),固定最大高度 180px。RIGHT:列表在**聊天输入区右侧**(~260px 侧栏),**撑满外层布局容器高度**——输入区容器较宽时放在输入框右侧利用横向宽度、省纵向空间。位置切换通过设置项 `msgQueue.position: "top" | "right"` 持久化(复用现有设置保存机制)。

**Blocked by:** T3

**Status:** done (2026-08-11)

- [x] TOP 布局:列表嵌聊天区底部(输入框上方),最大高度 180
- [x] RIGHT 布局:输入区右侧 260px 侧栏(输入框在左、队列在右),列表撑满容器高度
- [x] `msgQueue.position` 设置读写 + 持久化(settings.rs 字段 + merge 测试)

## T5 — 设置项接入 + 上限校验

**What to build:** 把队列相关设置接进设置系统/面板:布局位置(top/left)、队列上限(maxItems,默认 20)。设置变更即时生效并持久化。上限满时入队提示"队列已满"(T1 已处理拒绝逻辑,这里接设置 UI 与读写)。

**Blocked by:** T4

**Status:** done (2026-08-11)

- [x] 设置项读写(`msgQueue.position` / `msgQueue.maxItems`)接入现有设置 store
- [x] 设置面板入口(位置 + 上限, chat 分类)
- [x] 变更即时生效 + 持久化(Rust settings.rs 字段 + merge 测试)

## T6 — 回归测试

**What to build:** 覆盖状态机与消化的纯逻辑测试(接缝在 store 的纯函数 + 发送分流):默认 auto / 打断→paused / 恢复 / 排空+新入队→auto / 重启一律 paused / 上限拒绝 / 消化顺序(逐条串行) / 立即发送分叉(auto 提队首 / paused 提队首+恢复)。UI 组件冒烟(渲染、最大高度滚动、位置切换)。

**Blocked by:** T2, T4

**Status:** done (2026-08-11)

- [x] store 状态机单测(24 条 vitest 全绿)
- [x] 发送分流/消化顺序(chatSession 接线 + code-review 修复重试)
- [x] 立即发送分叉单测
- [x] UI 冒烟(渲染/滚动/位置切换, Playwright dev 验证)

---

# Tickets: 消息列表划词弹出层（选中文本 → 发送到聊天框 / 复制）

来源: 2026-08-11 grill-me 会话。消息列表内选中任意文本(用户/助手/thinking/工具输出/代码块)后,选区旁弹出小工具栏:「发送到聊天框」把选中文本以**可编辑纯文本**插入输入框 composer(复用 `CHAT_INSERT_TEXT` 事件,非 `@ref`,保留编辑性),「复制」复制选区。设置里可开关,默认开启。

Work the **frontier**: any ticket whose blockers are all done.

## T1 — 划词弹出层开关:设置字段贯通

**What to build:** `msgSelectionToolbar: boolean`(默认 `true`=开启)在 TS `AppSettings` + Rust `settings.rs`(struct 字段 + Default + `merge_workspace_overrides` + 回归测试)双端贯通,保存后重启不丢。字段命名沿用 `msgQueuePosition` 先例(TS camelCase / Rust snake_case)。

**Blocked by:** None — 可立即开始

**Status:** done (2026-08-11)

- [x] TS `AppSettings` 新增 `msgSelectionToolbar?: boolean`(默认开启)
- [x] Rust `settings.rs` 新增 `msg_selection_toolbar: Option<bool>` + Default + merge 分支 + 回归测试(Rust 端缺字段会让设置保存后失效,参考 msg-queue 教训)
- [x] `cargo test` 83 绿 + vitest 绿

## T2 — 设置面板「消息划词工具栏」开关

**What to build:** 设置面板聊天分类出现「消息划词工具栏」开关(默认开),切换后即时生效并持久化。i18n zh/en 各两个 key(label + 描述)。

**Blocked by:** T1

**Status:** done (2026-08-11)

- [x] `SettingsPanel.tsx` 聊天分类加开关(复用现有 bool 开关模式,如 `chatEnterBehavior` 同区)
- [x] 读写 `settings.msgSelectionToolbar`,变更持久化
- [x] `zh.ts` / `en.ts` 新增 `settings.msgSelectionToolbar` + `settings.msgSelectionToolbarDesc`

## T3 — 消息列表划词弹出层(发送到聊天框 + 复制)

**What to build:** 消息列表内任意文本选中(`mouseup` 且选区非空)→ 选区末尾弹出小工具栏(贴视口边缘自动夹紧,下方放不下自动翻到上方)。点「发送到聊天框」把选中文本以可编辑纯文本插入 composer(`CHAT_INSERT_TEXT`,光标处插入,非 `@ref`);点「复制」复制选区。点弹层外 / 选区清空 / 消息列表滚动 / Esc / 点完任一按钮 → 消失。设置 `msgSelectionToolbar=false` 时完全不出现。

**Blocked by:** T1(要读开关)

**Status:** done (2026-08-11)

- [x] 纯函数:选区 rect + 视口尺寸 → 弹层位置(夹紧 + 翻转),单测覆盖(5 条)
- [x] `MessageList` 挂 `mouseup`/滚动监听,选区在列表内且非空 → 显示弹层
- [x] 「发送到聊天框」→ `eventBus.emit(CHAT_INSERT_TEXT, { text })`(纯文本)
- [x] 「复制」→ `navigator.clipboard.writeText(选区)`
- [x] 消失条件(点外/清空/滚动/Esc/操作后)全部生效
- [x] 开关关闭时弹层不出现;渲染后实测尺寸校正定位(防字体缩放/i18n 文案导致夹紧失效);`bunx tsc --noEmit` + vitest 168 绿

---

# Tickets: 编辑器 Markdown 渲染预览（md 文件 编辑 ⇄ 预览 切换）

来源: 2026-08-12 grill-me 会话 + `.scratch/editor-md-preview/PRD.md`。`.md/.markdown/.mdx` 文件在编辑区右上角常驻悬浮胶囊(半透明,避开 minimap),一键在「编辑 Monaco 源码 ⇄ 预览渲染」间切换。预览只读,`marked` + hljs 高亮 + `md-body` 样式,与消息区 markdown 视觉一致;视图状态按标签持久化。

Work the **frontier**: any ticket whose blockers are all done.

## T1 — Markdown 渲染引擎（纯函数 + 测试）

**What to build:** `renderMarkdownPreview(content)` 纯函数用 `marked` 解析 + 自定义 code renderer 用 hljs 高亮(失败回退原文转义、空输入安全),返回 HTML 字符串;`isMarkdownFile(filename)` 判定 `.md/.markdown/.mdx`。vitest 覆盖:标题/列表/粗斜体/链接/表格/行内代码 → 对应 HTML;代码块 → hljs 高亮 class(含语言 class);hljs 抛错 → 回退转义不崩溃;空/仅空白输入 → 安全空输出;非 md 文件 → false。

**Blocked by:** None — 可立即开始

**Status:** done (2026-08-12)

- [x] `renderMarkdownPreview` 纯函数(marked + hljs 自定义 code renderer,共享 `utils/highlight.ts`;渲染选项与消息区对齐)
- [x] `isMarkdownFile` 判定 `.md/.markdown/.mdx`
- [x] vitest 单测 12 条(标题/列表/粗斜体/链接/表格/行内代码/代码高亮/转义/hljs 抛错回退/空输入);`bunx tsc --noEmit` 干净

## T2 — 编辑器 md 预览切换（胶囊 + 视图状态 + 渲染接线）

**What to build:** 打开 `.md` 文件后,编辑区右上角出现悬浮胶囊(仅 md 系列显示、常驻半透明 opacity 0.5/hover 1、`right` 偏移 ~100px 避开 minimap、top 8px)。点击在「编辑 Monaco ⇄ 预览渲染」间切换:预览态用 MarkdownPreview 组件(只读,`md-body` class)替代 Monaco,胶囊变「编辑」+ accent 高亮;视图状态按标签持久化(`editorStore.tab.previewMode`,切走再切回保持);外部文件变更 reload 后预览自动更新。

**Blocked by:** T1(要用渲染函数)

**Status:** done (2026-08-12)

- [x] `editorStore` tab 加 `previewMode` + `togglePreviewMode`(按标签持久化)
- [x] `EditorPanel` 内容区 `position: relative` + 右上角悬浮胶囊(仅 md 显示、半透明 opacity 0.5、右偏移 100px 避开 minimap、font-scale 字号)
- [x] `MarkdownPreview` 组件:只用 `renderMarkdownPreview` 渲染 + `md-body` class,只读
- [x] 预览/编辑切换 + 预览态胶囊变「编辑」+ accent 高亮;外部变更后预览重渲染
- [x] `bunx tsc --noEmit` 干净;Playwright 验证(打开 md → 胶囊「预览」半透明 → 点切换 → h1/列表/代码高亮/表格渲染 → 切回 Monaco → 内容变更重渲染 → 按标签持久化;非 md 无胶囊)

---

# Tickets: 会话文件夹 — 按目录组织会话（嵌套树，设置开关）

来源: 2026-08-12 grill-me 会话 + `.scratch/session-folders/PRD.md`。设置里可开启「会话文件夹」(默认关)。开启后会话面板顶部收藏区之下出现可嵌套、可折叠的文件夹树,会话可拖拽/select 批量移入文件夹;文件夹删除只移走会话(上移父级/未归类),绝不删会话。收藏与文件夹独立共存(一个会话可既收藏又在文件夹)。

Work the **frontier**: any ticket whose blockers are all done.

## T1 — 会话文件夹：设置字段贯通

**Status:** done (2026-08-12)

**What to build:** `sessionFolders`(开关, 默认 false) + `sessionFolderTree`(数据: `{ folders: [{id,name,parentId?}], assignments: Record<sessionId,folderId> }`)两个字段在 TS `AppSettings` + Rust `settings.rs`(struct 字段 + Default + merge_workspace_overrides + 回归测试)双端贯通,工作区作用域(同 favoriteSessionIds),保存重启不丢。

**Blocked by:** None — 可立即开始

**Status:** ready-for-agent

- [x] TS `AppSettings` 加 `sessionFolders?: boolean`(默认 false) + `sessionFolderTree?: {...}`
- [x] Rust `settings.rs` 加两个字段 + Default + merge 分支 + 回归测试
- [x] `cargo test` + vitest 绿

## T2 — 会话文件夹：纯函数模块 + 测试

**Status:** done (2026-08-12)

**What to build:** `sessionFolders.ts` 纯函数模块(无 DOM 依赖, 同 `sessionFavorites.ts` 先例): `addFolder` / `renameFolder` / `deleteFolder`(级联: 子文件夹 + 会话上移父级或未归类) / `moveFolder`(防循环: 不能移到自身/后代) / `assignSession` / `unassignSession` / `moveSessions`(批量) / `buildFolderTree`(扁平→嵌套) / `partitionSessionsByFolder`(分组 + 未归类)。vitest 覆盖嵌套/级联/防循环/批量/分组/收藏共存。

**Blocked by:** None — 可立即开始(类型自包含)

**Status:** ready-for-agent

- [x] 全部纯函数 + 类型定义
- [x] vitest 覆盖上述用例;`bunx tsc --noEmit` 干净

## T3 — 设置面板「会话文件夹」开关 + i18n

**Status:** done (2026-08-12)

**What to build:** 设置面板聊天分类出现「会话文件夹」开关(默认关),切换后即时生效并持久化。zh/en 各两个 key(label + 描述)。

**Blocked by:** T1

**Status:** ready-for-agent

- [x] `SettingsPanel` 聊天分类加开关
- [x] 读写 `settings.sessionFolders`,变更持久化
- [x] `zh.ts` / `en.ts` 新增 keys

## T4 — 会话文件夹树 UI 核心

**Status:** done (2026-08-12)

**What to build:** 开关开启后,会话面板顶部收藏区之下渲染可折叠文件夹树(递归渲染子文件夹,节点可展开/收起)。「新建文件夹」按钮(根级; 树中选中某文件夹时新建为其子级)。文件夹行 hover: ✎ 重命名 / 🗑 删除(确认, 删除级联: 会话上移父级或未归类)。会话行「移动到文件夹」菜单(树选择器)走 `assignSession`/`moveSessions`。未归类会话在最后。收藏区保持置顶不变。

**Blocked by:** T1(读开关/数据) + T2(用纯函数)

**Status:** ready-for-agent

- [x] 文件夹树渲染(递归/折叠) + 新建/重命名/删除(确认/级联)
- [x] 会话「移动到文件夹」菜单(树选择器)
- [x] 未归类会话 + 收藏区共存;`bunx tsc --noEmit` 干净

## T5 — 会话文件夹：拖拽 + select 批量移动

**Status:** done (2026-08-12)

**What to build:** 会话行可**拖拽**到文件夹节点(成为该文件夹直接子级; 目标 hover 时展开)。select 多选后底部出现「移动到文件夹」批量操作(树选择器)。拖拽/批量走同一套 `assignSession`/`moveSessions`;拖拽命中用折叠树 + hover 展开, 防误放。

**Blocked by:** T4(树已渲染可作拖放目标)

**Status:** ready-for-agent

- [x] 会话行拖拽到文件夹节点(直接子级)
- [x] select 多选 → 底部「移动到文件夹」批量
- [x] Playwright 验证(开开关 → 建文件夹 → 拖会话 → 批量移动 → 折叠/删除级联)

## T-NEXT — 主题预设系统 (Theme Presets)

**Status:** done (2026-08-19)

**Source spec:** `.scratch/theme-presets/PRD.md`

**What to build:** 设置面板主题下拉从 2 项扩为 4 项预设（`light` / `dark` / `dark-a` / `dark-b`），暗色 A（深蓝专业）与 B（高级深灰）为新配色；A/B 变量值来自已验收原型。统一暗色判定 `isDarkTheme()`，替换 8 处 `=== "dark"` 硬判断，确保编辑器/终端/消息/超级桌面跟随预设。清理全 GUI 残留硬编码浅色。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] tokens.css: 新增 `[data-theme="dark-a"]`/`[data-theme="dark-b"]` 两套变量；`[data-theme="dark"]` 与 `dark-b` 同值（兼容旧值）
- [x] SettingsPanel 主题下拉 2→4 项，含 i18n 新文案
- [x] 新增 `isDarkTheme()` 工具，替换 8 处 `=== "dark"` 硬判断
- [x] 工具栏 toggle 在暗色间保持当前预设（亮↔暗不重置预设）
- [x] App.tsx 启动恢复：非法 theme 值回退 `light`
- [x] 全 GUI 扫描并清理硬编码浅色（FileTree 拖入桌面死色）
- [x] `bunx tsc --noEmit` 干净
- [x] 验证：themeUtils 测试 16/16 PASS + 发布 08.19.6
