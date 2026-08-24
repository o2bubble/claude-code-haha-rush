# 06 — SuperDesktopCanvas 无限画布

**What to build:** `gui/src/components/desktop/SuperDesktopCanvas.tsx`

- [ ] CSS transform 平移/缩放：`transform: translate(panX, panY) scale(zoom)`, `transform-origin: 0 0`
- [ ] 滚轮缩放（以光标为中心计算新 pan 偏移）
- [ ] 鼠标拖拽平移（空区域 mousedown 开始）
- [ ] CSS grid 背景 (`repeating-linear-gradient`)，toggle 可见
- [ ] 子层容器：DesktopItemView[] + SVG ConnectionOverlay（同 transform）
- [ ] 缩放手柄尺寸随 zoom 反比缩放 (`1 / zoom`)
- [ ] 右键上下文菜单（添加内容块快捷入口）
- [ ] 接受文件拖放 → 创建 RefItem
