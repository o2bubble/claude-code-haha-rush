# 01 — AppSettings 添加 layoutTree 字段

**What to build:** Rust `AppSettings` struct 和 TypeScript `AppSettings` interface 都添加 `layoutTree` 字段，支持布局持久化。

**Blocked by:** None

**Status:** completed

- [x] Rust: `AppSettings` struct 添加 `layout_tree: Option<serde_json::Value>`，`#[serde(rename = "layoutTree", default)]`
- [x] TS: `settingsStore.ts` 的 `AppSettings` interface 添加 `layoutTree?: object`
- [x] 验证：启动后修改布局、保存、重启，`settings.json` 中能看到 `layoutTree` 字段

**实现说明：**
- `serde_json::Value` 可以存任意 JSON，不需要精确类型定义
- `Option` + `default` 保证旧配置文件无此字段时不报错
- TS 侧 `layoutTree` 是嵌套对象，序列化时 ReactNode icon 字段会被 strip（见 ticket 02）
