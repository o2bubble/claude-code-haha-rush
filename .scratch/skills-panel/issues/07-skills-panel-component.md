# 07 — SkillsPanel 主组件

**What to build:** 技能列表面板，搜索、收藏置顶、点击打开浮动对话框。

**Status:** completed

- [x] 从 `chatStore.slashCommands` 读取，过滤 `type === "prompt" || type === "skill"`
- [x] 搜索框实时过滤
- [x] 收藏区域置顶（★ 标记），分隔线
- [x] 点击技能 → `addFloatingPanel("skill-dialog")` + `updateChatState({ activeSkillDialog })` + `setSkillDialogCallbacks`
- [x] 收藏 toggle → `updateSettings({ favoriteSkills: [...] })`
- [x] 空列表占位文本（无匹配/暂时无技能）

**实现说明:**
- 无 props 组件，通过 useEvent 接收数据
- 列表项点击防抖（打开同一技能时 bringToFront）
