# 02 — 布局序列化 + debounced 自动保存

**What to build:** layoutStore 新增序列化/反序列化函数，并在布局变更时自动保存到 settings。

**Blocked by:** 01 — AppSettings 添加 layoutTree 字段

**Status:** completed

- [x] `serializeLayout()`: tree → JSON-safe object，去掉 `TabInstance.icon`（ReactNode 不可序列化）
- [x] `deserializeLayout(json)`: JSON-safe object → tree + floatingPanels，从 `panelId` 通过 `Icons` 映射重建 icon
- [x] `deserializeFloating(json)`: 加类型守卫，group 非 TabGroup 时返回 null 并被 filter 掉
- [x] debounced 保存逻辑：在 App.tsx 的 useEffect hook 中订阅 `LAYOUT_TREE_CHANGED`，debounce 1s → 调用 `saveSettings()`（避免 store 含 I/O，符合 Rule 8）
- [x] 防止循环：`restoreLayout()` 设置 `_skipSave = true`，100ms 后恢复

**实现说明：**
- icon 映射：`Icons` 对象已包含所有 panelId（explorer, file, plan, terminal, editor, default），从 panelId 取对应 icon
- 浮窗序列化字段：id, x, y, width, height, zIndex, group（完整 TabGroup 递归序列化）
- TabGroup 递归序列化：type, id, tabs[], activeTabId, tabStyle, visibility
- **Code review fix**: `scheduleSave()` 从 layoutStore 移除，放入 App.tsx hook，消除 store 中的 I/O 违规
