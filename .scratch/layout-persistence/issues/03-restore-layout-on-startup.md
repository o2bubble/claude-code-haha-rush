# 03 — 启动时恢复布局

**What to build:** App.tsx 启动时读取 settings.layoutTree，反序列化并应用到 layoutStore。

**Blocked by:** 02 — 布局序列化/反序列化

**Status:** completed

- [x] App.tsx 中 `loadSettings()` 之后，检查 `settings.layoutTree`
- [x] 如果有 layoutTree，调用 `restoreLayout()` → `setTree()` + 恢复 floatingPanels + 设 zIndex 计数器
- [x] 如果没有 layoutTree（首次启动），使用默认布局 `createDefaultTree()`
- [x] `restoreLayout()` 设置 `_skipSave` flag 防止恢复触发保存回环
- [x] try-catch 保护，损坏的 layoutTree 回退到默认布局

**实现说明：**
- layoutStore 不需要 React 组件 mount 就能操作（模块级单例），所以可以在 App.tsx 顶层（组件外）或 useEffect 最早时机 setTree
- 重启后如果 layoutTree 中的某个 tab 引用了不存在的 panelId，反序列化时应跳过该 tab 而非 crash
