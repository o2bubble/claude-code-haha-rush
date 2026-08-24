# Claude Code Haha 安装程序打包脚本
# 自动计算当前周数作为 Build Tag，调用 Inno Setup 编译

param(
  [switch]$Quick        # skip version confirmation
)

$ErrorActionPreference = "Stop"

# ── Compute build tag: 2026W28 ──
Write-Host "  Build Tag"

$today = Get-Date
$year = $today.Year
$jan1 = Get-Date -Year $year -Month 1 -Day 1
$dayOfYear = ($today - $jan1).Days + 1
$week = [math]::Floor(($dayOfYear - 1) / 7) + 1
$buildTag = "$year`W$week"

Write-Host "  Build tag: $buildTag"

# ── Locate ISCC ──
$iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
  "${env:ProgramFiles}\Inno Setup 7\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
  Write-Error "ISCC.exe not found. Install Inno Setup: https://jrsoftware.org/isdl.php"
  exit 1
}
Write-Host "  ISCC: $iscc" -ForegroundColor DarkGray

# ── Compile ──
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptDir
try {
  Write-Host "  Compiling..."
  & $iscc setup.iss /DBuildTag=$buildTag
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
  Write-Host "  Done: dist\ClaudeCodeHaha_Setup_v*_$buildTag.exe"
} finally {
  Pop-Location
}
