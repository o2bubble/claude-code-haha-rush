#!/usr/bin/env pwsh
set-strictmode -version 3.0
$ErrorActionPreference = "Stop"

# 正确获取上级目录（兼容 cmd 调用时 $PSScriptRoot 为空的情况）
$ROOT_DIR = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Get-Location }
$ORIGINAL_CWD = if ($env:ORIGINAL_CWD) { $env:ORIGINAL_CWD } else { Get-Location }
Set-Location "$ROOT_DIR"

# Profile env chain: user default → project override (last wins).
# Skip in IDE mode — the extension manages its own env.
$USER_PROFILE = "$env:USERPROFILE\.claude\profile.env"
$PROJ_PROFILE = "$ROOT_DIR\.claude\profile.env"
$IsIdeMode = $args -contains "--ide-mode"
$ProfileOpts = @()
if (!$IsIdeMode) {
    if (Test-Path $USER_PROFILE) { $ProfileOpts += "--env-file=$USER_PROFILE" }
    if (Test-Path $PROJ_PROFILE) { $ProfileOpts += "--env-file=$PROJ_PROFILE" }
}

# 强制恢复 CLI 模式
if ($env:CLAUDE_CODE_FORCE_RECOVERY_CLI -eq "1") {
    $env:ORIGINAL_CWD = $ORIGINAL_CWD
    bun --env-file="$ROOT_DIR/.env" @ProfileOpts "$ROOT_DIR/src/localRecoveryCli.ts" @args
    exit $LASTEXITCODE
}

# 默认启动完整 CLI
$env:ORIGINAL_CWD = $ORIGINAL_CWD
bun --env-file="$ROOT_DIR/.env" @ProfileOpts "$ROOT_DIR/src/entrypoints/cli.tsx" @args
exit $LASTEXITCODE