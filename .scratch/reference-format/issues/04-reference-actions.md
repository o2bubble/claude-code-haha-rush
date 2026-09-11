# 04 — 引用点击动作分发

**What to build:** `gui/src/services/referenceActions.ts` — 接收 Reference 对象，执行对应动作。

**Blocked by:** 01 — Reference 类型定义

**Status:** completed

- [x] `openReference(ref: Reference)` — 根据 type 分发动作（异步）
- [x] `file`: 调用 `fileService.readFile()` + `editorStore.openFile()`，定位到 `startLine`（TODO: Monaco revealLine）
- [x] `dir`: 显示 status 提示（文件树展开 TODO）
- [x] `panel`: 调用 `findTabByPanelId`（支持复合子 tab）→ `ensureGroupVisible` + `setActiveTab` + `setActiveChild`
- [x] `session`: 调用 `switchSession(ref.path)` 加载会话
- [x] 静态导入 `fileService`（避免不必要的动态 import）
- [x] `findTabByPanelId` 返回 `childTabId` 支持复合子 tab 定位

**实现说明：**
- `openReference` 可以在组件中直接调用（不需要通过 CommandRegistry，因为是纯前端动作）
- 编辑器定位行需要 Monaco 支持 `revealLine`，可暂缓到 editor tieck 再做
