# 19 — desktop-item ref chip 点击 → 高亮定位

**What to build:** 点击消息区中的 `@ref{desktop-item:...}` chip 跳转到 Super Desktop 后，对应内容块应有高亮闪烁动画，画布自动平移使目标居中，用户一眼就知道是哪个块。

**Status:** completed

**Why:**
- issue #18 实现了 chip 点击跳转到桌面面板，但没有任何视觉反馈
- 用户需要知道具体是哪个块被引用

**Changes:**

### 1. SuperDesktopCanvas.tsx — 监听 DESKTOP_ITEM_SELECTED
- `desktopRef` 保持 desktop 最新引用，避免 useEffect 频繁重订阅
- `highlightedItemId` 状态
- `useEffect` 注册 `DESKTOP_ITEM_SELECTED` 监听器：
  - 查找目标 item
  - 计算并执行画布平移（将 item 中心对齐到视口中心）
  - 设置 `highlightedItemId`
  - 3 秒后自动清除
- 传递 `highlighted={highlightedItemId === item.id}` 给 DesktopItemView

### 2. DesktopItemView.tsx — highlighted prop + 闪烁动画
- Props 新增 `highlighted?: boolean`
- 模块级单例注入 `@keyframes dt-item-flash`：
  - 0%/100%: `box-shadow: 0 0 0 2px #007acc, 0 0 20px rgba(0,122,204,0.3)`
  - 50%: `box-shadow: 0 0 0 3px #007acc, 0 0 32px rgba(0,122,204,0.6)`
- 高亮时：border 变蓝色 2px + `animation: dt-item-flash 0.8s ease-in-out 3`（脉冲 3 次）
- memo 比较加入 `prev.highlighted === next.highlighted`

**Verification:**
- [x] 点击消息中 `@ref{desktop-item:chart/uuid}` chip → 桌面面板激活 → 画布平移居中 → 蓝色光晕闪烁
- [x] 点击 `@ref{desktop-item:text/uuid}` chip → 同上
- [x] 3 秒后高亮自动消失
- [x] TypeScript 编译通过
