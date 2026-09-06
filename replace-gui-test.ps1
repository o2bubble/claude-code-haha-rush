# Local GUI replace (only claude-code-gui.exe, keep server)
# Usage: run as admin (copy into Program Files needs elevation)
#   - kill running claude-code-gui.exe
#   - backup current exe -> .bak
#   - copy newly built exe (with naming-refactor frontend)
#   - relaunch GUI

$installDir = "C:\Program Files (x86)\Claude Code Haha"
# Newly built GUI exe (current repo)
$guiNew = "D:\Development\claude-code-haha-dev\gui\src-tauri\target\release\claude-code-gui.exe"

# --- self-elevate (copying into Program Files needs admin) ---
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Host "Need admin. Re-running elevated (approve the UAC prompt)..." -ForegroundColor Yellow
    Start-Process -FilePath "powershell" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

if (-not (Test-Path $guiNew)) { Write-Host "Missing new exe: $guiNew (run cargo tauri build --no-bundle first)" -ForegroundColor Red; exit 1 }

# --- kill running GUI (else exe locked, cannot replace) ---
Write-Host "Stopping claude-code-gui.exe..." -ForegroundColor Cyan
taskkill /F /IM claude-code-gui.exe 2>$null | Out-Null
Start-Sleep -Seconds 2

# --- backup old exe (rollback) ---
if (Test-Path "$installDir\claude-code-gui.exe") {
    Copy-Item "$installDir\claude-code-gui.exe" "$installDir\claude-code-gui.exe.bak" -Force
    Write-Host "Backed up old exe -> claude-code-gui.exe.bak" -ForegroundColor Green
}

# --- copy new exe ---
Copy-Item $guiNew "$installDir\claude-code-gui.exe" -Force
Write-Host ("Installed: claude-code-gui.exe  {0:N0} bytes" -f (Get-Item "$installDir\claude-code-gui.exe").Length) -ForegroundColor Green

# --- relaunch GUI ---
Write-Host "Relaunching GUI..." -ForegroundColor Cyan
Start-Process "$installDir\claude-code-gui.exe"
Write-Host "Done. GUI should have reopened." -ForegroundColor Green

# --- rollback note ---
Write-Host ""
Write-Host "[ROLLBACK] If issues: exit GUI, then copy claude-code-gui.exe.bak over claude-code-gui.exe"
