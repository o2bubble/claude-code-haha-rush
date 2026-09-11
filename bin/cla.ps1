#!/usr/bin/env pwsh
set-strictmode -version 3.0
$ErrorActionPreference = "Stop"

# 正确获取上级目录（兼容 cmd 调用时 $PSScriptRoot 为空的情况）
$ROOT_DIR = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Get-Location }
$ORIGINAL_CWD = if ($env:ORIGINAL_CWD) { $env:ORIGINAL_CWD } else { Get-Location }
Set-Location "$ROOT_DIR"

# 强制恢复 CLI 模式
if ($env:CLAUDE_CODE_FORCE_RECOVERY_CLI -eq "1") {
    $env:ORIGINAL_CWD = $ORIGINAL_CWD
    bun --env-file="$ROOT_DIR/.env" "$ROOT_DIR/src/localRecoveryCli.ts" @args
    exit $LASTEXITCODE
}

# 默认启动完整 CLI
$env:ORIGINAL_CWD = $ORIGINAL_CWD
bun --env-file="$ROOT_DIR/.env" "$ROOT_DIR/src/entrypoints/cli.tsx" @args
exit $LASTEXITCODE