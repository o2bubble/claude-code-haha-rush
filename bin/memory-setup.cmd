@echo off
chcp 65001 >nul
bun run "%~dp0..\scripts\memory-setup.ts" %*
