# Claude Code Haha — update IDE extensions to latest VSIX/ZIP
# Run from repo root after a fresh build

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path "$root\.."

Write-Host "=== IDE Extension Updater ===" -ForegroundColor Cyan
Write-Host ""

# ── Find available packages ──
$choices = @()

# 1) VS Code
$codeExe = Get-Command code -ErrorAction SilentlyContinue
$vsix = Get-ChildItem "$root\extensions\vscode\claude-code-ide-*.vsix" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($vsix) {
  $choices += [PSCustomObject]@{
    Label = "VS Code ($($vsix.Name))"
    Action = {
      if ($codeExe) {
        Write-Host "  Installing $($vsix.Name)..."
        & code --install-extension $vsix.FullName --force 2>&1 | Out-Null
        Write-Host "  VS Code: done — please reload window (Ctrl+Shift+P → Developer: Reload Window)" -ForegroundColor Green
      } else {
        Write-Host "  VS Code: 'code' not in PATH, cannot auto-install" -ForegroundColor Yellow
      }
    }
  }
}

# 2) Visual Studio
$vsVsix = Get-ChildItem "$root\extensions\vs\ClaudeCodeVS-*.vsix" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($vsVsix) {
  $choices += [PSCustomObject]@{
    Label = "Visual Studio ($($vsVsix.Name))"
    Action = {
      Write-Host "  Visual Studio: manual install required" -ForegroundColor Yellow
      Write-Host "    Double-click $($vsVsix.FullName) or install via VS Extension Manager" -ForegroundColor DarkGray
    }
  }
}

# 3) IntelliJ
$ijZip = Get-ChildItem "$root\extensions\intellij\claude-code-ide-*.zip" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($ijZip) {
  $choices += [PSCustomObject]@{
    Label = "IntelliJ ($($ijZip.Name))"
    Action = {
      Write-Host "  IntelliJ: manual install required" -ForegroundColor Yellow
      Write-Host "    Settings > Plugins > Install Plugin from Disk..." -ForegroundColor DarkGray
      Write-Host "    Select: $($ijZip.FullName)" -ForegroundColor DarkGray
    }
  }
}

if ($choices.Count -eq 0) {
  Write-Host "No extension packages found. Run build first." -ForegroundColor Red
  exit 1
}

# ── Show menu ──
Write-Host "Available extensions:" -ForegroundColor White
for ($i = 0; $i -lt $choices.Count; $i++) {
  Write-Host "  [$($i + 1)] $($choices[$i].Label)"
}
Write-Host "  [A] All of the above"
Write-Host "  [Q] Quit"
Write-Host ""

$pick = Read-Host "Choose (1-$($choices.Count)/A/Q, default: A)"
if ($pick -eq '') { $pick = 'A' }

# ── Execute ──
Write-Host ""
if ($pick -eq 'A' -or $pick -eq 'a') {
  # Install all
  foreach ($c in $choices) {
    Write-Host "[$($c.Label)]" -ForegroundColor Cyan
    & $c.Action
    Write-Host ""
  }
} elseif ($pick -eq 'Q' -or $pick -eq 'q') {
  Write-Host "Cancelled." -ForegroundColor DarkGray
  exit 0
} elseif ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $choices.Count) {
  $idx = [int]$pick - 1
  $c = $choices[$idx]
  Write-Host "[$($c.Label)]" -ForegroundColor Cyan
  & $c.Action
} else {
  Write-Host "Invalid choice: $pick" -ForegroundColor Red
  exit 1
}

Write-Host "=== Done ===" -ForegroundColor Cyan
