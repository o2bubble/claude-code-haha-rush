# 09 — App.tsx 面板注册

**What to build:** 注册 `skills` 面板（列表）和 `skill-dialog` 面板（浮动窗口）。

**Status:** completed

- [x] `registerPanel({ id: "skills", title: "Skills", ... })` — 侧边栏面板
- [x] `registerPanel({ id: "skill-dialog", userManaged: false, ... })` — 浮动窗口
- [x] 导入 `SkillsPanel` 和 `SkillDialogFloating`
- [x] Icons 使用 `Icons.sessions`（临时）

**实现说明:**
- `skill-dialog` 不暴露给 PanelDropdown（userManaged: false）
