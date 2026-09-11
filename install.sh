#!/usr/bin/env bash
# install.sh — Claude Code Haha 安装引导
# 仅负责：1) 安装 Bun（如未安装） 2) 委托给 scripts/install.ts
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[--]${NC} $*"; }
err()  { echo -e "${RED}[!!]${NC} $*"; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "=========================================="
echo "  Claude Code — 安装"
echo "=========================================="
echo ""

# ── Step 1: 确保 Bun 已安装 ─────────────────────────────
if command -v bun &>/dev/null; then
    log "Bun 已安装: $(bun --version)"
else
    warn "Bun 未安装，正在安装..."
    case "$(uname -s)" in
        Darwin|Linux)
            curl -fsSL https://bun.sh/install | bash || {
                err "Bun 安装失败，请手动安装: https://bun.sh"
                exit 1
            }
            export PATH="$HOME/.bun/bin:$PATH"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex" || {
                # 离线回退
                OFFLINE_BUN="$ROOT_DIR/offline-tools/windows/bun.exe"
                if [[ -f "$OFFLINE_BUN" ]]; then
                    warn "在线安装失败，使用离线备份..."
                    cp "$OFFLINE_BUN" "$ROOT_DIR/bin/bun.exe"
                    export PATH="$ROOT_DIR/bin:$PATH"
                else
                    err "Bun 安装失败，请手动安装: https://bun.sh"
                    exit 1
                fi
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

# ── Step 2: 委托给 Bun TypeScript ───────────────────────
echo "[>>] 启动安装程序..."
echo ""
exec bun run "$ROOT_DIR/scripts/install.ts" "$@"
