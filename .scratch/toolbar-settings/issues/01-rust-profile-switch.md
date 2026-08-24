# 01 — Rust 后端模型切换命令

**What to build:** 新增 Tauri command `switch_model_profile`，读 profile 文件，写 `settings.local.json`，重启 IDE 后端。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 新增 `find_profiles_dir()` — 按优先级查找 `.env.profiles` 目录（扩展目录 → workspace → `~/.claude/`）
- [ ] 新增 `switch_model_profile(profile_id)` Tauri command
- [ ] 读 `.env.profiles/<profile_id>.env`，解析 key=value
- [ ] 读已有 `.claude/settings.local.json`，更新 `env` 字段
- [ ] 写回 `.claude/settings.local.json`
- [ ] 写 `<profile_id>` 到 `.claude/active-profile`
- [ ] 调用已有 `restart_ide_backend` 重启 IDE 进程
- [ ] 新增 `list_model_profiles` Tauri command — 返回 profiles 列表 + active profile

**实现说明：**
- IDE 后端启动时已调用 `applyConfigEnvironmentVariables()`，会自动从 `settings.local.json` 读取 env
- 持久化链路与原版 VS Code 扩展完全一致
