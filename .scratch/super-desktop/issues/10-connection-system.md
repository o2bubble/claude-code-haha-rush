# 10 — ConnectionOverlay + useConnectionDrag（连线系统）

**What to build:** 创建连线渲染层和拖拽 Hook

**ConnectionOverlay:**
- [ ] SVG overlay（与画布同步 transform）
- [ ] 每 connection 渲染一条 `<path>` 贝塞尔曲线
- [ ] 锚点坐标计算：根据 item 位置 + side 算出边上的点
- [ ] 控制点：从锚点垂直于 side 方向延伸 (距离 = 两点距离的 1/3)
- [ ] 中点处 `<foreignObject>` 显示 label（可选）
- [ ] 悬停高亮 + 点击选中 + Delete 键删除
- [ ] 选中后可编辑 label（inline input）
- [ ] 选中后可选择颜色和线型

**useConnectionDrag:**
- [ ] 锚点 mousedown → 记录 fromItemId, fromSide
- [ ] mousemove → 渲染临时橡皮筋线（跟随鼠标）
- [ ] mouseup 在另一个锚点上 → `addConnection()`
- [ ] mouseup 在空区域或 Esc → 取消
