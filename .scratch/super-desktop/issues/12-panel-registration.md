# 12 — Panel 注册 + 默认布局

**What to build:** 将 Super Desktop 注册到 App 和布局系统。

- [ ] `App.tsx`: `registerPanel({ id: "super-desktop", title: "Super Desktop", ... })` 注册面板
- [ ] `layoutStore.ts`: 在 `editor-area` TabGroup 添加 `tab-desktop` 作为第二个 tab
- [ ] `icons.tsx`: 可选 — 添加 desktop 图标 (LayoutGrid 或自定义 SVG)
- [ ] `commandRouter.ts`: PANEL_MAP 添加 `desktop: "super-desktop"` — `/desktop` B 类路由
- [ ] 验证面板在默认布局中与 Editor 同行显示
- [ ] 验证可通过 PanelDropdown 在其他位置添加
- [ ] 验证 `/desktop` 命令可打开/激活面板
