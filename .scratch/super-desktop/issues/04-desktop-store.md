# 04 — desktopStore（模块级单例 Store）

**What to build:** `gui/src/stores/desktopStore.ts` — 遵循现有 store 模式。

- [ ] State: `Desktop[]`, `activeDesktopId`, `registeredItemIds: Set`
- [ ] Desktop mutations: `createDesktop`, `deleteDesktop`, `setActiveDesktop`, `renameDesktop`, `setDesktops`
- [ ] Viewport: `updateDesktopViewport(id, partial)`
- [ ] Item mutations: `addItem`, `updateItem`, `removeItem`, `moveItem`, `resizeItem`, `bringItemToFront`
- [ ] Connection mutations: `addConnection`, `removeConnection`, `updateConnection`
- [ ] Data registry tracking: `markItemRegistered`, `markItemUnregistered`, `isItemRegistered`
- [ ] 每次 mutation 发射 `DESKTOP_CHANGED` (sticky)
- [ ] 每次 mutation 后 debounce 500ms → SQLite 写入
- [ ] 启动时调用 `invoke("db_get_desktops")` 加载持久化数据
