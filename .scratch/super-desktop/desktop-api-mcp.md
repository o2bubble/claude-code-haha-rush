# Desktop API + MCP Server — Spec

## Problem Statement

当前桌面操作只能通过 store import（面板内部）调用，外部系统和 AI agent 没有访问路径。需要：

1. **搜索能力** — AI 和用户都需要按关键词查找 block（当前只能遍历 UUID）
2. **智能放置** — AI 创建 block 时不应手动计算坐标，应由系统自动避让、放在合适位置
3. **批量读取** — AI 需要一次读取多个 block 的 content（当前只能逐个 `getDesktopItem`）
4. **外部 API** — AI agent 需要标准化的接口操作桌面（MCP），内部面板需要统一的调用入口

## Solution

分 4 个 step 实现：

### Step 1: 搜索/筛选

**Store:** `desktopStore.searchItems(query: string, desktopId?: string): DesktopItem[]`

- `query` 为空 → 返回所有 item
- 匹配逻辑：`item.label` 包含 query（大小写不敏感）OR `content` 内文本字段包含 query
- 文本提取规则：
  - `text` → `item.content.text`
  - `form` → `item.content.fields.map(f => f.name + f.value).join(" ")`
  - `file-group` → `item.content.files.map(f => f.label).join(" ")`
  - `chart` → `item.content.title`
  - `ref` → `item.content.note` + `references.map(r => r.label)`
  - `image` → `item.label` only（无文本 content）
  - `graphic` → `item.content.nodes.map(n => n.label).join(" ")`

**UI:** CanvasToolbar 加搜索框

- 输入即搜（debounce 200ms）
- 匹配的 item：不变
- 不匹配的 item：`opacity: 0.25` + 不可交互（点击穿透）
- 清空搜索框 → 恢复全部
- 搜索框右侧显示 "N matches" 计数

**MCP tool:** `desktop_search({ query: string, desktopId?: string })`

---

### Step 2: 智能放置

**Store:** `addItem` 加 `smartPlace?: number` 参数

`smartPlace` 值逻辑：
- `undefined / 0`: 用调用方指定的 x, y（现有行为）
- `1`: 计算视口中心的第一个空闲位置

**算法**（`smartPlace: 1`）：
```
1. 起点 = 视口中心 (viewportCenterX, viewportCenterY)
2. 从起点开始 spiral search（螺旋向外搜索）
3. 每步检查 newItem 的 bounding box 是否与现有 item 重叠
4. 第一个不重叠的位置 → 放置
5. 螺旋步长 = gridSize（有 snap 时）or 20px
6. 最远搜索 100 步 → 如全部重叠则放在视口中心 + 微小偏移
7. snapToGrid 开启时，候选位置吸附到 gridSize
```

**函数签名：**
```ts
function findSmartPlace(
  desktop: Desktop,
  itemW: number, itemH: number,
  viewportW: number, viewportH: number,
): { x: number; y: number }
```

`findSmartPlace` 作为独立 export（utility），不耦合 addItem。

**MCP tool:** `desktop_create_item` 默认 `smartPlace: 1`

---

### Step 3: 批量读取

**Store:** `getDesktopItems(itemIds: string[]): DesktopItem[]`

- 遍历所有 desktop 的 items，收集匹配的
- 不存在的 id 静默跳过
- 顺序与输入 ids 一致

**MCP tool:** `desktop_get_items({ ids: string[] })`

---

### Step 4: MCP Server (Worker)

**定位：** 内嵌在 Tauri 进程里，作为一个 "Worker" 管理。扩展 worker 的语义：不局限于独立进程，线程/协程/内置服务都属于 worker 范畴。

**技术选型：**
- Transport: HTTP SSE（与现有 memory MCP 保持一致）
- Server: Tauri 内启动轻量 HTTP server（`tiny_http` 或复用现有 `actix-web`）
- 端口：自动分配（`127.0.0.1:0`），注册到 worker 列表

**MCP Tools 清单：**

| Tool | 参数 | 返回 | 对应函数 |
|------|------|------|---------|
| `desktop_summary` | `{ viewportW?, viewportH? }` | `DesktopSummary` | `computeDesktopSummary()` |
| `desktop_get_items` | `{ ids: string[] }` | `DesktopItem[]` | `getDesktopItems()` |
| `desktop_search` | `{ query: string, desktopId? }` | `DesktopItem[]` | `searchItems()` |
| `desktop_create_item` | `{ desktopId, type, label, content?, smartPlace? }` | `DesktopItem` | `addItem()` |
| `desktop_update_item` | `{ itemId, partial }` | `void` | `updateItem()` |
| `desktop_delete_items` | `{ ids: string[] }` | `void` | `removeItem()` (批量) |
| `desktop_move_item` | `{ itemId, x, y }` | `void` | `moveItem()` |
| `desktop_resize_item` | `{ itemId, width, height }` | `void` | `resizeItem()` |
| `desktop_connect` | `{ desktopId, from, to, label? }` | `Connection` | `addConnection()` |
| `desktop_disconnect` | `{ connectionId }` | `void` | `removeConnection()` |
| `desktop_undo` | `{ desktopId }` | `DesktopSnapshot \| null` | `undoHistory()` |
| `desktop_redo` | `{ desktopId }` | `DesktopSnapshot \| null` | `redoHistory()` |
| `desktop_list` | `{}` | `Desktop[]` | `getDesktops()` |
| `desktop_create` | `{ name }` | `Desktop` | `createDesktop()` |
| `desktop_delete` | `{ id }` | `void` | `deleteDesktop()` |

**MCP Server 架构：**

```
Tauri main process
├── Backend (lib.rs)
│   ├── HTTP SSE server (embedded, port auto-assigned)
│   │   ├── POST /mcp → JSON-RPC (tool calls)
│   │   └── GET  /sse → SSE stream (events)
│   └── Desktop MCP handler
│       ├── tool dispatch (match tool name → call store function)
│       └── JSON serialize results
├── GUI (React)
│   └── Workers panel
│       └── Shows MCP server as worker entry (pid/port/status)
```

**Worker 注册：**
- App 启动时自动启动 MCP HTTP server
- 注册到 worker 列表：`{ name: "Desktop MCP", type: "embedded", port: <auto>, status: "running" }`
- Workers 面板显示：名称、端口、运行状态、可重启

---

### Step 5 (Cleanup): 删除 dataRegistry WS handlers

**删除的文件/代码：**
- `dataRegistry.ts` 中注册的 WS handler 函数（`data_registry_query`, `data_registry_operation`, `data_registry_list`）
- 对应的 `Events.DESKTOP_DATA_REGISTRY_CHANGED` 事件（如无其他消费者）
- 相关 WS handler 注册代码

**保留：**
- `registerDataSource()` / `getDataSource()` / `queryData()` / `executeOperation()` — 内部面板仍可使用
- `DataSourceDescriptor` 类型 — 组件注册仍用这个

---

## Changes Summary

| Step | File | Change |
|------|------|--------|
| 1 | `gui/src/stores/desktopStore.ts` | +`searchItems(query, desktopId?)` |
| 1 | `gui/src/components/desktop/CanvasToolbar.tsx` | +搜索框 + 筛选 UI |
| 2 | `gui/src/stores/desktopStore.ts` | +`findSmartPlace()` export |
| 2 | `gui/src/stores/desktopStore.ts` | `addItem` 支持 `smartPlace` |
| 3 | `gui/src/stores/desktopStore.ts` | +`getDesktopItems(ids[])` |
| 4 | `gui/src-tauri/src/` | MCP HTTP SSE server |
| 4 | `gui/src/services/mcp/` | MCP tool handler + dispatch |
| 4 | `gui/src/components/workers/` | Worker 注册 + 面板显示 |
| 5 | `gui/src/services/dataRegistry.ts` | 删除 WS handler 部分 |

## Testing

1. JS/TS 单元：`searchItems` 各内容类型的文本提取
2. JS/TS 单元：`findSmartPlace` spiral search 不重叠
3. MCP：用 curl 调 `POST /mcp` 验证 tool dispatch
4. UI：搜索框输入 → item 半透明/恢复
5. UI：Workers 面板显示 MCP server 条目
6. Rust：`cargo check` + `cargo test`
