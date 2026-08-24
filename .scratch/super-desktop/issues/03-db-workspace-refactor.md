# 03b — DB 路径重构到 workspace/.claude/data.db

**What to build:** 将数据库从全局 `%APPDATA%/claude-code-gui/plans.db` 移到各 workspace 的 `.claude/data.db`，支持 workspace 切换时自动重新打开。

**Status:** completed

- [x] 路径：`dirs_next().join("plans.db")` → `work_dir.join(".claude").join("data.db")`
- [x] 新增 `DbState { conn, work_dir }` 结构体
- [x] 新增 `ensure_db()` 辅助函数——每次 DB 操作时检查 workspace 是否变更，变更则自动重开
- [x] `restart_ide_backend` 后下一次 DB 操作自动切换到新 workspace 的 DB
- [x] Manage `Mutex<DbState>` 替代 `Mutex<Connection>`
- [x] 文件名从 `plans.db` 改为通用的 `data.db`（同时存储 plans + desktops）
- [x] Rust 编译无警告

**实现说明:**
- 旧 `%APPDATA%/claude-code-gui/plans.db` 不会被自动迁移，旧数据遗留需手动删除
- `restart_ide_backend` 更新 `BackendState.work_dir`，`ensure_db` 比较 `DbState.work_dir` 与最新 `load_settings().work_dir`
