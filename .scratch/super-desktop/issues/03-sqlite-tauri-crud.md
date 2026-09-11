# 03 — SQLite Schema + Tauri CRUD Commands

**What to build:** 在 `db.rs` 中创建 3 张表 + 7 个 Tauri commands，在 `lib.rs` 注册。

- [ ] `CREATE TABLE desktops` (id, name, pan_x, pan_y, zoom, show_grid, grid_size, sort_order, timestamps)
- [ ] `CREATE TABLE desktop_items` (id, desktop_id FK, x, y, width, height, z_index, content_type, content_json, label, color, collapsed, timestamps)
- [ ] `CREATE TABLE desktop_connections` (id, desktop_id FK, from_item_id, from_side, to_item_id, to_side, label, stroke_color, stroke_width, stroke_dasharray, created_at)
- [ ] 索引: `idx_items_desktop`, `idx_connections_desktop`
- [ ] 7 个 Rust commands: `db_save_desktop`, `db_get_desktops`, `db_delete_desktop`, `db_save_item`, `db_delete_item`, `db_save_connection`, `db_delete_connection`
- [ ] `lib.rs` 注册所有新 commands
- [ ] 复用现有 `Mutex<Connection>` managed state 模式
