# 07 — DesktopItemView 画布元素框架

**What to build:** `gui/src/components/desktop/DesktopItemView.tsx`

- [ ] 标题栏：拖动手柄 (cursor: move) + label 文字 + 折叠 button + 关闭 button
- [ ] 8 方向缩放手柄（复用 FloatingRenderer resize handle 逻辑）
- [ ] 5 个连线锚点（上下左右中）：hover 时显示圆点，mousedown 触发连线拖拽
- [ ] 内容区：根据 `item.content.type` 切换子组件
- [ ] 点击 → `bringItemToFront()`
- [ ] 拖拽 → `moveItem(id, newX, newY)`
- [ ] 缩放 → `resizeItem(id, newW, newH)`，最小 50x50
- [ ] 折叠 → 仅显示标题栏（`collapsed` toggle）
- [ ] 背景色：`item.color` → CSS background-color
- [ ] `React.memo` + `item.id + item.updatedAt` 比较函数优化
