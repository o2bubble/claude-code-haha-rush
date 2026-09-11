# GUI Code Review + Visual System — 2026-07-28

## 双轴 Review 修复

### Rust unwrap 消除
- `lib.rs` 4 处 `.lock().unwrap()` 改为 match/if-let 处理 poisoned mutex
- 仅 Exit handler 保留（exit 时 crash 无影响）

### iconForPanel 重构
- `layoutStore.ts:iconForPanel()`: 硬编码 11 项映射 → `getPanel()?.icon ?? Icons.default`，一劳永逸
- `restoreLayout()`: `refreshIcons()` 现在也覆盖 `floatingPanels` + `tauriWindows`，修复持久化恢复后浮窗图标过期

### registerPanel 去重提示
- `panelRegistry.ts`: 重复注册时 `console.warn`，防止 App.tsx/FloatingApp.tsx 面板不同步

### ARCHITECTURE.md 同步
- Rust 命令表补全 12 个新命令
- `ExplorerPanel.tsx` → `FileBrowserPanel.tsx`
- 修复 §1 第 86 行 markdown 格式错乱

### 删除死代码
- `ExplorerPanel.tsx` — 无任何 import 引用，被 `FileBrowserPanel.tsx` 替代

## Visual System Overhaul

### Design Token 系统 (`tokens.css`)
- CSS 自定义属性：亮色/暗色双主题（`[data-theme="dark"]`）
- 统一 背景/文字/强调色/语义色/边框/投影/圆角/字体
- 全局滚动条美化 + `body` 过渡 + `focus-visible` 光环
- 消息淡入动画 `@keyframes msg-fade-in`

### Panel 定义集中 (`services/panelDefs.tsx`)
- `ALL_PANEL_DEFS` — 17 个面板的统一定义，单一数据源
- App.tsx + FloatingApp.tsx 遍历调用 `registerPanel()`，不再各自维护副本
- 新增面板只需改一处

### Error Boundary (`components/ErrorBoundary.tsx`)
- Class-based React error boundary，包裹每个面板 render
- 面板崩溃显示 fallback UI + 重试按钮，不拖垮整页

### 共享状态组件 (`components/SharedStates.tsx`)
- `LoadingSpinner` — 统一加载动画
- `EmptyState` — 空态提示 + 可选操作按钮
- `ErrorState` — 错误提示 + 可选重试

### 工具 (`utils/useClickOutside.ts`)
- `useClickOutside(ref, open, onClose)` — 点击外部关闭，含 `mousedown` cleanup

### 50+ 组件视觉统一
- 硬编码颜色/字体 → CSS 变量引用
- 支持亮/暗主题切换（数据驱动，无需改代码）

## i18n 补全

- `zh.ts` +212 行, `en.ts` +210 行
- 新增命名空间: `toolbar.*`, `panel.*`, `common.*`, `plan.*`, `skills.*`, `worker.*`, `desktop.*`, `canvas.*`, `status.*`, `subAgent.*`, `files.*`, `settings.*`, `chat.*`
- panelDefs 全部标题 + SubAgent/Toolbar/Terminal/Canvas/Desktop 组件硬编码英文 → `t()`

## Commits

| Commit | 内容 |
|--------|------|
| `fix(gui): code review fixes` | Rust unwrap + iconForPanel + docs + registerPanel warn |
| `style(gui): visual system overhaul` | tokens.css + panelDefs + ErrorBoundary + SharedStates + 50组件 |
| `chore(gui): remove dead ExplorerPanel.tsx` | 删死代码 |
| `i18n(gui): full i18n coverage` | panel 标题 + 组件内硬编码替换 |
