# GUI Agent Guide — Working Inside Claude Code GUI

You are running inside the Claude Code GUI desktop client. This document covers what's different from the CLI and what tools/panels are available.

## Environment

- **Runtime**: Tauri 2 (Rust backend) + React (frontend), WebView2 rendering
- **Shell**: Bun (not Node.js), TypeScript + React JSX
- **User interaction**: Graphical UI with panels, not terminal-only
- **Available documents**: `~/.claude/gui-ref-system.md` (reference links), `~/.claude/gui-config-files.md` (config file architecture — read it when fixing MCP/settings/env), `docs/ARCHITECTURE.md` (full architecture)

## Panels (what the user sees)

| Panel | ID | Purpose |
|-------|-----|---------|
| Chat Messages | `messages` | Conversation display |
| Chat Input | `input` | Message input area |
| File Browser | `files` | File tree with create/rename/delete/context menu |
| Editor | `editor` | Monaco code editor + image/PDF/SVG preview |
| Terminal | `terminal` | xterm.js multi-tab terminal for agent commands |
| Sessions | `sessions` | Conversation history manager |
| Plan | `plan` | TodoWrite task display + history timeline |
| Sub-Agents | `subagents` | Background agent list + transcript viewer |
| Skills | `skills` | Installed skills + online marketplace |
| Workers | `workers` | Backend process status |
| Super Desktop | `super-desktop` | Infinite canvas with 9 block types |
| Settings | `settings` | App configuration (language, font, editor, etc.) |
| Quick Prompts | `quick-prompts` | Saved prompt templates |
| Notes | `notes` | Personal notes with tags, scope, and associations |

## Super Desktop (9 block types)

The Super Desktop is an infinite canvas where content blocks can be created, edited, and connected.

| Block Type | Content Type | Editable By |
|-----------|-------------|-------------|
| Text | `text` | User + AI |
| Table | `table` | User + AI (spreadsheet-like, editable cells) |
| Chart | `chart` | AI only (uPlot, display-only) |
| Graphic | `graphic` | User + AI (Mermaid diagram or flowchart/mindmap) |
| Ref | `ref` | AI-created (@ref link card) |
| File Group | `filegroup` | User paste/drop (file tree) |
| Image | `image` | User paste/drop (base64 preview) |
| Form | `form` | User fill values, AI configure fields (10 control types) |
| Drawing | `drawing` | User draw (freehand/shapes/text/eraser) + AI view |

## Super Desktop MCP Tools (16 available)

Access these via the MCP server running on the Tauri backend:

| Tool | Description |
|------|-------------|
| `desktop_summary` | Lightweight snapshot of all desktops, items, connections |
| `desktop_get_items` | Full content of specific items by ID |
| `desktop_search` | Search items by label or content text |
| `desktop_create_item` | Create a new block (text/table/chart/graphic/ref/form/drawing; graphic accepts Mermaid code) |
| `desktop_update_item` | Update block content or properties |
| `desktop_delete_items` | Delete blocks by ID |
| `desktop_move_item` | Move block to new position |
| `desktop_resize_item` | Resize block |
| `desktop_connect` | Create a connection line between two blocks |
| `desktop_disconnect` | Remove a connection |
| `desktop_undo` | Undo last canvas operation |
| `desktop_redo` | Redo last undone operation |
| `desktop_list` | List all desktops |
| `desktop_create` | Create a new desktop tab |
| `desktop_delete` | Delete a desktop tab |
| `initialize` | MCP handshake |
| `tools/list` | List available tools |

### Content type reference

Each block type requires a specific content structure. **Match `type=` parameter to `content.type=` field:**

| type= | content.type | Key content fields |
|-------|-------------|-------------------|
| `text` | `"text"` | `format` ("plain"\|"markdown"\|lang), `text` |
| `table` | `"table"` | `columns[{id, name, width?, children?, pinned?}]`, `rows[{id, cells: {colId: value}}]`, `cellStyles?`, `formats?` — 多级表头/合并/样式/数字格式/冻结，语法见下方 Table syntax（高级） |
| `drawing` | `"drawing"` | `svg` (view mode), `width`, `height`, `elements?` (editable strokes) |
| `chart` | `"chart"` | `chartType` ("bar"\|"line"\|"pie"\|"scatter"\|"area"\|"radar"\|"funnel"\|"gauge"), `title`, `data: {labels, datasets}`; config: bar{stack:true}, pie{donut:true}, scatter{[x,y] pairs} |
| `graphic` | `"graphic"` | `mermaid` (Mermaid code, recommended), or legacy `subType`+"flowchart"\|"mindmap"+`nodes[]`+`edges[]` |
| `ref` | `"ref"` | `references[]` (@ref links) |
| `filegroup` | `"file-group"` | `files[]` (file paths) |
| `image` | `"image"` | `path` |
| `form` | `"form"` | `fields[]` |

**Drawing vs Graphic**: `drawing` is for hand-drawn vector art (raw SVG). `graphic` is for diagrams — **Mermaid** (recommended, supports all Mermaid types: flowchart / sequenceDiagram / mindmap / stateDiagram / gantt / pie / ...) or structured flowchart/mindmap (legacy, nodes+edges). Do NOT use `graphic` when you want free-form SVG art — use `drawing`.

### Common MCP workflows

```
# Text note
desktop_create_item(type="text", label="Note",
  content={type:"text", format:"markdown", text:"# Hello"})

# Table (spreadsheet)
desktop_create_item(type="table", label="Project Tasks",
  content={type:"table",
    columns:[{id:"c1",name:"Task"},{id:"c2",name:"Status"}],
    rows:[
      {id:"r1",cells:{c1:"Design API",c2:"Done"}},
      {id:"r2",cells:{c1:"Implement",c2:"In Progress"}},
    ]})

# Table syntax（高级）— 多级表头 / 合并 / 单元格样式 / 数字格式 / 冻结
# 1) 多级表头: 列组用 children 树。组不承载数据，叶子列才是数据列（cells 的 key = 叶子列 id）。
desktop_create_item(type="table", label="区域销售",
  content={type:"table",
    columns:[
      {id:"city",name:"城市",pinned:"left"},                                  # pinned 冻结列
      {id:"g-east",name:"华东",children:[{id:"q1",name:"Q1"},{id:"q2",name:"Q2"}]},
      {id:"total",name:"总计"},
    ],
    rows:[{id:"r1",cells:{city:"上海",q1:"12345.6",q2:"0.25",total:"12370.1"}}],
    formats={q1:"0,0.00", q2:"0%"},                                          # 千分位两位小数 / 百分比
    cellStyles={"r1:total":{color:"#e5484d",bold:true,align:"right"}},        # 标红加粗右对齐
  })
# 2) 跨列合并: 该格 cellStyle 加 colSpan:N（向右占 N 列，N=1 不合并）。
#    cellStyles 键格式 "rowId:colId"，可用字段: color / bgColor / bold / italic / align('left'|'center'|'right') / colSpan。
# NOT supported: rowSpan（跨行合并）、条件着色（直接算好静态色写 cellStyles）、公式（算好结果写值）。

# Vector art (raw SVG, view-only)
desktop_create_item(type="drawing", label="Sketch", width=800, height=600,
  content={type:"drawing", svg:"<svg viewBox='0 0 800 600'>...</svg>", width:800, height:600})

# Vector art (editable strokes — user can select and edit individual shapes)
desktop_create_item(type="drawing", label="Sun", width=300, height=300,
  content={type:"drawing", svg:"<svg viewBox='0 0 300 300'><circle cx='150' cy='150' r='50' fill='#FFD700'/></svg>",
    width:300, height:300,
    elements:[
      {id:"sun",type:"circle",cx:150,cy:150,r:50,color:"#FFA500",strokeWidth:3,fillColor:"#FFD700",opacity:1},
      {id:"ray1",type:"line",x1:150,y1:70,x2:150,y2:40,color:"#FFA500",strokeWidth:3,opacity:1},
      {id:"smile",type:"freehand",points:[{x:130,y:160},{x:150,y:175},{x:170,y:160}],color:"#FF8C00",strokeWidth:2,opacity:1},
    ]})

# Chart — three data channels (ECharts, all types supported)
# (a) Simple: data + chartType (bar/line/pie/scatter/area/radar/funnel/gauge)
desktop_create_item(type="chart", label="Sales",
  content={type:"chart", chartType:"line", title:"Q3 Sales",
    data:{labels:["Jan","Feb","Mar"], datasets:[{label:"Revenue",data:[100,200,150]}]}})
# (b) Series passthrough: raw ECharts series[] (any type)
desktop_create_item(type="chart", label="Treemap",
  content={type:"chart", title:"Storage",
    series:[{type:"treemap", data:[{name:"A",value:120},{name:"B",value:80}]}]})
# (c) Full option: complete ECharts option for complex charts
desktop_create_item(type="chart", label="Candlestick",
  content={type:"chart", title:"Stock",
    option:{xAxis:{type:"category",data:["D1","D2"]},
      yAxis:{type:"value"},
      series:[{type:"candlestick", data:[[20,34,10,38],[40,35,30,50]]} ]}})

# Mermaid diagram (recommended — all Mermaid types)
desktop_create_item(type="graphic", label="Workflow",
  content={type:"graphic",
    mermaid:"graph TD;\n  A[Start]-->B{Decide};\n  B-->|yes|C[Action];\n  B-->|no|D[Other];"})

# Flowchart (legacy structured nodes + edges, NOT raw SVG)
desktop_create_item(type="graphic", label="Workflow",
  content={type:"graphic", subType:"flowchart",
    nodes:[{id:"a",label:"Start",x:100,y:50,width:100,height:40}],
    edges:[{id:"e1",from:"a",to:"b"}]})

# Update item (content merged, type preserved)
desktop_update_item(itemId="<uuid>", partial={content: {svg: "<new svg>"}})
```

## Notes (9 MCP tools)

Notes are personal Markdown notes, user-level and shared across all workspaces. **Always read/write notes through the `note_*` MCP tools below — never open the notes database file directly** (the GUI holds it open; direct reads can get stale or lock errors).

| Tool | Description |
|------|-------------|
| `note_create` | Create a note (title, content, scope?, tags?) |
| `note_update` | Update a note (only provided fields changed) |
| `note_delete` | Delete a note by ID |
| `note_get` | **Read a note by ID** — full content + tags + associations |
| `note_list` | List notes, optionally filtered by scope or tag |
| `note_search` | Search notes by text — title+content+tags, multi-word weighted (title match ranks highest) |
| `note_associate` | Link two notes (weight, type: related_to/derived_from/contradicts/supports) |
| `note_tags` | List all tags with usage counts |
| `note_normalize_tags` | Normalize tags via LLM (groups similar tags, returns mapping) |

> **Reading a note the user sent to the chat**: the reference looks like `@ref{note:<id>}` — call `note_get(id="<id>")`. Do NOT locate or open the notes DB.

### Note workflows

```
# Create a note
note_create(title="Rust Ownership", content="## Rules\n...",
  scope="domain:rust", tags=["rust", "ownership"])

# Search notes (title+content+tags; multi-word terms accumulate weight)
note_search(query="ownership")
note_search(query="ownership borrow")

# Link related notes
note_associate(source_id="<id1>", target_id="<id2>",
  type="related_to", bidirectional=true)

# Normalize messy tags
note_normalize_tags(dry_run=true)  # preview first
```

## @ref System

You can emit `@ref{...}` links in your responses. The GUI renders them as clickable chips. Full reference: `~/.claude/gui-ref-system.md`.

Quick examples:
```
@ref{file:/path/to/file.ts:42}       — open file at line 42
@ref{panel:plan}                     — open Plan panel
@ref{desktop-item:text/abc123}       — focus Super Desktop item
@ref{session:xyz789|Previous chat}   — switch session
```

When users send `@ref{...}` in messages, read the referenced resource before responding.

## Key Differences from CLI

1. **No terminal-only interactions** — the user sees a GUI. Don't describe terminal colors or keystrokes.
2. **Editor integration** — files opened via `@ref{file:...}` load in Monaco. Changes written by AI tools (`Write`/`Edit`) trigger `FILE_CHANGED` → editor auto-reloads.
3. **Terminal panel** — your Bash tool output renders in the xterm.js terminal panel, not inline.
4. **Plan panel** — TodoWrite output displays in a dedicated panel, not inline in chat.
5. **Font scaling** — UI text uses `calc(var(--font-scale, 1) * Xpx)`. Don't worry about font sizes in UI code — the framework handles it.
6. **Multi-window** — the user can float panels into separate windows. The same components render everywhere.
