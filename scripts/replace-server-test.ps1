# One-click replace: install the "server-enabled" test build into the local install dir.
# Usage: run as admin, or let this script self-elevate.
#   - Stops running claude-code-gui.exe
#   - Backs up the old claude-code-gui.exe -> .bak
#   - Copies the new claude-code-gui.exe + claude-gui-server.exe into the install dir
#   - Optionally relaunch the GUI

$installDir = "C:\Program Files (x86)\Claude Code Haha"
# Source paths resolve relative to this script (scripts/ → repo root), so the
# script works from any checkout location / machine.
$repoRoot = Split-Path -Parent $PSScriptRoot
$guiSrc = Join-Path $repoRoot "gui\src-tauri\target\release\claude-code-gui.exe"
$srvSrc = Join-Path $repoRoot "gui\src-tauri\server\target\release\claude-gui-server.exe"

# --- self-elevate (copying into Program Files needs admin) ---
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Host "Need admin. Re-running elevated (approve the UAC prompt)..." -ForegroundColor Yellow
    Start-Process -FilePath "powershell" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

if (-not (Test-Path $guiSrc)) { Write-Host "Missing new GUI exe: $guiSrc (build it first)" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $srvSrc)) { Write-Host "Missing server exe: $srvSrc" -ForegroundColor Red; exit 1 }

# --- stop running GUI (force-kill all, so no process holds the exe lock) ---
taskkill /F /IM claude-code-gui.exe 2>$null | Out-Null
Start-Sleep -Seconds 2

# --- backup old exe (rollback) ---
if (Test-Path "$installDir\claude-code-gui.exe") {
    Copy-Item "$installDir\claude-code-gui.exe" "$installDir\claude-code-gui.exe.bak" -Force
}

# --- copy new exes ---
Copy-Item $guiSrc "$installDir\claude-code-gui.exe" -Force
Copy-Item $srvSrc "$installDir\claude-gui-server.exe" -Force

Write-Host "Installed:" -ForegroundColor Green
Write-Host ("  claude-code-gui.exe   {0:N0} bytes" -f (Get-Item "$installDir\claude-code-gui.exe").Length)
Write-Host ("  claude-gui-server.exe {0:N0} bytes" -f (Get-Item "$installDir\claude-gui-server.exe").Length)
Write-Host ("  backup: {0}\claude-code-gui.exe.bak" -f $installDir)

# --- relaunch GUI ---
$answer = Read-Host "Launch the GUI? (y/n)"
if ($answer -match '^y') {
    Start-Process "$installDir\claude-code-gui.exe"
}
