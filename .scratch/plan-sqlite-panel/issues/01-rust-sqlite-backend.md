# 01 — Rust SQLite 后端

**What to build:** 在 Tauri Rust 层引入 SQLite，暴露 plan 持久化的 CRUD 接口给前端调用。数据库文件放在 `%APPDATA%/claude-code-gui/plans.db`，和现有 settings.json 同目录。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `Cargo.toml` 加 `rusqlite = { version = "0.31", features = ["bundled"] }`
- [ ] 新建 `db.rs`：建表 plans(id, session_id, session_title, tasks_json, plan_text, created_at, updated_at)，含索引
- [ ] `db.rs` 实现 `init_db() → Connection`、`save_plan()`、`get_plans(offset, limit)`、`get_plan_sessions()`
- [ ] `lib.rs` 注册 3 个 Tauri command：`db_save_plan`、`db_get_plans`、`db_get_plan_sessions`
- [ ] `lib.rs` 的 `run()` 中初始化 DB 连接，通过 `.manage()` 注入 Mutex<Connection>
- [ ] `cargo check` 编译通过
