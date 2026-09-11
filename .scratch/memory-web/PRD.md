# PRD: Memory MCP — Web 可视化界面 + REST API

## 问题陈述

Memory MCP 服务已完整实现并部署（9 tools, SSE transport, 96 服务器端口 40020），但当前只有 MCP 协议接口——只有 Claude Code agent 能访问它。作为开发者，我想：

1. **浏览记忆库** — 不敲 JSON 就能看到有哪些记忆
2. **可视化知识图谱** — 力导向图直观展示记忆间的关联
3. **快速搜索** — 浏览器里搜，比在终端调 MCP tool 方便
4. **直接编辑** — 鼠标点一下就能改标题、内容、标签，不用 JSON
5. **监控状态** — 一眼看到记忆增长、标签分布、热门记忆

## 目标

1. **REST API 层** (`api.py`) — 独立的 FastAPI 服务，共享 `store.py` + `embeddings.py`，与 MCP server 协议分离但逻辑复用
2. **Web UI** — 纯前端 SPA，调用 REST API，提供：
   - 知识图谱可视化（D3.js 力导向图）
   - 记忆搜索 + 列表浏览
   - 记忆 CRUD 编辑
   - 标签管理
   - 统计仪表盘
3. **Docker 部署** — 同一镜像，同时运行 MCP + REST API 两个进程

## 非目标

- 不做用户认证（内网信任）
- 不替代 MCP 接口（互补关系）
- 不做移动端适配
- 不做记忆的实时 WebSocket 推送（首版轮询/刷新即可）
- 不做批量导入导出

---

## 技术方案

### 架构

```
Claude Code ──MCP/SSE──▶ server.py (现有, :40020)
                              │
                              ├── store.py (不改)
                              ├── embeddings.py (不改)
                              └── normalize.py (不改)

Browser ──REST──▶ api.py (新增, :40021)
                       │
                       ├── 搜索逻辑 (从 server.py 提取为 search_engine.py)
                       ├── 静态文件 → web/
                       └── CORS → 允许浏览器跨域
```

**关键决策：代码复用策略**

| 模块 | 状态 | 说明 |
|------|------|------|
| `store.py` | 不动 | 完整 CRUD，直接 import |
| `embeddings.py` | 不动 | 直接 import |
| `normalize.py` | 不动 | 直接调用，它访问 `store._conn` 可接受 |
| `server.py` | 微调 | 提取 `hybrid_search()` 到新文件 `search_engine.py`，两边共用 |
| `search_engine.py` | 新增 | 纯函数 `hybrid_search(query, store, embedder, ...)` |

### 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| API 框架 | FastAPI | Starlette 超集，自动 Swagger 文档，Pydantic 验证 |
| API 端口 | 40021 | 与 MCP(40020) 分离，各自独立 |
| 前端框架 | React 18 + Vite | 项目已是 React 生态（Ink TUI），保持一致。组件化开发，后期扩展不卡 |
| 图可视化 | D3.js v7 | 只做力导向布局算法 + SVG 操作，不抢 React 的 DOM |
| 样式 | CSS Modules | 零配置（Vite 内置），作用域隔离，按组件拆分 |
| 状态管理 | React hooks + context | 当前规模不需要 Redux/zustand，useReducer + context 足够 |
| 构建产物 | `web/dist/` | Vite 打包成静态文件，FastAPI 直接 serve |

### Search Engine 提取

`server.py::_handle_memory_search` (~95行) 中的混合搜索逻辑：
- 语义搜索: `embedder.encode(query)` → `store.get_all_with_embeddings()` → `cosine_similarity`
- 标签搜索: `store.search_by_tags(tags, scope, type)`
- 合并公式: `score = 0.7 * similarity + 0.2 * importance + 0.1 * tag_boost`
- 提取为 `search_engine.py::hybrid_search()`，server.py 和 api.py 都调用它

---

## REST API 设计

### 基础信息

- Base URL: `http://<host>:40021`
- Content-Type: `application/json`
- CORS: `*`（内网）
- 自动文档: `/docs` (Swagger UI), `/redoc` (ReDoc)

### 端点

#### `GET /api/stats`
系统概览，同 `memory_stats`。
```json
{
  "total_memories": 25,
  "by_type": {"fact": 12, "experience": 8, "lesson": 5},
  "by_scope": {"global": 3, "domain:devops": 7, "project:claude-code-haha": 15},
  "total_tags": 18,
  "total_associations": 34,
  "total_content_refs": 10,
  "db_size_kb": 2048,
  "model": "all-MiniLM-L6-v2"
}
```

#### `GET /api/memories`
搜索 + 列表。查询参数：
```
q?           string   — 搜索词（为空则返回最新）
mode?        string   — "hybrid" (default) | "semantic" | "tag"
type?        string[] — 过滤类型: fact, experience, lesson
scope?       string[] — 过滤 scope
tags?        string[] — 过滤标签（AND）
limit?       int      — default 20, max 100
offset?      int      — default 0
sort?        string   — "relevance" (default when q) | "newest" (default when no q) | "importance" | "access_count"
```

Response:
```json
{
  "total": 25,
  "items": [{
    "id": "uuid",
    "title": "...",
    "type": "fact",
    "scope": "global",
    "snippet": "前200字...",
    "tags": ["python", "docker"],
    "importance": 0.8,
    "access_count": 5,
    "similarity": 0.72,
    "created_at": "2026-07-15T10:00:00",
    "updated_at": "2026-07-15T12:00:00"
  }]
}
```

#### `GET /api/memories/{id}`
单条记忆详情。
```json
{
  "id": "uuid",
  "type": "fact",
  "scope": "global",
  "title": "...",
  "content": "完整 Markdown...",
  "tags": ["python", "docker"],
  "importance": 0.8,
  "access_count": 5,
  "associations": [
    {"id": "uuid", "title": "...", "type": "related_to", "weight": 0.7}
  ],
  "content_refs": [{"id": "uuid", "title": "..."}],
  "referenced_by": [{"id": "uuid", "title": "..."}],
  "created_at": "...",
  "updated_at": "..."
}
```

#### `POST /api/memories`
创建记忆。
```json
// Request
{
  "type": "fact",
  "title": "...",
  "content": "...",
  "scope": "global",
  "tags": ["python", "docker"],
  "importance": 0.5,
  "associations": [
    {"target_id": "uuid", "weight": 0.7, "type": "related_to"}
  ]
}
// Response: 201 { id, title, type, scope }
```

#### `PUT /api/memories/{id}`
更新记忆（部分更新）。
```json
// Request: 所有字段可选
{ "title": "new title", "content": "new content", "importance": 0.9 }
// Response: 200 { id, updated: true }
```

#### `DELETE /api/memories/{id}`
删除记忆（级联删除关联和内容引用）。
```json
// Response: 200 { deleted: true, id: "uuid" }
```

#### `GET /api/tags`
标签列表，可选 scope 过滤。
```
scope? string — 可选，按 scope 过滤
```
```json
{
  "tags": [
    {"tag": "python", "count": 8},
    {"tag": "docker", "count": 5}
  ]
}
```

#### `GET /api/graph`
全图数据，用于前端 D3 可视化。
```
start_id? string  — 可选，从某个节点出发
max_depth? int    — default 2（仅当 start_id 时有效）
min_weight? float — default 0.1
```
```json
{
  "nodes": [
    {"id": "uuid", "title": "...", "type": "fact", "scope": "global", "importance": 0.8}
  ],
  "edges": [
    {"source": "uuid", "target": "uuid", "weight": 0.7, "type": "related_to"}
  ]
}
```

#### `POST /api/associations`
创建关联。
```json
// Request
{
  "source_id": "uuid",
  "target_id": "uuid",
  "weight": 0.7,
  "type": "related_to",
  "bidirectional": false
}
// Response: 201
```

#### `DELETE /api/associations`
删除关联。
```json
// Request
{
  "source_id": "uuid",
  "target_id": "uuid",
  "type": "related_to"
}
// Response: 200 { deleted: true }
```

#### `POST /api/tags/normalize`
标签归一化。
```json
// Request
{
  "dry_run": true,
  "min_similarity": 0.85
}
// Response
{
  "mappings": {"rust-lang": "rust", "Rust": "rust"},
  "merged_count": 2,
  "dry_run": true
}
```

---

## Web UI 设计

### 布局

```
┌─────────────┬──────────────────────────┬──────────────┐
│ Sidebar     │      Main Area           │ Detail Panel │
│ 280px       │                          │ 340px        │
│             │ ┌──────────────────────┐ │              │
│ [🔍 Search] │ │ Stats Bar            │ │ [Title]      │
│             │ │ 25 记忆 · 18 标签    │ │              │
│ Q: docker   │ │ 34 关联 · 2.0 MB     │ │ Type: fact   │
│             │ └──────────────────────┘ │ Scope: glob  │
│ [Tags]      │                          │              │
│ ☐ python(8)│ ┌──[Graph View]────────┐ │ Tags:        │
│ ☐ docker(5)│ │   ● ── ●            │ │ [python]     │
│ ☐ rust (3) │ │  /    /  \           │ │ [docker]     │
│ ☐ ai   (4) │ │ ● ─ ●    ●          │ │              │
│             │ │  |                  │ │ Content:     │
│ [Types]     │ │  ●                  │ │ Markdown...  │
│ ◉ All       │ └─────────────────────┘ │              │
│ ○ fact      │                          │ Associations:│
│ ○ experience│ ┌──[List View]────────┐  │ ● Docker...  │
│ ○ lesson    │ │ ● Docker部署实录    │  │ ● Python...  │
│             │ │ ● Python虚拟环境... │  │              │
│ [+ New      │ │ ● 标签归一化方案    │  │ [Edit]       │
│  Memory]    │ │                      │  │ [Delete]    │
│             │ └──────────────────────┘ │              │
└─────────────┴──────────────────────────┴──────────────┘
```

### 交互流程

1. **首次打开** → 加载 stats + 最新记忆列表
2. **搜索** → 输入关键词，实时搜索（300ms debounce），结果按相关性排序
3. **点击搜索结果** → 右侧面板展开详情
4. **点击图节点** → 右侧面板展开详情
5. **标签/类型过滤** → 与搜索词组合过滤
6. **新建记忆** → 弹出/滑入编辑表单
7. **编辑** → 详情面板切换到编辑模式
8. **删除** → 确认弹窗 → 级联删除
9. **图视图切换** → 主区域切换为 D3 力导向图或记忆列表
10. **创建关联** → 在图视图中拖拽连线，或表单中搜索选择

### 配色（暗色主题）

```
背景: #0d1117 (GitHub dark)
卡片: #161b22
文字: #c9d1d9
强调: #58a6ff (蓝)
类型色:
  fact       → #58a6ff (蓝)
  experience → #3fb950 (绿)
  lesson     → #f85149 (红)
边类型色:
  related_to    → #8b949e (灰)
  derived_from  → #58a6ff (蓝)
  contradicts   → #f85149 (红)
  supports      → #3fb950 (绿)
```

---

## 文件清单

### 新增

| 文件 | 行数(估) | 说明 |
|------|----------|------|
| `.scratch/memory-web/PRD.md` | ~250 | 本文档 |
| `extensions/memory/search_engine.py` | ~80 | 提取的混合搜索纯函数 |
| `extensions/memory/api.py` | ~350 | FastAPI REST 服务 |
| `extensions/memory/web/index.html` | ~15 | Vite 入口 HTML |
| `extensions/memory/web/package.json` | ~15 | React + Vite + D3 依赖 |
| `extensions/memory/web/vite.config.js` | ~15 | Vite 配置 |
| `extensions/memory/web/src/main.jsx` | ~10 | ReactDOM.createRoot |
| `extensions/memory/web/src/App.jsx` | ~80 | 主布局 + 状态管理 |
| `extensions/memory/web/src/App.module.css` | ~60 | 主布局样式 |
| `extensions/memory/web/src/components/Sidebar.jsx` | ~100 | 搜索 + 过滤 |
| `extensions/memory/web/src/components/StatsBar.jsx` | ~30 | 统计条 |
| `extensions/memory/web/src/components/MemoryList.jsx` | ~80 | 记忆列表 |
| `extensions/memory/web/src/components/MemoryDetail.jsx` | ~150 | 详情/编辑面板 |
| `extensions/memory/web/src/components/GraphView.jsx` | ~180 | D3 力导向图（React 容器）|
| `extensions/memory/web/src/components/CreateDialog.jsx` | ~80 | 新建/编辑弹窗 |
| `extensions/memory/web/src/lib/api.js` | ~100 | REST 调用封装 |
| `extensions/memory/web/src/lib/d3-graph.js` | ~120 | D3 力导向纯逻辑（不碰 JSX）|
| `extensions/memory/web/src/hooks/useDebounce.js` | ~15 | 防抖 hook |
| `extensions/memory/web/src/index.css` | ~80 | 全局 + 暗色变量 |

### 修改

| 文件 | 变更 |
|------|------|
| `extensions/memory/server.py` | `_handle_memory_search` 改为调用 `search_engine.hybrid_search()` |
| `extensions/memory/requirements.txt` | 新增 `fastapi>=0.110.0`, `python-multipart>=0.0.9` |
| `extensions/memory/Dockerfile` | 复制 web/ + search_engine.py, 修改 CMD 同时启动两个进程 |
| `extensions/memory/.dockerignore` | 新增排除 `web/node_modules`, `web/dist` (Docker 内构建) |
| `.scratch/memory-mcp/PRD.md` | 更新非目标: "不做前端/UI" → "前端另见 memory-web PRD" |

### 服务器部署

- API 地址: `http://192.168.186.96:40021`
- API 文档: `http://192.168.186.96:40021/docs`
- Web UI: `http://192.168.186.96:40021/`
- 容器内启动脚本: 同时启动 MCP(:40020) 和 API(:40021)

---

## 风险

1. **SQLite 并发** — MCP + REST API 同时读写同一个 DB。SQLite WAL 模式下读写并发足够（万级记忆场景），两个进程各自打开连接没有问题
2. **搜索性能** — 每次搜索遍历全量 embedding。万级以内 NumPy 余弦计算 < 50ms，够用。超万可考虑 FAISS
3. **D3 大数据量** — 超过 200 个节点力导向图会卡。首版全图加载，后续可只加载子图
4. **docker-compose 端口暴露** — 需要同时暴露 40020 和 40021，注意防火墙

## 未来扩展（不在本 PRD）

- 记忆时间线视图
- 批量操作（选择多条记忆关联/删除）
- WebSocket 实时同步：MCP 端有新记忆时 Web UI 自动刷新
- 记忆分享链接（只读）
- 导出为 Markdown/JSON
- 移动端响应式
