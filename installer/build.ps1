# Claude Code Haha 安装程序打包脚本
#
# 版本号来源：**dist\manifest.json 的 version**（项目发布版本，如 2026.09.20.6）——
# 与 build.ts / 发布脚本用的是同一份数据，保证安装包名与发布版本一一对应。
#
# ⚠️ 历史教训：这里曾写死 `2.1.89`（那是 claude.exe 的**上游**版本）+ 按周数算
# BuildTag（2026W38）—— 两个都跟项目版本体系（日期式，如 2026.09.20.6）无关，
# 结果安装包文件名 `..._v2.1.89_2026W38.exe` 里**找不到任何发布版本信息**，
# 用户拿到包无法判断对应哪次发布。

param(
  [switch]$Quick        # skip version confirmation
)

$ErrorActionPreference = "Stop"

# ── Read version from dist\manifest.json ──
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$manifestPath = Join-Path $repoRoot "dist\manifest.json"

if (-not (Test-Path $manifestPath)) {
  Write-Error "manifest.json not found: $manifestPath`n  Run a build first: bun run scripts/build.ts --release <version> --components gui"
  exit 1
}

# ⚠️ **必须显式 -Encoding UTF8** —— Windows PowerShell 5.1 的 Get-Content 默认按
# 系统 ANSI（简中即 GBK）读文件，而 manifest.json 是 UTF-8（release_notes 含中文）
# → 乱码 → ConvertFrom-Json 抛 ArgumentException（表象像"JSON 非法"，实为编码问题）。
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
if (-not $version) {
  Write-Error "manifest.json has no 'version' field: $manifestPath"
  exit 1
}

Write-Host "  Version (from dist\manifest.json): $version" -ForegroundColor Cyan

# ── Verify the packaged binaries exist & show their freshness ──
# 安装包把 dist\ 下的现成产物打进去 —— 如果某个关键文件缺失或过旧，
# 早点发现比装完再查便宜（曾漏过 office/ 的打包，见 setup.iss 的 [Files]）。
$required = @(
  "claude.exe", "bun.exe", "claude-code-gui.exe", "claude-gui-server.exe",
  "Update.exe", "manifest.json"
)
$missing = @()
foreach ($f in $required) {
  $p = Join-Path $repoRoot "dist\$f"
  if (-not (Test-Path $p)) { $missing += $f }
}
# Extensions are required (office bridge + IDE plugins)
foreach ($d in @("extensions", "bin", "scripts")) {
  $p = Join-Path $repoRoot "dist\$d"
  if (-not (Test-Path $p)) { $missing += "$d\" }
}
if ($missing.Count -gt 0) {
  Write-Error "dist\ is incomplete, missing: $($missing -join ', ')"
  exit 1
}

Write-Host "  Key files present:" -ForegroundColor DarkGray
foreach ($f in $required) {
  $p = Join-Path $repoRoot "dist\$f"
  $age = (Get-Date) - (Get-Item $p).LastWriteTime
  $ageStr = if ($age.TotalHours -lt 1) { "{0:N0}m ago" -f $age.TotalMinutes }
            elseif ($age.TotalDays -lt 1) { "{0:N1}h ago" -f $age.TotalHours }
            else { "{0:N0}d ago" -f $age.TotalDays }
  Write-Host ("    {0,-24} {1,10}  ({2})" -f $f, ("{0:N1} MB" -f ((Get-Item $p).Length / 1MB)), $ageStr) -ForegroundColor DarkGray
}

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

if (-not $Quick) {
  Write-Host ""
  Write-Host "  Will package: ClaudeCodeHaha_Setup_v$version.exe" -ForegroundColor Yellow
  $ans = Read-Host "  Continue? [Y/n]"
  if ($ans -and $ans -ne "y" -and $ans -ne "Y") { Write-Host "  Aborted."; exit 0 }
}

# ── Compile ──
Push-Location $scriptDir
try {
  Write-Host "  Compiling..."
  & $iscc setup.iss "/DMyAppVersion=$version"
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

  $out = Join-Path $repoRoot "dist\ClaudeCodeHaha_Setup_v$version.exe"
  if (Test-Path $out) {
    $sizeMB = [math]::Round((Get-Item $out).Length / 1MB, 1)
    Write-Host ""
    Write-Host "  Done: $out ($sizeMB MB)" -ForegroundColor Green
  } else {
    Write-Host "  Done (output path unexpected — check OutputDir in setup.iss)" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
