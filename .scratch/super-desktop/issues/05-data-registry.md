# 05 — Data Registry Service（数据披露注册表）

**What to build:** `gui/src/services/dataRegistry.ts` — 独立服务模块，解耦于 UI。

- [ ] `DataSourceDescriptor` 接口：itemId, desktopId, label, contentType, dataKeys[], queryHandler?, opHandler?
- [ ] `registerDataSource(itemId, descriptor)` — 注册数据源
- [ ] `updateDataSource(itemId, partial)` — 更新数据源
- [ ] `unloadDataSource(itemId)` — 卸载数据源
- [ ] `getDataSource(itemId)` / `getAllDataSources()` — 查询
- [ ] `queryData(itemId, key)` — 查询特定 key 值
- [ ] `executeOperation(itemId, op, params?)` — 执行操作
- [ ] 变更时通过 EventBus 发射 `DESKTOP_DATA_REGISTRY_CHANGED`
- [ ] 纯内存，不单独持久化（数据已在 SQLite）
