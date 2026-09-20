# install.ps1 — Claude Code Haha 安装引导 (PowerShell)
# 仅负责：1) 安装 Bun（如未安装） 2) 委托给 scripts/install.ts
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function IsInteractive {
    return -not $([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-' })
}

Write-Host ""
Write-Host "=========================================="
Write-Host "  Claude Code — 安装"
Write-Host "=========================================="
Write-Host ""

# ── Step 1: 确保 Bun 已安装 ─────────────────────────────
$bunPath = Get-Command bun -ErrorAction SilentlyContinue
if ($bunPath) {
    Write-Host "[OK] Bun 已安装: $(bun --version)"
} else {
    Write-Host "[--] Bun 未安装，正在安装..."
    $installed = $false

    # 尝试离线 bun
    $offlineBun = Join-Path $scriptDir "offline-tools\windows\bun.exe"
    $binDir = Join-Path $scriptDir "bin"
    if (Test-Path $offlineBun) {
        Write-Host "[--] 从离线备份安装..."
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        Copy-Item $offlineBun "$binDir\bun.exe" -Force
        $env:PATH = "$binDir;$env:PATH"
        if (Get-Command bun -ErrorAction SilentlyContinue) {
            Write-Host "[OK] bun 已从离线备份安装: $(bun --version)"
            $installed = $true
        }
    }

    # 在线安装 (bun.sh) — 官方安装脚本
    if (-not $installed) {
        Write-Host "[--] 将使用官方脚本在线安装 Bun: https://bun.sh"
        $confirm = Read-Host "是否继续? (Y/n)"
        if ($confirm -eq '' -or $confirm -match '^[Yy]') {
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-RestMethod bun.sh/install.ps1 -UseBasicParsing | Invoke-Expression
                if (Get-Command bun -ErrorAction SilentlyContinue) {
                    Write-Host "[OK] bun 安装完成: $(bun --version)"
                    $installed = $true
                }
            } catch {
                Write-Host "[!!] bun.sh 安装失败: $_"
            }
        } else {
            Write-Host "[!!] 用户取消在线安装"
        }
    }

    # 备用: npm install -g bun
    if (-not $installed -and (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host "[--] 尝试通过 npm 安装..."
        try {
            npm install -g bun 2>$null
            if (Get-Command bun -ErrorAction SilentlyContinue) {
                Write-Host "[OK] bun 安装完成 (via npm): $(bun --version)"
                $installed = $true
            }
        } catch {
            Write-Host "[!!] npm install -g bun 也失败了: $_"
        }
    }

    if (-not $installed) {
        Write-Host "[!!] 所有安装方式均失败，请手动安装: https://bun.sh"
        if (IsInteractive) { pause }
        exit 1
    }
}

# ── Step 2: 委托给 Bun TypeScript ───────────────────────
Write-Host "[>>] 启动安装程序..."
Write-Host ""
bun run "$scriptDir\scripts\install.ts"

if ($LASTEXITCODE -ne 0) {
    Write-Host "[!!] 安装程序异常退出 (code: $LASTEXITCODE)"
    if (IsInteractive) { pause }
    exit $LASTEXITCODE
}

if (IsInteractive) { pause }
