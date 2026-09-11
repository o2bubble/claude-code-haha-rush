# PRD: Memory Explorer UX/UI 重设计

> 基于设计 Agent 交付的 Notion 风格原型，对 Memory MCP Web 前端进行体系化重设计。

## 设计原型

以下文件为设计 Agent (Open Design) 的交付物，不可修改，仅作参考：

| 文件 | 路径 |
|------|------|
| HANDOFF | `C:\Users\SZH\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c2771c3b-8f66-4216-a361-19894eb5ba0b\HANDOFF.md` |
| 主产品原型 | `C:\Users\SZH\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c2771c3b-8f66-4216-a361-19894eb5ba0b\memory-explorer.html` |
| Landing 页 | `C:\Users\SZH\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c2771c3b-8f66-4216-a361-19894eb5ba0b\landing.html` |
| 布局对比 | `C:\Users\SZH\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c2771c3b-8f66-4216-a361-19894eb5ba0b\memory-layout-compare.html` |

项目源码在 `C:\Storage\claude-code-haha-dev\extensions\memory\web\`。

## 问题陈述

当前 Memory Explorer Web UI 虽然功能完整，但存在以下体验问题：

1. **暗色主题单一** — 亮色环境下对比度过高，且无亮/暗切换
2. **三栏布局拥挤** — 侧栏+主区+详情面板同时显示，小屏下空间不足
3. **模态框编辑割裂** — 新建/编辑记忆弹出独立模态框，遮住列表和图谱，失去上下文
4. **浏览器 confirm() 简陋** — 删除确认用原生弹窗，风格不统一且无 a11y
5. **缺少标签浏览** — 只能通过侧栏 checkbox 筛选标签，无法浏览和发现标签
6. **Scope 扁平化** — 自由文本字段无层级结构，大量 scope 时难以导航
7. **无响应式** — 仅桌面端适用，小屏或窗口较窄时布局崩溃

## 解决方案

基于 **Notion 设计体系**（暖白底、`#0075de` accent）全面重设计前端，后端 API 不动。核心策略：组件逻辑保留或增强，视觉和布局对齐设计原型。

## 用户故事

1. 作为开发者，我希望能在亮色和暗色主题之间切换，以适应不同光照环境
2. 作为开发者，我希望侧栏更紧凑（240px），主区更大，详情面板点击后才滑入而非始终占用空间
3. 作为开发者，我希望点击记忆后在原地编辑（面板内切换阅读↔编辑），不弹出遮住全屏的模态框
4. 作为开发者，我希望编辑时面板自动扩宽到 600px，给 Markdown 编辑留足空间
5. 作为开发者，我希望删除确认弹窗与应用风格一致，且支持键盘操作和无障碍访问
6. 作为开发者，我希望在侧栏中看到 Scope 的树形层级而非扁平列表
7. 作为开发者，我希望在标签视图中浏览所有标签的网格卡片，点击标签即可筛选记忆
8. 作为开发者，我希望详情面板中能看到当前记忆的局部关联子图
9. 作为开发者，我希望在编辑模式下能添加/删除显式关联
10. 作为开发者，我希望搜索框的 UI 风格对齐 Notion（圆角、聚焦环、字体系统）
11. 作为开发者，我希望登录页有更精致的视觉效果（可选粒子背景）
12. 作为开发者，我希望图谱每个节点按类型着色，边按关联类型着色
13. 作为开发者，我希望图谱有全屏模式按钮，方便在大数据集下探索
14. 作为开发者，我希望窗口 ≤860px 时布局自适应收紧，≤640px 时侧栏折叠为图标模式
15. 作为开发者，我希望所有动画在系统开启 `prefers-reduced-motion` 时自动降级
16. 作为访客，我希望在 landing 页看到产品介绍和特性展示，点击后进入登录页
17. 作为开发者，我希望焦点环不被容器裁剪（`outline-offset: 1px`）

## 实现决策

### 1. 设计体系：Notion tokens

CSS 变量全量替换为 Notion 暖白体系，保留亮/暗双主题：

```css
/* 亮色 (默认) */
--bg: #ffffff;
--surface: #f6f5f4;
--fg: rgba(0,0,0,0.95);
--muted: #615d59;
--meta: #a39e98;
--border: rgba(0,0,0,0.1);
--accent: #0075de;
--type-fact: #0075de;
--type-experience: #1aae39;
--type-lesson: #dd5b00;
```

暗色通过 `[data-theme="dark"]` 覆盖这些变量，值从当前暗色主题中选取并适配 Notion 色板。

### 2. 主题切换

- 默认跟随 `prefers-color-scheme`
- 用户手动切换后写入 `localStorage('memory_web_theme')`
- 手动选择优先于系统设置
- 在 App.jsx 中通过 `useEffect` + `matchMedia` 监听系统变化

### 3. 布局：二栏 + 滑入面板

```
┌──────────┬─────────────────────┬──────────────┐
│ Sidebar  │      Main Area       │ Detail Panel │
│ 240px    │                      │ 380px/600px  │
│          │ [Stats Bar]          │ (slide-in)   │
│ Search   │                      │              │
│ Types    │ [View Tabs]          │ Read/Edit    │
│ Scope 🌲 │  List | Graph | Tags │ Sub-graph    │
│ Top Tags │                      │              │
│ [+ New]  │ [Content Area]       │              │
│ Stats    │                      │              │
└──────────┴─────────────────────┴──────────────┘
```

- 侧栏固定 240px，背景 `var(--surface)`
- 主区弹性，包含 StatsBar + ViewTabs + 内容区（列表/图谱/标签三 tab）
- 详情面板 `position: absolute; right: 0; width: 380px`，`transform: translateX(100%)` 隐藏，选中记忆后 `translateX(0)` 滑入（`transition: 0.25s cubic-bezier(0.2,0,0,1)`）
- 编辑模式下面板宽度切换为 600px（通过 CSS class 切换，transition 0.25s）

### 4. Scope 树形导航

- 自动解析：按 `:` 分割 scope 字符串
  - `domain:devops` → 一级 `domain`，二级 `devops`
  - `project:claude-code-haha` → 一级 `project`，二级 `claude-code-haha`
  - `global` → 叶子节点，无层级
- 构建树：收集所有 scope → 按层级分组 → 渲染可折叠树
- 点击 scope 节点 → 过滤记忆（精确匹配该 scope）
- 默认折叠到一级，展开后显示完整层级

### 5. 标签视图 (TagView)

- 主区第三个 tab，与列表/图谱并列
- 网格布局：`grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))`
- 每张卡片：标签名（accent 色，bold）+ 记忆数（mono 字体）+ 关联 scope（灰色小字）
- 顶部搜索框：客户端过滤标签名
- 点击标签卡片 → 切回列表视图并筛选该标签
- 底部 "标签归一化" 按钮 → 调用 `POST /api/tags/normalize`

### 6. 面板内编辑

- MemoryDetail 面板有两种模式：`reading` / `editing`
- 阅读模式：内容渲染 + 关联列表 + 局部子图 + 元数据 + 编辑/删除按钮
- 点击 "编辑" → 面板切换到编辑模式（`dp-form.show`），宽度 600px
- 编辑表单字段：类型(select)、标题(input)、Scope(input)、标签(input, 逗号分隔)、内容(textarea)、重要性(range slider)
- "保存" → PUT /api/memories/{id} → 切回阅读模式，刷新列表/图谱/标签
- "取消" → 放弃修改，切回阅读模式
- "删除" → 打开自定义 ConfirmDialog → 确认后 DELETE → 关闭面板
- CreateDialog.jsx 逻辑合并到 MemoryDetail.jsx，"新建" 时打开空表单的面板

### 7. 自定义确认对话框 (ConfirmDialog)

- 通用组件，替代所有 `confirm()` 调用
- `role="alertdialog"` + `aria-modal="true"`
- Notion 风格卡片：标题 + 描述 + 确认/取消按钮
- 支持 `danger` 变体（确认按钮红色）
- 暴露接口：`<ConfirmDialog open title message onConfirm onCancel variant />`

### 8. 详情面板内嵌子图

- 380px 面板底部嵌入 140px 高的 D3 力导向子图
- 节点：当前记忆 + 直接关联的记忆（1 跳）
- 复用 `d3-graph.js` 的力导向逻辑，缩小画布
- 点击子图节点 → 切换到该记忆的详情
- 面板编辑模式下不显示子图（节省空间）

### 9. 关联编辑

- 面板编辑模式下，关联列表每条加 × 删除按钮（`DELETE /api/associations`）
- 底部 "添加关联" 区域：搜索框（输入标题搜索记忆）+ 搜索结果下拉 + 选择关联类型和权重
- 新增关联通过 `POST /api/associations`

### 10. 侧栏搜索 UI

- 不做 Spotlight Cmd+K 弹窗
- 搜索框 UI 对齐 Notion 风格：更大内边距、聚焦环 `outline: 2px solid var(--accent); outline-offset: 1px`
- 输入时 300ms debounce 调用 `/api/memories?q=...` 进行语义搜索
- 搜索结果在主区列表视图中展示

### 11. 登录页优化

- Notion 风格卡片：居中、阴影、大标题、"请输入密码以继续" 副标题
- Canvas 粒子背景：50 个 accent 色粒子 + 近距连线，非阻塞（canvas 不可用时静默跳过）
- 独立于 React 渲染，放在 HTML 中 `<canvas>` + 内联 JS
- 粒子动画尊重 `prefers-reduced-motion`

### 12. Landing 页

- 独立 HTML 页面，产品营销风格
- 结构：Hero（标题+副标题+CTA 按钮）→ 3 特性卡片 → 数据展示 → 底部链接
- "进入产品" 按钮链接到 `memory-explorer.html` 或 `/`
- 与主应用共享部分 CSS tokens

### 13. 图谱全屏按钮

- 图谱视图右上角 "全屏" 图标按钮
- 点击后图谱扩展到整个视口（`position: fixed; inset: 0; z-index: 40`）
- 全屏模式下显示 "退出全屏" 按钮
- 复用 GraphView 组件，只是切换容器大小

### 14. 响应式

- ≤860px：侧栏缩窄到 200px，详情面板 320px
- ≤640px：侧栏折叠为图标模式（仅显示图标，hover 展开文字），详情面板占满宽度
- 通过 CSS `@media` 查询实现，不需 JS 逻辑

### 15. a11y

- 密码输入框：`<label>` 视觉隐藏但可被屏幕阅读器读到
- 图标按钮：`aria-label`
- 弹窗：`role="dialog"` / `role="alertdialog"` + `aria-modal="true"`
- 侧栏：`<nav aria-label="主导航">`
- ALL CAPS 标签：`letter-spacing ≥ 0.06em`
- 焦点环：`outline-offset: 1px`（非负值）
- `@media (prefers-reduced-motion: reduce)` 全局动画降级

## 组件清单

### 修改的组件

| 组件 | 变更 |
|------|------|
| `App.jsx` | 二栏+滑入面板布局、亮/暗主题、视图三 tab、面板状态管理 |
| `App.module.css` | 全面重写，Notion tokens |
| `index.css` | CSS 变量替换为 Notion 体系 + 暗色变量 |
| `Login.jsx` | Notion 卡片风格 |
| `Sidebar.jsx` | Scope 树形导航、常用标签 top 8、"查看全部"入口、新 UI |
| `StatsBar.jsx` | Notion 风格 badge、mono 字体数字 |
| `MemoryList.jsx` | Notion 卡片样式、选中高亮、新 badge |
| `MemoryDetail.jsx` | 阅读↔编辑切换、内嵌子图、关联编辑、删除确认替代 |
| `GraphView.jsx` | Notion 配色、全屏按钮 |
| `d3-graph.js` | 节点/边配色更新为 Notion 语义色 |

### 新增的组件

| 组件 | 说明 |
|------|------|
| `TagView.jsx` | 标签网格视图，搜索过滤，归一化入口 |
| `ConfirmDialog.jsx` | 自定义确认弹窗，替代 `confirm()` |
| `ScopeTree.jsx` | 侧栏 Scope 树形导航（可折叠） |
| `ThemeToggle.jsx` | 亮/暗主题切换按钮 |
| `landing.html` | 独立 Landing 页 |

### 删除

| 文件 | 原因 |
|------|------|
| `CreateDialog.jsx` | 逻辑合并到 MemoryDetail 面板编辑模式 |

## 测试决策

- **测试范围**：仅测组件外部行为（渲染正确的 DOM 结构、事件回调触发、条件显示/隐藏）
- **不测**：CSS 视觉样式、动画效果、D3 力导向的物理行为
- **现有模式**：项目无前端测试体系，首版以手动验证 + E2E 截图对比为主
- **验证方式**：构建后部署 → Playwright 截图 → 与设计原型对比关键页面

## 不在范围

- 后端 API 修改（现有 12 个端点保持不变）
- MCP 协议修改
- 移动端原生适配
- 多语言扩展（保持 zh-CN/en 双 locale）
- 性能优化（虚拟列表等）
- PWA / Service Worker
- **Spotlight (Cmd+K) 全局搜索** — 侧栏搜索框已覆盖 90% 场景，Spotlight 附加交互复杂度收益有限。原型中有实现（scale+fade 弹窗），搁置，未来有明确需求时再启用
