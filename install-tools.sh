#!/usr/bin/env bash
# install-tools.sh — 安装开发辅助 CLI 工具
# 仅负责：1) 安装 Bun（如未安装） 2) 委托给 scripts/install-tools.ts
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[--]${NC} $*"; }
err()  { echo -e "${RED}[!!]${NC} $*"; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. 确保 Bun 已安装 ─────────────────────────────────────
if command -v bun &>/dev/null; then
  log "Bun 已安装: $(bun --version)"
else
  warn "Bun 未安装，正在安装..."
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex" || {
        err "Bun 安装失败，请手动安装: https://bun.sh/docs/installation"
        exit 1
      }
      # 安装后 bun 在 %USERPROFILE%\.bun\bin\bun.exe，需确保在 PATH 中
      export PATH="$HOME/.bun/bin:$PATH"
      ;;
    Darwin|Linux)
      curl -fsSL https://bun.sh/install | bash || {
        err "Bun 安装失败，请手动安装: https://bun.sh/docs/installation"
        exit 1
      }
      export PATH="$HOME/.bun/bin:$PATH"
      ;;
    *)
      err "未知平台: $(uname -s)"
      exit 1
      ;;
  esac
  log "Bun 安装完成: $(bun --version)"
fi

# ── 2. 委托给 Bun TypeScript ────────────────────────────────
exec bun run "$ROOT_DIR/scripts/install-tools.ts" "$@"
