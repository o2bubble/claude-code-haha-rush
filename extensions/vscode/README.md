# Claude Code IDE

AI-powered coding assistant in VS Code sidebar. Community-maintained fork based on Claude Code that works with any Anthropic-compatible API.

> **中文用户请查看 [GUIDE.md](./GUIDE.md)** — 包含完整的中文使用指南。

---

## Features

- **Chat panel** — Ask questions, explain code, refactor, debug, right in your sidebar
- **Streaming output** — Real-time thinking blocks, tool output, and streaming responses
- **CDP Inspector** — Inspect real browser DOM, styles, and console logs via Chrome DevTools Protocol (MCP-based)
- **Edit history** — AI edit history persisted across sessions with diff-based JSONL logging
- **Permission control** — 5 modes: Default / Accept Edits / Plan Mode / Bypass / Don't Ask
- **Model profiles** — Switch between multiple API configurations from the status bar
- **Session management** — Browse, search, rename, delete, pin, and resume past conversations
- **File tools** — Read, edit, write, search (grep/glob) files with inline diff preview
- **@mention files** — Attach files from workspace tree with keyboard navigation
- **Markdown editor** — Structured message editing with live preview
- **Custom quick commands** — Create reusable command shortcuts
- **Background tasks** — Run agents and shell commands with progress tracking
- **Plan mode** — Step-by-step execution plans with dependency tracking
- **Rewind points** — Save and restore conversation checkpoints
- **Side questions** — Ask quick questions without interrupting ongoing tasks
- **i18n** — English and Simplified Chinese (zh-cn) support
- **Dual theme** — Automatically matches VS Code's dark/light theme
- **Message filter** — Filter chat history by All / You / Claude

---

## Quick Start

### Prerequisites

- **VS Code** 1.85+
- **Bun** runtime — Install: `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows) or `curl -fsSL https://bun.sh/install | bash` (macOS/Linux)
- **Git**

### 1. Clone & Install

```bash
git clone https://gitee.com/randomlife/claude-code-haha-dev.git
cd claude-code-haha-dev

# Install dependencies and dev tools
bash install.sh          # Git Bash / WSL / macOS / Linux
# or: .\install.ps1     # Windows PowerShell
```

### 2. Configure API

Use the profile manager to set up your API configuration:

```bash
# Create a profile (interactive)
bash bin/claude-profile create

# List profiles
bash bin/claude-profile list

# Switch profiles
bash bin/claude-profile switch <profile-name>
```

Three templates are available during creation:

| Template | Description |
|----------|-------------|
| **DeepSeek v4 Pro** | Pre-configured for DeepSeek, just enter your auth token |
| **DeepSeek v4 Flash** | Same but with the faster Flash model |
| **Custom** | Full manual configuration |

Profiles are stored in `.env.profiles/` directory. Switching a profile writes the env vars to `~/.claude/settings.json`'s `env` block, shared between CLI and IDE.

Alternatively, create manually:

```bash
mkdir -p .env.profiles
cat > .env.profiles/my-model.env << 'EOF'
ANTHROPIC_AUTH_TOKEN=your_key_here
ANTHROPIC_BASE_URL=https://api.example.com/anthropic
ANTHROPIC_MODEL=your-model-name
EOF

# Activate it
bash bin/claude-profile switch my-model
```

### 3. Install the Extension

**Option A: Pre-built VSIX (recommended)**

A pre-built VSIX is included in the repository:

```bash
extensions/vscode/claude-code-ide-0.2.6.vsix
```

Install in VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX` → select the `.vsix` file.

**Option B: Build from source**

```bash
cd extensions/vscode
npm install
npm run compile
npx vsce package
```

Then install the generated `.vsix` file as above.

**Option C: F5 Debug**

```bash
cd extensions/vscode && npm install
```

Open `extensions/vscode/` in VS Code and press `F5`.

### 4. Start Chat

- Click the **Claude Code icon** in the sidebar
- Or `Ctrl+Shift+P` → `Claude Code: Start Chat`
- Or click `Claude Code` in the VS Code status bar

---

## Status Bar Controls

The status bar at the bottom of the chat panel provides quick access to key functionality:

| Control | Description |
|---------|-------------|
| **Connection Indicator** | 🔵 Connected / 🟡 Connecting / 🔴 Disconnected |
| **Shield (Permission Mode)** | Click to switch between permission modes |
| **Model Name** | Click to switch API profiles |
| **Context Bar (XX%)** | Click to view token usage details and compact conversation |
| **Lightning (Quick Commands)** | Click to trigger preset commands |
| **Status Text** | Current state: Ready / Thinking / Compacting... |

---

## Permission Modes

| Mode | Behavior |
|------|----------|
| **Default** | Prompt for approval on risky actions (shell commands, file edits) |
| **Accept Edits** | Auto-approve file edits, prompt for everything else |
| **Plan Mode** | AI plans first, then executes after your approval |
| **Bypass** | Auto-approve all actions — no prompts |
| **Don't Ask** | Remember your last choice per action type |

---

## Slash Commands

Type `/` in the input box to trigger commands:

| Command | Description |
|---------|-------------|
| `/commit` | Generate Git commit message |
| `/review` | Review code changes |
| `/explain` | Explain selected code |
| `/config` | View/modify configuration |
| `/status` | Show IDE status |
| `/stats` | Show usage statistics |
| `/memory` | Manage AI memory |
| `/model` | Temporarily switch model |
| `/compact` | Compact conversation context |
| `/export` | Export conversation |
| `/hooks` | Manage hooks |

---

## Key Bindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` → `Claude Code: Start Chat` | Open chat panel |
| `Ctrl+Shift+L` | Send selected code to Claude |
| Right-click file → `Add to Claude Chat` | Attach file to conversation |
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| Click stop button | Interrupt generation |

---

## Architecture Overview

```
VS Code Extension Host                    Bun Backend
┌─────────────────────┐     WebSocket     ┌──────────────┐
│  provider.ts        │ ◄──────────────► │  ideMode.ts  │
│  processManager.ts  │    JSON messages  │  CLI core    │
│  webview (HTML/JS)  │                   │  Tools/Agents│
└─────────────────────┘                   └──────────────┘
```

- **Extension Host** (`extensions/vscode/`): VS Code extension that spawns a Bun process and communicates via WebSocket
- **WebView** (`media/webview/`): UI built with vanilla JS, no framework dependencies
- **Backend** (`src/`): Claude Code engine running under Bun, manages tools, agents, sessions
- **CDP Inspector** (`extensions/cdp-inspector/`): MCP server for browser DevTools Protocol inspection

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Plugin won't start** | Check `.env` file exists with valid API config. Set `claudeCode.cliPath` if needed. Check output panel (`Ctrl+Shift+U` → "Claude Code"). |
| **No profiles in dropdown** | Ensure `.env.profiles/` exists with `.env` files. Each needs `ANTHROPIC_MODEL` + auth key. |
| **Always "Connecting..."** | Check API endpoint and network. Verify auth credentials. Restart chat panel. |
| **Garbled terminal output** | Windows encoding issue. Plugin auto-detects UTF-8/GBK. Use Git Bash if problems persist. |
| **Model shows "Default"** | No model name received from backend. Check API configuration. |
| **Permission buttons in English** | Ensure `claudeCode.language` is set correctly in VS Code settings. |
| **Can't scroll messages** | Restart chat panel or reload webview (`Developer: Reload Webview`). |
| **Extension not activating** | Check VS Code version (1.85+). Reinstall from VSIX. |

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | API key sent via `x-api-key` header |
| `ANTHROPIC_AUTH_TOKEN` | Auth token sent via `Authorization: Bearer` |
| `ANTHROPIC_BASE_URL` | Custom API endpoint |
| `ANTHROPIC_MODEL` | Default model name |
| `ANTHROPIC_DEFAULT_SONNET/HAIKU/OPUS_MODEL` | Per-tier model overrides |
| `API_TIMEOUT_MS` | API timeout in ms (default: 600000) |
| `DISABLE_TELEMETRY=1` | Disable telemetry |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Block non-essential network requests |

---

## Changelog

### 0.2.6

- Feature: edit history JSONL — AI edits persisted across sessions, supports undo/rollback
- Feature: edit history uses unified diff format (compact storage)
- Feature: CDP Inspector MCP server — inspect real browser DOM, styles, console logs
- Feature: XPath selector support in CDP Inspector
- Feature: Edge browser support in CDP Inspector
- Fix: install script PS 5.1 compatibility (no `-AsHashtable`, `ContainsKey`)
- Fix: install script offline mode support
- Fix: install script PATH ordering (user before system)
- Docs: comprehensive SETUP.md rewrite, CDP Inspector README

### 0.2.2

- Fix: permission prompt buttons now properly localized (was hardcoded English)
- Fix: model name displayed in status bar on first connection
- Fix: interrupt during permission prompt returns correct "interrupted" reason
- Fix: scrolling after compaction no longer breaks conversation
- Fix: plan panel updates after context compaction
- Fix: Windows shell output encoding (UTF-8/GBK fallback)
- Fix: model switch now interrupts current task before restarting
- Fix: extra blank lines before pasted content and file chips
- Fix: markdown preview supports multi-line content
- Fix: install script preserves system PATH correctly
- Feature: markdown content styles (tables, lists, blockquotes, code)

### 0.2.1

- Fix: session memory compaction skipped in IDE mode (always uses API path)
- Fix: historyRenderStart clamp after compaction
- Fix: plan panel refresh after compaction
- Fix: thinking_delta unthrottled (direct DOM append)
- Fix: input area chip insertion position
- Fix: decodePlatformOutput for Windows GBK encoding

### 0.2.0

- Complete UI redesign with component-based architecture
- GitHub Dark/Light dual theme with semantic color tokens
- Message filter bar (All / You / Claude)
- Context window detail overlay with compact action
- Status bar dropdowns for permission mode, model profile, quick commands
- Structure mode markdown editor with live preview
- Custom quick commands CRUD
- i18n support (en, zh-cn)
- Rewind points list and restore
- Side question dialog integration
- Task management panel with progress tracking
- Plan tasks display
- Enhanced @mention file picker with workspace tree
- Inline permission prompt with diff preview

### 0.1.0

- Initial release
- Basic chat panel with streaming support
- Session history (TUI sessions, read-only)
- Tool permission prompts
- Thinking block rendering
- Image paste support
- Emoji quick-pick panel
- Model profile switching
