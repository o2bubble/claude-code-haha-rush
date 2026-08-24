# 01 — AppSettings 添加 workspaces 字段

**What to build:** Rust `AppSettings` struct 和 TypeScript `AppSettings` interface 都添加 `workspaces` 字段，支持多工作区持久化。

**Blocked by:** None

**Status:** completed

- [x] Rust: `AppSettings` struct 添加 `workspaces: Vec<String>`，`#[serde(rename = "workspaces", default)]`
- [x] TS: `settingsStore.ts` 的 `AppSettings` interface 添加 `workspaces: string[]`
- [x] 默认值：Rust `vec![]`，TS `[]`
- [x] 验证：settings.json 中能看到 `workspaces` 数组

**实现说明：**
- 迁移：`loadSettings()` 中若 workspaces 为空但 workDir 非空，自动把 workDir 加入 workspaces
- 存量用户无缝升级，无需手动迁移
