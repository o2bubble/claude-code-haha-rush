# 笔记面板（Notes Panel）

**Status:** spec-ready (2026-07-29)

---

## Problem Statement

目前 GUI 没有个人笔记功能。用户需要手动记录的知识、备忘、灵感无处存放。同时 AI 也需要一个结构化的笔记系统来为用户创建、整理和检索信息。

现有的 Memory MCP 系统虽然有标签/scope/关联体系，但依赖本地 embedding 做语义搜索、内置 D3 图谱可视化，且作为独立 Python 进程运行。GUI 需要的是一个轻量级、纯文本检索、与 GUI 深度集成的笔记系统。

## Solution

在 GUI 中构建内置笔记系统：

1. **用户级 SQLite 存储**（`~/.claude/notes/notes.db`），跨工作区共享
2. **左侧边栏面板** — 笔记列表 + Milkdown WYSIWYG Markdown 编辑器
3. **MCP 工具集**（9 个）— AI 可创建/读取/搜索/管理笔记
4. **标签 + Scope + 关联系统**（复刻 Memory MCP 的设计，去掉 embedding/图谱）
5. **标签归一化** — 手动触发，调用当前 LLM 做语义分组（不依赖本地 embedding 模型）

## User Stories

1. As a 用户, I want to 在左侧边栏看到笔记列表，so that 我能快速浏览和切换笔记
2. As a 用户, I want to 点击"+ 新建笔记"创建一个新笔记，so that 我能随时记录想法
3. As a 用户, I want to 用所见即所得的 Markdown 编辑器编辑笔记，so that 我不需要记住 Markdown 语法
4. As a 用户, I want to 给笔记添加标签和 scope，so that 我能分类和筛选笔记
5. As a 用户, I want to 建立笔记之间的关联（相关/派生/矛盾/支持），so that 我能组织知识网络
6. As a 用户, I want to 手动触发标签归一化，so that 语义相似的标签被合并
7. As an AI, I want to 通过 MCP 创建和更新笔记，so that 我能为用户持久化重要信息
8. As an AI, I want to 通过 MCP 搜索笔记（纯文本 LIKE），so that 我能检索已有知识
9. As an AI, I want to 通过 MCP 列表和管理标签，so that 我能了解笔记的标签体系

## Implementation Decisions

### 1. 架构

```
NotesPanel.tsx  ←→  Tauri invoke()  ←→  Rust notes.rs  ←→  ~/.claude/notes/notes.db
     ↑
MCP Bridge (mcpBridge.ts) ← Rust TCP (13920) ← AI agent
```

- **存储**: Rust 直接操作 SQLite（不经过 JS store），前端通过 Tauri invoke 调用
- **MCP**: 复用现有 MCP bridge 模式（Tauri TCP → JS dispatch → invoke Rust commands）
- **编辑器**: Milkdown v7（WYSIWYG Markdown，基于 ProseMirror）

### 2. 数据模型

#### `notes` 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID v4 |
| title | TEXT NOT NULL | 笔记标题 |
| content | TEXT NOT NULL | Markdown 正文 |
| scope | TEXT NOT NULL DEFAULT 'global' | global / domain:xxx / project:xxx |
| created_at | TEXT NOT NULL | ISO 8601 |
| updated_at | TEXT NOT NULL | ISO 8601 |

#### `note_tags` 表（多对多）
| 字段 | 类型 | 说明 |
|------|------|------|
| note_id | TEXT FK → notes(id) CASCADE | 笔记 ID |
| tag_id | INTEGER FK → tags(id) CASCADE | 标签 ID |
| PK | (note_id, tag_id) | |

#### `tags` 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK AUTOINCREMENT | |
| name | TEXT UNIQUE NOT NULL | 小写存储 |

#### `note_associations` 表
| 字段 | 类型 | 说明 |
|------|------|------|
| source_id | TEXT FK → notes(id) CASCADE | |
| target_id | TEXT FK → notes(id) CASCADE | |
| weight | REAL DEFAULT 0.5 | 0.0–1.0 |
| type | TEXT DEFAULT 'related_to' | related_to / derived_from / contradicts / supports |
| PK | (source_id, target_id, type) | |

### 3. 与 Memory MCP 的关键差异

| 维度 | Memory MCP | Notes Panel |
|------|-----------|-------------|
| 搜索 | 语义搜索（384-dim embedding） | 纯文本 LIKE |
| 可视化 | D3 知识图谱 | 无（仅列表中显示关联） |
| 标签归一化 | 本地 embedding 聚类 | 调用当前 LLM 做语义分组 |
| 嵌入模型 | all-MiniLM-L6-v2 | 不需要 |
| 部署 | 独立 Python 进程 + Docker | 内嵌于 Tauri Rust 后端 |
| 存储 | 独立 SQLite | `~/.claude/notes/notes.db` |
| content_refs | memory://UUID 自动解析 | 暂不需要 |

### 4. MCP 工具（9 个）

| 工具 | 必需参数 | 可选参数 | 说明 |
|------|---------|---------|------|
| `note_create` | title, content | scope, tags[] | 创建笔记 |
| `note_update` | id | title, content, scope, tags[] | 更新笔记（仅更新提供的字段） |
| `note_delete` | id | | 删除笔记（CASCADE tags/associations） |
| `note_get` | id | | 获取完整笔记（含 tags + associations） |
| `note_list` | | scope, tag, limit(默认50) | 列表，按 updated_at 降序 |
| `note_search` | query | scope, limit(默认20) | LIKE %query% 搜索 title+content |
| `note_associate` | source_id, target_id | weight, type, bidirectional | 创建关联 |
| `note_tags` | | scope | 列出所有标签 + 计数 |
| `note_normalize_tags` | | dry_run | 调用 LLM 归一化标签 |

### 5. 标签归一化（LLM 版）

流程：
1. 用户点击"归一化标签"按钮（或 AI 调用 `note_normalize_tags`）
2. 收集所有标签名 → 构造 prompt：`"Group these tags by semantic similarity:{tag1, tag2, ...}. Return JSON: {mappings: {old_tag: new_canonical_tag}}"`
3. 发 `run_cli_print` 给后台 Claude（类似技能翻译的机制）
4. 解析返回的 JSON → 应用 SQL UPDATE 重命名标签
5. 返回 `{mappings, merged_count}` 给调用者

### 6. 前端面板布局

```
NotesPanel
├── 顶部工具栏
│   ├── [+ 新建笔记]
│   ├── [Scope 筛选 ▼]
│   ├── [标签筛选 ▼]
│   ├── [搜索...]
│   └── [归一化标签]
├── 笔记列表（可滚动）
│   └── 每项: 标题 + 标签 chips + updated_at + scope badge
└── 编辑器区域（选中笔记后展开）
    ├── 标题输入框
    ├── Scope 下拉 + 标签 chips（可编辑）
    ├── Milkdown 编辑器（WYSIWYG Markdown）
    ├── 关联笔记区域
    └── 底部: 保存状态 + 删除按钮
```

### 7. 依赖

- `@milkdown/kit` — 核心编辑器 + 常用插件
- `@milkdown/react` — React 集成
- `@milkdown/theme-nord` — 默认主题
