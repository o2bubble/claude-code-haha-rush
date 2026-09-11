@echo off
setlocal enabledelayedexpansion

chcp 65001 >nul

REM install-tools.cmd — Windows wrapper that installs Bun then delegates
REM 用法: double-click or run from cmd

where bun >nul 2>nul
if !ERRORLEVEL! EQU 0 (
    echo [OK] Bun 已安装
) else (
    echo [--] Bun 未安装，正在安装...
    powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"
    if !ERRORLEVEL! NEQ 0 (
        echo [!!] Bun 安装失败，请手动安装: https://bun.sh/docs/installation
        pause
        exit /b 1
    )
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

bun run "%~dp0scripts\install-tools.ts" %*
pause
