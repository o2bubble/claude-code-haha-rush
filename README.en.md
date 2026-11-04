# Claude Code Haha

<p align="right"><a href="./README.md">中文</a> | <strong>English</strong></p>

A **locally-runnable version** of Claude Code, repaired from the leaked source.

Works with any Anthropic-compatible API (DeepSeek, Qwen, MiniMax, OpenRouter, …).

> The leaked source does not run as-is. This repo fixes the startup-path blockers so the full Ink terminal UI comes up.

---

## What this repo is

The **CLI engine** of Claude Code: repaired source plus build scripts. The terminal UI,
tool system, slash commands, skills, MCP, and permission layers all live here.

**The desktop GUI is not in this repo.** The graphical client is a separate project,
[lumen-agent-desktop](https://gitee.com/randomlife/lumen-agent-desktop), which drives the
`claude` binary built here. Either can be built independently.

---

## Quick start

```bash
# 1. Install Bun — https://bun.sh

# 2. Install dependencies
bun install

# 3. Configure the API (copy .env.example and fill it in)
cp .env.example .env
#   ANTHROPIC_AUTH_TOKEN=sk-xxxx
#   ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

# 4. Launch
./bin/claude-haha                                 # macOS / Linux / Git Bash
bun --env-file=.env ./src/entrypoints/cli.tsx     # Windows
```

One-shot prompt (headless mode, for scripts/CI):

```bash
./bin/claude-haha -p "your prompt"
echo "explain this" | ./bin/claude-haha -p
```

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | one of | API key, sent via the `x-api-key` header |
| `ANTHROPIC_AUTH_TOKEN` | one of | Auth token, sent via `Authorization: Bearer` |
| `ANTHROPIC_BASE_URL` | no | Custom API endpoint (defaults to Anthropic) |
| `ANTHROPIC_MODEL` | no | Default model |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | no | Sonnet-tier model mapping |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | no | Haiku-tier model mapping |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | no | Opus-tier model mapping |
| `API_TIMEOUT_MS` | no | API timeout, default 600000 (10 min) |
| `DISABLE_TELEMETRY` | no | Set to `1` to disable telemetry |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | no | Set to `1` to disable non-essential requests |

---

## Layout

```
src/                     # engine
├── entrypoints/         #   CLI entry (cli.tsx / ideMode.ts / compiled-entry.ts)
├── main.tsx             #   TUI core (Commander.js + React/Ink)
├── tools/               #   agent tools (Bash/Edit/Grep/Agent…)
├── commands/            #   slash commands
├── skills/              #   skill system
├── services/            #   service layer (API / MCP / OAuth / plugins)
├── ink/                 #   terminal renderer
└── utils/               #   utilities

build/                   # build
├── build-claude.ts      #   entry: compile src/ → claude binary
├── engine.ts            #   release engine (manifest / zip / reuse checks)
└── componentPlan.ts     #   per-platform build plan

bin/                     # launchers (cla / claude / claude-ide / claude-profile…)
stubs/                   # stand-ins for native modules missing under Bun
preload.ts               # Bun preload (sets the MACRO globals)
docs/                    # architecture notes, RE records, build playbooks
scripts/                 # helper scripts (tool install, diagnostics, release)
```

---

## Development

```bash
# Run from source (changes take effect immediately)
bun --env-file=.env ./src/entrypoints/cli.tsx

# Fallback recovery CLI (when the TUI misbehaves)
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha

# List all CLI options
./bin/claude-haha --help
```

---

## Building

```bash
# Compile the claude binary → dist/
bun run build/build-claude.ts

# Build a release (manifest + component zips)
bun run build/build-claude.ts --release 2026.11.05.1 --notes "what changed"
```

Artifacts land in `dist/`: `claude.exe` (Windows) or `claude` (macOS / Linux).

### Joint build with the GUI repo

If you have the GUI repo locally:

```bash
bun run build/joint.ts --gui-repo ../lumen-agent-desktop --release 2026.11.05.1
```

One command produces the full set (CLI + GUI + Python + Git + toolchain). That script
references the other repo's path, so it is **not committed** (it's in `.gitignore`).

---

## Fixes on top of the leaked source

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| TUI won't start | Entry script routed no-arg startup to the recovery CLI | Route to the full `cli.tsx` entry |
| Startup hang | `verify` skill imported a missing `.md`; Bun's text loader hung | Added stub `.md` |
| `--print` hang | `filePersistence/types.ts` missing | Added a type stub |
| `--print` hang | `ultraplan/prompt.txt` missing | Added a resource stub |
| **Enter key dead** | `modifiers-napi` missing; `isModifierPressed()` threw and broke `handleEnter` | Wrapped in try/catch |
| setup skipped | `preload.ts` set `LOCAL_RECOVERY=1` unconditionally | Removed the default |
| Compiled build can't find ripgrep | `bun build --compile` doesn't embed `vendor/ripgrep/` | Multi-path runtime lookup |

---

## Disclaimer

This repo is based on Claude Code source leaked from the Anthropic npm registry on 2026-03-31. All original source is copyright [Anthropic](https://www.anthropic.com). For study and research only.

**License**: **No license is granted.** The engine source under `src/` is Anthropic's, and the author of this repo has no standing to license it.

**Usage**: Do not use this repo (including `dist/` artifacts) for commercial purposes or public distribution. Personal study, research, and technical verification only.

**Rights holders**: If Anthropic or any rights holder believes this repo infringes, contact the author and the content will be **removed immediately** and distribution stopped.

---

## Related

- Desktop client: [lumen-agent-desktop](https://gitee.com/randomlife/lumen-agent-desktop) (MIT)
