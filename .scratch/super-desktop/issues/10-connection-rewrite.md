# 10b — 连线系统重写（锚点可见性 + 画布 transform 补偿）

**What to build:** 修复连线拖拽不可用的问题。锚点始终可见 + 拖拽橡皮筋 + 正确补偿画布平移/缩放。

**Status:** completed

- [x] 锚点始终可见（opacity 0.45），hover 时 1.0 + 橙色光晕 + 1.2x 放大
- [x] 橙色锚点与蓝色缩放手柄视觉区分
- [x] 连线拖拽逻辑从 `useConnectionDrag.ts` (broken) 移入 `SuperDesktopCanvas.tsx`（内联）
- [x] `screenToCanvas()` 函数：`(clientX - rect.left - panX) / zoom` 正确转换鼠标坐标
- [x] 橡皮筋虚线：拖拽时实时显示贝塞尔曲线路径（橙色虚线段），直到松手
- [x] mouseup 在另一个锚点上 → `addConnection()` 创建连线
- [x] mouseup 在空区域 → 取消
- [x] Esc 键取消连线拖拽
- [x] 底部提示条："Drag to another item's anchor dot to connect · Press Esc to cancel"
- [x] 画布 cursor 变为 `crosshair` 在拖拽连线时

**已删除文件:**
- `gui/src/components/desktop/useConnectionDrag.ts` — 原 hook 未考虑 transform 补偿，已由内联逻辑替代
- `SuperDesktopPanel.tsx` 中 `containerRef` + `useConnectionDrag` 调用移除

**锚点样式:**
- 大小: `Math.max(10, 10 / scale)` px（始终 >=10px 视觉尺寸）
- 颜色: `#ff6b35`（橙色）
- 常态: opacity 0.45, box-shadow `0 0 0 1px rgba(255,107,53,0.3)`
- hover: opacity 1, box-shadow `0 0 0 2px #ff6b35, 0 0 6px rgba(255,107,53,0.4)`, transform `scale(1.2)`
