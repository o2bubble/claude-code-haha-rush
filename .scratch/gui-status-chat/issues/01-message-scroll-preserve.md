# 01 — 消息列表滚动加载保持位置

**What to build:** 向上滚动加载更早消息时，保持当前可视区域不跳动。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 滚动到顶部触发加载更多时，记录加载前的 scrollHeight
- [x] 加载完成后用 `useLayoutEffect` 补偿 scrollTop 偏移
- [x] "Load earlier messages" 按钮同样保持位置
- [x] 初始加载保持显示最近 20 条 + 滚动到底部
