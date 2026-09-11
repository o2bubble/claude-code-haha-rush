# 01 — Rust 后端 open_system_terminal 命令

**What to build:** 新增 Tauri command `open_system_terminal`，在工作区目录打开系统终端（cmd / PowerShell / Git Bash）。

**Blocked by:** None

**Status:** completed

- [x] 新增 `open_system_terminal(terminal_type, work_dir)` Tauri command
- [x] cmd: `cmd /c start cmd /K cd /d <work_dir>` 在新窗口打开并 cd 到工作区
- [x] powershell: `cmd /c start powershell -NoExit -Command "Set-Location '<work_dir>'"` 单引号安全传路径
- [x] git-bash: 自动检测安装路径（常见路径 + 从 git PATH 推导），`git-bash --cd=<work_dir>`
- [x] `find_git_bash()` 辅助函数：检查 `Program Files\Git\`、`Program Files (x86)\Git\`、从 `where git` 推导
- [x] 注册到 `tauri::generate_handler![]`
- [x] `#[cfg(not(target_os = "windows"))]` 提供降级错误提示

**实现说明：**
- 用 `start` 命令（不设窗口标题）避免引号混淆
- `cd /d` 参数拆成独立 argv 避免转义问题
- PowerShell 路径用单引号：`Set-Location 'path'`，单引号本身用 `''` 转义
