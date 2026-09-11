@echo off
chcp 65001 >nul
setlocal
if not defined ORIGINAL_CWD set "ORIGINAL_CWD=%cd%"
cd /d "%~dp0.."
set "ORIGINAL_CWD=%ORIGINAL_CWD%"
bun --env-file=.env ./src/entrypoints/cli.tsx --permission-mode bypassPermissions %*
