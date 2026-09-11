# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a repaired, locally-runnable version of Claude Code based on the 2026-03-31 leaked source from the Anthropic npm registry. The original leaked source does not run as-is — this repo fixes multiple startup-path blockers so the full Ink-based terminal UI (TUI) works against any Anthropic-compatible API.

**Runtime**: Bun (NOT Node.js).  
**Language**: TypeScript with React JSX (`tsconfig.json` → `"jsx": "react-jsx"`).  
**TUI framework**: React + [Ink](https://github.com/vadimdemedes/ink) 6.x.  
**CLI framework**: Commander.js (`@commander-js/extra-typings`).

## Commands

```bash
# Install dependencies
bun install

# Interactive TUI mode (Windows — recommended)
bun --env-file=.env ./src/entrypoints/cli.tsx

# Interactive TUI mode (macOS/Linux, or Windows Git Bash)
./bin/claude-haha

# Headless / --print mode (single prompt, CI/scripts)
bun --env-file=.env ./src/entrypoints/cli.tsx -p "your prompt"
echo "explain this" | ./bin/claude-haha -p

# Recovery CLI (simplified readline loop, no Ink TUI)
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha
# or directly:
bun --env-file=.env ./src/localRecoveryCli.ts

# Show all CLI options
./bin/claude-haha --help
```

## Available CLI Tools

This project installs the following tools via `install-tools.sh`. **Use them when running shell commands.**

| Tool | Command | Why | Instead of |
|------|---------|-----|------------|
| ripgrep | `rg` | Fast code content search | `grep`, `grep -r` |
| fd | `fd` | Fast file finding | `find`, `ls -R` |
| jq | `jq` | JSON parsing/querying | `python -c`, `JSON.parse` in scripts |
| yq | `yq` | YAML/TOML/JSON processing | Manual parsing |
| shellcheck | `shellcheck` | Shell script validation | Running blindly |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | API key sent via `x-api-key` header |
| `ANTHROPIC_AUTH_TOKEN` | Auth token sent via `Authorization: Bearer` header |
| `ANTHROPIC_BASE_URL` | Custom API endpoint (default: Anthropic official) |
| `ANTHROPIC_MODEL` | Default model name |
| `ANTHROPIC_DEFAULT_SONNET/HAIKU/OPUS_MODEL` | Per-tier model overrides |
| `API_TIMEOUT_MS` | API timeout in ms (default: 600000) |
| `DISABLE_TELEMETRY=1` | Disable telemetry |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Disable non-essential network requests |

## Architecture

### Startup flow

```
bin/claude-haha → bun --env-file=.env → preload.ts → src/entrypoints/cli.tsx
```

1. **`preload.ts`** — Sets `MACRO` global (VERSION, PACKAGE_URL, BUILD_TIME, etc.) before any module loads. Also sets `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1`.
2. **`src/entrypoints/cli.tsx`** — Bootstrap entrypoint. All imports are dynamic for fast-pathing. Checks for special flags (`--version`, `--print`, `--daemon-worker`, `--claude-in-chrome-mcp`, `--tmux`, etc.) before loading the heavy `main.tsx`.
3. **`src/main.tsx`** — Core CLI setup. Builds the Commander.js program, loads tools/commands/skills/plugins, renders the Ink TUI via `renderAndRun()`. This is the largest file (~800KB — includes inline source maps).
4. **`src/setup.ts`** — Initialization: cwd resolution, terminal backup restoration, worktree creation, background jobs, prefetching, and safety checks (root-user bypass guard).

### Key subsystems

- **`src/tools/`** — Agent tools (BashTool, FileEditTool, FileReadTool, GrepTool, AgentTool, etc.). Each tool is a class implementing the `Tool` interface from `src/Tool.ts`. Tools are registered in `src/tools.ts`.
- **`src/commands/`** — Slash commands (`/commit`, `/review`, `/config`, etc.). Loaded and registered in `src/commands.ts`.
- **`src/services/`** — Service layer: API client, MCP client/server, OAuth, LSP, analytics, plugins, policy limits, remote managed settings.
- **`src/screens/REPL.tsx`** — Main interactive REPL screen rendered by Ink.
- **`src/ink/`** — Low-level Ink terminal rendering engine (custom components, hooks, layout, I/O, events).
- **`src/components/`** — Reusable UI components (PromptInput, Spinner, StructuredDiff, permissions dialogs, etc.).
- **`src/skills/`** — Skill system (bundled skills + search).
- **`src/hooks/`** — React hooks for the TUI (text input, notifications, tool permissions, etc.).
- **`src/utils/`** — Utilities: git, shell execution, file persistence, auth, config, settings, sandbox, memory, telemetry, model selection, etc.

### Feature flags (DCE)

The codebase uses `feature()` from `bun:bundle` for build-time dead code elimination. Many subsystems are gated behind feature flags like `KAIROS`, `DAEMON`, `BRIDGE_MODE`, `BG_SESSIONS`, `AGENT_TRIGGERS`, `VOICE_MODE`, `PROACTIVE`, etc. When working in this local tree, assume these are NOT enabled unless explicitly set.

### Stubs (native module replacements)

The `stubs/` directory contains TypeScript stub files that replace native Node modules not available in Bun:
- **`stubs/color-diff-napi.ts`** — Stub for `color-diff-napi` native package. Maps to `src/native-ts/color-diff/index.ts`.
- **`stubs/ant-claude-for-chrome-mcp.ts`** — Stub for `@ant/claude-for-chrome-mcp`.

These are mapped via `tsconfig.json` paths:
```json
"paths": {
  "@ant/claude-for-chrome-mcp": ["./stubs/ant-claude-for-chrome-mcp.ts"],
  "color-diff-napi": ["./stubs/color-diff-napi.ts"],
  "src/*": ["./src/*"]
}
```

## Edit History

Every file edit made through the VS Code plugin is appended to a **per-project** JSONL log at `~/.claude/projects/<project-slug>/edit-history.jsonl`. Each entry stores a **unified diff** (not full file content), making it compact and practical.

### When to read it

Read the edit history (last 20 lines via `tail -n 20`) in any of these scenarios:

| When the user says... | It means... | What to do |
|-----------------------|-------------|------------|
| "回顾/回顾一下/之前改了啥/改了什么/最近改了啥" | Wants to hear what changed recently | Read history → summarize edits |
| "撤销/撤销上次修改/回退/回滚/恢复" | Wants to undo a previous edit | Read history → find target entry → reverse the diff to restore the file |
| "编辑历史/修改记录/改动记录" | Wants to see edit history | Read history → summarize edits |
| "清空编辑历史/清除记录" | Wants to delete history | Delete the JSONL file directly |

**After context compaction**: Also read the last 20 lines to restore awareness of previous edits.

If the user asks about a **specific file**, filter with `rg`:
```bash
rg '"filePath":"*filename.ts"' ~/.claude/projects/d-Development-claude-code-haha-dev/edit-history.jsonl
```

### How to undo/rollback

1. Read the edit history to find the target entry's `diff` field
2. The `diff` is a unified diff string — reverse the `+`/`-` signs and apply with `patch -R` or reconstruct the old content manually
3. Write the restored content back to the file

### Format

```jsonl
{"timestamp":"2026-05-25T02:36:18.123Z","filePath":"<abs-path>","label":"AI 编辑: filename.ts","diff":"--- original\\n+++ modified\\n@@ -1,5 +1,7 @@\\n..."}
```

### Clear

When the user says "清空编辑历史" or similar, delete this file. Safe to delete — the backend recreates it on the next edit.

```bash
rm ~/.claude/projects/d-Development-claude-code-haha-dev/edit-history.jsonl
```

### Key fixes applied to the leaked source

1. **TUI not starting** — Entry script was routing no-arg invocation to recovery CLI instead of `cli.tsx`.
2. **Startup hang** — `verify` skill imported a missing `.md` file; Bun's text loader hung indefinitely. Added stub `.md` files.
3. **`--print` hang** — Missing `filePersistence/types.ts` and `ultraplan/prompt.txt`. Added stub files.
4. **Enter key unresponsive** — `modifiers-napi` native package missing; `isModifierPressed()` threw, breaking `handleEnter` → `onSubmit`. Fixed via try-catch in `src/utils/modifiers.ts` (Line 37-39).
5. **Setup skipped** — `preload.ts` originally set `LOCAL_RECOVERY=1` unconditionally. Removed this default.
6. **Ripgrep missing in compiled claude.exe** — `bun build --compile` doesn't embed `vendor/ripgrep/` (it's resolved at runtime, not imported), and `USE_BUILTIN_RIPGREP` unset defaults to the builtin branch → compiled binary found no rg and degraded to plain grep. `getRipgrepConfig` now searches `{exe}/bin/rg.exe` (install's `bin/` = the `tools` update component) → `vendor/ripgrep/<arch>-win32/rg.exe` → system `rg`. rg.exe stays in `bin/` (not beside claude.exe) so the update system manages it as a component. See `src/utils/ripgrep.ts`.

## Agent skills

### Issue tracker

Issues/PRDs live as local markdown: specs under `.scratch/<feature-slug>/`, implementation tickets in a root `tickets.md`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical labels, using the default strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo. `CONTEXT.md` and `docs/adr/` when present. See `docs/agents/domain.md`.
