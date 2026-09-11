# 16 — wheel event 互斥 + 折叠容器高度修复

**What to build:** 修复两个交互问题。

**Status:** completed

**wheel 互斥:**
- [x] `handleWheel` 检测 `target.closest("[data-desktop-item]")` → 跳过 `e.preventDefault()` 和缩放
- [x] 内容块内部滚轮正常滚动内容，空白画布滚轮缩放

**折叠高度:**
- [x] `item.collapsed` 时容器 `height: undefined`（auto-size 到标题栏高度）
- [x] 展开时恢复 `item.height` 原高度
- [x] 折叠后容器视觉上收缩为仅标题栏
