# 14 — 画布右键上下文菜单

**What to build:** 拦截浏览器默认右键菜单，显示自定义上下文菜单（复用 `showCtxMenu` 全局系统）。

**Status:** completed

- [x] `onContextMenu` handler 拦截 `e.preventDefault()`
- [x] 空画布右键：Add Text / Add Chart / Add Graphic / Add Reference / Reset View（在鼠标位置创建 item）
- [x] 内容块右键：Send to Agent / Bring to Front / Delete Item
- [x] 连线右键：Edit Label / Delete Connection
- [x] `data-connection` 属性加到 ConnectionOverlay 的 `<g>` 上用于识别连线点击
- [x] `screenToCanvas()` 用于将右键位置转为画布坐标

**实现说明:**
- 复用现有 `showCtxMenu(x, y, items)` 全局 API（与 FileTree 右键菜单同一系统）
- "Send to Agent" 按 content.type 格式化文本后调用 `commands.execute("SEND_MESSAGE", text)`
