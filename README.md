# Claude Code Haha

<p align="right"><strong>中文</strong> | <a href="./README.en.md">English</a></p>

基于 Claude Code 泄露源码修复的**本地可运行版本**，在其之上构建了一套**完整的桌面 GUI 客户端**（Tauri 2 + React）。

支持接入任意 Anthropic 兼容 API（DeepSeek、Qwen、MiniMax、OpenRouter 等）。

> 原始泄露源码无法直接运行。本仓库修复了启动链路的多个阻塞问题，并新增了原版没有的图形界面与插件生态。

<p align="center">
  <img src="docs/diagrams/00gui-main.png" alt="GUI 主界面" width="900">
  <br><sub>多面板工作台：子代理 / 超级桌面 / 技能 / 快捷提示 / 计划 / 聊天 / 输入 / 终端</sub>
</p>

<p align="center">
  <img src="docs/diagrams/00runtime.png" alt="启动页 — 选择工作区" width="700">
  <br><sub>启动页：选择或新建工作区</sub>
</p>

---

## 桌面 GUI（主要形态）

原版 Claude Code 是终端程序。本项目在保留 TUI 的同时，提供了一套桌面客户端 —— **多面板工作台**，把终端里线性滚动的信息铺开成可自由布局的面板：聊天、编辑器、终端、文件树各自独立，可拖拽拆分、浮动成窗。

### 面板

| 面板 | 说明 |
|------|------|
| **编辑器** | Monaco 代码编辑器；图片/PDF/SVG 预览（滚轮缩放、拖拽平移、取色器）|
| **聊天** | 消息流 + 会话历史；消息时间线（按用户提问定位）、搜索、引用跳转 |
| **终端** | xterm.js 多标签终端，Agent 的 Bash 输出直接在这里呈现 |
| **文件** | 文件树（增删改、右键菜单、定位到编辑器） |
| **超级桌面** | 无限画布：9 类内容块（文本/表格/图表/图形/绘图/表单/图片/引用/文件组），可连线、缩放、与 AI 双向协作 |
| **技能 / 插件市场** | 在线安装技能与插件；插件可贡献面板、命令、后台进程 |
| **笔记** | 带标签、作用域、关联关系的个人笔记（跨工作区共享）|
| **计划 / 子代理 / 工作进程** | TodoWrite 任务展示、后台代理列表与转录查看、插件进程状态 |
| **运行环境诊断** | 一键检查并修复后端服务/端口/连接/环境变量 |
| **设置 / 更新** | 模型与 API 配置、主题语言、组件更新 |

### 特性

- **自由布局**：面板可拖拽重排、拆分成组、浮动成独立窗口；布局按工作区持久化
- **多实例**：可同时开多个窗口，各自绑定不同工作区；会话列表/笔记/设置跨窗口实时同步
- **多模型 Profile**：内置 DeepSeek / Qwen 等预设，一键切换；配置文件与 CLI 共用
- **插件生态**：插件以 zip 分发（市场一键装），可贡献面板（iframe 沙箱）、斜杠命令、后台进程、运行时依赖
- **AI 深度集成**：AI 可通过 MCP 操作 GUI（创建画布块、读写笔记、检查 git、代装插件等）
- **主题 / 字体缩放**：暗色/亮色主题，界面字号跟随设置

### 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | [Tauri 2](https://tauri.app)（Rust + WebView2）|
| 前端 | React 18 + TypeScript + Vite |
| 编辑器 | Monaco |
| 终端 | xterm.js |
| 表格 / 图表 | AG Grid / ECharts |
| 运行时 | Bun（引擎侧）|

---

## 快速开始

### 方式 A：安装包（推荐）

运行 `ClaudeCodeHaha_Setup_*.exe`，按向导完成。安装后可选择"配置 API Profile"输入 Key。

详见 [SETUP.md](./SETUP.md)。

### 方式 B：源码运行

```bash
# 1. 安装 Bun
curl -fsSL https://bun.sh/install | bash          # macOS / Linux
powershell -c "irm bun.sh/install.ps1 | iex"      # Windows

# 2. 安装依赖
bun install
cd gui && bun install && cd ..

# 3. 配置 API
cp .env.example .env    # 填入 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN

# 4. 启动 GUI（开发模式）
cd gui && cargo tauri dev
```

> **Windows 前置**：需安装 [Git for Windows](https://git-scm.com/download/win)（提供 Git Bash，Shell 执行依赖它）。

> **技能 / 插件市场**需要一个可达的 registry 服务（设置面板可改地址）。默认指向开发者的内网地址，公网环境下请改为你自己的部署或自建服务 —— 市场不可达不影响其余功能。

---

## 终端 TUI 模式

原版形态仍然完整可用 —— 与官方 Claude Code 一致的 Ink 交互界面：

```bash
# macOS / Linux
./bin/claude-haha                    # 交互 TUI
./bin/claude-haha -p "your prompt"   # 无头模式（脚本/CI）

# Windows（PowerShell / cmd）
bun --env-file=.env ./src/entrypoints/cli.tsx
bun --env-file=.env ./src/entrypoints/cli.tsx -p "your prompt"
```

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ANTHROPIC_API_KEY` | 二选一 | API Key，通过 `x-api-key` 头发送 |
| `ANTHROPIC_AUTH_TOKEN` | 二选一 | Auth Token，通过 `Authorization: Bearer` 头发送 |
| `ANTHROPIC_BASE_URL` | 否 | 自定义 API 端点，默认 Anthropic 官方 |
| `ANTHROPIC_MODEL` | 否 | 默认模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 否 | Sonnet 级别模型映射 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 否 | Haiku 级别模型映射 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 否 | Opus 级别模型映射 |
| `API_TIMEOUT_MS` | 否 | API 请求超时，默认 600000 (10min) |
| `DISABLE_TELEMETRY` | 否 | 设为 `1` 禁用遥测 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 否 | 设为 `1` 禁用非必要网络请求 |

GUI 下这些由设置面板 / Profile 管理，无需手改 `.env`。

---

## 项目结构

```
gui/                     # 桌面客户端（本项目的主体新增部分）
├── src/                 # React 前端
│   ├── components/      #   面板与 UI 组件
│   ├── stores/          #   状态（布局/会话/桌面/笔记…）
│   ├── services/        #   服务桥（Tauri 命令、MCP、跨窗口）
│   └── i18n/            #   中英文案
└── src-tauri/           # Rust 后端（窗口、文件、进程、插件、DB）

src/                     # 引擎（基于泄露源码修复）
├── entrypoints/         #   CLI 入口（cli.tsx / ideMode.ts）
├── main.tsx             #   TUI 主逻辑（Commander.js + React/Ink）
├── tools/               #   Agent 工具（Bash/Edit/Grep…）
├── commands/            #   斜杠命令
├── skills/              #   技能系统
├── services/            #   服务层（API/MCP/OAuth…）
└── utils/               #   工具函数

plugins/                 # 官方插件（含 _template/ 脚手架与文档规范）
extensions/              # IDE 插件（VS Code / VS / IntelliJ）+ memory 服务
installer/               # 安装程序（Inno Setup）
docs/                    # 架构图与开发文档
bin/claude-haha          # 入口脚本
preload.ts               # Bun preload（设置 MACRO 全局变量）
```

---

## 开发

```bash
# GUI 开发（热重载）
cd gui && cargo tauri dev

# GUI 测试 / 类型检查
cd gui && npm test && npx tsc --noEmit

# 引擎侧（TUI）
bun --env-file=.env ./src/entrypoints/cli.tsx

# 降级 Recovery CLI（TUI 出问题时用）
bun --env-file=.env ./src/localRecoveryCli.ts
```

架构文档见 [docs/](./docs/)（`ARCHITECTURE.md`、`gui/` 下的专题文档）。

---

## 构建

产物都落在 `dist/`，由 `scripts/build.ts` 统一驱动（编译各组件 → 组装 dist → 可选生成更新包）。

```bash
# 全量构建（引擎 + GUI + CLI 工具 + 嵌入式运行时 → dist/）
bun run scripts/build.ts

# 只重建指定组件（其余复用上一版 zip，快很多）
bun run scripts/build.ts --components gui,claude
#   可用组件：gui, server, claude, bun, updater, tools, python, git, extensions

# 增量跳过已有产物（本地反复调试用）
bun run scripts/build.ts --quick

# 生成更新包：更新清单 + 各组件 zip → dist/release/<version>/
bun run scripts/build.ts --release 2026.09.10.14 --notes "v2026.09.10.14

### 修复
- 一句话说明改了什么 — 为什么"
```

产物结构：

```
dist/
├── claude.exe / claude-code-gui.exe / claude-gui-server.exe / …   # 各组件
├── bin/                          # CLI 工具（rg / fd / jq / yq / shellcheck）
└── release/<version>/
    ├── manifest.json             # 更新清单（版本 + 各组件 sha256）
    └── <component>.zip           # 分组件更新包（GUI 客户端按 sha 增量更新）
```

### 打包安装程序

```powershell
# 需先装 Inno Setup 6+ (https://jrsoftware.org/isdl.php)
cd installer
./build.ps1            # 自动以「年W周」算 build tag；-Quick 跳过版本确认
```

产出 `dist/ClaudeCodeHaha_Setup_<版本>_<buildTag>.exe`（安装向导含组件勾选、PATH、API Profile 配置）。

> **关于分发**：更新包与技能/插件市场都需要一个兼容的 registry / 更新服务（`GET /api/updates/latest`、`POST /api/updates/<version>/upload`）。本仓库不含服务端实现 —— 自建或改成你熟悉的发布方式均可。打包与上传的完整流程（含 Windows/macOS 差异）见 `docs/windows-build-playbook.md` / `docs/macos-build-playbook.md`。

---

## 相对于原始泄露源码的修复

泄露源码无法直接运行，主要修复：

| 问题 | 根因 | 修复 |
|------|------|------|
| TUI 不启动 | 入口脚本把无参数启动路由到了 recovery CLI | 恢复走 `cli.tsx` 完整入口 |
| 启动卡死 | `verify` skill 导入缺失的 `.md`，Bun text loader 无限挂起 | 创建 stub `.md` |
| `--print` 卡死 | `filePersistence/types.ts` 缺失 | 创建类型桩 |
| `--print` 卡死 | `ultraplan/prompt.txt` 缺失 | 创建资源桩 |
| **Enter 键无响应** | `modifiers-napi` 原生包缺失，`isModifierPressed()` 抛异常中断 `handleEnter` | 加 try-catch 容错 |
| setup 被跳过 | `preload.ts` 自动设 `LOCAL_RECOVERY=1` | 移除默认设置 |
| 编译版找不到 ripgrep | `bun build --compile` 不内嵌 `vendor/ripgrep/` | 运行时多路径查找 |

---

## Disclaimer

本仓库基于 2026-03-31 从 Anthropic npm registry 泄露的 Claude Code 源码。所有原始源码版权归 [Anthropic](https://www.anthropic.com) 所有。仅供学习和研究用途。

**关于授权**：本仓库**不附带任何开源许可证**（no license granted）。`src/` 目录下的引擎源码版权归 Anthropic 所有，本仓库作者无权就该部分授予任何许可；`gui/`、`scripts/`、`docs/` 等新增部分亦不单独授权，以保持整体立场一致。

**使用限制**：请勿将本仓库内容（含 `dist/` 构建产物）用于商业用途或对外分发。本仓库仅作为个人学习、研究与技术验证用途。

**权利方声明**：如 Anthropic 或任何权利方认为本仓库内容侵犯其权利，请联系仓库作者，我们将**立即删除**相关内容并停止分发。

**后续规划**：引擎层计划迁移至自研推理框架；届时 `gui/` 桌面客户端层将拆分至新仓库独立维护，并采用正式开源协议。
