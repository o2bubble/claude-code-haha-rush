# VS Code 插件使用指南

## 概述

Claude Code IDE 是一款基于 Claude API 的 AI 编程助手插件，直接集成在 VS Code 侧边栏中。它允许你在不离开编辑器的情况下与 AI 对话、执行命令、编辑文件、搜索代码库等。

> 此版本社区维护版基于 Anthropic 内部版本修复改造，支持任意兼容 Anthropic API 格式的后端服务。

---

## 环境要求

- **VS Code** 1.85+
- **Bun** 运行时（JavaScript/TypeScript 运行时，替代 Node.js）
- **Git**（用于部分工具功能）
- 操作系统：Windows、macOS 或 Linux

---

## 快速安装

### 1. 克隆仓库

```bash
git clone https://gitee.com/randomlife/claude-code-haha-dev.git
cd claude-code-haha-dev
```

### 2. 安装工具和依赖

根据你的平台选择合适的脚本：

```bash
# Windows PowerShell（推荐）
.\install.ps1

# Windows 命令提示符
install.cmd

# macOS/Linux (Git Bash / WSL)
bash install-tools.sh
```

脚本运行时会：
- **检查 Git** — 确认 Git 已安装
- **安装 Bun 运行时** — Claude Code CLI 后端的运行环境（支持在线/离线两种模式）
- **配置 PATH** — 将 `bin/` 目录添加到用户环境变量
- **安装项目依赖** — 自动运行 `bun install`
- **安装辅助 CLI 工具** — `rg`（文件搜索）、`fd`（快速查找）、`jq`（JSON 处理）、`yq`（YAML 处理）、`shellcheck`（Shell 脚本检查）
- **配置 API** — 交互式创建 API profile

安装后重启终端使 PATH 生效。

### 3. 配置 API

插件支持多套 API 配置快速切换。使用 `claude-profile` 脚本管理：

```bash
# 创建新的 API 配置
.\bin\claude-profile.ps1 create

# 查看所有配置
.\bin\claude-profile.ps1 list

# 切换配置
.\bin\claude-profile.ps1 switch <profile-name>
```

创建时提供交互式模板：

| 选项 | 说明 |
|------|------|
| **DeepSeek v4 Pro** | 预设模板，只需输入 AUTH_TOKEN |
| **DeepSeek v4 Flash** | 更快但稍弱的模型预设 |
| **Custom** | 自定义模板，手动填写所有字段 |

**配置存储结构：**

```
.env.profiles/
├── deepseek-v4-pro.env    # 每个 .env 文件是一个模型配置（源）
├── deepseek-v4-flash.env
└── qwen-3.6-plus.env

.env.active                # 当前激活的 Profile 名称

~/.claude/settings.json    # 切换时写入 "env" 块，CLI 和 IDE 共用
```

> 插件启动后自动读取 `.env.profiles/` 下的所有 Profile，填入状态栏下拉框。切换 Profile 时插件会将配置写入 `~/.claude/settings.json` 的 `env` 块，同时重启后端进程以应用新配置。

### 4. 安装插件

**方式 A：从 VSIX 安装（推荐）**

1. 确保已执行上面第 2 步（`bun install` 完成）
2. 使用项目根目录的 `.vsix` 文件：
   ```
   VS Code → Ctrl+Shift+P → Extensions: Install from VSIX → 选择 .vsix
   ```

**方式 B：F5 调试模式**

```bash
cd extensions/vscode
bun install  # 或 npm install
```

然后在 VS Code 中打开 `extensions/vscode/` 目录，按 `F5` 启动调试窗口。

### 5. 配置 cliPath

插件需要找到仓库根目录才能启动后端。按优先级自动查找：

1. **PATH 环境变量**：如果 `claude-ide.cmd`（Windows）或 `claude-ide`（macOS/Linux）已在 PATH 中，无需配置
2. **VS Code 设置**：设置 `claudeCode.cliPath` 为仓库根目录的绝对路径
3. **工作区根目录**：如果当前工作区就是仓库目录，自动识别

> 大多数情况无需手动配置。仅当插件提示找不到脚本时才需设置。

---

## 界面总览

```
┌──────────────────────────────────────────────────┐
│  ☰ 会话面板 │ 新建 ✕   🔍 搜索过滤             │
├──────────────────────────────────────────────────┤
│ ┌─ 会话列表 ───┐ ┌─ 消息区域 ────────────────┐ │
│ │  ✎ 项目调试   │ │ 过滤器: [全部] [你] [助手] │ │
│ │  📌 bug修复   │ │                             │ │
│ │  功能开发     │ │ 用户: 帮我调试这段代码      │ │
│ │  重构页面     │ │  ┌─ 🤔 思考 ───── 0:12 ┐  │ │
│ │  ...          │ │  │ 分析了调用栈...     │  │ │
│ │               │ │  │ [翻译]              │  │ │
│ │               │ │  └─────────────────────┘  │ │
│ │               │ │                            │ │
│ │               │ │  ┌─ 工具: bash ─────────┐  │ │
│ │               │ │  │ $ npm test           │  │ │
│ │               │ │  │ 输出内容...          │  │ │
│ │               │ │  │ ⏱ 退出码 0  [打开]  │  │ │
│ │               │ │  └─────────────────────┘  │ │
│ │               │ │                            │ │
│ │               │ │ ┌─ 差异对比 ────────────┐  │ │
│ │               │ │ │ - line  old text      │  │ │
│ │               │ │ │ + line  new text      │  │ │
│ │               │ │ │               [打开]  │  │ │
│ │               │ │ └─────────────────────┘  │ │
│ │               │ │                            │ │
│ │               │ │ Claude: 找到问题了...     │ │
│ │               │ │ ┌─ 授权窗口 ────────────┐ │ │
│ │               │ │ │ 执行命令: git add ...  │ │ │
│ │               │ │ │    [允许] [拒绝]       │ │ │
│ │               │ │ └─────────────────────┘  │ │
│ │               │ │                            │ │
│ │               │ │ ▼ 1条消息 ─────────────────│ │
│ │               │ │                            │ │
│ │               │ └────────────────────────────┘ │
│ └───────────────┘  📌 粘贴  chips 标签           │
│                    🔗 文件   chips 标签           │
├──────────────────────────────────────────────────┤
│ 🔵已连接  🛡️默认  🌐 模型名  ████░ 42%  ⚡    │
│   ├── 权限下拉    └── 模型下拉  └── 快捷命令    │
└──────────────────────────────────────────────────┘
```

---

## 基本使用

### 打开聊天面板

- 点击侧边栏的 **Claude Code 图标**
- 或按 `Ctrl+Shift+P` → `Claude Code: Start Chat`
- 或点击 VS Code 底部状态栏的 `Claude Code` 文字

### 发送消息

- 在底部输入框输入问题或指令
- 按 `Enter` 发送
- 如需多行输入，按 `Shift+Enter` 换行，或使用 Markdown 编辑器（✍）

### 输入框工具栏

工具栏位于输入框左侧，提供以下功能：

| 按钮 | 功能 | 触发方式 |
|------|------|----------|
| **@** | 附加文件 — 从工作区文件树中选择文件 | `@` 或点击按钮 |
| **/** | 斜杠命令 — 列出可用命令 | 在输入框首字符输入 `/` |
| **✍** | Markdown 编辑器 — 结构化消息编辑 | 点击按钮 |
| **😊** | 表情选择器 — 插入 emoji | 点击按钮 |

### 附加文件到对话

多种方式：

1. **文件选择器**：点击 `@` 按钮或输入 `@`，从文件树中浏览选择
2. **粘贴文件**：直接粘贴文件内容，自动转为 Paste Chip
3. **右键菜单**：在文件资源管理器中右键文件/文件夹 → `Add to Claude Chat`
4. **发送选中代码**：在编辑器中选中代码后按 `Ctrl+Shift+L`（Selection Chip）
5. **拖放**：从文件资源管理器拖入文件

### 中断和停止

- 响应过程中点击红色 **⏹ 停止** 按钮中断生成
- 中断后 AI 会停止当前操作，已生成的内容保留

---

## 状态栏详解

状态栏位于聊天面板底部，从左到右：

| 控件 | 说明 |
|------|------|
| **连接指示器** | 🔵 已连接 / 🟡 连接中 / 🔴 已断开 |
| **权限模式** | 当前权限模式，点击弹出选择下拉框 |
| **模型名称** | 当前使用的模型名称，点击可切换 Profile |
| **上下文窗口** | 已使用百分比 + 填充条，点击查看详情/压缩 |
| **快捷命令** | ⚡ 闪电图标，点击触发预设命令/打开管理 |

### 模型切换

点击模型名称标签打开下拉列表，列出所有 `.env.profiles/` 下的配置。切换后插件会自动中断当前任务并重启后端。

### 权限模式

下拉框设计：名称 + 描述 + 选中高亮 + 提示文字。

| 模式 | 图标 | 行为 |
|------|------|------|
| **Default** | 🛡️ | 高风险操作（如执行命令、修改文件）需要用户确认 |
| **Accept Edits** | ✏️ | 自动批准文件编辑操作，其他操作仍需确认 |
| **Plan Mode** | 📋 | AI 先输出计划，确认后再执行，适合复杂任务 |
| **Bypass Permissions** | ⚡ | 自动批准所有操作，不弹出确认窗口 |
| **Don't Ask** | 🤫 | 记住用户在本次对话中的上一次选择 |

### 上下文窗口

- 点击上下文百分比查看详细 Token 用量
- 详情弹窗：梯度色填充条 + 颜色图例（安全/正常/警告/危险）
- 会话累积 Token：输入 + 输出（不重复统计上下文 Token）
- 点击"压缩对话"释放上下文空间
- 压缩后 AI 会生成对话摘要并继续对话

### 快捷命令

用于快速执行常用操作，支持自定义：

- 点击 ⚡ 图标显示命令列表
- 选择命令立即执行
- 可在命令管理器中增删改（底部 `管理命令...`）
- 命令存储在 `~/.claude/quick-cmds.json`

---

## 特性详解

### 消息过滤

消息区上方提供过滤按钮：

| 选项 | 显示内容 |
|------|----------|
| **全部** | 显示所有消息 |
| **你** | 仅显示用户消息 |
| **助手** | 仅显示 AI 回复 |

功能位置支持国际化（中/英）。

### 消息计数

消息列表末尾显示`━ 1 条消息 ──────`分隔线，实时反映当前列表的消息数。

### 会话管理

左侧面板提供完整的会话管理功能：

- **新建会话**：点击 `+` 按钮或 `Ctrl+Shift+I`
- **切换会话**：点击列表中的条目
- **搜索**：顶部的搜索框按标题过滤
- **排序**：支持按最近/名称/消息数排序
- **重命名**：点击会话名旁的 ✎ 图标进入内联编辑，按 `Enter` 保存或 `Escape` 取消
- **删除**：点击删除图标（需二次确认）
- **钉选**：点击 📌 图标固定在顶部
- **恢复**：历史会话自动保存到 JSONL，随时恢复

### 用户消息展示

- **纯文本**：直接显示消息内容
- **Paste Chip**：粘贴内容 ≥ 500 字符显示为标签 `📄 文件名 (N chars)`，可展开查看全部
- **Selection Chip**：编辑器中选中的代码显示为标签 `📝 文件:行号`，悬停显示预览
- **文件附加**：通过 @ 添加的文件显示为标签 `📁 文件路径`
- 消息末尾携带的附件以 Chips 形式排在消息下方，可收起/展开

### Thinking 块

AI 在调用工具前的推理过程以折叠块形式显示：

- 带有 🤔 图标和序号
- **实时计时器**：思考过程中持续更新耗时（`0:05 → 0:12 → ...`）
- 思考完成后显示最终耗时
- **完整内容**：全部推理文本，不截断（最大高度 400px，可滚动）
- **翻译按钮**：一键将推理内容发送为旁问翻译（当前仅支持 AI 助手名称 = assistant）
- 多个 Thinking 块连续显示时自动编号（🤔 1/3、🤔 2/3...）
- 思考结束后无需手动收回，自动折叠

### 命令执行（工具卡片）

AI 执行 Shell 命令时：

- **命令语法高亮**：使用 highlight.js 自动识别语言并着色
- **提示词（prompt）**：显示在命令之上，说明执行目的
- **输出流式追加**：长时间运行的命令实时输出，默认展开
- **输出区域**：最大高度 300px 可滚动，支持展开/折叠
- **打开按钮**：对于文件编辑类工具，点击可在 VS Code 中打开对应文件
- 命令完成后显示耗时和退出码

### 差异对比（Diff）

AI 修改文件时显示差异对比：

- 红色行 = 删除的内容，绿色行 = 新增的内容
- 点击授权按钮确认后才实际写入
- 完整 diff 内容展示（不省略中间行）
- **打开按钮**：点击在编辑器中打开对应文件

### 文件编辑

- 差异对比视图完整显示所有变更行
- 支持通过权限弹窗逐条确认
- 点击授权按钮确认后才实际写入

### Markdown 编辑器

用于编写格式复杂的消息：

- 复用的实际输入框（`inputEl`），编辑器打开时输入框移入弹窗
- 工具栏：标题、加粗、斜体、列表、代码块、引用
- `Enter` = 换行（非发送）
- 关闭编辑器时输入框移回到原位，已输入文字保留
- 取消发送时清空输入内容

### 旁问 (Side Question)

在不打断当前 AI 任务的前提下提问：

- **用户主动提问**：点击"旁问"按钮 → 输入快速问题
- **AI 发起提问**：当 AI 需要向用户确认时自动弹出
- 结果区域支持 Markdown 渲染
- 当前正在进行的任务不受影响

### 旁问翻译

Thinking 块中的翻译按钮基于旁问机制实现：

- 点击 Thinking 块的 `[翻译]` 按钮
- 将推理内容通过 `side_question` 通道发送
- 结果在旁问区域显示翻译后的文本

### 滚动到底部按钮

消息溢出时自动显示：

- 位置：滚动区域右下角（悬浮）
- 出现条件：滚动位置距离底部 > 100px
- 点击后平滑滚动到最新消息

### 权限弹窗

AI 执行高风险操作时弹窗确认：

- 显示完整命令内容（不省略）
- 按钮：`[允许]` `[本次会话允许]` `[始终允许]` `[拒绝]`
- 标记模式名称方便识别

### 任务面板

底部状态栏上方可展开的任务面板：

- 显示后台运行的任务（Agent 任务）
- 运行中：图标 + 名称 + 统计（步骤/工具调用数，仅 >0 时展示）+ 停止按钮
- 已完成：图标 + 名称
- 统计格式：`steps/total`

### 计划面板

配合 Plan Mode 使用：

- 显示 AI 的分步骤执行计划
- 标记已完成/进行中/待办任务
- `blocked_by` 依赖：仅对 pending/active 任务显示（已完成的不显示阻塞信息）
- 计划完成后自动汇总

### 记忆系统

AI 能够保存和回顾会话上下文：

- **Recall**：回顾之前保存的关于你和项目的信息
- **Update**：将当前会话中的重要信息保存到记忆中
- 重启后记忆仍然保留

### 输入框特性

- **Paste Chip**：粘贴文本 ≥ 500 字符自动转为标签，防止误发大量内容
- **图片粘贴**：支持图片粘贴为附件
- **Chip 保护**：`contentEditable=false` + `beforeinput` 事件拦截，防止光标移入 Chip 内部
- **/@ 键盘触发**：输入 `@` 自动打开文件选择器，输入 `/` 自动打开命令列表
- **Selection Chip**：通过 `Ctrl+Shift+L` 发送选中代码

### CDP Inspector（浏览器实时渲染检查器）

前端调试专用 MCP 工具，连接本地 Chrome/Edge 读取真实渲染结果。参见 [extensions/cdp-inspector/README.md](../cdp-inspector/README.md)。

可配合插件使用：在 `.mcp.json` 中配置后，AI 可自动调用以下工具：

| 工具 | 用途 |
|------|------|
| `cdp_inspect(selector)` | 获取元素真实 outerHTML（支持 CSS 选择器 + XPath） |
| `cdp_styles(selector)` | 获取计算后样式 |
| `cdp_box(selector)` | 获取盒模型信息 |
| `cdp_console(limit?)` | 读取控制台日志 |
| `cdp_evaluate(expression)` | 在页面上下文执行 JS |

---

## 斜杠命令

在输入框中以 `/` 开头可触发斜杠命令，支持键盘导航和过滤：

| 命令 | 功能 |
|------|------|
| `/commit` | 生成 Git 提交信息 |
| `/review` | 代码审查 |
| `/explain` | 解释代码 |
| `/config` | 查看/修改配置 |
| `/status` | 查看 IDE 状态 |
| `/stats` | 查看使用统计 |
| `/memory` | 管理记忆系统 |
| `/model` | 切换模型（临时） |
| `/compact` | 压缩对话上下文 |
| `/export` | 导出对话 |
| `/hooks` | 管理 hooks |
| `/skills` | 查看可用技能 |

选择命令后自动填入输入框（如 `/commit `），按 `Enter` 发送。

---

## 故障排查

### 插件无法启动

1. 确认 API 配置已设置：运行 `claude-profile create` 或在 `~/.claude/settings.json` 中配置 `env` 块
2. 检查 `claude-ide.cmd`（Windows）或 `claude-ide`（macOS/Linux）是否在 PATH 中
3. 或手动设置 `claudeCode.cliPath` 为仓库根目录
4. 打开 VS Code 输出面板（`Ctrl+Shift+U`），选择 `Claude Code` 查看日志
5. 检查扩展宿主控制台（`F1` → `Developer: Toggle Developer Tools` → Console）

### 模型列表为空

1. 确认 `.env.profiles/` 目录存在且包含 `.env` 文件
2. 每个文件需有 `ANTHROPIC_MODEL` 和至少一个认证字段（`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`）
3. 如果配置文件在仓库外，确保 `claudeCode.cliPath` 指向仓库根目录
4. 重启插件：关闭再打开聊天面板

### 连接状态异常

| 状态 | 含义 | 处理 |
|------|------|------|
| **Starting...** | 后端进程启动中 | 等待，通常 < 10 秒 |
| **Connecting...** | WebSocket 连接中 | 检查 API 地址和端口 |
| **Disconnected** | 连接已断开 | 检查进程是否被意外终止 |
| **长时间 Starting** | 后端启动失败 | 检查 API 配置和 Bun 安装 |

### 终端输出乱码

Windows 系统下 Shell 输出可能使用 GBK 编码：

- 插件会自动检测并尝试 UTF-8 → GBK 回退解码
- 如果仍然乱码，检查系统区域设置
- 建议使用 Git Bash 而非 CMD

### 输入框无响应

1. 检查状态栏连接指示器是否为 "已连接"
2. 如果长时间 "连接中..."，检查 API 配置
3. 重启插件进程：关闭再打开聊天面板
4. 按 `Ctrl+Shift+P` → `Developer: Reload Webview` 强制刷新

### Chip 光标异常

如果光标移入 Chip 内部（文本输入到标签中）：

- 正常状态下 Chip 不可编辑（`contentEditable=false`）
- 极少数情况因 `range.insertNode` 插入位置异常导致嵌套
- 最新版本已通过 `beforeinput` 事件拦截修复
- 如仍出现，刷新 WebView 即可修复面板显示

### 权限弹窗按钮行为异常

- 某些模式下（如 Bypass Permissions）不会弹出权限确认
- 检查当前权限模式是否符合预期
- 如果不小心设置了 Bypass，在权限模式下拉框中切回 Default

### 会话列表不更新

- 压缩对话后可能需要点击刷新
- 手动切换会话再切回即可刷新列表
- 极端情况重启插件

### 思考块显示问题

- 思考块结束后自动折叠（不消失，可展开查看全部内容）
- 如果思考块完全消失：检查 `assistant` 消息处理器是否替换了内容（旧版 bug，已修复）
- 计时器不更新：检查 `content_block_delta` 中的 `thinking_delta` 是否正确触发 AppState.set

---

## 常见问题

### 这是官方插件吗？

不是。此版本基于 Anthropic 的 Claude Code 源码修复改造，旨在提供可本地运行的版本，支持任意兼容 Anthropic API 格式的后端。

### 需要 Node.js 吗？

不需要。运行时使用 **Bun** 而非 Node.js。

### 支持哪些 API？

支持所有兼容 Anthropic API 格式的服务，包括：
- Anthropic 官方 API
- DeepSeek 等第三方 Anthropic 兼容接口
- 自建代理/中转服务

通过配置 `ANTHROPIC_BASE_URL` 和认证信息即可接入。

### 数据安全

- 所有请求直接发到配置的 API 端点，不经过第三方代理
- 插件与后端之间通过本地 WebSocket 通信
- 不收集任何遥测数据（已通过 `DISABLE_TELEMETRY=1` 禁用）

---

## 开发

### 本地构建

```bash
# 安装根目录依赖
bun install

# 编译插件
cd extensions/vscode
bun install   # 安装插件依赖
bun run compile  # 或 npx tsc

# 打包 VSIX
npx @vscode/vsce package
```

### 项目结构

```
extensions/vscode/
├── src/
│   ├── extension.ts            # 插件入口
│   ├── processManager.ts       # 后端进程管理
│   └── webview/
│       └── provider.ts         # WebView 提供者
├── media/webview/
│   ├── app-new.js              # 新 UI 主入口（组件化架构）
│   ├── template.html           # HTML 模板
│   ├── tokens.css              # 设计 Token 变量
│   ├── styles-new.css          # 新 UI 样式表
│   ├── locales/                # 国际化文件
│   │   ├── en.json
│   │   └── zh-cn.json
│   ├── components/             # UI 组件
│   │   ├── message-stream.js   # 消息流渲染（用户/AI/Thinking/Tool/Diff）
│   │   ├── input-area.js       # 输入框（Chips, Paste, @/ 触发）
│   │   ├── session-panel.js    # 会话列表（重命名、排序、搜索）
│   │   ├── status-bar.js       # 状态栏（连接、权限、模型、上下文、快捷）
│   │   └── plan-panel.js       # 计划面板
│   │   └── tasks-panel.js      # 任务面板
│   ├── overlays/               # 弹窗/覆盖层组件
│   │   ├── permission-prompt.js
│   │   ├── markdown-editor.js
│   │   ├── file-picker.js
│   │   ├── emoji-picker.js
│   │   ├── context-detail.js   # 上下文详情（Token 分布、压缩）
│   │   ├── rewind-points.js
│   │   ├── side-question.js    # 旁问 & 翻译
│   │   ├── slash-autocomplete.js
│   │   ├── quick-command-manager.js
│   │   └── toast.js
│   └── utils/
│       ├── state.js            # AppState 全局状态管理
│       ├── dom.js              # DOM.createElement 封装
│       ├── api.js              # WebSocket API 通信
│       └── locale.js           # 国际化（__t 函数）
└── package.json
```
