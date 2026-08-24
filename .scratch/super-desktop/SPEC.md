# Super Desktop (超级桌面) — Spec

## Problem Statement

当前 GUI 缺乏一个**自由形态的工作桌面**——用户无法在可视化空间中组织思路、数据和引用。现有面板都遵循固定的结构化布局（聊天、编辑、终端），但用户需要像白板一样自由放置、连接、编辑各种内容块，并与 AI agent 协作。

具体缺失的能力：
1. **多种内容类型的自由布局** — Markdown 笔记、图表、流程图、文件引用无法在同一视觉空间中并存和自由排列
2. **信息关联** — 内容块之间没有视觉连线来表达关系线索
3. **数据暴露** — 桌面上的结构化数据无法被其他面板或 agent 发现和查询
4. **协作反馈闭环** — 用户整理的数据/思路无法便捷地发送给 agent，agent 返回的结果也无法直接放回桌面
5. **多桌面切换** — 不同项目/话题的内容混在一起，缺少快速切换的工作区

## Solution

新增 **Super Desktop 面板**——一个无限画布面板，支持放置多种类型的内容块（文本、图表、流程图/思维导图、@ref 引用），可自由拖拽、缩放、连线，通过 data registry 暴露数据给其他系统组件，并通过 @ref 系统与 agent 协作。

## User Stories

### 桌面管理
1. 作为用户，我可以创建多个命名桌面（如"架构设计"、"Bug 分析"），并在标签栏切换
2. 作为用户，我可以重命名、删除桌面
3. 作为用户，每个桌面的视口位置（平移/缩放/网格）独立记忆

### 内容块
4. 作为用户，我可以添加文本块（支持 Markdown 渲染预览），自由编辑文字
5. 作为用户，我可以添加引用块，含 @ref 文件/目录引用，点击可跳转
6. 作为用户，我可以添加图表块（柱状/折线/饼图），编辑数据后实时更新图表
7. 作为用户，我可以添加图形块（流程图/思维导图），交互式编辑节点
8. 作为用户，所有内容块支持拖拽移动、8 方向缩放、置顶、折叠、删除
9. 作为用户，我可以切换内容块的背景色以进行视觉分类

### 连线
10. 作为用户，我可以从一个内容块的锚点拖拽连线到另一个内容块
11. 作为用户，连线可添加标签文字、更改颜色和线型
12. 作为用户，连线锚点有 5 个位置（上、下、左、右、中）

### 画布操作
13. 作为用户，画布支持鼠标拖拽平移和滚轮缩放
14. 作为用户，画布可选显示/隐藏网格
15. 作为用户，工具栏提供快捷添加按钮和缩放控件

### 数据暴露
16. 作为开发者/agent，可以通过 WS 查询已注册的数据源列表
17. 作为开发者/agent，可以针对某个数据源查询特定 key 的数据
18. 作为开发者/agent，可以对某个数据源执行操作（如更新图表数据）

### Agent 协作
19. 作为用户，选中内容块后可以"发送到 Agent"，通过 @ref chip 发送到聊天输入框
20. 作为用户，可以从画布上拖拽/粘贴文件创建引用块（复用现有 @ref 系统）
21. 作为 AI agent，读取桌面摘要可获得所有 block 的类型/位置/可见性/选中态，无需加载 content
22. 作为 AI agent，拿到摘要后可按需通过 `getDesktopItem(id)` 获取任意 block 的完整 content

### 持久化
23. 作为用户，桌面数据（items、connections、viewport）在关闭 GUI 后持久化到 SQLite
24. 作为用户，操作历史（undo/redo）跨 session 持久化
25. 作为用户，重启 GUI 后自动恢复上次的桌面状态

### 框选与批量操作
26. 作为用户，可以在空白区域拖拽框选多个 block（Figma/Miro 风格）
27. 作为用户，选中的 block 可以一起拖拽移动、批量删除、批量发送到 Agent
28. 作为用户，按住 Space+拖拽 或中键拖拽可平移画布（替换原先的空区域拖拽）

### 网格吸附
29. 作为用户，开启 Snap 模式后拖拽移动时自动吸附到网格点
30. 作为用户，新创建的 block 位置也自动对齐网格

### 操作历史
31. 作为用户，可以撤销/重做操作（undo/redo），深度 100，支持跨 session
32. 作为用户，连续拖拽/缩放操作在松手时合并为一个历史条目

## Implementation Decisions

### 无限画布（纯 CSS Transform，无外部库）
- `transform: translate(panX, panY) scale(zoom)` + `transform-origin: 0 0`
- 鼠标滚轮缩放（以光标为中心），拖拽平移
- CSS `repeating-linear-gradient` 网格背景
- **不引入 react-zoom-pan-pinch 等第三方库**——避免多余抽象层和依赖体积

### 内容块框架
- 标题栏（拖动手柄 + label + 折叠/关闭按钮）
- 8 方向缩放手柄（复用 FloatingRenderer 模式）
- 5 个连线锚点（top/right/bottom/left/center）——橙色圆点，hover 时显示，连线模式下全部显示
- `React.memo` + `item.updatedAt` 时间戳优化渲染

### 图表：uPlot（AI 驱动，纯展示）
- **uPlot** (~30KB gzip, canvas 渲染, 零依赖)
- 支持柱状/折线/饼图/散点
- 用户不可编辑——AI 通过 `opHandler.update_data({ data })` 管理

### 图形：SVG + AI 驱动（纯展示+微调）
- 流程图/思维导图：彩色节点 + 边，拖拽节点可重排
- SVG 内滚轮缩放 + 拖拽平移
- Auto Layout：拓扑排序/树形布局整理 AI 产出
- 用户不可编辑内容——AI 通过 `opHandler.update_data({ nodes, edges })` 管理

### 连线：SVG Overlay
- 与画布同步 transform 的 SVG 层
- 贝塞尔曲线：`M x1 y1 C cp1x cp1y, cp2x cp2y, x2 y2`，控制点垂直于锚点边方向延伸
- 拖拽创建：锚点 mousedown → 橡皮筋虚线（橙色）→ 另一个锚点 mouseup → 创建完成
- 连线逻辑内联在 `SuperDesktopCanvas.tsx` 中，通过 `screenToCanvas()` 正确补偿画布 transform
- 选中连线后可编辑标签、Delete 键删除、Esc 取消选中
- 锚点颜色与缩放手柄区分：橙色=连线锚点，蓝色=缩放手柄
- **连线模式**：默认锚点仅 hover 可见；拖拽锚点时自动全显所有 item 锚点；松手或 Esc 自动退出

### SQLite 持久化（复用现有 db.rs 模式）
- 3 张表：`desktops`, `desktop_items`, `desktop_connections`
- 3 个 Tauri commands：`db_save_desktop`, `db_get_desktops`, `db_delete_desktop`（全量保存/加载）
- 前端 debounce 500ms 写入——避免频繁拖动时过度 I/O
- 启动时 `db_get_desktops()` 加载，同步到 desktopStore
- **数据库位置**：`<workspace>/.claude/data.db`（每个 workspace 独立，天然隔离）
- `DbState { conn, work_dir }` 包装 + `ensure_db()` 辅助函数：workspace 切换时自动重新打开新路径的 DB

### Data Registry（独立服务模块）
- `gui/src/services/dataRegistry.ts` — 完全解耦于 UI
- 生命周期：组件 `useEffect` 注册 → cleanup 卸载
- 暴露 WS handlers：`data_registry_query`, `data_registry_operation`, `data_registry_list`
- 仅内存——反映当前桌面状态，不单独持久化（数据已在 SQLite 中）

### 面板位置
- 注册为 `userManaged: true` 的普通面板
- 默认布局中作为 Editor 的同行标签页（`editor-area` TabGroup 的第二个 tab）
- 用户也可通过 PanelDropdown 在其他位置打开

### 命令路由
- B 类命令 `/desktop` 打开/激活此面板（加入 `commandRouter.ts` 的 PANEL_MAP）

## Testing Decisions

- 验证桌面 CRUD：创建 → 重命名 → 切换 → 删除
- 验证 4 种内容块创建和编辑
- 验证图表数据编辑后实时更新
- 验证流程图节点拖拽和编辑
- 验证连线创建、显示、删除
- 验证画布平移/缩放/网格
- 验证数据持久化（关闭重启后恢复）
- 验证 data registry 的注册/查询/操作接口
- 验证 WS handlers 正确返回数据
- 验证"发送到 Agent"格式化正确
- 验证面板注册和 drag-float 创建正常

## AI-Facing API: DesktopSummary

AI agent 读取桌面状态时，返回轻量摘要（不含 content 详情），减少上下文占用。Agent 按需通过 `getDesktopItem(id)` 取完整 content。

### Query (planned)

```
read_desktop_state() → DesktopSummary
```

### `DesktopSummary` schema

```ts
interface DesktopSummary {
  desktops: Array<{
    id: string;
    name: string;
    itemCount: number;
  }>;
  activeId: string;
  activeDesktop: {
    viewport: {
      panX: number;  // 画布平移（pixels）
      panY: number;
      zoom: number;  // 缩放比（0.1–5）
    };
    items: Array<{
      id: string;                   // UUID — 后续查询/操作的 key
      type: ItemContentType;        // "text"|"form"|"file-group"|"image"|"chart"|"graphic"|"ref"
      label: string;                // 标题栏文字
      x: number; y: number;         // 画布坐标（绝对，原点左上角）
      width: number; height: number;
      zIndex: number;               // 层级
      screenX: number; screenY: number; // 当前视口内的屏幕像素坐标
      visible: "full" | "partial" | "none"; // 在当前视口内的可见性
      selected: boolean;            // 是否被框选选中
    }>;
    connections: Array<{
      id: string;
      from: { itemId: string; side: "top"|"right"|"bottom"|"left"|"center" };
      to:   { itemId: string; side: "top"|"right"|"bottom"|"left"|"center" };
      label?: string;
    }>;
  };
}
```

### Detail query

Agent 从摘要获取目标 `itemId` 后，调用现有 store 函数：

```
getDesktopItem(itemId) → DesktopItem  // 包含完整 ItemContent
```

无需新增协议 — `getDesktopItem()` 已遍历所有 desktop 的 items 数组，O(N) 查找，足够快。

### AI workflow

```
1. read_desktop_state()   → DesktopSummary（~200 tokens for 10 items）
2. 决定操作目标 item
3. getDesktopItem(id)     → DesktopItem（含 content）
4. 执行操作（updateItem / addItem / removeItem / ...）
```

### Design decisions

- **`screenX/Y` + `visible`** — AI 无需自己反算 pan/zoom 就能判断 item 在不在屏幕上、在哪
- **画布坐标 (`x`, `y`)** — 绝对坐标系，方便 AI 计算排版和位置关系
- **connections 保留** — AI 可据此发现关联 block，发散场景下不用逐个查询
- **不含 `content`** — 摘要不加载 item 的 content_json，减少上下文。常见场景 AI 只需知道"这是什么类型的什么块在哪"
- **不含 `createdAt`/`updatedAt`** — AI 不关心时间戳

---

## Out of Scope

- 内容块模板/预设
- 桌面数据导入/导出（JSON 手动导出后续可加）
- 协作/多用户实时同步
- 移动端触摸支持
- 内容块内的 `/` 命令补全
- 图表动画/高级交互
- 思维导图所有节点的自由拖拽（初始仅支持根节点拖拽 + 自动布局）
- 桌面数据通过 MCP 暴露（详见 [desktop-api-mcp.md](./desktop-api-mcp.md)）

## Further Notes

### 子文档
- [desktop-api-mcp.md](./desktop-api-mcp.md) — 搜索、智能放置、批量读取、MCP Server、Worker 管理

### 架构复用
- 浮动窗口生命周期：参考 `SkillDialogFloating`（callbacks + chatStore 数据 + drag 检测）
- 缩放手柄：复用 `FloatingRenderer` 的 8-direction resize 逻辑
- @ref chip：复用 `InputArea` 的 `formatReference` + `insertChipAtCursor`
- SQLite 模式：完全复用 `planHistoryStore` 的 `db_save_plan` / `db_get_plans` 模式
- EventBus：完全遵循现有 sticky/non-sticky 模式

### 关键文件

| 文件 | 类型 |
|------|------|
| `.scratch/super-desktop/SPEC.md` | 新建 — 本文件 |
| `gui/src/types/desktop.ts` | 新建 — 所有桌面相关类型 |
| `gui/src/stores/desktopStore.ts` | 新建 — Module-level store |
| `gui/src/services/dataRegistry.ts` | 新建 — 数据披露注册表 |
| `gui/src/components/desktop/SuperDesktopPanel.tsx` | 新建 — 面板入口 |
| `gui/src/components/desktop/SuperDesktopCanvas.tsx` | 新建 — 无限画布 |
| `gui/src/components/desktop/DesktopItemView.tsx` | 新建 — 元素框架 |
| `gui/src/components/desktop/DesktopTabs.tsx` | 新建 — 桌面切换标签栏 |
| `gui/src/components/desktop/CanvasToolbar.tsx` | 新建 — 工具栏 |
| `gui/src/components/desktop/TextItem.tsx` | 新建 — 文本内容渲染 |
| `gui/src/components/desktop/ChartItem.tsx` | 新建 — 图表渲染 (uPlot) |
| `gui/src/components/desktop/GraphicItem.tsx` | 新建 — 流程图/思维导图 |
| `gui/src/components/desktop/RefItem.tsx` | 新建 — @ref 引用渲染 |
| `gui/src/components/desktop/ConnectionOverlay.tsx` | 新建 — SVG 连线层 |
| `gui/src-tauri/src/lib.rs` | 修改 — 注册 Tauri commands + DbState + ensure_db |
