# Claude Code Haha

<p align="right"><strong>中文</strong> | <a href="./README.en.md">English</a></p>

基于 Claude Code 泄露源码修复的**本地可运行版本**。

支持接入任意 Anthropic 兼容 API（DeepSeek、Qwen、MiniMax、OpenRouter 等）。

> 原始泄露源码无法直接运行。本仓库修复了启动链路的多个阻塞问题，让完整的 Ink 终端界面能跑起来。

---

## 这个仓库是什么

Claude Code 的 **CLI 引擎**：修复后的源码 + 构建脚本。终端界面、工具系统、斜杠命令、
技能、MCP、权限体系都在这里。

**桌面 GUI 不在本仓库**。图形客户端是独立项目
[lumen-agent-desktop](https://gitee.com/randomlife/lumen-agent-desktop)，它把这里的
`claude` 二进制作为后端驱动。两者可以各自独立构建。

---

## 快速开始

```bash
# 1. 安装 Bun —— https://bun.sh

# 2. 安装依赖
bun install

# 3. 配置 API（复制 .env.example 后填入）
cp .env.example .env
#   ANTHROPIC_AUTH_TOKEN=sk-xxxx
#   ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

# 4. 启动
./bin/claude-haha                                 # macOS / Linux / Git Bash
bun --env-file=.env ./src/entrypoints/cli.tsx     # Windows
```

单次提示（无头模式，适合脚本/CI）：

```bash
./bin/claude-haha -p "your prompt"
echo "explain this" | ./bin/claude-haha -p
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

---

## 项目结构

```
src/                     # 引擎主体
├── entrypoints/         #   CLI 入口（cli.tsx / ideMode.ts / compiled-entry.ts）
├── main.tsx             #   TUI 主逻辑（Commander.js + React/Ink）
├── tools/               #   Agent 工具（Bash/Edit/Grep/Agent…）
├── commands/            #   斜杠命令
├── skills/              #   技能系统
├── services/            #   服务层（API / MCP / OAuth / 插件）
├── ink/                 #   终端渲染引擎
└── utils/               #   工具函数

build/                   # 构建
├── build-claude.ts      #   入口：编译 src/ → claude 二进制
├── engine.ts            #   发布引擎（manifest / zip / 复用校验）
└── componentPlan.ts     #   平台构建规划

bin/                     # 启动脚本（cla / claude / claude-ide / claude-profile…）
stubs/                   # Bun 下缺失的原生模块替身
preload.ts               # Bun preload（设置 MACRO 全局变量）
docs/                    # 架构分析、逆向记录、构建手册
scripts/                 # 辅助脚本（工具安装、诊断、发布）
```

---

## 开发

```bash
# 直接跑源码（改完即时生效）
bun --env-file=.env ./src/entrypoints/cli.tsx

# 降级 Recovery CLI（TUI 出问题时的排查入口）
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha

# 查看全部 CLI 选项
./bin/claude-haha --help
```

---

## 构建

```bash
# 编译 claude 二进制 → dist/
bun run build/build-claude.ts

# 生成发布包（manifest + 组件 zip）
bun run build/build-claude.ts --release 2026.11.05.1 --notes "改了什么"
```

产物落在 `dist/`：`claude.exe`（Windows）或 `claude`（macOS / Linux）。

### 与 GUI 联合构建

如果本地还有 GUI 仓：

```bash
bun run build/joint.ts --gui-repo ../lumen-agent-desktop --release 2026.11.05.1
```

一条命令产出完整的一套（CLI + GUI + Python + Git + 工具链）。该脚本引用另一个仓的
路径，因此**不入库**（已 `.gitignore`）。

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

**关于授权**：本仓库**不附带任何开源许可证**（no license granted）。`src/` 目录下的引擎源码版权归 Anthropic 所有，本仓库作者无权就该部分授予任何许可。

**使用限制**：请勿将本仓库内容（含 `dist/` 构建产物）用于商业用途或对外分发。本仓库仅作为个人学习、研究与技术验证用途。

**权利方声明**：如 Anthropic 或任何权利方认为本仓库内容侵犯其权利，请联系仓库作者，我们将**立即删除**相关内容并停止分发。

---

## 相关

- 桌面客户端：[lumen-agent-desktop](https://gitee.com/randomlife/lumen-agent-desktop)（MIT）
