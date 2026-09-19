# GUI Agent Guide — Working Inside Claude Code GUI

You are running inside the Claude Code GUI desktop client. This document covers what's different from the CLI and what tools/panels are available.

## Environment

- **Runtime**: Tauri 2 (Rust backend) + React (frontend), WebView2 rendering
- **Shell**: Bun (not Node.js), TypeScript + React JSX
- **User interaction**: Graphical UI with panels, not terminal-only
- **Available documents**: `~/.claude/gui-ref-system.md` (reference links), `~/.claude/gui-config-files.md` (config file architecture — read it when fixing MCP/settings/env), `docs/ARCHITECTURE.md` (full architecture — **only in the source repo**, not on user machines)

## Panels (what the user sees)

| Panel | ID | Purpose |
|-------|-----|---------|
| Chat Messages | `chat-messages` | Conversation display |
| Chat Input | `chat-input` | Message input area |
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
| Diagnostics | `diagnostics` | Runtime/environment health checks + one-click fix |
| Profiles | `profile-manager` | API profile (model config) manager |
| Plugin Market | `plugin-market` | Browse/install GUI plugins |
| Updates | `update` | Version check + component update |

The 10 above are the **user-managed** panels (they persist in the saved layout and can be
toggled from the icon bar).

**System panels** (never persisted; they appear only while relevant — but if one is open,
`@ref{panel:<id>}` still targets it):

| Panel | ID | Appears when |
|---|---|---|
| Help | `help` | User opens Help |
| Feedback | `feedback` | User opens Feedback |
| Settings | `settings` | — (also reachable from the icon bar) |
| Diagnostics | `diagnostics` | User opens Runtime diagnostics |
| Profiles | `profile-manager` | User manages API profiles |
| Skill detail | `skill-dialog` | User opens a skill's details |
| Plugin detail | `plugin-market-detail` | User opens a plugin's details |
| Ask Question | `ask-question` | **You called `AskUserQuestion`** — do NOT point a ref at this; the user is already looking at it |
| Desktop item view | `desktop-item-view` | User double-clicks a Super Desktop item |

Use `@ref{panel:<id>}` to point the user at a panel — the ID must match one of these tables exactly.

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

## GUI MCP Tools

These run on the Tauri backend. Registration lives in `gui/src/services/mcpBridge.ts`
(source repo only — tools work regardless of whether you can read that file).
Tool descriptions are auto-exposed to you, so this section focuses on **when to use them**.

### Super Desktop (15)

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

### GUI Plugins (6)

| Tool | When to use |
|------|-------------|
| `plugin_list` | Before debugging anything plugin-related — see what's installed, enabled, and its manifest summary |
| `plugin_get` | Read one plugin's full `plugin.json` (panels/commands/events/processes it contributes) |
| `plugin_docs` | **Call before writing or debugging a plugin.** Without `name`: the plugin-system guide (layout, schema, lifecycle, troubleshooting). With `name`: that plugin's own `AI_NOTES.md` — author-written failure modes, log locations, diagnostics |
| `plugin_install` | Install a **standard** plugin from the marketplace by slug (panels/commands go live immediately). ai-guided plugins have no runtime — read their docs and perform the guided steps yourself instead |
| `plugin_uninstall` | DANGEROUS — requires `confirm: true` **after the user explicitly agreed in conversation**. Refused while other plugins depend on it. **The result may carry two fields you must relay to the user**: `needsRestart` (the plugin declares it needs a restart to fully take effect — ask the user; only call `app_relaunch` if they agree) and `cleanupWarning` (the plugin's `beforeUninstall` cleanup script failed — the uninstall **did** finish, but cleanup may be incomplete; say so honestly) |
| `plugin_set_status` | Report AI-verified environment status (`ready`/`not_ready`/`error`) for an ai-guided plugin, e.g. after manually installing a runtime per its AI_NOTES |

Install flow: `plugin_list` (is it already installed?) → `plugin_docs(name=...)` (read its notes first) → `plugin_install(slug=...)` → verify with `plugin_list`. **Dependency gate**: if the target depends on others, install is refused when they are **missing** (the error names them — install those first) *or* **installed but not ready** (e.g. an ai-guided dependency whose runtime was never downloaded — finish its environment setup first, per its AI_NOTES, then retry).

### Plugin-powered tools (check before relying on them)

**Not every tool in your list is pure GUI.** Some are backed by a **plugin's process** — the
tool is registered by the host, but calling it forwards to that plugin, and **fails if the
plugin isn't installed, enabled, or running**. These aren't "built-in capabilities you can
count on" — they're conditional on the user's plugin setup.

**How to tell, before you rely on one:**

1. `plugin_list` — is the plugin installed **and** `enabled: true`?
2. Its process actually running? (A plugin with a `processes` declaration needs its process up —
   the Workers panel / `plugin_get` show status. Missing dependency → process may never start.)
3. `plugin_get name=<name>` — read its manifest: it lists the tools it contributes and the
   processes behind them.

**Examples** (the *general* rule above is what matters — these are illustrations, not a
guaranteed inventory; a plugin update can change names):

| Plugin | What it powers | How the tools appear |
|---|---|---|
| `git-viewer` | read-only git inspection for the bound workspace (diff / history / branches) | tools are declared **by that plugin** (names come from its manifest), and require its process to be running — auto-starts when a workspace is bound. **Prefer these over shelling out to `git`** when you only need to look |
| `mouse-keyboard` + `screenshot` (often via the `computer-use` bundle) | screen capture + mouse/keyboard control | see *Operating the Computer / Browser* |
| `playwright-mcp` | browser automation | a browser-automation server it registers (`mcp__<server>__*`) — see below |

**If a tool you expected isn't there (or fails immediately):** check `plugin_list` and install /
enable / start the plugin before concluding the action is impossible — but **don't silently work
around it**; tell the user what's missing.

### App (2)

| Tool | When to use |
|------|-------------|
| `chat_send_command` | Pre-fill text into the chat input (e.g. a slash command like `/mcp-refresh`) for the user to review and send with one keystroke. Nothing is sent automatically — use when a GUI-side action needs a slash command the user must trigger |
| `app_relaunch` | Restart the GUI app. DANGEROUS — only with `confirm: true` **after the user agreed**; ends the current AI session. Use as the last step of an install flow (e.g. after an ai-guided plugin registered an MCP server that needs a reload) |

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
# A single edge is already visible from both endpoints — do NOT create the
# mirror edge by swapping source/target (that renders the relation twice).
note_associate(source_id="<id1>", target_id="<id2>", type="related_to")

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

## Operating the Computer / Browser

You may be able to **drive the user's browser or their whole desktop** — but only if the right
plugin is installed. This is **not a built-in GUI capability**: the tools come from plugins, so
**always check what's actually available before deciding, and don't assume a tool exists**.

### ⚠️ Before your first action: read the `computer-use` skill, if you have it

**Check your skill list for `computer-use` (or any desktop-control skill) and read it BEFORE you
act.** It is not optional background reading — it carries the hard-won operating experience:

- **verify each step** (a tool reporting success means the event was *sent*, not that it landed)
- **coordinate conversion** (screenshot pixels → screen-absolute)
- **input timing** (non-ASCII text needs a slower cadence; the reported character count is
  *intent*, not what actually landed)
- when to take exclusive input control, and what to do if the user takes over

Driving a desktop without it means re-discovering each of those failures live — with the user's
mouse and keyboard. **Skills are scanned at session start**: if the plugin was just installed,
the skill appears only in a **new session**.

### Check what's installed, then decide

`plugin_list` shows installed plugins (name, `enabled`, category, dependencies). `plugin_get
name=<name>` shows a plugin's manifest, which includes **the tools it contributes** — that is
the authoritative list for what it would give you. Decide from the tools **actually in your
tool list**, not from what you remember a plugin being called.

Two plugin *categories* to look for:

| Purpose | Look for a plugin like | Prefer it when |
|---|---|---|
| **Browser automation** | one in category `integration` that registers browser tools (e.g. `playwright-mcp`) | the task is inside a web page — it acts **in the page** and leaves the user's real mouse/keyboard alone |
| **Whole-desktop control** | one that contributes screen-capture + mouse/keyboard tools (e.g. the `computer-use` bundle, which depends on `mouse-keyboard` + `screenshot`) | the task is genuinely **outside** a browser (native apps), or the browser path isn't available |

> ⚠️ **For browser work, prefer the in-page tool over driving the real cursor.** Moving the
> user's actual mouse hijacks their machine; it's the fallback, not the default.

### If the needed plugin isn't installed

**Ask the user first** (`AskUserQuestion`) — e.g. "This needs a plugin that gives me browser /
desktop control. Want me to install it?" Offer the choice; **never install unprompted**.

If they agree:
- **Check its `installType` first** (`plugin_get`). A `standard` plugin is ready once installed.
  An **`ai-guided`** plugin is **not** — installing only drops its docs; you must then complete
  its environment setup yourself: `plugin_docs(name=<name>)` and follow the steps there.
- **Dependencies are gated**: `plugin_install` refuses when a dependency is missing (the error
  names it — install that first) or installed-but-not-ready (e.g. an ai-guided dependency whose
  runtime was never downloaded — finish its setup first). Follow the error; don't work around it.
- Some bundles deliver a **skill** alongside the tools. If one shows up in your skill list,
  **read it before your first action** — it carries the practical habits (verify each step,
  coordinate conversion, input timing). Skills are scanned at session start, so a freshly
  installed skill appears only in a **new session**.

### While operating

- **Verify, don't assume.** A tool returning success usually means *the action was dispatched*,
  not that it landed. Re-read the screen (or the page) after acting.
- **The user is watching.** Desktop-control plugins typically show an on-screen indicator, and
  the user can take control back at any time (often a hotkey — the plugin's docs will say).
  If they take over, **stop and re-check the state** rather than retrying.
- **Don't fight the user for the mouse.** If they're actively working, ask before taking over.

*(Exact tool names, parameters, and safety behavior belong to each plugin — read its README /
AI_NOTES via `plugin_docs name=<name>`. If it ships a skill (see the top of this section),
that skill is where the *operating* knowledge lives — read it first.)*

## Key Differences from CLI

1. **No terminal-only interactions** — the user sees a GUI. Don't describe terminal colors or keystrokes.
2. **Editor integration** — files opened via `@ref{file:...}` load in Monaco. Changes written by AI tools (`Write`/`Edit`) trigger `FILE_CHANGED` → editor auto-reloads.
3. **Terminal panel** — your Bash tool output renders in the xterm.js terminal panel, not inline.
4. **Plan panel** — TodoWrite output displays in a dedicated panel, not inline in chat.
5. **Font scaling** — UI text uses `calc(var(--font-scale, 1) * Xpx)`. Don't worry about font sizes in UI code — the framework handles it.
6. **Multi-window** — the user can float panels into separate windows. The same components render everywhere.
