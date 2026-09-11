# 15 — 连线模式（Connection Mode）

**What to build:** 正常情况下锚点仅 hover 可见（避免视觉噪音）。拖拽锚点时自动进入连线模式——所有 item 锚点同时显示。松手或 Esc 自动退出。

**Status:** completed

- [x] 连线模式由 `!!connDrag.current` 衍生——无需单独 state
- [x] 拖拽开始（锚点 mousedown）→ `connDrag.current` 被设置 → `setConnDragTick` 触发重渲染 → 所有 item 接收 `connectionMode=true`
- [x] 拖拽结束（mouseup / Esc）→ `connDrag.current = null` → 所有锚点恢复 hover-only
- [x] 成功创建连线后自动退出（松手即退出）
- [x] 无需手动开关按钮——完全由拖拽手势驱动
- [x] DesktopItemView 通过 `connectionMode` prop 接收，memo 正确比较

**实现说明:**
- 移除了手动 `connectionMode` state 和 "Connect" 按钮
- `connDrag.current` 是 ref，配合 `setConnDragTick` force-update 达到响应式效果
- 锚点 visibility: `hovered || connectionMode` → true 时渲染锚点
