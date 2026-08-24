# 06 — SkillDialogFloating 浮动窗口包装

**What to build:** 模块级回调 + chatStore 读数据，管理浮动窗口生命周期（同 AskQuestion 模式）。

**Status:** completed

- [x] Module-level: `_onSend`, `_onSkip`, `_onToggleFav`, `_floatId`
- [x] `setSkillDialogCallbacks(floatId, onSend, onSkip, onToggleFav)`
- [x] `clearSkillDialogCallbacks()`
- [x] useEffect cleanup: 检测 `getFloatingPanels().some(...)` 区分 drag 和关闭
- [x] drag re-render: float 仍在 store → 不触发 skip → 数据保持
- [x] × 关闭: float 不存在 → 触发 skip + 清回调
- [x] 发送: 先捕获 `_floatId`，再清回调，再 `removeFloatingPanel`
