@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo Claude Code — 聊天 UI
echo.
bun run extensions\general_ui\start.ts
