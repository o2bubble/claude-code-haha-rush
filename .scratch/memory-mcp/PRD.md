# PRD: Claude Code Agent Memory MCP Server

## 问题陈述

Claude Code agent 目前缺乏跨会话的持久化记忆能力。虽然有 session memory（会话内摘要）和 auto memory（文件注释式记忆），但它们：
- 无法主动查询历史经验——只能被动加载写死的 markdown 文件
- 无法建立记忆间的非线关联——读完一条不能发散到相关记忆
- 无法在多台机器间共享——每台电脑各自为战
- 缺乏经验积累机制——踩过的坑下次还会踩

## 目标

开发一个 MCP server，为 agent 提供：
1. **持久化记忆存储** — 跨会话、跨机器
2. **语义搜索** — 自然语言查询相关记忆
3. **知识图谱** — 记忆间有权重边，支持图遍历发散
4. **经验积累** — 成功/失败经验沉淀，避免重复踩坑
5. **Scope 隔离** — 通用方法论 vs 特定技术域 vs 特定项目，分层管理

## 非目标

- 不做前端/UI 界面
- 不替代现有 session memory 或 auto memory（互补关系）
- 不做实时自动记忆提取（首版仅手动+提示词驱动）

---

## 技术方案

### 选型

| 层 | 选择 | 理由 |
|----|------|------|
| 语言 | Python 3.10+ | `mcp` 包成熟，`sentence-transformers` 生态好 |
| 存储 | SQLite | 单文件零配置，可同步 |
| Embedding | all-MiniLM-L6-v2 | 80MB 轻量，CPU 推理 <100ms，384维 |
| 向量搜索 | NumPy 余弦相似度 | 无需额外向量数据库，万级记忆够用 |
| 部署 | Docker + FastAPI/SSE | HTTP transport 支持多机访问 |
| 本地兜底 | stdio transport | 离线或无 Docker 时直接起进程 |

### 架构

```
┌─────────────┐     HTTP/SSE      ┌──────────────────────┐
│  Claude Code │ ───────────────→ │  Docker (Linux x64)   │
│  (any PC)    │                  │  ┌────────────────┐  │
└─────────────┘                  │  │  MCP Server     │  │
       │                          │  │  - FastAPI/SSE  │  │
       │ stdio (本地兜底)         │  │  - store.py     │  │
       └──────────────────────────│  │  - embeddings   │  │
                                  │  └────────────────┘  │
                                  │  ┌────────────────┐  │
                                  │  │  SQLite DB      │  │
                                  │  └────────────────┘  │
                                  └──────────────────────┘
```

---

## 数据模型

### memories

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,          -- UUID v7
  type TEXT NOT NULL,            -- fact | experience | lesson
  scope TEXT NOT NULL DEFAULT 'global',  -- global | domain:<name> | project:<name>
  title TEXT NOT NULL,
  content TEXT NOT NULL,         -- Markdown
  embedding BLOB,                -- float32, 384-d
  importance REAL DEFAULT 0.5,   -- 0.0-1.0
  access_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,      -- ISO-8601
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_scope ON memories(scope);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
```

### tags + memory_tags

```sql
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, tag_id)
);
```

### associations (知识图谱边)

```sql
CREATE TABLE associations (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0
  type TEXT NOT NULL DEFAULT 'related_to',
    -- related_to | derived_from | contradicts | supports
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, type)
);
```
### content_refs (内容引用边，自动解析)

```sql
CREATE TABLE content_refs (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, target_id)
);
```

`memory_store` 写入 content 时自动用正则 `memory://([a-f0-9-]{36})` 解析引用链接。`memory_get` 返回 `content_refs`（出边）和 `referenced_by`（入边），支持双向导航和未来 web 知识图谱渲染。

### meta (元数据)

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 记录 schema_version, last_normalized_at, embedding_model 等
```

---

## MCP Tools

### 1. memory_store
存储新记忆。
```
Input:
  type: "fact" | "experience" | "lesson"
  title: string
  content: string (Markdown)
  scope?: string (default "global")
  tags?: string[]
  associations?: [{ target_id: string, weight: float, type: string }]

Output:
  { id, title, type, scope }
```

### 2. memory_search
多模式搜索。
```
Input:
  query: string
  mode?: "semantic" | "tag" | "hybrid" (default "hybrid")
  scope?: string[] (过滤 scope)
  type?: string[] (过滤类型)
  tags?: string[] (仅 tag 模式)
  limit?: int (default 10)
  min_similarity?: float (default 0.3)

Output:
  [{ id, title, type, scope, snippet (前200字), similarity, tags }]
```

### 3. memory_get
获取单条记忆完整内容 + 关联。
```
Input: id

Output:
  { id, type, scope, title, content, tags,
    associations: [{ id, title, type: edge_type, weight }],
    content_refs: [{ id, title }],         -- memory:// references (outgoing)
    referenced_by: [{ id, title }],        -- memories that reference this one (incoming)
    importance, access_count, created_at, updated_at }
```

### 4. memory_associate
创建/更新关联边（双向可选）。
```
Input:
  source_id, target_id, weight, type,
  bidirectional?: bool (default false)

Output: { source_id, target_id, weight, type }
```

### 5. memory_traverse
从记忆出发沿边 BFS 遍历。
```
Input:
  start_id, max_depth? (default 2), min_weight? (default 0.3),
  direction?: "outgoing" | "incoming" | "both" (default "both")

Output:
  { nodes: [{ id, title, type, scope }],
    edges: [{ source_id, target_id, weight, type }] }
```

### 6. memory_tags
列出所有标签。
```
Input: scope? (可选过滤)

Output: [{ tag, count }]
```

### 7. memory_forget
删除记忆。
```
Input: id, confirm: bool

Output: { deleted: true }
```

### 8. memory_stats
统计信息。
```
Input: (none)

Output:
  { total_memories, by_type: { fact: n, experience: n, lesson: n },
    by_scope: { global: n, ... }, total_tags, total_associations, total_content_refs,
    db_size_kb, model }
```

### 9. memory_normalize_tags
标签归一化（LLM 驱动，服务端只执行映射）。
```
Input:
  mapping: dict (required) — {old_tag: canonical_tag}
  dry_run?: bool (default false)

Output:
  { mappings: { "old_tag": "new_tag", ... },
    merged_count: int,
    dry_run: bool }
```
流程: memory_tags() → LLM分析重复 → 构建 mapping → memory_normalize_tags(mapping)

---

## Scope 设计

```
global          — 通用方法论，任何场景适用
domain:rust     — Rust 技术域（标签 rust/cargo/tokio… 自然聚于此域）
domain:react    — React 技术域
domain:devops   — DevOps/CI 技术域
project:claude-code-haha  — 特定项目的记忆
project:my-blog             — 另一个项目
```

- `scope` 是 memories 表的普通字段，不是枚举——用户可以创建任意 scope
- 搜索时 `scope?` 参数支持列表，也支持前缀匹配 `domain:*`
- 标签归一化时，同 scope 内的标签优先聚类

---

## Agent 使用流程

### 自动触发（agent 判断）
Agent 收到系统指令（`docs/agents/memory-mcp.md` 注入后），在以下情况主动调用：
- 开始新任务前 → `memory_search(query)` 查找相关经验
- 学习到新知识点 → `memory_store(type="fact")` 记录
- 完成任务后 → `memory_store(type="experience")` 记录方案
- 踩坑/出错后 → `memory_store(type="lesson")` 记录教训

### Skill 命令触发 (`/remember`)
纯提示词技能（无脚本），让 agent：
1. 回顾最近对话中的关键决策和问题
2. 提取可复用的经验、教训、知识点
3. 调用 `memory_store` + `memory_associate` 完成沉淀

### 手动调用
用户直接让 agent 调 MCP tool，如 "存一下这条记忆"、"搜一下关于 Docker 的经验"。

---

## 部署与配置

### Docker 部署（HTTP transport）
```dockerfile
FROM python:3.11-slim
RUN pip install mcp sentence-transformers numpy
COPY extensions/memory/ /app/
WORKDIR /app
CMD ["python", "server.py", "--transport", "sse", "--host", "0.0.0.0", "--port", "8080"]
```

```bash
docker build -t claude-memory-mcp -f extensions/memory/Dockerfile .
docker run -d -p 8080:8080 -v /data/claude-memory:/data --name claude-memory claude-memory-mcp
```

### Claude Code MCP 配置示例
```json
// 远程 HTTP 模式
{
  "mcpServers": {
    "memory": {
      "type": "sse",
      "url": "http://<server-ip>:8080/sse"
    }
  }
}

// 本地 stdio 模式
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "python",
      "args": ["extensions/memory/server.py", "--db-path", "~/claude-memory.db"]
    }
  }
}
```

---

## 项目结构

```
extensions/memory/
├── server.py              # MCP server (stdio + SSE dual transport)
├── store.py               # SQLite CRUD + vector search
├── embeddings.py           # all-MiniLM-L6-v2 wrapper
├── normalize.py            # 标签归一化逻辑
├── requirements.txt        # Python deps
├── Dockerfile
├── docker-compose.yml
├── setup.ps1               # Windows 一键初始化
├── setup.sh                # Linux/macOS 一键初始化
└── config.example.json     # Claude Code MCP 配置示例

docs/agents/
└── memory-mcp.md           # Agent 注入文档

.scratch/memory-mcp/
└── PRD.md                  # 本文档
```

---

## 风险与待定

1. **SQLite 并发写入** — HTTP 模式下多 agent 同时写，SQLite 有锁争用。首版接受（万级记忆、单用户场景并写概率低），未来可升级到 PostgreSQL
2. **Embedding 模型升级** — 模型版本变化导致向量不兼容。meta 表记录 model 名，搜索前检查匹配
3. **记忆爆炸** — 时间久了记忆太多，搜索质量下降。`importance` + `access_count` 提供排序基础，未来可加衰减策略
4. **标签归一化歧义** — "python" 和 "python3" 在通用上下文中是同义词，但在特定场景可能需要区分。`min_similarity` 阈值可调 + `dry_run` 预览
