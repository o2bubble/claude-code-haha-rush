# Claude Code Haha — 安装与使用指南

基于 Claude API 的 AI 编程助手。支持 VS Code 插件、终端 TUI、CLI 三种使用方式。

> 此版本基于 Anthropic 的 Claude Code 源码修复改造，可本地运行，支持任意兼容 Anthropic API 格式的后端服务。

---

## 目录

- [系统要求](#系统要求)
- [安装方式](#安装方式)
  - [方式 A：打包安装程序（推荐）](#方式-a打包安装程序推荐)
  - [方式 B：源码安装](#方式-b源码安装)
- [启动方式](#启动方式)
  - [终端 TUI 模式](#终端-tui-模式)
  - [VS Code 插件模式](#vs-code-插件模式)
- [API 配置管理](#api-配置管理)
- [扩展功能](#扩展功能)
- [常见问题](#常见问题)

---

## 系统要求

| 项目 | 要求 |
|------|------|
| **操作系统** | Windows 10+、macOS、Linux |
| **Git** | 2.x+ |
| **VS Code** | 1.85+（仅插件模式需要） |

---

## 安装方式

### 方式 A：打包安装程序（推荐）

运行 `ClaudeCodeHaha_Setup_v2.1.89.exe`，按向导完成安装。

**安装过程：**

1. 选择安装目录
2. 选择组件：
   - **核心文件**（必选）— claude.exe + CLI 工具 + IDE 插件
   - **最小 Git Bash 环境**（可选，~52 MB）
   - **嵌入式 Python 3.12**（可选，~58 MB）
3. 勾选"添加到用户 PATH"（推荐）
4. 安装完成后，勾选"配置 API Profile"→ 弹窗输入 DeepSeek API Key

**安装目录结构：**

```
{安装目录}/
  bin/          ← claude.exe + CLI 工具( rg / fd / jq / yq / shellcheck ) + 启动器
  python/       ← 嵌入式 Python 3.12 + pywin32（可选）
  git/          ← 最小 Git Bash（可选）
  extensions/   ← IDE 插件包
    vscode/     ← VS Code (.vsix)
    vs/         ← Visual Studio (.vsix)
    intellij/   ← JetBrains (.zip)
  scripts/      ← TS 工具脚本
```

**安装完成后：**

```powershell
# 验证安装
claude --version

# 配置 API（如安装时跳过了）
claude-profile create

# 安装 VS Code 插件
# Ctrl+Shift+P → Extensions: Install from VSIX
# → 选择 {安装目录}\extensions\vscode\claude-code-ide-0.2.35.vsix
```

---

### 方式 B：源码安装

适合开发者，需要修改源码或调试。

#### 1. 克隆仓库

```bash
git clone https://gitee.com/randomlife/claude-code-haha-dev.git
cd claude-code-haha-dev
```

#### 2. 运行安装脚本

项目自带离线 Bun（bin/bun.exe）和 CLI 工具，不需要联网下载额外依赖。

**PowerShell（推荐）：**

```powershell
.\install.ps1
```

**CMD：**

```cmd
install.cmd
```

**Git Bash：**

```bash
bash install.sh
```

安装脚本会自动完成：

1. **选择模式**：检测到离线工具包时，询问是否使用离线模式
2. **检查 Git**：确认 Git 已安装
3. **安装 Bun**：优先使用 bin/bun.exe 离线备份
4. **配置 PATH**：将 bin/ 添加到用户 PATH
5. **安装依赖**：`bun install` 安装所有 npm 包
6. **安装 CLI 工具**：rg / fd / jq / yq / shellcheck
7. **配置 API**：交互式创建 API profile

> 如遇 PowerShell 执行策略限制，先运行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

#### 3. 配置 API

```powershell
claude-profile create
```

可选模板：DeepSeek Flash / DeepSeek v4 Pro / Custom。

---

## 启动方式

### 终端 TUI 模式

交互式终端界面（Ink 渲染），功能最完整。

**打包安装：**

```powershell
cla              # 交互式 TUI（最简）
claude           # 等效
claude -p "..."  # 单次问答
```

**源码运行：**

```powershell
cla           # 交互式 TUI（最简）
claude-haha   # 等效
```

**Recovery CLI**（TUI 因终端兼容性问题无法启动时）：

```powershell
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 claude
```

### VS Code 插件模式

**1. 安装插件：**

VS Code → `Ctrl+Shift+P` → `Extensions: Install from VSIX` → 选择 `.vsix` 文件

- 打包安装：`{安装目录}\extensions\vscode\claude-code-ide-0.2.35.vsix`
- 源码：项目根目录 `extensions\vscode\claude-code-ide-0.2.35.vsix`

**2. 启动：**

- 点击侧边栏 Claude Code 图标
- 或 `Ctrl+Shift+P` → `Claude Code: Start Chat`

> 其他 IDE 插件：`extensions/vs/ClaudeCodeVS-0.2.10.vsix`（Visual Studio）、`extensions/intellij/claude-code-ide-0.2.10.zip`（JetBrains，`Settings → Plugins → Install from Disk`）

---

## API 配置管理

多套 API 配置通过 Profile 系统管理：

```
~/.claude/.env.profiles/          # 全局 profiles（GUI / cli 默认写入位置）
├── deepseek-v4-pro.env
├── custom-model.env
~/.claude/.env.active            # 当前激活 profile
~/.claude/settings.json          # IDE 扩展读取 env 块

{安装目录}/.env.profiles/        # 安装器写入（向后兼容）
```

**常用命令：**

```powershell
claude-profile create              # 创建新配置
claude-profile list                # 查看所有配置
claude-profile switch <name>       # 切换配置
```

**在 VS Code 中切换：**

状态栏 → 模型名称下拉列表 → 选择 profile → 插件自动重启后端应用新配置。

---

## 命令参考

`bin/` 目录下的所有快捷脚本（安装后无需全路径）：

### 启动

| 命令 | 说明 |
|------|------|
| `cla` | 交互式 TUI（最简） |
| `claude` | 同上 |
| `claude-haha` | 同上 |
| `cla-bypass` | 绕过权限模式（实验性） |
| `claude-ide` | IDE 模式后端 |
| `claude-gui` | 浏览器聊天 UI |

### 配置

| 命令 | 说明 |
|------|------|
| `claude-profile` | API Profile 管理（create / list / switch / delete） |

### 工具

| 命令 | 说明 |
|------|------|
| `cdp-browser` | 启动 Chrome/Edge 调试模式（端口 9222） |
| `cdp-setup` | 自动配置 CDP Inspector MCP |
| `codegraph-cleanup` | 清理代码图谱索引 |
| `kill-claude` | 终止所有 claude 进程 |

---

## 扩展功能

### Playwright MCP（浏览器自动化）

> 详见 [docs/playwright-mcp.md](docs/playwright-mcp.md) — 完整安装指南、配置说明、可用工具表、常见问题。
>
> 快速安装：`./bin/playwright-setup.ps1`（项目级）或 `./bin/playwright-setup.ps1 -User`（用户级）。

### CDP Inspector（浏览器实时渲染检查）

连接 Chrome/Edge 读取真实渲染的 DOM、样式和控制台日志。

```powershell
cdp-browser            # 启动浏览器（带调试端口 9222）
cdp-browser edge       # 启动 Edge
cdp-setup              # 自动配置 CDP MCP
```

### Git Bash（Windows）

打包安装可选组件，提供 bash / git / ls / grep / sed 等 Unix 工具。

---

## 常见问题

### install.ps1 报"无法加载文件"

PowerShell 执行策略限制：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### 打包安装时"拒绝访问"写入 .env.profiles

已修复。`gui-profile.py` 和 `claude-profile` 现在写入 `~/.claude/`，无需管理员权限。

### VS Code 插件模型列表为空

确认 `~/.claude/.env.profiles/` 或安装目录 `.env.profiles/` 下有 `.env` 文件，且包含 `ANTHROPIC_MODEL`。

### Bun 安装失败

项目自带离线 Bun（bin/bun.exe），安装脚本会自动回退到离线模式。

### 终端中文乱码

所有启动器已内置 `chcp 65001`，自动切换 UTF-8 代码页。

### claude 命令找不到

重启终端使 PATH 生效。打包安装时勾选"添加到 PATH"；源码运行时运行 `install.ps1`。

### API 连接失败

1. 确认 `.env.profiles/` 下配置正确
2. 确认 `ANTHROPIC_BASE_URL` 正确
3. 用 `curl` 测试 API 可达性
