# 07 �?Rust open_system_terminal 支持 Claude 启动

**What to build:** `lib.rs` �?`open_system_terminal` 命令增加参数，支持在终端中自动启�?Claude Code（带 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 环境变量）�?
**Blocked by:** None

**Status:** completed

- [ ] `open_system_terminal` 参数新增 `claude_launch: Option<bool>`
- [ ] �?`claude_launch: true` 时，各终端类型的启动命令�?  - cmd: `cmd /K "cd /d <work_dir> && set CLAUDE_CODE_SKIP_PROMPT_HISTORY=true && claude"`
  - powershell: `cmd /c start powershell -NoExit -Command "Set-Location '<work_dir>'; $env:CLAUDE_CODE_SKIP_PROMPT_HISTORY='true'; claude"`
  - git-bash: `& git-bash.exe --cd=<work_dir> -c "export CLAUDE_CODE_SKIP_PROMPT_HISTORY=true && claude; exec bash"`
- [ ] git-bash 未找到时 fallback �?cmd
- [ ] 验证：终端窗口打开�?`claude` 命令自动运行

**实现说明�?*
- `claude` 必须�?PATH 上（GUI 环境继承自启�?GUI 的终端）
- 不传 `--resume` 参数——终�?Claude 独立运行，不�?GUI session 共享
- `CLAUDE_CODE_SKIP_PROMPT_HISTORY=true` 确保终端会话不写�?jsonl 文件
