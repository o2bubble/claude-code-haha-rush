@echo off
REM Office COM Bridge -- prompt guide injection
REM Thin wrapper, delegates to scripts/inject-office-bridge.ts

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."

REM Try bun in PATH first, then fall back to bundled Python + script
where bun >nul 2>&1
if %errorlevel% equ 0 (
    bun run "%REPO_ROOT%\scripts\inject-office-bridge.ts" %*
    exit /b %errorlevel%
)

REM Fallback: if claude-haha is installed (dist), look for bun there
if exist "%REPO_ROOT%\..\runtime\bun\bun.exe" (
    "%REPO_ROOT%\..\runtime\bun\bun.exe" run "%REPO_ROOT%\scripts\inject-office-bridge.ts" %*
    exit /b %errorlevel%
)

echo [ERROR] bun not found. Please install bun or run: bun run scripts/inject-office-bridge.ts
exit /b 1
