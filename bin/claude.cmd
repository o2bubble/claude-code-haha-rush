@echo off
chcp 65001 >nul
setlocal
set CLAUDE_CODE_SAFE_WRITE=1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude.ps1" %*
