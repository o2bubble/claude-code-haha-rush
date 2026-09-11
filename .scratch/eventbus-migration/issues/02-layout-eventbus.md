# 02 — layoutStore EventBus 迁移

**What to build:** 将 layoutStore 的双 listener 模式（`subscribe` + `subscribeFloating`）替换为 EventBus 事件（`LAYOUT_TREE_CHANGED`、`LAYOUT_FLOATING_CHANGED`），3 个消费者组件改用 `useEventHandler` hooks。

**Blocked by:** 01 — chatStore + terminalStore EventBus 迁移

**Status:** ready-for-agent

- [ ] layoutStore: 删 subscribe/subscribeFloating/listeners/floatingListeners
- [ ] layoutStore: setTree 改为 `eventBus.emit(LAYOUT_TREE_CHANGED, {tree}, sticky)`
- [ ] layoutStore: notifyFloatingChange 同时 emit LAYOUT_FLOATING_CHANGED + LAYOUT_TREE_CHANGED
- [ ] layoutStore: 4 处直接 `listeners.forEach` 替换为 EventBus emit
- [ ] LayoutRenderer、Toolbar: subscribe → useEventHandler(LAYOUT_TREE_CHANGED)
- [ ] FloatingRenderer: subscribeFloating → useEventHandler(LAYOUT_FLOATING_CHANGED)
