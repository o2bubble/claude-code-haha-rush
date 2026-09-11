# eidtor-baby-dev 项目研究报告

> 研究日期：2026-07-17 | 仓库路径：`C:\Storage\eidtor-baby-dev` | 最新提交：`3c0c5b8`

---

## 一、项目概览

基于 **Tauri 2 + React 18 + Monaco Editor** 的跨平台桌面代码编辑器。目标是构建一个具有完整面板系统、布局树、拖拽系统和浮动窗口支持的轻量级编辑器，界面概念对标 VS Code（Activity Bar、面板系统、布局树）。

- **仓库**：https://gitee.com/randomlife/eidtor-baby-dev
- **开发路径**：`C:\Storage\eidtor-baby-dev`
- **Vite Dev**：http://localhost:1420
- **启动命令**：`cargo tauri dev`
- **构建命令**：`bun run build`（前端）+ `cargo tauri build`（二进制）
- **二进制体积**：约 8MB

---

## 二、技术栈

| 层 | 技术 | 版本 | 关键文件 |
|---|------|------|----------|
| 桌面壳 | Tauri 2 | 2.x | `src-tauri/Cargo.toml:14` |
| 构建工具 | Vite | 6.x | `vite.config.ts:4` |
| 前端框架 | React | 18.3 | `package.json:19-20` |
| 编辑器核心 | Monaco Editor | 0.52+ (CDN) | `src/components/Editor.tsx:2` |
| Rust 后端 | Rust 2021 | 1.96 | `src-tauri/Cargo.toml:4` |
| 图标库 | Lucide React | 1.18 | `src/utils/icons.tsx:1` |

**NPM 依赖**（`package.json:11-21`）：`react`, `react-dom`, `@monaco-editor/react`, `monaco-editor`, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-shell`, `lucide-react`

**Rust 依赖**（`src-tauri/Cargo.toml:14-22`）：`tauri 2`, `serde`/`serde_json`, `log`/`env_logger`, `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-shell`

---

## 三、项目结构

```
eidtor-baby-dev/
├── src/                                 # React 前端
│   ├── main.tsx                         # 入口：浮动窗口 vs 主窗口分发
│   ├── App.tsx                          # 根组件（状态中枢 + 面板注册 + 菜单 + dock 事件监听）
│   ├── FloatingTauriApp.tsx             # Tauri 原生子窗口的独立 App（完整布局引擎，无 MenuBar）
│   ├── components/
│   │   ├── LayoutRenderer.tsx           # 布局树渲染引擎（53KB, 1365行，最核心）
│   │   ├── FloatingRenderer.tsx         # 应用内浮窗管理器（position:fixed, 491行）
│   │   ├── Editor.tsx                   # Monaco Editor 封装（91行，4个 addAction 快捷键）
│   │   ├── FileTree.tsx                 # 递归文件树（动态展开，169行）
│   │   ├── MenuBar.tsx                  # 顶部下拉菜单（File/Edit/View, 171行）
│   │   ├── TabBar.tsx                   # 文件标签栏（dirty 黄点标识, 93行）
│   │   ├── StatusBar.tsx                # 底部状态栏（路径/语言/光标, 56行）
│   │   ├── ExplorerPanel.tsx            # 文件浏览器面板（工具栏 + FileTree, 41行）
│   │   ├── ContextMenu.tsx              # 右键菜单（模块级 pub/sub, 127行）
│   │   └── ConfirmDialog.tsx            # 未保存关闭确认弹窗（92行）
│   ├── services/
│   │   └── fileService.ts              # Tauri IPC 封装（6个方法，80行）
│   ├── stores/
│   │   ├── layoutStore.ts              # 布局树全局状态（662行，核心）
│   │   └── panelRegistry.ts            # 面板注册表（38行）
│   ├── types/
│   │   ├── editor.ts                   # FileTab、AppState 类型定义（36行）
│   │   └── layout.ts                   # LayoutNode、SplitNode、TabGroup、FloatingWindow 等（60行）
│   └── utils/
│       ├── detectLanguage.ts           # 扩展名 → Monaco language ID / 人类可读标签（29行）
│       └── icons.tsx                   # Lucide React 图标映射 + GROUP_ICON_POOL（24行）
├── src-tauri/                           # Rust 后端
│   ├── src/lib.rs                       # Tauri 命令：文件I/O + 浮窗管理（192行，全部 Rust 逻辑集中于此）
│   ├── src/main.rs                      # Rust 入口（仅 6 行，调用 lib::run）
│   ├── Cargo.toml                       # Rust 依赖
│   ├── tauri.conf.json                 # Tauri 配置（窗口/安全/打包/插件/CSP, 44行）
│   └── capabilities/default.json      # 插件权限声明（5 项权限, 13行）
├── docs/
│   └── dev-log.md                       # 开发日志（踩坑记录 + 架构演进，228行）
├── package.json                         # 前端依赖 + 脚本
├── tsconfig.json                        # TypeScript 配置（target ES2022, strict）
├── vite.config.ts                       # Vite 配置（port 1420, ESNext target）
├── .mcp.json                            # CDP Inspector MCP 配置
├── .gitignore                           # 忽略规则（含 src/**/*.js 构建产物）
└── tauri-editor-from-scratch.md         # 从零构建指南（24.6KB）
```

---

## 四、最新提交（2026-06-14）

### 4.1 `3c0c5b8` — chore: add build artifacts to .gitignore

纯维护提交。将 `src/**/*.js`、`vite.config.js`、`package-lock.json` 加入 `.gitignore:7-9`，防止 TypeScript 编译产物和 Vite 构建输出被误提交。

### 4.2 `db903bc` — fix: 7 bug fixes from full code review

影响 4 个文件，共 +60 / -95 行。7 个修复按重要性排列：

#### Fix 1: dock_me 事件广播范围错误（`src-tauri/src/lib.rs:154-155`）

**问题**：`dock_me` 命令使用 `window.emit()` 发送事件，但 `WebviewWindow::emit()` 只发给当前窗口自身，导致主窗口永远收不到 `tauri-dock-panel` 事件，子窗口入坞功能完全失效。

**修复**：改为 `window.app_handle().emit()` 全局广播。

```rust
// Before (broken):
window.emit("tauri-dock-panel", serde_json::json!({...}))?;
// After:
window.app_handle().emit("tauri-dock-panel", serde_json::json!({...}))?;
```

#### Fix 2: FloatingRenderer dock handle 冷启动失败（`src/components/FloatingRenderer.tsx:243`）

**问题**：浮窗的 dock handle（⠿ 拖拽入坞）在 mousedown 时未调用 `ensureGlobalDragListeners()`，如果用户从未在主窗口拖拽过标签就直接拖浮窗的 dock handle，全局 mousemove/mouseup 监听器尚未安装，`computeDropTarget()` 不会被调用，入坞无反应。

**修复**：在 dock handle 的 `onMouseDown` 回调开头插入 `ensureGlobalDragListeners()`。

#### Fix 3: 浅拷贝导致 children 数组共享引用（`src/stores/layoutStore.ts:189-194` + `src/components/LayoutRenderer.tsx:490-494`）

**问题**：`createFloatingFromTab()` 对 tab 做 `{ ...tab }` 展开，但 `tab.children` 是引用类型，展开后新旧 tab 共享同一个数组。当后续修改任一 tab 的 children 时，另一个被意外变异。

**修复**：显式深拷贝 `children: tab.children ? tab.children.map((c) => ({ ...c })) : undefined`。同样修复了 `executeDrop` 中的 `newTab()` 函数。

#### Fix 4-6: toggle 面板硬编码索引（`src/stores/layoutStore.ts:631-661`）

**问题**：`toggleLeftPanel()`、`toggleRightPanel()`、`toggleBottomPanel()` 都通过硬编码索引（`root.sizes[0]`, `root.sizes[2]`, `center.sizes[1]`）操作，假设布局树结构不变。如果布局树被拖拽重组，这些索引就指向错误的节点。

**修复**：全部改为 `findParentSplit()` 查找父节点 + `hideGroup()`/`ensureGroupVisible()` 的标准化方式，与布局树实际结构解耦。

#### Fix 7: 消除浮动窗口子 tab 移除逻辑的三重内联重复（`src/components/FloatingRenderer.tsx` + `src/components/LayoutRenderer.tsx`）

**问题**：从浮窗复合父 tab 移除子 tab 时，相同的逻辑在 `FloatingRenderer` 的 `Action menu`、`Close Tab` 以及 `LayoutRenderer` 的 `executeDrop` 三个地方内联重复，每次约 15 行，且不一致（有些浅拷贝，有些直接突变）。

**修复**：提取为 `removeChildFromFloatingTab()` 统一函数（`src/stores/layoutStore.ts:165-186`），三处调用点改为一行调用。

---

## 五、架构详解

### 5.1 入口分发逻辑

`src/main.tsx:6-13` 根据运行时环境决定加载哪个 React 树：

- **主窗口**（`!isFloating`）-> 加载 `App.tsx`（含 MenuBar、完整 AppState、文件操作、dock 事件监听）
- **浮动子窗口**（hash `#floating/` 或 Tauri label 前缀 `float-`）-> 加载 `FloatingTauriApp.tsx`（独立布局树，无 MenuBar，通过 hash/label 解析 panelId 和 title）

检测逻辑（`src/main.tsx:6-8`）：
```typescript
const isFloating = window.location.hash.startsWith("#floating/")
  || ((window as any).__TAURI_INTERNALS__?.webview?.label || "").startsWith("float-");
```

双重检测原因（`docs/dev-log.md:201-206`）：hash 优先（URL 中物理存在，100% 可靠），label 回退（Tauri IPC 可直接读取）。

### 5.2 布局树系统（核心架构）

整个工作区的 UI 结构是一棵 **递归布局树**，定义在 `src/types/layout.ts:8`：

```typescript
type LayoutNode = SplitNode | TabGroup;
```

#### 类型定义（`src/types/layout.ts:8-59`）

| 类型 | 文件行号 | 说明 |
|------|----------|------|
| `LayoutNode` | L8 | 联合类型：`SplitNode \| TabGroup` |
| `SplitNode` | L11-17 | 水平/垂直分割容器，含 `children: LayoutNode[]` + `sizes: number[]` |
| `TabGroup` | L24-31 | 标签组，含 `tabs: TabInstance[]` + `activeTabId` + `tabStyle` |
| `TabStyle` | L21 | 四种风格：`"tabs" \| "activity" \| "activity-right" \| "activity-bottom"` |
| `FloatingWindow` | L34-46 | 浮窗定义：position + size + zIndex + 内嵌 TabGroup |
| `TabInstance` | L49-59 | 标签实例：支持复合子标签（`children?: TabInstance[]`）+ `activeChildId` |

#### 默认布局树（`src/stores/layoutStore.ts:7-60`）

```
root (horizontal split, sizes [25, 75, 0])
├── sidebar-left (TabGroup, activity style)  ← Explorer/Search/Outline
├── center-column (vertical split, sizes [100, 0])
│   ├── editor-area (TabGroup)               ← 编辑器
│   └── bottom-panel (TabGroup, activity-bottom)  ← 默认隐藏
└── sidebar-right (TabGroup, activity-right)  ← 默认隐藏
```

**状态管理**（`src/stores/layoutStore.ts:62-82`）：模块级单例模式 -- 非 immutable + 非框架 store（不用 Zustand/Redux），而是直接模块变量 + 订阅-发布模式：

```typescript
let tree: LayoutNode = createDefaultTree();
let listeners: Listener[] = [];
export function getTree(): LayoutNode { return tree; }
export function setTree(newTree: LayoutNode) { tree = newTree; listeners.forEach(fn => fn()); }
export function subscribe(fn: Listener) { ... return unsubscribe; }
```

设计取舍：每次拖拽操作需要突变整个树路径（`mapGroup` / `mapTree` 产生新对象），但订阅粒度是整棵树级别的（而非按节点），避免了 React context 的 per-node re-render 开销，保证拖拽操作 60fps。

#### 关键遍历函数（`src/stores/layoutStore.ts:210-272`）

| 函数 | 行号 | 功能 |
|------|------|------|
| `findGroup(root, groupId)` | L210-218 | 递归查找 TabGroup |
| `mapTree(root, fn)` | L221-227 | 递归映射整棵树 |
| `mapGroup(root, groupId, fn)` | L229-235 | 定位并变换指定 TabGroup |
| `findParentSplit(root, targetId)` | L238-252 | 查找 group 的父 SplitNode + 下标 |
| `ensureGroupVisible(groupId, defaultSize)` | L255-273 | 确保 group 可见（从最大兄弟借空间） |
| `hideGroup(groupId)` | L279-301 | 隐藏 group（size 归零，比例分配给兄弟） |

**PINNED_GROUPS**（`src/stores/layoutStore.ts:276`）：`Set(["sidebar-left", "editor-area", "sidebar-right", "bottom-panel"])` -- 这 4 个系统锚点 group 只能隐藏不能删除。

#### Tab 操作集（`src/stores/layoutStore.ts:303-481`）

| 函数 | 行号 | 功能 |
|------|------|------|
| `addTab(groupId, tab)` | L305-313 | 添加 tab 到 group 末尾 |
| `removeTab(groupId, tabId)` | L315-325 | 移除 tab（自动选下一个活跃） |
| `setActiveTab(groupId, tabId)` | L327-334 | 切换活跃 tab |
| `setActiveChild(groupId, tabId, childId)` | L337-346 | 复合组内切换活跃子 tab |
| `removeChildFromCompound(...)` | L349-379 | 从复合父 tab 拆出子 tab 为独立 tab |
| `moveTab(groupId, tabId, beforeTabId)` | L382-398 | 调整 tab 在同组内的顺序 |
| `setTabIcon(groupId, tabId, icon)` | L401-408 | 切换 tab 图标 |
| `moveChild(groupId, parentTabId, childId, beforeChildId)` | L411-431 | 调整复合子 tab 在父 tab 内的顺序 |
| `moveChildBetweenTabs(groupId, sourceParentId, childId, targetTabId)` | L434-481 | 跨父 tab 移动复合子 tab（最复杂操作） |
| `mergeIntoTab(groupId, targetTabId, sourceGroupId, sourceTabId)` | L484-531 | 将 source 标签合并为 target 的复合子组 |

#### 分割/合并操作（`src/stores/layoutStore.ts:533-613`）

| 函数 | 行号 | 功能 |
|------|------|------|
| `splitGroup(groupId, hint, newTab)` | L535-557 | 将 group 一分为二，新侧包含 newTab |
| `splitGroupEmpty(groupId, hint)` | L560-582 | 空分割（新侧为空白 TabGroup），由 SplitButton 调用 |
| `closeGroup(groupId)` | L585-587 | 移除 TabGroup，父 split 降级/合并 |
| `removeAndMerge(root, targetId)` | L589-613 | 内部递归：移除后如果只剩 1 子节点则收起 split |
| `updateSizes(splitId, sizes)` | L617-626 | 更新分割比例 |

### 5.3 面板注册系统

`src/stores/panelRegistry.ts:22-37` -- 简单的面板注册表：

```typescript
const panels = new Map<string, PanelDefinition>();
export function registerPanel(panel: PanelDefinition) { ... }
export function getPanel(id: string): PanelDefinition | undefined { ... }
```

**已注册的 4 个面板**（`src/App.tsx:202-284` + `src/FloatingTauriApp.tsx:34-52`）：

| ID | 用途 | Icon 来源 |
|----|------|-----------|
| `explorer` | 文件浏览器 + ExplorerPanel + FileTree | `Icons.explorer` (`FolderOpen`) |
| `search` | 搜索（占位） | `Icons.search` (`Search`) |
| `outline` | 大纲/符号（占位） | `Icons.outline` (`ListTree`) |
| `editor` | Monaco 编辑器 + TabBar | `Icons.editor` (`Code2`) |

主窗口和子窗口各自独立注册全部 4 个面板。主窗口的 `explorer` 面板通过 `appRef` 动态获取 rootPath 和回调（`App.tsx:207-215`），子窗口的则是空壳占位（`FloatingTauriApp.tsx:37-39`）。

### 5.4 图标系统

`src/utils/icons.tsx:1-24` 从 `lucide-react` 导入 12 个图标：

- **Icons 对象**（L5-13）：`explorer`(FolderOpen), `search`(Search), `outline`(ListTree), `editor`(Code2), `compoundGroup`(Layers), `file`(File), `default`(Box) -- 7 个
- **GROUP_ICON_POOL**（L16-23）：6 个候选图标用于复合组右键循环切换：Layers, FolderKanban, Package, Grid3X3, LayoutGrid, Combine

图标 fallback 链（贯穿 LayoutRenderer 和 FloatingRenderer）：`tab.icon -> panel.icon -> Icons.default`（三层链，见 `LayoutRenderer.tsx:493` 和 `FloatingRenderer.tsx:276`）。

---

## 六、LayoutRenderer -- 布局引擎详解

`src/components/LayoutRenderer.tsx`（1365 行，项目最大文件），是整个项目的核心引擎。

### 6.1 组件树

```
LayoutRenderer (L1335-1364)
└── LayoutNodeView (L1288-1293) — 递归分发
    ├── SplitView (L123-179) — flexbox 分割容器
    │   └── ResizeDivider (L183-226) — 可拖拽分隔线
    └── TabGroupView (L944-1284) — 标签组渲染
        ├── IconBtn (L816-852) — Activity Bar 图标
        ├── ReorderHandle (L701-726) — 排序把手
        └── SplitButton (L862-940) — 分割按钮（⊕）
```

### 6.2 useSplitResize -- 分隔线拖拽（L17-119）

核心设计要点：

1. **RAF + DOM 直写**（L74-86）：`requestAnimationFrame` 节流，直接设置 `el.style.flex` 而非通过 React state，避免 60fps 下的 re-render 开销
2. **松手同步**（L90-112）：`onUp` 时从 DOM 最终尺寸反算百分比，调用 `updateSizes()` 同步到 layoutStore
3. **隐藏节点处理**（L106-108）：`originalSizes` 跟踪完整数组（含 size=0 的隐藏节点），松手时通过可变索引 `vi` 仅对可见节点赋值
4. **全局 `userSelect: none`**（L66-67, L97）：拖拽期间禁用文本选择，松手时恢复

### 6.3 拖拽系统（L228-587）

拖拽系统是项目中最复杂的子系统，分为以下层次：

#### 拖拽状态机（L240-322）

模块级单例 `dragState`（L241），避免每次 render 重新创建：

```typescript
interface DragState {
  active: boolean;
  sourceGroupId: string;
  sourceFloatingId: string | null;
  tab: TabInstance | null;
  ghostEl: HTMLDivElement | null;
  startX: number; startY: number;
  compoundParentId: string | null;
}
```

- **5px 阈值启动**（L240, L261-297）：`DRAG_THRESHOLD = 5`，`startDragIfMoved()` 在鼠标移动超过阈值后才激活拖拽，避免误触
- **Ghost 元素**（L287-296）：蓝色 `position:fixed` 标签跟随鼠标，文字为 `tab.title`
- **dragDisabledElements 数组**（L259, L275-286）：拖拽期间禁用悬浮面板和滚动容器的 `pointer-events`，让 `elementFromPoint` 穿透到布局树；松手时通过数组精确恢复（不用不靠谱的字符串匹配，dev-log:106）
- **dragDidStart 标志**（L258, L268）：`onClick` 用它判断是否拖拽过，如果是拖拽则不触发 tab 切换

#### 统一 DropTarget 系统（L324-450）

**DropTarget 类型**（L328-331）：

```typescript
type DropTarget =
  | { kind: "root-edge"; side: "left" | "right" | "top" | "bottom" }
  | { kind: "group"; groupId: string; zone: ZoneType; targetTabId?: string;
      reorderBeforeTabId?: string; isReorder?: boolean; compoundBar?: boolean }
  | null;
```

**computeDropTarget() 优先级链**（L400-450）：

1. **root-edge 指示器**（L404-405）：4 个圆形箭头指示器，位于布局树根节点四边中点
2. **排序把手**（L408-413）：遍历 `reorderTargets` 数组，精确命中则触发同组排序
3. **图标子目标**（L416-421）：遍历 `iconTargets` 数组，命中则合并到目标 tab（作为复合子 tab）
4. **elementFromPoint**（L424-449）：鼠标位置下方的 DOM 元素 -> 查找 `data-group-id` 属性 -> 4a) 复合 tab 栏（`data-compound-bar`）优先几何 zone -> 4b) 几何 zone 检测

**isOverRootIndicator()**（L382-396）：四个 40px 圆形区域，距布局树边缘 6px，检测鼠标是否在任意指示器上方。

**Set-drop suppression**（L343-351）：`setDropTarget()` 用详细相等性检查避免重复通知，防止 React state 无意义更新。

**注册-注销模式**：`iconTargets`（L353-355）、`reorderTargets`（L357-359）、`groupRegs`（L363-374）三个数组/Map，组件通过 `useLayoutEffect` 注册，返回的清理函数自动注销。

#### 执行逻辑（L453-557）

`executeDrop()` 统一处理所有拖放操作：

- **null target**（L459-469）：tab 被拖到空区 -> 从源移除 -> `createFloatingFromTab()` 创建浮窗
- **root-edge**（L497-503）：按 `ROOT_EDGE_GROUPS` 映射创建新 tab 到目标侧
- **bar zone**（L510-529）：区分同组排序、跨组添加、图标合并（mergeIntoTab）、复合子移动
- **content zone**（L532-547）：同组 content drop = `mergeIntoTab` 到活跃 tab；跨组 content drop = 添加
- **edge-* zone**（L549-556）：跨组时 `splitGroup()` 创建新分割；同组 edge drop 不执行（由 `filterZone` 过滤）

#### 全局监听器安装（L560-586）

`ensureGlobalDragListeners()` -- 挂载全局 `mousemove`/`mouseup` 事件（仅一次）：

- **mousemove**（L564-575）：更新 ghost 位置 + `computeDropTarget()` + `setDropTarget()`
- **mouseup**（L576-585）：最后一次 `computeDropTarget()` -> `executeDrop()` -> `endDrag()` -> `setDropTarget(null)`

### 6.4 Zone 系统（L588-697）

四层解耦架构，将位置检测与视觉渲染完全分离：

**Layer 1: Zone 检测规则**（L606-630）

按 `TabStyle` 分组的规则表，由 `detectZone()`（L633-639）裁决。每种风格定义了 bar/content/edge-left/edge-right/edge-top/edge-bottom 的匹配区域。

**Layer 2: 上下文过滤**（L649-662）

`filterZone()` 根据拖拽元信息过滤无意义的 zone：
- 跨组：全部 zone 允许
- 同组：bar 和 content 始终允许；edge-* 不允许（不能在自己身上再分割）

**Layer 3: 统一入口**（L666-678）

`resolveDropZone()` 组合 Layer 1 + Layer 2，将屏幕坐标和 group rect 转化为有效 zone。

**Layer 4: Zone -> 视觉样式**（L682-697）

`getZoneVisual()` 将 zone 类型映射为：
- `edge-*` -> 3px 蓝色边框 + inset 阴影
- `bar` -> 高亮背景
- `content` -> 半透明覆盖层

### 6.5 TabGroupView 渲染（L944-1284）

**四种 TabStyle 渲染**：

| TabStyle | 布局 | Bar 位置 | 条件 |
|----------|------|----------|------|
| `tabs` | column | 顶部横排 | `!isActivity` (L1151-1283) |
| `activity` | row | 左侧 48px 纵排 | L1040-1127 |
| `activity-right` | row (reverse) | 右侧 48px 纵排 | L1129-1144 |
| `activity-bottom` | column (reverse) | 底部 35px 横排 | L1041-1127 |

**Content 解析**（L954-969）：
- `activeTab.children?.length` -> 复合组，取 `activeChildId` 对应的子 panel
- 否则 -> 基 tab，直接取 `panelId` 对应的 panel

**SplitButton**（L862-940）：每个 TabGroupView 内容区右上角显示 `×`（关闭/隐藏 group）+ `⊕`（Split 下拉菜单：Split Right/Down/Left/Up 四个方向）。使用 250ms 延迟关闭（L872-875）解决菜单一闪消失问题（dev-log:107）。

**Pin 逻辑**（L909）：`PINNED_GROUPS.has(nodeId)` 的 group 显示 "Hide" 而非 "Close Group"，因为它们不能删除只能隐藏。

### 6.6 根边缘覆盖层（L1297-1331）

`RootEdgeOverlay` -- 四个 40px 圆形半透明蓝色箭头指示器，位于布局树根节点四边中点 6px 偏移处。当 `currentTarget.kind === "root-edge"` 时渲染（L1361）。

---

## 七、FloatingRenderer -- 应用内浮窗

`src/components/FloatingRenderer.tsx`（491 行），管理应用内 `position: fixed` 浮窗。

### 7.1 架构

```
FloatingRenderer (L10-29)
└── FloatingPanelView[] (L77-490) — 每个浮窗一个实例
    ├── 标题栏 (L228-398)
    │   ├── Dock handle (⠿) — 拖拽入坞回布局树 (L242-325)
    │   ├── Tab bar — 嵌入标题栏，支持拖出 (L328-385)
    │   └── 关闭按钮 (L388-398)
    ├── 复合 tab bar (L402-444)
    ├── 内容区 (L448-458)
    └── 8 方向 resize 把手 (L460-487)
```

### 7.2 浮窗生命周期

**创建**：拖 tab 到空区（`LayoutRenderer.tsx:459-468`，`executeDrop` null target 分支）-> `createFloatingFromTab()`（`layoutStore.ts:189-206`）-> 深拷贝 tab（含 children 数组），创建新 TabGroup + FloatingWindow，位置为鼠标位置或错位 offset（每个新浮窗 +30px）。

**拖拽移动**（L109-142）：标题栏 mousedown -> move 事件直写 `el.style.left/top` -> up 时 `updateFloatingPosition()` 同步到 store。

**Resize**（L146-196）：8 方向把手（n/ne/e/se/s/sw/w/nw），最小 200x150，same pattern：DOM 直写移动 + 松手同步。

**z-index 管理**（`layoutStore.ts:88,130-134`）：单调计数器 `_floatingZCounter`，从 1000 开始递增。`bringFloatingToFront()` 赋最高值 -> 点击提至最前。

**入坞**（L242-325）：Dock handle 拖拽（⠿）-> `ensureGlobalDragListeners()` -> 浮窗 `opacity: 0.4` -> 蓝色 ghost "Dock ->" 标签 -> `elementFromPoint` 走 `computeDropTarget()` -> up 时将所有 tab 复制进目标 group -> `removeFloatingPanel()`。右键入坞（L294-315）：直接 dock 到 `editor-area`。

**右键菜单**（L33-73）：Open in New Window（Tauri 原生窗口）/ Float Tab（再次拆出）/ Close Tab。Close Tab 移除最后一个 tab 时自动 `removeFloatingPanel()`（`layoutStore.ts:153`）。

### 7.3 浮窗的 tab bar 拖出功能

浮窗内的 tab bar 支持拖出回布局树（L335-339）：`prepareDrag(group.id, tab, ..., sourceFloatingId=panel.id)` -> 全局拖拽系统接管 -> `computeDropTarget` 返回目标 -> `executeDrop` 的 `cleanSource` 分支调用 `removeTabFromFloating()`。

---

## 八、Tauri 原生窗口系统

### 8.1 Rust 命令（`src-tauri/src/lib.rs:92-164`）

| 命令 | 行号 | 功能 | 调用者 |
|------|------|------|--------|
| `create_floating_window` | L93-110 | 从单独线程创建 Tauri WebviewWindow | 主窗口（右键菜单） |
| `close_me` | L117-124 | 子窗口关闭自身 | 子窗口 |
| `close_floating_window` | L127-148 | 主窗口按 label 关闭子窗口 | 主窗口 |
| `dock_me` | L151-164 | 子窗口入坞 -> 广播 `tauri-dock-panel` 事件 -> 关闭自身 | 子窗口 |

**关键坑**（`docs/dev-log.md:158-176`）：`WebviewWindowBuilder::build()` 必须在 `std::thread::spawn` 里调用。如果在 `#[tauri::command]` 里直接调用会阻塞，永远不返回。

```rust
// 子窗口 URL 格式: index.html#floating/{panelId}/{title}/{label}
// hash 让浏览器保留路由信息，同时保证 Tauri App URL 正确解析
let path = format!("index.html#floating/{}/{}/{}",
    urlencoding(&panel_id), urlencoding(&title), urlencoding(&label));
```

### 8.2 FlotatingTauriApp.tsx（`src/FloatingTauriApp.tsx:1-82`）

子窗口加载的独立 React App。从 URL hash（优先）或 Tauri label（回退）解析 `panelId` 和 `title`（L11-16），然后：

1. 注册全部 4 个面板（空壳无文件操作能力）（L34-52）
2. 构建仅含目标 panel 的单 TabGroup 布局树（L55-68）
3. 渲染 LayoutRenderer（L76-79）
4. 无 MenuBar（注意：`FloatingTauriApp` 不包含 `<MenuBar menus={menus} />` -- L77-79 只渲染 div + LayoutRenderer）

### 8.3 事件流

```
主窗口: 右键 "Open in New Window"
  -> invoke("create_floating_window") 
  -> Rust thread::spawn -> WebviewWindowBuilder::build()
  -> 新 WebView2 进程加载 index.html#floating/{panelId}/{title}/{label}
  -> FloatingTauriApp 渲染

子窗口: 右键 "Dock to Main"
  -> invoke("dock_me", { panelId, title })
  -> Rust app_handle().emit("tauri-dock-panel", ...) 全局广播
  -> Rust window.close() 关闭自身
  -> 主窗口 App.tsx useEffect listen (L287-300) 
  -> addTab("editor-area", ...)
```

**重要约束**：
- 子窗口通过 Tauri IPC `import("@tauri-apps/api/core")` 调用 Rust 命令；
- 子窗口不支持 `BroadcastChannel`/`localStorage`/`window.postMessage` -- WebView2 进程隔离（`docs/dev-log.md:184-188`）
- 子窗口读 dist/，不走 Vite HMR，每次改前端代码需 `bun run build`（`docs/dev-log.md:217-218`）

---

## 九、核心组件详解

### 9.1 Editor.tsx -- Monaco 封装（`src/components/Editor.tsx:17-90`）

- **CDN 模式**：使用 `@monaco-editor/react` 而非静态 `import * as monaco` + `?worker`（Vite worker 导入不可靠，`docs/dev-log.md:133-134`）
- **Ref 稳定化**（L21-28）：4 个回调（`onSave`, `onSaveAs`, `onOpenFile`, `onCloseTab`）通过 `useRef` 避免闭包过时
- **4 个 Monaco addAction**（L36-62）：Ctrl+S（保存）/ Ctrl+Shift+S（另存为）/ Ctrl+O（打开）/ Ctrl+W（关闭）
- **语言检测**（L75）：`detectLanguageForMonaco()` 基于扩展名映射
- **光标追踪**（L32-34）：`onDidChangeCursorPosition` -> `onCursorChange(line, column)`

### 9.2 FileTree.tsx -- 文件树（`src/components/FileTree.tsx:58-132`）

- **递归组件**：`DirNode` 组件自调用（L122-128）
- **懒加载**：点击目录时 `fileService.readDir()` 拉取子节点（L80-84）
- **展开/折叠动画**：CSS `transform: rotate(90deg)`（L47-49）
- **图标**：目录 `📁`/`📂`，文件 `📄`（L96）
- **隐藏文件过滤**：Rust 侧跳过 `.` 开头、`node_modules`、`target`（`src-tauri/src/lib.rs:27-29`）

### 9.3 MenuBar.tsx -- 菜单系统（`src/components/MenuBar.tsx:83-169`）

- **自定义下拉菜单**（非原生，React 完全渲染）
- **悬停切换**（L118-120）：一个菜单已打开时悬停其他菜单自动切换
- **热退出**：Esc 关闭（L99-106）、点击外部关闭（L88-97，使用 `setTimeout(..., 0)` 避免当前 click 触发）
- **三级菜单**：File（New/Open/Save/Save As/Close）、Edit（Undo/Redo/Cut/Copy/Paste -- 通过 `editor.trigger()` 转发到 Monaco）、View（Toggle Left/Right/Bottom Panel）

### 9.4 fileService.ts -- IPC 封装（`src/services/fileService.ts:6-78`）

全部通过动态 `import()` 懒加载 Tauri 模块（而非静态 import），支持非 Tauri 环境优雅降级：

| 方法 | 行号 | 调用 | 说明 |
|------|------|------|------|
| `pickFile()` | L7-18 | `@tauri-apps/plugin-dialog` open | 单文件选择 |
| `readFile(path)` | L20-26 | `invoke("read_file")` | 自定义 Rust 命令（避免 fs plugin scope 限制） |
| `saveFile(path, content)` | L29-36 | `invoke("save_file")` | 自定义 Rust 命令（有完善错误处理） |
| `pickFolder()` | L39-49 | `@tauri-apps/plugin-dialog` open directory | 文件夹选择 |
| `readDir(path)` | L52-59 | `invoke("read_dir")` | 自定义 Rust 命令 |
| `saveAs(content)` | L62-78 | `@tauri-apps/plugin-dialog` save + `@tauri-apps/plugin-fs` writeTextFile | 另存为（双模块并行加载） |

### 9.5 其他组件

| 组件 | 文件 | 行数 | 功能 |
|------|------|------|------|
| TabBar | `src/components/TabBar.tsx` | 93 | 文件标签横栏，dirty 黄点（`#e5a43c` 8px 圆点, L47-54）+ 关闭按钮 |
| StatusBar | `src/components/StatusBar.tsx` | 56 | 文件路径 + 语言标签 + 光标行/列（`Ln X, Col Y` 格式, L50） |
| ContextMenu | `src/components/ContextMenu.tsx` | 127 | 模块级 pub/sub 右键菜单（`showCtxMenu`/`hideCtxMenu`, L11-20），`setTimeout` 延迟绑定 mousedown 避免当前 click 触发（L68） |
| ConfirmDialog | `src/components/ConfirmDialog.tsx` | 92 | 自定义确认弹窗替代不起作用的 `window.confirm`（Tauri WebView2 不显示原生 confirm, `docs/dev-log.md:143`），支持 Esc 关闭（L63-68） |

---

## 十、配置与开发环境

### 10.1 Tauri 配置

- **CSP**（`src-tauri/tauri.conf.json:25`）：`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; worker-src 'self' blob:`
- **插件配置**（`src-tauri/tauri.conf.json:38-42`）：`dialog: null`, `fs: null`, `shell: null` -- Tauri 2 要求用 `null` 而非 `{}`（`docs/dev-log.md:126`）
- **插件权限**（`src-tauri/capabilities/default.json:5-10`）：5 项 -- `core:default`, `dialog:allow-open`, `dialog:allow-save`, `fs:allow-read-text-file`, `fs:allow-write-text-file`
- **CDP 调试**（`src-tauri/src/lib.rs:81`）：WebView2 开启 port 8315 供 Chrome DevTools 连接
- **CDP Inspector MCP**（`.mcp.json:2-12`）：通过 `extensions/cdp-inspector` 连接 WebView2
- **日志**（`src-tauri/src/lib.rs:62-76`）：`env_logger` 写入 `%APPDATA%/my-editor/my-editor.log`，panic 也写日志（L85-89）

### 10.2 构建配置

- **Vite**（`vite.config.ts:4-20`）：`server.port: 1420`（strictPort），`build.target: "esnext"`，debug 时不 minify + 生成 sourcemap
- **TypeScript**（`tsconfig.json:2-14`）：target `ES2022`，module `ESNext`，`strict: true`，moduleResolution `bundler`
- **Rust**（`src-tauri/Cargo.toml:1-4`）：edition `2021`，`[lib]` crate-type `["lib", "cdylib", "staticlib"]`，build dependency `tauri-build 2`
- **前端构建产物**（`.gitignore:8-10`）：`src/**/*.js`, `vite.config.js`, `package-lock.json` 在 `3c0c5b8` 中加入

### 10.3 开发陷阱（`docs/dev-log.md:118-226`）

| 陷阱 | 说明 | 相关行号 |
|------|------|----------|
| 路径问题 | 不能从 `D:\` 启动（Junction 映射导致 esbuild 解析失败） | L120-123 |
| Monaco | 用 CDN 模式而非静态 `import * as monaco` + `?worker` | L131-134 |
| Tauri 插件 | config 用 `null` 而非 `{}`，capabilities 必须显式声明 | L126-128 |
| 插件 scope | `@tauri-apps/plugin-fs` 的 `readTextFile` 受 scope 限制，改为自定义 Rust 命令 | L128 |
| 构建环境 | Cargo 需代理，360 杀软拦截 Temp 目录 | L137-139 |
| 子窗口 | `build()` 需 `thread::spawn`，子窗口读 dist/ 不走 Vite HMR | L158-176, L217-218 |
| window.confirm | Tauri WebView2 不显示原生 confirm，需自定义组件 | L143 |
| 保存 src-tauri/ 触发 cargo watch 重编译 | 不是崩溃，是热重载 | L129 |

### 10.4 Tauri 子窗口通信验证（`docs/dev-log.md:149-199`）

| URL 类型 | JS 加载 | `__TAURI_INTERNALS__` | invoke 可用 |
|----------|---------|----------------------|-------------|
| `External("http://localhost:1420/")` | Vite HMR | 不存在 | 不可用 |
| `App("index.html")` (无 build) | 404 | - | - |
| `App("index.html")` (有 build) | 从 dist 加载 | 存在 | 可用 |
| `CustomProtocol("tauri://localhost/")` | 404 | - | - |

---

## 十一、错误处理机制

### 11.1 Rust 侧

- **文件 I/O**（`src-tauri/src/lib.rs:16,38,44`）：所有 `fs` 操作通过 `map_err` 转为 `Result<_, String>`，由 Tauri 自动序列化返回前端
- **save_file 目录检查**（L48-51）：写之前验证父目录存在
- **Panic 捕获**（L85-89）：`std::panic::set_hook` 将 panic 信息写入日志文件
- **子窗口操作**（L105-108, L120-123, L137-139, L160-162）：全部 `log::error!` + `map_err` 返回字符串错误

### 11.2 前端侧

- **Tauri 环境检测**（`fileService.ts:2-4`）：`isTauri()` 检查 `__TAURI_INTERNALS__` / `__TAURI__`，非 Tauri 环境优雅降级
- **动态 import**（`fileService.ts` 多处）：所有 Tauri 模块通过 `await import()` 懒加载，避免非 Tauri 环境报错
- **子窗口 IPC**（`FloatingTauriApp.tsx`）：`import("@tauri-apps/api/core")` 而不是静态 import（`docs/dev-log.md:209-214`）
- **ConfirmDialog**（`ConfirmDialog.tsx:63-68`）：Escape 键关闭（ref 稳定化避免闭包过时）
- **saveFile alert**（`App.tsx:123-126`）：捕获 `saveFile` 错误后 `alert()` 显示

---

## 十二、开发进度

| Phase | 内容 | 状态 | Commits |
|-------|------|------|---------|
| 1 | Tauri + Vite + React + Monaco 脚手架 | Completed | `97f1375` |
| 2 | FileTree + TabBar + StatusBar + 文件读写 + 快捷键 | Completed | `01aa1bf`, `433cb59` |
| 3 | MenuBar + SidePanel + Activity Bar + 面板拖拽 + 面板注册 | Completed | `035551f`, `c2af381`, `e1bd5ad` |
| 4 | 统一布局树 + 拖拽系统 + SplitView + TabGroup + Lucide 图标 | Completed | `438564b` |
| 5 | 应用内浮窗 + Tauri 原生窗口 + 右键菜单 + dock 入坞 | Completed | `fc10c68`, `de5a7bb`, `db903bc` |
| Maintain | Build artifacts gitignore | Completed | `3c0c5b8` |
| 待做 | 深色主题、插件系统、Terminal 面板、图标选择器 | Not started | - |

---

## 十三、关键文件索引

| 文件 | 大小 | 重要性 | 说明 |
|------|------|--------|------|
| `src/components/LayoutRenderer.tsx` | 53KB (1365行) | Core | 布局引擎核心：SplitView + TabGroupView + 拖拽系统 + Zone 系统 |
| `src/stores/layoutStore.ts` | 22KB (662行) | Core | 布局状态管理：CRUD + 遍历 + 浮窗 + 面板显隐 |
| `src-tauri/src/lib.rs` | 7.6KB (192行) | Core | Rust 后端：全部 7 个 Tauri 命令 + 日志 + CDP |
| `src/App.tsx` | 12KB (363行) | Core | 根组件：状态中枢 + 面板注册 + dock 事件 + 菜单 |
| `src/components/FloatingRenderer.tsx` | 19KB (491行) | Core | 应用内浮窗：移动、resize、z-index、dock handle、tab bar |
| `src/FloatingTauriApp.tsx` | 3.7KB (82行) | High | 子窗口 App：独立布局树构建 + 面板注册 |
| `docs/dev-log.md` | 12KB (228行) | High | 开发日志：踩坑记录 + 架构演进 + 子窗口验证矩阵 |
| `src/components/Editor.tsx` | 2.8KB (91行) | Medium | Monaco 封装：4 个 addAction + ref 稳定化 |
| `src/components/FileTree.tsx` | 4.1KB (169行) | Medium | 递归文件树：DirNode 自调用 + 懒加载 |
| `src/components/MenuBar.tsx` | 4.8KB (171行) | Medium | 非原生下拉菜单：悬停切换 + Esc/外部关闭 |
| `src/components/TabBar.tsx` | 2.4KB (93行) | Medium | 文件标签栏：dirty 黄点 + 关闭 |
| `src/services/fileService.ts` | 2.7KB (80行) | Medium | IPC 封装：6 个方法，动态 import + 环境降级 |
| `src/components/ContextMenu.tsx` | 3.3KB (127行) | Medium | 右键菜单：模块级 pub/sub |
| `src/types/layout.ts` | 1.8KB (60行) | Medium | 布局类型定义：LayoutNode + SplitNode + TabGroup + FloatingWindow + TabInstance |
| `src/types/editor.ts` | 1.2KB (36行) | Medium | 前端类型定义：FileTab + AppState |
| `src/utils/icons.tsx` | 0.8KB (24行) | Medium | Lucide 图标：Icons 对象 + GROUP_ICON_POOL |
| `src/utils/detectLanguage.ts` | 0.8KB (29行) | Medium | 扩展名映射：Monaco 语言 ID + 人类可读标签 |
| `src/stores/panelRegistry.ts` | 1.0KB (38行) | Medium | 面板注册表：Map + 订阅 |
| `src/main.tsx` | 0.4KB (14行) | Low | React 入口：浮动/主窗口分发 |
| `src-tauri/tauri.conf.json` | 1.0KB (44行) | Low | Tauri 配置：CSP + 插件 + 打包 |
| `src-tauri/capabilities/default.json` | 0.3KB (13行) | Low | 插件权限声明 |
| `src-tauri/src/main.rs` | 0.2KB (6行) | Low | Rust 入口 |
| `package.json` | 0.7KB (30行) | Low | NPM 依赖 + 脚本 |
| `vite.config.ts` | 0.5KB (21行) | Low | Vite 构建配置 |
| `tsconfig.json` | 0.4KB (16行) | Low | TS 编译配置 |
| `index.html` | 0.4KB (16行) | Low | HTML 入口 + 全局 CSS reset |
| `.mcp.json` | 0.3KB (12行) | Low | CDP Inspector MCP |
| `.gitignore` | 0.1KB (11行) | Low | Git 忽略规则 |
| `src-tauri/Cargo.toml` | 0.4KB (23行) | Low | Rust 依赖 |

---

## 十四、与 claude-code-haha-dev 的关联点

1. **CDP Inspector MCP**（`.mcp.json:2-12`）：eidtor-baby 通过 `cdp-inspector` MCP server 连接 WebView2 CDP port 8315，MCP server 入口为 `D:/Development/claude-code-haha-dev/extensions/cdp-inspector/entry.ts`
2. **编辑器概念借鉴**：claude-code 的 IDE 插件（VS Code/IntelliJ/VS Studio）与 eidtor-baby 共享类似的面板/布局概念
3. **Office COM Bridge**：eidtor-baby 的文件 I/O 模式（Rust command -> IPC -> React）和模块级 pub/sub 模式（ContextMenu、layoutStore）可作为 Office COM bridge 架构参考
4. **开发方法论**：eidtor-baby 采用的 `docs/dev-log.md` 踩坑记录、迭代式 Phase 推进、全源码 code review 修复等实践方法在 claude-code-haha-dev 项目中也适用
