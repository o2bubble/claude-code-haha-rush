# GUI 架构参考 (Architecture Reference)

> 本文档是 `docs/ARCHITECTURE.md`（架构图/地图）的**详细参考附录**，保留各子系统的
> 数据模型、协议、关键机制与历史修复细节。先在架构图定位组件，再到本文件查细节。
> 章节按日期累积保留原编号（§1-§43），供追溯实现动机与坑位。

---

# GUI Architecture

## Directory Structure

```
gui/src/
├── App.tsx                    # Root — bootstraps app, registers panels, renders layout
├── FloatingApp.tsx            # Entry for Tauri native sub-windows (renders layout via Bridge)
├── types/
│   └── layout.ts             # LayoutNode, SplitNode, TabGroup, FloatingWindow, TauriWindow, TabInstance
├── services/
│   ├── serviceBus.ts         # EventBus + CommandRegistry (module singletons)
│   ├── useService.ts         # React hooks: useEvent, useEventHandler, useCommand
│   ├── events.ts             # Event name constants + payload types
│   ├── commands.ts           # Command name constants
│   ├── backendService.ts     # Backend lifecycle: init/start/stop/restart + useBackend hook
	│   ├── fileService.ts        # File I/O service (Tauri dialog/file ops)
	│   ├── referenceActions.ts   # Reference link action handler (@ref click → open/activate)
	│   ├── clipboardService.ts   # Shared clipboard (saveClipboardItem, isRealFilePath)
│   ├── desktopSummary.ts     # computeDesktopSummary() — AI-facing lightweight snapshot
│   ├── mcpBridge.ts          # MCP tool dispatch bridge (Rust → JS store → response)
│   ├── desktopItemViewerRegistry.ts # Passes itemId to DesktopItemViewer panels (NEW 2026-07-27)
│   ├── dataBus.ts            # DataBus — unified topic pub/sub + 4-channel router (NEW 2026-07-26)
│   ├── bridge.ts             # Bridge — Hub/Leaf Tauri event transport + handshake (NEW)
│   ├── dataBusHub.ts         # Hub adapter — EventBus → DataBus + cmd→WS forward (NEW)
│   └── dataBusLeaf.ts        # Leaf adapter — DataBus → local store mirror (NEW)
│   └── skillMarketplace.ts   # Skill marketplace API client (NEW 2026-07-28)
│   └── feedbackService.ts    # Feedback API client (NEW 2026-07-28)
└── stores/
	│   ├── chatStore.ts          # Chat state (messages, sessions, tasks, streaming, connected, context, tokens, inputBlockedReason)
	│   ├── layoutStore.ts        # Layout tree + floating/tauri windows (mutation functions, LAYOUT_PRESETS + applyLayoutPreset, resetLayout)
	│   ├── terminalStore.ts      # Terminal entries (xterm output per command)
	│   ├── editorStore.ts        # Open-file tabs (Monaco editor state)
	│   ├── settingsStore.ts      # App settings (persisted: workDir, workspaces[], layoutTree, showHiddenFiles, skillRegistryUrl, favoriteSkills, _version, uiFontSize...)
	│   ├── planStore.ts          # Current TodoWrite tasks (PlanTask[] in memory)
	│   ├── planHistoryStore.ts   # Plan history (SQLite via Tauri commands, paginated)
	│   ├── subAgentStore.ts      # Sub-agent state + transcripts (EventBus SUB_AGENTS_CHANGED)
	│   ├── statusMsgStore.ts     # StatusBar message log (subscribe-based, auto-dismiss)
	│   ├── panelRegistry.ts      # Panel registration (Map<id, PanelDefinition>), userManaged flag
│   ├── layoutMode.ts         # Layout edit-mode toggle (boolean)
│   └── desktopStore.ts       # Super Desktop state (desktops[], items, connections, SQLite persist)
├── components/
│   ├── LayoutRenderer.tsx    # Recursive layout tree renderer (SplitView + TabGroupView)
│   ├── FloatingRenderer.tsx  # Floating window overlay renderer
│   ├── Toolbar.tsx           # Top toolbar (panels, layout, permission, model, settings, feedback)
│   ├── StatusBar.tsx         # Bottom message log (expandable, auto-dismiss non-errors)
│   ├── ContextMenu.tsx       # Right-click context menu (submenus, separators, hover expand)
│   ├── FileBrowserPanel.tsx  # File explorer panel
│   ├── EditorPanel.tsx       # Monaco editor + FilePreview for images/PDF/SVG
│   ├── FilePreview.tsx        # Image/PDF/SVG viewer with zoom controls (NEW 2026-07-27)
│   ├── Editor.tsx            # Monaco editor integration
│   ├── FileBrowserPanel.tsx  # File tree browser
│   ├── FileTree.tsx          # File tree component
│   ├── TerminalPanel.tsx     # xterm.js terminal panel (multi-tab)
│   ├── NotesPanel.tsx        # Notes panel (Milkdown editor, tags, scope tree, MCP) (NEW 2026-07-29)
│   └── chat/
│       ├── useChatBridge.ts      # WebSocket client + message handlers (CORE DATA HUB)
│       ├── ChatMessagesPanel.tsx # Chat message display area
│       ├── ChatInputPanel.tsx    # Chat input area + permission prompts + ChatStatusBar
│       ├── InputArea.tsx         # Text input component
│       ├── MessageList.tsx       # Message list — @tanstack/react-virtual full virtualization (2026-08-07)
│       ├── MessageItem.tsx       # Single message render (text, thinking, tool cards)
│       ├── SessionPanel.tsx      # Session list sidebar
│       ├── WorkerPanel.tsx       # Background tasks + backend info
│       ├── TasksPanel.tsx        # Active background tasks
│       ├── SubAgentPanel.tsx     # Sub-agent list + expandable transcript viewer
│       ├── SettingsPanel.tsx     # Settings UI
│       ├── FeedbackDialog.tsx    # Feedback form (bug/suggestion + screenshot) (NEW 2026-07-28)
│       ├── PlanPanel.tsx         # Current plan + history timeline
│       ├── WorkspaceSelector.tsx # Workspace picker overlay
│       ├── WelcomeWizard.tsx     # First-launch onboarding wizard (NEW 2026-07-29)
│       ├── AskQuestionOverlay.tsx # AskUserQuestion UI — questions, options, notes
│       ├── AskQuestionFloating.tsx # Floating window + lifecycle for AskQuestion
│       ├── HelpPanel.tsx          # Help guide — toolbar + panel reference with HTML diagrams (NEW 2026-07-31)
│       ├── SkillsPanel.tsx        # Skill browser + marketplace (tabs: 已安装/在线库, one-click install)
│       ├── SkillDialog.tsx        # Skill dialog content (contentEditable + @ref chips)
│       ├── SkillDialogFloating.tsx # Floating window + lifecycle for SkillDialog
│       ├── ReferenceLink.tsx      # @ref{...} link renderer
│       └── FileDiffView.tsx      # Syntax-highlighted diff viewer
│   └── desktop/
│       ├── SuperDesktopPanel.tsx # Panel entry (tabs + toolbar + canvas)
│       ├── SuperDesktopCanvas.tsx # Infinite canvas (CSS transform, pan/zoom/grid)
│       ├── DesktopItemView.tsx   # Item frame (drag/resize/anchors)
│       ├── DesktopItemViewer.tsx # Full-panel single-item viewer (float/window, NEW 2026-07-27)
│       ├── DesktopTabs.tsx       # Multi-desktop tab bar
│       ├── CanvasToolbar.tsx     # Add-item buttons + zoom controls
│       ├── TextItem.tsx          # Text/markdown content (AI-driven)
│       ├── ChartItem.tsx         # ECharts renderer, 3-channel (option/series/data)
│       ├── GraphicItem.tsx       # SVG flowchart/mindmap (AI-driven, drag+auto-layout)
│       ├── RefItem.tsx           # @ref reference card
│       ├── FileGroupItem.tsx     # Lazy tree (paste/drop files, expandable directories)
	│       ├── ImageItem.tsx         # Image display (base64 preview via read_bytes)
	│       ├── FormItem.tsx          # Editable form (10 controls, view/edit dual mode, drag reorder)
	│       ├── TableItem.tsx         # Editable table (spreadsheet, add/delete rows/columns)
		│       └── ConnectionOverlay.tsx # SVG bezier connection lines
│   ├── index.ts              # t(), useT(), setLanguage(), getLanguage()
│   ├── zh.ts                  # Chinese translations
│   └── en.ts                  # English translations
├── utils/
│   ├── icons.tsx             # IconKey → ReactNode registry (iconFor(), GROUP_ICON_POOL)
│   ├── detectLanguage.ts     # 80+ ext → 40+ Monaco language IDs + filename detection
│   ├── dedupTools.ts         # Tool deduplication by id (shared utility)
│   └── referenceParser.ts    # @ref{...} parse/format encode/decode utilities
├── types/
│   ├── layout.ts             # Layout type definitions
│   ├── editor.ts             # Editor state types
│   ├── reference.ts          # @ref{...} reference types (file/dir/line/panel/session/paste/desktop/desktop-item)
│   └── desktop.ts            # Desktop, DesktopItem, Connection, ItemContent types (2026-07-24)
```

## Build & Distribution (2026-07-30)

### Build Script

`scripts/build.ts` — 11-step build pipeline:
```
bun run scripts/build.ts                     # smart: use release builds if exist
bun run scripts/build.ts --rebuild           # force cargo build
bun run scripts/build.ts --quick             # skip steps with existing output
bun run scripts/build.ts --release 2026.07.31 # build + generate update manifest + component zips
```

| Step | Content |
|------|---------|
| 1 | Install deps (bun install) |
| 2 | Compile claude.exe (bun compile) |
| 3 | Build GUI (`cargo tauri build --no-bundle`) → `claude-code-gui.exe` |
| 4 | Build Updater (cargo) → `Update.exe` |
| 5 | Bundle runtime: bun.exe + scripts/ |
| 6 | Bundle extensions (COM bridge, Memory MCP) |
| 7 | Copy CLI tools → `dist/bin/` (rg, fd, jq, yq, shellcheck) |
| 8 | Setup Python (official python.org zip via Huawei mirror, 3.12.10) |
| 9 | Setup Git (PortableGit zip, 155 MB, .NET ZipFile extraction) |
| 10 | IDE extensions + launcher scripts |
| 11 | (with `--release`) Generate manifest.json + 7 component zips → `dist/release/<version>/` |

### dist/ Layout

```
dist/
  claude-code-gui.exe    ← GUI main app
  Update.exe             ← self-update stager
  claude.exe             ← CLI (bun compile)
  bun.exe                ← Bun runtime
  manifest.json          ← installed version manifest (for update comparison)
  *.cmd                  ← launcher scripts (claude.cmd, cla.cmd, etc.)
  bin/                   ← CLI tools (rg, fd, jq, yq, shellcheck)
  scripts/               ← TS tools (run via .cmd wrappers)
  python/                ← Python 3.12.10 full (pip, tkinter, pywin32)
  git/                   ← PortableGit (usr/bin + mingw64 + etc + perl5)
  extensions/            ← IDE plugins + COM bridge + Memory MCP
  release/<version>/     ← Update manifest + component zips (with --release)
```

### Installer Components (`installer/setup.iss`)

| Component | Type | Description |
|-----------|------|-------------|
| `core` | Fixed | claude.exe + CLI tools + IDE plugins + bun.exe + .cmd + manifest.json |
| `gui` | Optional | claude-code-gui.exe + Update.exe + Start Menu icon |
| `gitbash` | Optional | Git Bash shell + Unix tools |
| `git` | Optional | Git repo operations (requires gitbash) |
| `python` | Optional | Python 3.12 full + pywin32 |

- Sets `CLAUDE_CODE_HAHA_HOME` system env var → all PATH entries use `%CLAUDE_CODE_HAHA_HOME%`
- PATH: root → bin → git/usr/bin → git/bin → git/mingw64/bin → python
- `CLAUDE_CODE_GIT_BASH_PATH` = `%CLAUDE_CODE_HAHA_HOME%\git\usr\bin\bash.exe`

---

## 1. Communication: EventBus (MANDATORY — do NOT add custom subscribe/notify)

**Location**: `services/serviceBus.ts`, `services/useService.ts`, `services/events.ts`

This is the single communication channel for all cross-panel data flow. Adding custom subscribe/notify in stores is forbidden.

### EventBus API

```ts
import { eventBus } from "../services/serviceBus";

// Emit (in stores)
eventBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...snapshot } }, { sticky: true });
// sticky: true → new subscribers immediately get the latest value

// Subscribe (in components)
const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);    // re-renders on emit
useEventHandler<TerminalChangedPayload>(Events.TERMINAL_CHANGED, (data) => {     // side-effect only
  renderTerminal(data);
});
```

### All Events (defined in `services/events.ts`)

| Event | Emitted by | Payload |
|-------|-----------|---------|
| `backend.stateChanged` | backendService | `{ status, port, workDir, error }` |
| `backend.portReady` | backendService | `{ port }` (sticky) |
| `workspace.bound` | backendService | `{ workDir }` (sticky) — fires right after `bind_workspace` returns, BEFORE the backend port finishes polling; UI restores the workspace's settings/layout without waiting for backend boot |
| `chat.stateChanged` | chatStore | `{ state: ChatState }` (sticky) |
| `settings.changed` | settingsStore | `{ settings: AppSettings }` (sticky) |
| `terminal.changed` | terminalStore | `{ entries, activeEntryId }` |
| `layout.treeChanged` | layoutStore | `{ tree: LayoutNode }` (sticky) |
| `layout.floatingChanged` | layoutStore | `{ floatingPanels }` (sticky) |
| `editor.changed` | editorStore | `{ tabs, activePath }` (sticky) |
| `panelRegistry.changed` | panelRegistry | `{ panels: PanelDefinition[] }` (sticky) |
| `language.changed` | i18n | `{ language }` (sticky) |
| `plan.updated` | planStore | `{ tasks: PlanTask[] }` (sticky) |
| `plan.historyChanged` | planHistoryStore | `{ records: PlanRecord[] }` |
| `subAgents.changed` | subAgentStore | `{ state: SubAgentState }` |
| `file.changed` | useChatBridge | `{ path: string }` |
| `window.toast` | various | `{ message, type }` |
| `workspace.openSelector` | SettingsPanel/Toolbar | (none) |
| `chat.insertText` | referenceActions | `{ text: string }` |
| `chat.addReference` | referenceActions | `{ reference: Reference }` |
| `desktop.changed` | desktopStore | `{ desktops, activeDesktopId }` (sticky) |
| `desktop.itemMoved` | desktopStore | `{ itemId, x, y }` |
| `desktop.itemSelected` | referenceActions | `{ itemId }` |

> **Removed (2026-07-24):** `desktop.connectionStart`, `desktop.dataRegistryChanged` — data registry WS handlers deleted; MCP replaces data exposure.

### CommandRegistry (cross-panel actions)

```ts
import { commands } from "../services/serviceBus";

// Register (in useChatBridge useEffect — keeps WS logic centralized)
commands.register("SET_PERMISSION_MODE", (mode: string) => {
  send("set_permission_mode", { mode });
});

// Execute (from any component — e.g. Toolbar)
commands.execute("SET_PERMISSION_MODE", "bypassPermissions");
```

**Rule:** Components must NOT import WS functions directly. Use `commands.execute()` instead. The `useChatBridge` module registers all WebSocket-bound commands, keeping the send logic in one place.

## 2. Layout Architecture

### Data Model (`types/layout.ts`)

```ts
type LayoutNode = SplitNode | TabGroup;

SplitNode {
  type: "split", id, direction: "horizontal"|"vertical",
  children: LayoutNode[], sizes: number[]  // % each
}

TabGroup {
  type: "group", id, tabs: TabInstance[],
  activeTabId: string|null,
  tabStyle?: "tabs"|"activity"|"activity-right"|"activity-bottom",
  visibility?: "expanded"|"collapsed"|"hidden"
}

FloatingWindow {
  type: "floating", id, group: TabGroup,
  x, y, width, height, zIndex
}

TauriWindow {
  type: "tauri", id, label: string,
  x, y, width, height,
  group: TabGroup
}

// Icons are serializable keys, not ReactNode. Layout persistence stores the
// key straight through — `iconFor(key)` (utils/icons.tsx) maps it to a component.
IconKey =
  "editor" | "workers" | "plan" | "subagents" | "messages" | "input"
  | "sessions" | "skills" | "files" | "settings" | "terminal" | "superDesktop"
  | "askQuestion" | "desktopItemView" | "profileManager" | "feedback" | "update"
  | "explorer" | "search" | "outline" | "compoundGroup" | "file" | "notes"
  | "quickPrompts" | "help" | "default" | "user"
  | "folderKanban" | "package" | "grid3x3" | "layoutGrid" | "combine"

TabInstance {
  id, panelId, viewId?, title, icon?: IconKey,
  children?: TabInstance[], activeChildId?  // children ⇒ compound group
}
```

### Default Layout Tree (`layoutStore.createDefaultTree()`)

```
root (horizontal: 25% - 45% - 30%)
├─ sidebar-left [activity style]
│   ├─ Sessions | Files | Plan | Sub-Agents | Skills | Quick-Prompts | Workers
├─ center-column (vertical: 75% - 25%)
│   ├─ editor-area [tabs]
│   │   ├─ Super Desktop | Editor | Notes
│   └─ bottom-panel [activity-bottom]
│       └─ Terminal
└─ chat-split (vertical: 65% - 35%)
    ├─ chat-messages-group [tabs]
    │   └─ Messages
    └─ chat-input-group [tabs]
        └─ Input
```

### Render Order (App.tsx)

```
Toolbar                  ← fixed top (36px)
LayoutRenderer           ← flex: 1 (recursively renders layout tree)
StatusBar                ← fixed bottom (24px)
FloatingRenderer         ← position: fixed overlay (floating windows)
ContextMenu              ← position: fixed overlay (right-click menu)
WelcomeWizard            ← modal overlay (first launch only, z-index: 2000)
WorkspaceSelector        ← modal overlay (shown after wizard or on every non-first startup)
AskQuestionOverlay       ← floating window via FloatingRenderer (agent-triggered)
```

### Panel System

Panels are registered once at startup (`App.tsx` useEffect) with `registerPanel()`. A panel has multiple views — each view has a `render()` function. The layout tree maps tabs to panels via `panelId`. When a tab becomes active, `LayoutRenderer` looks up the panel and renders its active view.

**System panels** (`userManaged: false`) are hidden from the toolbar PanelDropdown. They have their own trigger mechanisms:
- `help` — opened via toolbar `?` button, auto-opens on first launch
- `settings` — opened via toolbar gear icon
- `ask-question` — created as floating window when agent calls `AskUserQuestion`

### Operation Patterns

| Operation | How |
|-----------|-----|
| Add tab to group | `addTab(groupId, tab)` → emits LAYOUT_TREE_CHANGED |
| Remove tab | `removeTab(groupId, tabId)` |
| Split area | `splitGroup(groupId, hint, newTab)` |
| Drag to float | `createFloatingFromTab(tab)` |
| Hide/show panel | `hideGroup(groupId)` / `ensureGroupVisible(groupId)` |
| Resize split | `updateSizes(splitId, sizes)` |
| Read tree | `getTree()` — synchronous module-level getter |

## 3. Store Inventory

All stores are module-level singletons. They emit EventBus events on mutation. Consumers use `useEvent`/`useEventHandler`.

### chatStore
- **Data**: `ChatState { messages[], streaming, connected, sessionId, sessions[], tasks[], permissionMode, pendingControlRequest, inputBlockedReason, slashCommands[], activeSkillDialog, contextPercent, contextWindowSize, usedTokens, outputTokens, model }`
- **Mutators**: `updateChatState(partial)`, `addMessage(msg)`, `updateLastAssistant(fn)`, `clearMessages()`
- **Event**: `CHAT_STATE_CHANGED` (sticky)
- **Consumers**: ChatMessagesPanel, ChatInputPanel, SessionPanel, TasksPanel, WorkerPanel, Toolbar (permission mode), ChatStatusBar (context, streaming, tokens), InputArea (checks inputBlockedReason, reads slashCommands, checks activeSkillDialog for @ref routing), SkillsPanel (reads slashCommands, sets/clears activeSkillDialog), SkillDialogFloating (reads activeSkillDialog)

### layoutStore
- **Data**: `LayoutNode` tree + `FloatingWindow[]` floating panels + `TauriWindow[]` native windows
- **Mutators**: 30+ functions (addTab, removeTab, splitGroup, updateSizes, hideGroup, createFloatingFromTab, createTauriWindowFromTab, removeTauriWindow, activatePanel, etc.)
- **Serialization**: `serializeLayout()` / `deserializeLayout()` / `restoreLayout()` — persist all three layout types; restore spawns Tauri windows with panelId dedup. `TabInstance.icon` is a serializable `IconKey` string, so `serializeTab` carries it through (no strip) and `deserializeTab` passes it back, falling back to the registry icon for legacy data (missing icon field or pre-IconKey ReactNode-object serializations). `refreshIcons` was reduced to `refreshTitles` (icons never go stale). Ephemeral filtering on restore uses `getPanel(panelId).userManaged === false` (`isEphemeralTab`) — compound tabs (`panelId=""`) resolve `getPanel` to undefined and are NOT treated as ephemeral (previously a bug dropped floating windows containing compound groups on restart).
- **Events**: `LAYOUT_TREE_CHANGED` (sticky), `LAYOUT_FLOATING_CHANGED` (sticky, includes tauriWindows)
- **Consumers**: LayoutRenderer, Toolbar, FloatingRenderer, FloatingApp (reads TauriWindow by label)

### terminalStore
- **Data**: `TerminalEntry[]` (id, toolUseId, command, output, exitCode, timestamp)
- **Mutators**: `startCommand()`, `appendToLastEntry()`, `setOutput()`, `finishCommand()`, `removeEntry()`, `clear()`
- **Event**: `TERMINAL_CHANGED`
- **Consumer**: TerminalPanel

### planStore
- **Data**: `PlanTask[] { content, activeForm, status }` — current TodoWrite output
- **Mutators**: `updatePlan(tasks)` — also auto-saves old tasks to planHistoryStore if content changed
- **Event**: `PLAN_UPDATED` (sticky)
- **Consumer**: PlanPanel

### planHistoryStore
- **Data**: `PlanRecord[]` + `PlanSession[]` — SQLite-backed, paginated (PAGE_SIZE=20)
- **Mutators**: `saveCurrentPlan()`, `loadMorePlans()`, `resetPagination()`
- **Event**: `PLAN_HISTORY_CHANGED`
- **ID dedup**: `sessionId + tasksDigest(tasks)` — hash of task content strings
- **Concurrency**: `generation` counter prevents race-condition duplicate appends

### editorStore
- **Data**: `FileTab[] { path, name, content, dirty, externalChanged, tabType? }`
- **Mutators**: `openFile()`, `openPreview()` (image/PDF/SVG), `closeTab()`, `setContent()`, `markClean()`, `setActive()`, `markExternalChanged(path)`, `reloadContent(path, content)`
- **Queries**: `isPreviewable(path)` — checks extension against PNG/JPG/GIF/WebP/BMP/ICO/SVG/PDF set
- **Auto-activation**: `openFile()`/`openPreview()` call `activatePanel("editor")` — auto-expands hidden editor group and focuses tab. Covers FileBrowser, @ref clicks, and clickable file paths.
- **Event**: `EDITOR_CHANGED` (sticky)
- **Consumer**: EditorPanel (renders Monaco for text, FilePreview for preview tabs)

### settingsStore
- **Data**: `AppSettings { workDir, workspaces[], isFirstLaunch, language, terminalMaxEntries, layoutTree?, showHiddenFiles?, favoriteSkills?, favoriteSessionIds? (workspace-scoped), saveLayoutToGlobal?, permissionMode?, skillRegistryUrl?, autoLoadLatestSession? }`
- **Save scope** (2026-08-06): `saveSettings` defaults to the **bound workspace** (`"workspace"`) — project-first, global fallback. Callers writing global-only fields (theme, language, wizard baseline) pass `"global"` explicitly.
- **Mutators**: `updateSettings()`, `loadSettings()`, `saveSettings()`, `applySettingsFromBus()` (silent in-memory update, no EventBus emit — used by Leaf to prevent echo)
- **Event**: `SETTINGS_CHANGED` (sticky)
- **Consumers**: SettingsPanel, FileBrowserPanel, terminalStore (reads maxEntries), WorkspaceSelector (reads workspaces)
- **Migration**: `loadSettings()` auto-populates `workspaces` from `workDir` if empty

### panelRegistry
- **Data**: `Map<id, PanelDefinition { id, title, icon: IconKey, defaultView, views[], userManaged? }>` — `icon` is a serializable key; renderers map it via `iconFor()`
- **Mutator**: `registerPanel(panel)` — called once at startup
- **Event**: `PANEL_REGISTRY_CHANGED` (sticky)
- **Consumer**: LayoutRenderer, PanelDropdown
- **userManaged**: If `false`, panel is hidden from toolbar PanelDropdown. Used for system panels like `settings` and `ask-question`.

### subAgentStore
- **Data**: `SubAgentState { agents[], expandedAgentId, transcripts{} }`
- **Mutators**: `upsertSubAgent()`, `removeSubAgent()`, `setExpandedAgent()`, `setTranscript()`, `setTranscriptLoading()`
- **Event**: `SUB_AGENTS_CHANGED`
- **Consumer**: SubAgentPanel

### statusMsgStore
- **Data**: `StatusMessage[] { id, text, timestamp, level }` — max 100 entries
- **Mutators**: `addStatusMessage(text, level)`, `clearStatusMessages()`
- **Subscription**: `subscribeStatusMessages(fn)` — custom subscribe (not EventBus — transient, high-frequency)
- **Consumer**: StatusBar
- **Note**: info/warn messages auto-dismiss after 5s; errors persist

### desktopHistoryStore
- **Data**: 2 stacks per desktop: `Map<id, DesktopSnapshot[]>` for undo + redo, max 100 deep
- **Mutators**: `pushSnapshot(id, state)`, `undo(id, state)`, `redo(id, state)`, `clearHistory(id)`
- **Queries**: `canUndo(id)`, `canRedo(id)`, `loadHistory(id)`
- **Persistence**: SQLite `desktop_history` table (JSON blobs), cross-session
- **Circular-dep safe**: Accepts `DesktopStateLike` as param — never imports `desktopStore`
- **Consumer**: `desktopStore` (wraps as `pushHistory`/`undoHistory`/`redoHistory`), `CanvasToolbar`

### selectionStore
- **Data**: `Set<string>` — ephemeral selected item IDs (not persisted)
- **Mutators**: `setSelection(ids)`, `clearSelection()`, `toggleSelection(id)`, `addToSelection(ids)`
- **Queries**: `getSelectedIds()`, `isSelected(id)`
- **React hook**: `useSelection()` — pub/sub pattern, separate from EventBus
- **Consumer**: `SuperDesktopCanvas`, `SuperDesktopPanel`, `CanvasToolbar` context menu

### layoutMode
- **Data**: boolean toggle for edit mode
- **Mutators**: `toggle()`, `set(v)`, `syncFromBus(v)` — publishes to DataBus for cross-window sync
- **Consumer**: Toolbar, LayoutRenderer, all windows (synced via DataBus `layout.mode` sticky topic)

## 4. WebSocket Protocol (`useChatBridge.ts`)

This is the **core data hub** — all chat-related state mutations originate here.

### Connection
```
connect(port) → new WebSocket(`ws://127.0.0.1:${port}/ws`)
              → onopen: dispatch queued messages, updateChatState({connected:true})
              → onmessage: JSON.parse → dispatch(msg)
              → onclose: reconnect with exponential backoff (1s → 30s max)
```

### Message Types Handled

| WS message type | Handler | What happens |
|----------------|---------|--------------|
| `stream_event` | handleStreamEvent | `message_start` → addMessage / `content_block_start` → tool to last assistant / `content_block_delta` → append text/thinking/partial_json / `content_block_stop` → mark tool done, extract TodoWrite / `message_stop` → streaming=false |
| `assistant` | (handler) | Non-streamed assistant messages → add tool_use blocks + extract TodoWrite |
| `user` | (handler) | Process tool_result blocks → set tool output/exit code, save plan on ExitPlanMode |
| `result` | (handler) | Streaming=false |
| `error` | (handler) | Add error message to chat |
| `tool_progress` | (handler) | Append bash/powershell output to last tool |
| `session_list` | handleSessionList | Update sessions in chatState |
| `session_loaded` | (handler) | Clear messages, restore messages + todo list from history |
| `current_session` | (handler) | Update sessionId |
| `control_request` | handleControlRequest | Set pendingControlRequest for permission prompts |
| `tasks_updated` | (handler) | Update background tasks list |
| `task_started` | buildSubAgentInfo | New sub-agent created (with identity) |
| `task_progress` | buildSubAgentInfo | Sub-agent tool/token progress update |
| `task_completed` | buildSubAgentInfo | Sub-agent finished (completed/failed/killed) |
| `agent_transcript` | setTranscript | Load sub-agent conversation history |
| `context_window` | updateChatState | Update contextPercent, usedTokens, outputTokens, model |
| `file_edit` | emit FILE_CHANGED | AI tool wrote/created/deleted a file on disk |
| `permission_mode_changed` | updateChatState | Permission mode switched by backend |

### Send Functions (outgoing)

| Function | Sends |
|----------|-------|
| `sendMessage(content)` | `{ type: "user", message: { role: "user", content } }` |
| `respondToPermission(allowed, always, updatedInput?)` | `{ type: "control_response", request_id, response: { allowed, updatedInput? } }` |
| `interrupt()` | `{ type: "interrupt" }` |
| `listSessions()` | `{ type: "list_sessions" }` |
| `loadSession(id)` / `switchSession(id)` | `{ type: "load_session", session_id }` |
| `newSession()` / `createSession()` | `{ type: "new_session" }` |
| `deleteSession(id)` / `removeSession(id)` | `{ type: "delete_session", session_id }` |
| `killTask(taskId)` | `{ type: "kill_task", task_id }` |
| `loadAgentTranscript(taskId)` | `{ type: "load_agent_transcript", task_id }` |
| `requestTaskList()` | `{ type: "list_tasks" }` |
| (via CommandRegistry) | `{ type: "set_permission_mode", mode }` |

## 5. Backend Lifecycle

### Flow

```
Rust setup() (before window shown):
  ├─ Read saved window size → set_size() before visible
  └─ if !isFirstLaunch: pre-start IDE backend in background thread

App.tsx mount → loadSettings()
  ├─ Restore layoutTree (always)
  ├─ if isFirstLaunch: show WelcomeWizard → onComplete → persist settings
  ├─ if !isFirstLaunch: show WorkspaceSelector directly
  └─ setAppReady(true)

User picks workspace → handleWorkspaceLaunch(workDir, wss)
  ├─ Save workspaces + workDir to settings
  ├─ BackendService.init(workDir)
  │   ├─ Save settings (workDir)
  │   ├─ Quick poll (3s) — backend may be pre-started (existing user)
  │   ├─ If fail: restart_ide_backend + full poll (30s)
  │   └─ status: "running" → emit BACKEND_STATE_CHANGED + BACKEND_PORT_READY
  └─ useChatBridge(port) → connect WebSocket
```

**First launch**: IDE backend NOT pre-started by Rust `setup()`. Starts only after workspace selection, with the correct workDir. Quick poll (3s) fails → restart explicitly.
**Existing user**: Backend pre-started during setup with last-used workDir. Quick poll succeeds immediately.

**Stream idle watchdog (2026-08-05)**: the backend is spawned with `CLAUDE_ENABLE_STREAM_WATCHDOG=1` + `CLAUDE_STREAM_IDLE_TIMEOUT_MS=300000` (5 min no-chunk). The engine's watchdog is off by default and the SDK request timeout only covers the initial fetch — without it a hung/silently-dropped model stream hangs the session forever. 5 min is generous for 582k-token contexts. A profile env can override either var.

**`restart_ide_backend` spawn guard (2026-08-05)**: no-ops when `spawning == true`. The frontend's 3s quick-poll times out on slow spawns and calls restart; if it killed the in-flight spawn (e.g. from a workspace rebind), each restart would kill the just-spawned backend and loop. Letting the in-flight spawn finish and the 30s full poll pick up the port breaks the loop.

### StatusBar

Collapsible message log at bottom (24px):
- **Collapsed**: latest message + time + expand arrow. Non-error messages auto-dismiss after 5s.
- **Expanded**: scrollable list of all messages (max 100), click-outside to close.
- **States**: "正在启动后端服务..." (starting) / error msg (error) / "未连接" (stopped) / empty (running).
- Messages from: backend lifecycle, WebSocket connect/disconnect/reconnect, model switching.

### Backend process cleanup / orphan prevention (2026-08-04)

`BackendState` tracks the spawned `claude.exe --ide-mode` process so it is never orphaned:

- **`backend_pid`** is registered in `BackendState` **immediately after spawn** (before the port is announced). A backend that hangs before printing `CLAUDE_CODE_IDE_PORT=` never stores its `Child` handle — without the early PID registration the exit cleanup could not find it, leaving an orphan.
- **`kill_backend`** runs a **blocking `taskkill /F /T /PID`** (`.status()`), preferring the registered PID over the `Child` handle. The previous fire-and-forget `.spawn()` raced the GUI exit and left `claude.exe` alive.
- The 30s "no port" timeout path also kills the whole tree (not just `child.kill()`, which only killed the `cmd` wrapper).
- **`spawning` flag**: the `bind_workspace` guard returns `0` (frontend polls `get_ide_port`) only while a spawn is genuinely in flight; after a failed spawn it re-spawns instead of returning `0` forever.

## 6. Tauri Backend

### Commands

| Command | File | Purpose |
|---------|------|---------|
| `get_app_settings` | lib.rs | Read all settings from settings.json (used by JS loadSettings + Rust window size restore) |
| `save_app_settings` | lib.rs | Write settings to disk; preserves `windowWidth`/`windowHeight` from Rust state |
| `get_default_work_dir` | lib.rs | Get user home directory |
| `get_ide_port` | lib.rs | Read current backend port |
| `restart_ide_backend` | lib.rs | Kill + respawn IDE backend, reads workDir from latest settings on disk |
| `list_model_profiles` | lib.rs | List .env.profiles/ directory entries |
| `switch_model_profile` | lib.rs | Read profile .env → write settings.local.json → restart |
| `save_permission_mode` | lib.rs | Persist permission mode to settings.json |
| `db_save_plan` | db.rs | INSERT OR REPLACE plan record |
| `db_get_plans` | db.rs | SELECT paginated plans (LIMIT/OFFSET) |
| `db_get_plan_sessions` | db.rs | SELECT GROUP BY session_id |
| `db_save_desktop` | db.rs | INSERT OR REPLACE desktop record |
| `db_get_desktops` | db.rs | SELECT all desktops with items + connections |
| `db_delete_desktop` | db.rs | DELETE desktop + cascade items + connections |
| `db_save_desktop_history` | db.rs | INSERT OR REPLACE undo/redo stacks (JSON) |
| `db_load_desktop_history` | db.rs | SELECT undo/redo stacks for a desktop |
| `mcp_response` | mcp.rs | JS bridge → Rust oneshot channel response |
| `get_mcp_port` | mcp.rs | Return MCP HTTP server port |
| `path_exists` | lib.rs | Check if file/dir path exists (boolean) |
| `read_bytes` | lib.rs | Read binary file → base64 string (images) |
| `read_dir` | lib.rs | List directory entries (name, path, is_dir) |
| `create_path` | lib.rs | Create file or directory |
| `delete_path` | lib.rs | Delete file or directory |
| `save_bytes` | lib.rs | Write base64-encoded binary to file |
| `open_system_terminal` | lib.rs | Spawn terminal with optional claude launch |
| `open_in_explorer` | lib.rs | Open file explorer with file selected (Win/Mac/Linux) |
| `copy_file` | lib.rs | Copy file/dir from src to dst, auto-overwrite, recursive |
| `read_clipboard_text` | lib.rs | Read system clipboard text (arboard crate) |
| `read_file` | lib.rs | Read file content as string |
| `save_file` | lib.rs | Write string content to file |
| `rename_path` | lib.rs | Rename or move file/directory |
| `create_floating_window` | lib.rs | Spawn Tauri child window with panel |
| `close_me` | lib.rs | Close the calling Tauri window |
| `create_profile` | lib.rs | Create new API profile (.env file) |
| `delete_profile` | lib.rs | Delete an API profile |
| `set_default_profile` | lib.rs | Set default profile + write settings.json env |
| `run_cli_print` | lib.rs | Spawn CLI headless in background → emit result via `cli-translate-result` Tauri event |
| `save_skills_i18n` | lib.rs | Save skills i18n translations to workspace |
| `load_skills_i18n` | lib.rs | Load skills i18n translations from workspace |
| `get_skills_dir` | lib.rs | Return `~/.claude/skills/` path (create if needed) (NEW 2026-07-28) |
| `install_skill` | lib.rs | Download skill zip from URL → extract to `~/.claude/skills/<name>/` (NEW 2026-07-28) |
| `install_package` | lib.rs | Download package zip → extract all skills with SKILL.md (NEW 2026-07-28) |
| `delete_skill` | lib.rs | Remove `~/.claude/skills/<name>/` directory (NEW 2026-07-28) |
| `save_window_size` | lib.rs | Persist main window width/height to settings.json + Rust state (sole authority; restore in setup before window visible) (NEW 2026-07-29) |
| `note_create` / `note_update` / `note_delete` / `note_get` | notes.rs | Note CRUD (NEW 2026-07-29) |
| `note_list` / `note_search` | notes.rs | List/search notes with scope/tag filters (NEW) |
| `note_associate` / `note_disassociate` | notes.rs | Create/delete note associations (NEW) |
| `note_tags` / `note_get_all_tag_names` | notes.rs | Tag management (NEW) |
| `note_apply_tag_mapping` | notes.rs | Apply LLM-generated tag normalization (NEW) |
| `check_for_updates` | update.rs | Fetch manifest → compare local hash/timestamp → return status per component (NEW 2026-07-30) |
| `download_and_install_component` | update.rs | Download zip → extract → replace files → execute post_install hook (NEW 2026-07-30) |
| `prepare_gui_update` | update.rs | Download new GUI exe → write %TEMP%/claude-update.json → return Update.exe path (NEW 2026-07-30) |
| `launch_updater_and_exit` | update.rs | Spawn Update.exe → exit(0) (NEW 2026-07-30) |
| `get_local_manifest` | update.rs | Read install dir's manifest.json (NEW 2026-07-30) |
| `get_install_dir_path` | update.rs | Return parent of current exe (NEW 2026-07-30) |

### SQLite (`db.rs` / `notes.rs`)

- Path: `<workspace>/.claude/data.db` (per-workspace isolation)
- Tables: `plans`, `desktops`, `desktop_items`, `desktop_connections`, `desktop_history`
- State: `Mutex<DbState { conn, work_dir }>` with `ensure_db()` auto-reopen on workspace switch
- Dependencies: `rusqlite = { version = "0.31", features = ["bundled"] }` (static SQLite), `base64 = "0.22"`

## 7. Component Dependency Map

```
App.tsx
├── WelcomeWizard (first launch only) → getSettings(), onComplete → persist + show WorkspaceSelector
├── WorkspaceSelector → settingsStore (workspaces), onLaunch → handleWorkspaceLaunch
├── Toolbar → layoutStore (tree), chatStore (permissionMode), Tauri invoke (model profiles)
├── LayoutRenderer → layoutStore (tree), panelRegistry (panel defs)
│   ├── ChatMessagesPanel → chatStore (state), useChatBridge (ws)
│   │   └── MessageList → MessageItem (props: ChatMessage[])
│   ├── ChatInputPanel → chatStore (state), useChatBridge (ws)
│   │   ├── TasksPanel → chatStore (tasks)
│   │   ├── InputArea → useChatBridge (send/interrupt), clipboardService (saveClipboardItem)
│   │   └── ChatStatusBar → chatStore (connected/streaming/context/tokens)
│   ├── SessionPanel → chatStore (sessions), useChatBridge (manage)
│   ├── SubAgentPanel → subAgentStore (agents/transcripts), useChatBridge (loadTranscript)
│   ├── PlanPanel → planStore (current), planHistoryStore (history)
│   ├── SkillsPanel → chatStore (slashCommands, activeSkillDialog), settingsStore (favorites)
│   │   └── SkillDialogFloating → chatStore (activeSkillDialog), layoutStore
│   │       └── SkillDialog → EventBus (CHAT_ADD_REFERENCE, CHAT_INSERT_TEXT)
│   ├── WorkerPanel → chatStore (tasks), backendService (status)
│   ├── SettingsPanel → settingsStore, i18n
│   ├── NotesPanel → Tauri invoke (note_* commands), EventBus (NOTES_CHANGED, NOTE_SELECTED) (NEW 2026-07-29)
│   ├── EditorPanel → editorStore, fileService (I/O), EventBus (FILE_CHANGED)
│   ├── FileBrowserPanel → settingsStore (workDir), fileService, ContextMenu (empty-area: Paste/Refresh)
│   │   └── FileTree → desktopStore (Send to Desktop), editorStore (openPreview detection)
│   │       ├── Selection: click to select (blue bg), Escape deselect, data-file-node attr
│   │       ├── KB shortcuts: Ctrl+C copy path, Ctrl+V paste, Delete remove
│   │       ├── Context menu: Copy/Absolute/Relative/Name, Paste, Explorer, Terminal, Send to Desktop(▶)
│   │       └── Refresh: root + all expanded folders re-read (treeVersion propagation)
│   │   └── FileTree → EventBus (FILE_CHANGED), fileService
│   └── TerminalPanel → terminalStore (entries), xterm.js
│   ├── SuperDesktopPanel → desktopStore (CRUD, search), selectionStore (search), mcpBridge (start)
│   │   ├── DesktopTabs → desktopStore (create/switch/delete desktops)
│   │   ├── CanvasToolbar → desktopStore (addItem, updateViewport, pushHistory, undoHistory, redoHistory), desktopHistoryStore (canUndo, canRedo, loadHistory)
│   │   ├── SuperDesktopCanvas → desktopStore (items, connections, batchMoveItems), clipboardService, selectionStore
│   │   │   ├── DesktopItemView → TextItem/ChartItem/GraphicItem/RefItem/FileGroupItem/ImageItem/FormItem
│   │   │   └── ConnectionOverlay → desktopStore (connections), panX/panY/zoom props (screen-coord conversion)
│   │   └── FormItem → desktopStore (updateItem with FormContent)
├── StatusBar → statusMsgStore (message log)
├── FloatingRenderer → layoutStore (floating panels)
└── ContextMenu (self-contained, internal pub/sub)
```

## 8. Key Design Rules

1. **Single-window data flows through EventBus; cross-window through DataBus.** Use `eventBus.emit()`/`useEvent()` within a window. Use `dataBus.publish()`/`dataBus.subscribe()` for data that needs to reach child windows. The two systems coexist — DataBus Hub adapter bridges them.

2. **Sticky events** for state that new subscribers need immediately (chat, layout, settings, plans). Non-sticky for transient events (toast notifications).

3. **Module-level singletons** for all stores. No React Context, no Redux. Just exported functions that read/mutate module-scoped variables and emit events.

4. **WebSocket messages flow through useChatBridge.ts** → calls store mutators → stores emit EventBus events → components re-render via useEvent.

5. **Layout tree is the single source of truth** for panel visibility. Show/hide via `hideGroup()`/`ensureGroupVisible()`, never via conditional rendering.

6. **Plan history uses SQLite** via Tauri commands. Frontend calls `tauriInvoke("db_*", args)`. Paginated with IntersectionObserver scroll trigger. Dedup via `sessionId + tasksDigest(tasks)`.

7. **Rust backend commands** are registered in `lib.rs` with `#[tauri::command]` and access state via `State<Mutex<Connection>>`. Frontend invokes via `import("@tauri-apps/api/core").invoke`.

8. **Stores must not contain I/O.** File reading, HTTP calls, and other async operations belong in components or hooks. Stores are synchronous data containers with getters/mutators/notify.

9. **Cross-panel actions go through CommandRegistry.** Components must NOT import WS functions directly. Use `commands.execute("COMMAND_NAME", ...args)`. The `useChatBridge` module registers all WebSocket-bound commands.

10. **External file changes flow through FILE_CHANGED event.** Backend broadcasts `file_edit` via WebSocket → `useChatBridge` emits `FILE_CHANGED` on EventBus → EditorPanel (reload tabs) and FileTree (refresh tree) subscribe.

11. **System panels use `userManaged: false`.** Panels like `settings` and `ask-question` are managed by system triggers (toolbar button, agent tool call), not by the user via PanelDropdown.

12. **Selection is store-separate from desktop state.** `selectionStore` is canvas-local, ephemeral, pub/sub (not EventBus). Selected item IDs never mix with persisted desktop data.

13. **MCP server uses Tauri event bridge.** Rust TCP listener on fixed port 13920 emits `mcp-request` → JS `mcpBridge.ts` dispatches to store → responds via `mcp_response` Tauri command → Rust oneshot channel → HTTP response. MCP registered in `.mcp.json` + `~/.claude.json` for Claude Code agent access.

14. **Child windows are store mirrors, not independent clients.** Leaf windows have no WebSocket, no backend service. All data arrives via DataBus through the Tauri Event bridge. Components are identical — Hub/Leaf difference is invisible to UI code.

15. **Stream channel uses RAF batching.** High-frequency topics (`chat.delta.*`, `terminal.delta.*`) are merged per animation frame. Without merging, 60 token/s would produce 3600 IPC events/min — with RAF, ~60 batches/s max.

16. **TauriWindow is a first-class layout type.** Opening a panel in a native window removes it from its source group (same as float), registers a `TauriWindow` in layoutStore, and persists to settings. Restore spawns windows on startup with panelId dedup. Window close sends goodbye for cleanup.

17. **IDE backend auto-applies active profile.** `spawn_ide_backend()` reads `~/.claude/.env.active` (or first available `.env.profiles/*.env`) and sets model env vars on the child process. No manual model switching needed on GUI startup.

18. **Desktop DataBus sync is bidirectional with loop prevention.** Local mutations publish to DataBus → Bridge to other windows. Remote sync receives via `syncDesktopsFromBus()` which emits EventBus only (no DataBus re-publish). The `fromBridge` meta flag distinguishes remote from local publishes in Hub's DataBus subscriber.
19. **Permission mode must be in TS AppSettings.** `permissionMode` is persisted via `save_permission_mode` Rust command _and_ included in the TS `AppSettings` interface. Without the TS field, layout auto-save (which runs periodically) overwrites settings.json without the field, resetting it to `"default"`. The `permission_mode_changed` WS handler calls both `updateSettings({ permissionMode })` (sync TS memory) and `save_permission_mode` invoke (immediate disk write).
20. **`userManaged: false` panels are never persisted.** `serializeLayout()` checks `getPanel(panelId).userManaged` — if false, the tab is stripped from the tree and excluded from floatingPanels/tauriWindows before saving. This prevents temporary system panels (settings, feedback, skill-dialog, ask-question, profile-manager) from being restored on restart. When adding a new system panel, register it with `userManaged: false` and it will be automatically excluded from persistence.

21. **Font Scale Awareness.** See Section 18 for the full rule. Summary: new UI code should use `fontSize: "calc(var(--font-scale, 1) * Xpx)"` for user-readable text; skip for ≤10px utilities, icons, editor/terminal monospace.

22. **MCP servers register in `~/.claude/settings.json`.** All GUI-developed MCP servers must write to the root-level `mcpServers` key in `~/.claude/settings.json` (user-scope), NOT per-workspace in `~/.claude.json`. In "single file mode" (settings.json exists), per-workspace entries may not be picked up. See Section 21.

23. **Session management is centralized via `resetSession()`.** Before creating or loading a session, call `resetSession()` which clears messages, plan, terminal, sub-agents, and resets sessionId/tasks/context info. GUI attaches `session_id` to every user WS message; backend uses lightweight `switchSession()` if the message's session_id differs from its current session. See Section 20.

24. **`respondToPermission` passes flat params to `send()`.** The `send("control_response")` handler expects `{ allowed, session, always, updatedInput }` at the top level, not nested under `response`. Use `sendRef.current()` to avoid HMR stale closure. See Section 20.

25. **Content type discriminator must survive updates.** `desktop_update_item` in the MCP bridge merges content shallowly (`{ ...existing.content, ...partial.content }`) so the `type` field is never lost. `desktop_create_item` auto-injects `content.type` from the item type parameter. See Section 21.

26. **Notes are user-level, not per-workspace.** Note storage lives at `~/.claude/notes/notes.db` — shared across all workspaces. MCP note tools communicate via the existing MCP bridge (port 13920) and call Rust invoke() commands directly. After each mutation, `NOTES_CHANGED` event is emitted so the NotesPanel auto-refreshes. See Section 23.

27. **Permission mode persistence has a race-condition guard.** The `permission_mode_changed` WS handler now checks: if backend broadcasts "default" but settings has a saved non-default mode, ignore "default" and re-send the saved mode to backend. This handles the race where backend's init-time broadcast ("default") arrives after `onopen`'s `set_permission_mode(savedMode)`. See Section 20.

28. **Editor context menu sends `@ref{file:path:line-range}`.** Monaco editor adds "发送到聊天" action that emits `CHAT_ADD_REFERENCE` with `type: "file"`, `path`, `startLine`, and optional `endLine` (when multi-line selection). No label needed — the line range in the path is sufficient.

29. **Window size restore happens in Rust `setup()`, not JS.** `lib.rs` reads `windowWidth`/`windowHeight` from settings and calls `window.set_size(LogicalSize::new(w, h))` during app setup — before the window becomes visible. This eliminates the flicker of create-at-default-then-resize. JS side only handles persistence via the resize event listener (debounced 500ms). See Section 5.

30. **`save_app_settings` preserves window dimensions from Rust state.** The Rust `save_app_settings` command takes `State<Mutex<AppSettings>>` and preserves `window_width`/`window_height` before applying JS-sent settings. This prevents JS `saveSettings()` (which may carry stale `null` values from snapshots) from overwriting the correct window dimensions on disk. `save_window_size` remains the sole authority for window size writes. See Section 6.

31. **IDE backend is not pre-started on first launch.** Rust `setup()` skips `spawn_ide_backend()` when `is_first_launch == true`. The backend starts only after the user selects a workspace via WorkspaceSelector, ensuring it uses the correct `workDir`. For existing users, the backend is pre-started during setup with the last-used workDir (same as before). See Section 5.

32. **Update server URL must be configurable.** `AppSettings.update_server_url` defaults to `http://192.168.186.96:8765` (same server as skill registry). Wizard lets users choose intranet vs public server. The `check_for_updates` command takes `base_url` as a parameter so it can be overridden. See Section 24.

33. **Self-update must use a stager process.** The running GUI exe cannot overwrite itself on Windows. `prepare_gui_update()` downloads the new exe to a temp directory, writes instructions to `%TEMP%/claude-update.json`, and returns the `Update.exe` path. `launch_updater_and_exit()` spawns the stager and exits. The stager handles the file swap and relaunch. See Section 24.

34. **Post-install hooks are non-fatal.** If a hook fails, the error is logged but the component install is still considered successful. The hook runs after files are replaced and the temp download is cleaned up. See Section 24.

35. **Monaco editor uses local assets, not CDN.** `gui/public/monaco/vs/` bundle + `loader.config({ paths })` + fetch-blob workers. CSP set to `null` (Tauri v2 nonce-handles `unsafe-inline`, so the old strict CSP broke Monaco's inline styles). See Section 27.

36. **Profile chain has a single `MANAGED_KEYS` source.** `scripts/claude-profile.ts` and Rust `lib.rs` both define the same 18-key list and clear-then-rewrite settings env, so no stale profile values survive. `switch` writes project `settings.local.json` env + `profile.env` + both markers; `default` writes user `settings.json` env + `profile.env` + user marker. See Section 29.

37. **Session restore is atomic.** `chatStore.setMessages()` replaces the whole message array in one EventBus emit (no per-message streaming during load); `MessageList` keys by `sessionId` and uses double-rAF instant scroll, with follow-scroll gated by `wasAtBottomRef`. See Section 30.

38. **GUI settings live under a `gui` key in Claude Code's own config files.** Global baseline in `~/.claude/settings.json` → `gui`, workspace overrides in `<W>/.claude/settings.local.json` → `gui`. The engine preserves the unknown `gui` key (`.passthrough()`), and GUI writes are read-modify-write so engine keys are never clobbered. One workspace per GUI process; the process-level `BOUND_WORK_DIR` resolves workspace context for helpers without State access. See Section 34.

39. **Tab/panel icons are serializable `IconKey` strings, not ReactNode.** `TabInstance.icon` and `PanelDefinition.icon` are keys into the `Icons` map in `utils/icons.tsx`; renderers use `iconFor(key)` (fallback `"default"`). Layout persistence therefore carries icons straight through `serializeTab` → `deserializeTab` — no strip/rebuild dance. `deserializeTab` only trusts `data.icon` when it's a string; legacy data (no icon field, or pre-IconKey ReactNode-object serializations from old versions) falls back to the registry icon, so stale persisted icons can't break rendering. Compound-group icons cycle through `GROUP_ICON_POOL` (an `IconKey[]`). See Section 2.

## 9. Workspace Management (2026-07-23, updated 2026-07-29)

### Flow

```
App startup → loadSettings()
  ├─ restoreLayout (always)
  ├─ if isFirstLaunch:
  │   └─ show WelcomeWizard (7-step onboarding)
  │       ├─ Language → Font Scale → Profile → Force Chinese Thinking → Layout Intro → Server → Done
  │       └─ onComplete → persist settings + isFirstLaunch=false → continue
  └─ else (existing user):
      ├─ `--workspace <path>` CLI arg → bind directly (skip selector)
      ├─ `autoEnterRecentWorkspace` && `recentWorkspaces[0]` → bind recent directly
      └─ else → show WorkspaceSelector overlay
          └─ User action:
              ├─ Select workspace + Launch → save workspaces → BackendService.bind()
              ├─ Add new workspace → browse/type path → add to list → auto-select
              ├─ Delete workspace → remove from list
              └─ Close window → app stays on selector (no backend running)
```

### Welcome Wizard (2026-07-29, updated 2026-07-30)

First-launch onboarding wizard replaces the orphaned `FirstLaunchWizard.tsx`. 7 steps:

| Step | Content | Persistent |
|------|---------|-----------|
| Language | zh/en cards, calls `setLanguage()` live | On "完成" |
| Font Scale | 80-150% slider with live preview | On "完成" |
| Profile | List existing / skip / create (DeepSeek preset or Custom) | Immediately via `switch_model_profile` |
| Force Chinese | Toggle + experimental warning badge | On "完成" |
| Panel Layout | HTML/CSS 3-column diagram (25%/45%/30%) | N/A |
| Server | Intranet (96, default) vs Public (cloud) — sets skillRegistryUrl + updateServerUrl | On "完成" |
| Done | Settings summary + "完成" button | `saveSettings()` + `isFirstLaunch=false` |

Key design:
- All ephemeral state stays in React `useState` — no `updateSettings()` calls until completion
- Wizard overlay is rendered outside the `key={langKey}` div so language-switching doesn't remount it
- `isFirstLaunch: false` is written on completion; if user closes before, wizard shows again next time

### Data Model

- `AppSettings.workspaces: string[]` — persisted list of workspace paths
- `AppSettings.workDir: string` — currently active workspace
- Rust `lib.rs` AppSettings: `workspaces: Vec<String>` with serde rename
- Migration: if `workspaces` is empty but `workDir` is set, auto-populate

### Key Components

| Component | Role |
|-----------|------|
| `WorkspaceSelector` | Full-screen overlay: list, select, delete, add, browse, launch |
| `Toolbar` FolderOpen button | Triggers `WORKSPACE_OPEN_SELECTOR` event → App re-shows selector |
| `App.handleWorkspaceLaunch(workDir, wss)` | Persists workspaces+workDir, starts backend |

### Auto-Load Latest Session (2026-07-28)

`AppSettings.autoLoadLatestSession?: boolean` — when enabled (default), the first `session_list` after WS connect triggers `load_session` for the session with the highest `timestamp`. Controlled by a toggle in Settings → Chat. Uses module-level `_autoLoaded` flag to run only once per connect (not on reconnect).

### Auto-Enter Recent Workspace (2026-08-05)

`AppSettings.autoEnterRecentWorkspace?: boolean` — when enabled (Settings → General, or the wizard's Done step), a no-arg, no-`--workspace` instance skips the workspace selector and binds straight to `recentWorkspaces[0]` (the most recently bound workspace, maintained by Rust `bind_workspace` → `add_to_workspaces` on every bind — any instance updates it). Precedence on startup: `--workspace` CLI > auto-enter > selector.

## 10. AskUserQuestion / Permission Flow

### Control Request/Response Protocol

```
Backend → GUI: control_request
  { type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name, input, tool_use_id } }

GUI → Backend: control_response
  { type: "control_response", request_id, response: { allowed, updatedInput? } }
```

**Critical**: tool info is nested under `request.*`, not at top level. Response must wrap fields in `response.*`. Protocol types defined in `src/ide/protocol.ts` (`IDEControlRequest`, `IDEControlResponse`).

### AskUserQuestion Tool

When agent calls `AskUserQuestion(questions[])`:

1. Backend sends `control_request` with `tool_name: "AskUserQuestion"`, `input: { questions }`
2. `handleControlRequest` stores `pendingControlRequest` + sets `inputBlockedReason`
3. `ChatInputPanel` creates floating window via `addFloatingPanel("ask-question")`
4. `AskQuestionFloating` renders `AskQuestionOverlay` inside the floating window
5. `InputArea` blocks sends (checks `inputBlockedReason`)
6. User submits → `respondToPermission(true, false, updatedInput)` → floating window closes
7. User skips → `respondToPermission(false)` → floating window closes
8. FloatingRenderer × button → component unmount → `useEffect` cleanup auto-skips

### Input Blocking

- `chatStore.inputBlockedReason: string | null` — when non-null, InputArea blocks ENTER and Send button
- Set by `handleControlRequest` when tool is `AskUserQuestion`
- Cleared by `respondToPermission` (both allow and deny)
- Bottom bar shows reason text instead of "Enter to send"

### Floating Window Lifecycle

- `setAskQuestionCallbacks(floatId, onSubmit, onSkip)` — stores module-level callbacks
- `clearAskQuestionCallbacks()` — called BEFORE `removeFloatingPanel` to prevent cleanup double-fire
- `useEffect` return (cleanup) — handles FloatingRenderer × button close → auto-skip
- Floating panel registered as `ask-question` with `userManaged: false`

## 11. Slash Command System (2026-07-23)

### Data Flow

```
ideMode.ts (WS connect)
  → system/subtype=slash_commands
    → useChatBridge handler
      → chatStore.slashCommands
        → InputArea useEvent
          → SlashCommandDropdown (React portal)

User sends /cmd:
  InputArea.handleSend → onSend("/cmd")
    → ChatInputPanel.handleRoutedSend
      → commandRouter.routeCommand("cmd") → A/B/C/D
        → A: sendMessage (backend executes)
        → B: open GUI panel
        → C: spawn system terminal with claude
        → D: show "unavailable" toast
```

### Four Command Categories

| Category | Criteria | Action | Count |
|----------|---------|--------|-------|
| A | Info display, can render as text | Send to backend as normal message | ~default |
| B | GUI has matching panel | Open/activate panel (PlanPanel, TasksPanel, etc.) | 4 |
| C | Needs interactive terminal UI | Spawn system terminal + `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | 13 |
| D | Process-level / platform-specific | Show "not available" toast | 9 |

### Command Router (`utils/commandRouter.ts`)

Pure function, no side effects. Input: command name. Output: `RouteDecision { category, action, panelId? }`.

Priority: B (exact panel match) > C (terminal list) > D (blocklist) > A (default).

### Slash Detection in InputArea

- `findSlashContext(container)` — walks text to find `/` at word boundary before cursor
- Returns `{ trigger, filter, slashPos, cursor }` for positioning and insertion
- `handleInput` detects `/`, stores position refs, opens dropdown
- `handleSlashSelect(cmd)` replaces `/partial` with `/cmd ` in contenteditable
- Keyboard nav (↑↓TabEnter) handled by InputArea, dropdown is presentational
- NBSP (`\u00A0`) normalized to `\u0020` in `extractContent` — critical for backend command parsing

### Backend Protocol

**Incoming (WS → GUI):**
- `system/subtype=slash_commands`: `{ commands: [{ cmd, desc, type }] }` — sent on connect + after plugin_refresh

**Outgoing (GUI → WS):**
- `plugin_refresh`: Triggers backend to call `refreshActivePlugins()` + `getCommands(cwd)`, then broadcasts updated slash_commands

**Backend changes (`ideMode.ts`):**
- 6 commands unblocked: `doctor`, `ide`, `tag`, `fast`, `branch`, `reload-plugins`
- `reload-plugins` gets dedicated IDE handler (was blocked at both name-match and `supportsNonInteractive` levels)
- `broadcastSlashCommands(ws?)` helper — sends to specific client or all
- `plugin_refresh` WS case: refreshes plugins, reloads commands, broadcasts

### Terminal Spawn for C-class Commands

- Rust `open_system_terminal(terminalType, workDir, claudeLaunch)` added `claudeLaunch: bool`
- Prefer Git Bash (no quoting issues), fallback to cmd
- Sets `CLAUDE_CODE_SKIP_PROMPT_HISTORY=true` — no session file residue
- Git Bash: `--cd=<dir> -c "export VAR=true && claude; exec bash"` — terminal stays open after claude exits
- On close: `requestPluginRefresh()` → backend reloads → slash_commands updated in GUI

### Compact Context Button

ChatStatusBar shows a compact button next to the context bar. Sends `{ type: "compact" }` over WS (already supported by backend). Backend responds with `status: "compacting"` and `system: compact_boundary`, which update the streaming indicator.

## 12. Skills Panel (2026-07-23)

### Overview

Browse, search, and invoke skill commands via a visual panel. Click a skill to open a floating dialog with contentEditable input (supporting @ref chips), then send directly to the agent.

### Architecture

```
SkillsPanel (sidebar panel)
  ├─ reads chatStore.slashCommands → filter type="prompt"|"skill"
  ├─ reads settingsStore.favoriteSkills → favorite/regular split
  └─ click skill → openSkillDialog()
      │
      ├─ updateChatState({ activeSkillDialog: { skill, isFav } })
      ├─ setSkillDialogCallbacks(floatId, onSend, onSkip, onToggleFav)
      └─ addFloatingPanel("skill-dialog", x, y, w, h)
          │
          └─ SkillDialogFloating
              ├─ reads chatStore.activeSkillDialog (survives drag re-renders)
              └─ renders SkillDialog
                  ├─ contentEditable input (Enter=newline, Shift+Enter=send)
                  ├─ EventBus CHAT_ADD_REFERENCE → @ref chips (from FileTree right-click)
                  └─ [发送] → commands.execute("SEND_MESSAGE") → useChatBridge
```

### Floating Window Lifecycle

| Action | Behavior |
|--------|----------|
| FloatingRenderer × | unmount → useEffect cleanup → `!stillExists` → `_onSkip()` → clear callbacks |
| Send button | `onSend(text)` → capture `_floatId` → clear callbacks → `removeFloatingPanel(fid)` |
| Escape key | `onClose()` → capture `_floatId` → clear callbacks → `onSkip` → `removeFloatingPanel(fid)` |
| Drag/reposition | re-render → `stillExists` = true → skip DOES NOT fire → data kept |

**Critical**: `_floatId` must be captured BEFORE `clearSkillDialogCallbacks()` which sets it to null. Cleanup distinguishes "real close" (panel removed from store) from "drag re-render" (panel still in store) via `getFloatingPanels().some(...)`.

### @ref Chip Routing

When the SkillDialog is open (`chatStore.activeSkillDialog !== null`), InputArea's `CHAT_ADD_REFERENCE` handler skips — the SkillDialog's own handler picks up the event and inserts the chip.

### Favorites

- Stored in `settingsStore.favoriteSkills?: string[]`
- Toggle via ★/☆ button in dialog footer
- Favorite skills appear at top of SkillsPanel list with section header
- Persisted to `settings.json` automatically via `updateSettings`

### Sending

- `commands.execute("SEND_MESSAGE", "/cmd args")` — registered in useChatBridge
- Adds optimistic user message + sends via WebSocket
- SkillDialog closes after send

### Skills Translation (Async, 2026-07-28)

- **Button**: "翻译" / "重新翻译" in SkillsPanel header
- **Flow**: Builds prompt from skill commands → calls `run_cli_print` Rust command → Rust spawns CLI in background thread, returns `request_id` immediately → GUI listens for `cli-translate-result` Tauri event → parses JSON (brace counting) → saves to `<workspace>/.claude/skills-i18n.json` → updates UI
- **Non-blocking**: Translation no longer freezes the GUI. Status message shows "正在通过 CLI 翻译..." then "正在翻译（可能需要 1-2 分钟）..." while running.
- **Cleanup**: Stale listener auto-cleaned on unmount or re-trigger. `CLAUDE_CODE_SKIP_PROMPT_HISTORY=true` prevents session pollution.

### Command Type Filtering

Backend `broadcastSlashCommands` now passes through the actual command type (`prompt` | `local` | `local-jsx`) instead of hardcoding `"local"`. SkillsPanel filters for `c.type === "prompt" || c.type === "skill"`.

### Skill Marketplace (Online Registry + One-Click Install, 2026-07-28)

Two-part system enabling skill discovery and one-click installation from the GUI.

**Server** (`skills-server/`, Python FastAPI):
- Port 8765, primary deployment at 192.168.186.96 (intranet), also at 123.56.66.84 (cloud)
- SQLite: `packages` + `api_keys` tables
- Skill files stored as `skills-store/<slug>/<skill>/SKILL.md`
- Read-only public; upload requires `X-API-Key`
- Translations per package: `skills-store/<slug>/translations/<lang>.json`

**API endpoints**:
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/packages` | No | List packages (by download count) |
| GET | `/api/packages/{slug}` | No | Package detail + skill list + available translations |
| GET | `/api/packages/{slug}/download` | No | Download entire package as .zip |
| GET | `/api/packages/{slug}/skills/{name}/download` | No | Download single skill as .zip |
| GET | `/api/packages/{slug}/translations/{lang}` | No | Get translations JSON (skills-i18n format) |
| POST | `/api/packages` | API key | Upload package (manifest.yaml + skills.zip) |

**GUI — SkillsPanel Tabs**:
```
SkillsPanel
├── Tab: "已安装" (existing behavior)
│   ├── Search + Translate button
│   ├── Favorites section + Regular section
│   └── Click → SkillDialog (now shows Chinese desc via load_skills_i18n)
└── Tab: "在线库" (MarketplaceTab — NEW)
    ├── fetch → GET /api/packages → card list
    ├── Expand package → GET /api/packages/{slug} + translations
    │   ├── Per-skill: [/cmd] [中文标题] [描述...] [安装/已安装]
    │   └── Package-level: [安装全部]
    └── Install flow:
        ├── install_skill/install_package Rust command (download zip → extract → ~/.claude/skills/)
        ├── requestPluginRefresh() → CLI rescans skills
        └── mergeTranslations() → GET translations → merge into skills-i18n.json
```

**Translation flow**:
1. Server stores `translations/zh.json` per package
2. Marketplace tab: fetch translations on expand → display Chinese names/descs
3. Install: fetch translations → merge into `<workdir>/.claude/skills-i18n.json`
4. SkillDialog: loads i18n on mount → displays Chinese desc
5. Command names (`/cmd`) stay untranslated; Chinese titles shown as supplement

**Settings**:
- `skillRegistryUrl` in AppSettings (TS + Rust, default `http://192.168.186.96:8765`)
- Settings panel has dedicated "技能" category tab
- Rust migration: auto-upgrade `localhost` URLs to cloud default on startup

**Rust additions** (`gui/src-tauri/src/lib.rs`):
- New crates: `zip = "0.6"`, `reqwest = "0.12"` (blocking)
- Commands: `get_skills_dir`, `install_skill`, `install_package`, `delete_skill`
- Helpers: `download_and_extract()`, `find_skill_root()`, `find_package_root()`, `has_skill_dirs()`

**Published content**:
- Matt Pocock Engineering Skills (17 skills): code-review, to-spec, implement, prototype, diagnose-bugs, research, TDD, triage, wayfinder, etc.
- Matt Pocock Productivity Skills (5 skills): grill-me, handoff, teach, writing-great-skills, grilling

## 13. Super Desktop (2026-07-24, updated 2026-07-24 evening)

### Overview

A free-form infinite canvas panel for organizing data, ideas, and references. Supports 9 content types (text, table, charts, flowcharts/mindmaps, @ref references, file groups, images, forms, drawing), drag-to-connect lines, multi-desktop tab switching, clipboard paste & file drop, and a data disclosure registry for AI/programmatic access.

### Architecture

```
SuperDesktopPanel           — state owner: searchQuery + matchedIds + MCP bridge start
├── DesktopTabs             — switch/create/rename/delete desktops
├── CanvasToolbar           — +Text/+Form, zoom, Fit, Snap/Grid, Undo/Redo, Clear, search box
└── SuperDesktopCanvas      — infinite canvas (CSS transform pan/zoom/grid, box-select, multi-drag)
    ├── DesktopItemView[]   — positioned content blocks (drag/resize/anchors, selected/dimmed props)
    │   ├── TextItem / ChartItem / GraphicItem / RefItem / FileGroupItem / ImageItem / FormItem
    ├── ConnectionOverlay   — SVG bezier connections (rendered OUTSIDE transform, screen coords)
    ├── Canvas 2D rubber band — connection drag (orange bezier) + box-select (blue rect)
    └── Canvas overlay      — hint text during operations
```

### Data Flow

```
desktopStore (module singleton)
  ├── Desktop[] + activeDesktopId
  ├── Mutators: 20+ functions (create/delete/rename desktop, add/update/remove/move/resize/batchMove item,
  │              add/remove/update connection, clearDesktop, restoreSnapshot, pushHistory, undoHistory, redoHistory)
  ├── Queries: getDesktops, getActiveDesktop, getDesktopItem, getDesktopItems, searchItems, findSmartPlace
  ├── SQLite: save_desktop() debounced 500ms, loadDesktops() on mount
  └── EventBus: DESKTOP_CHANGED (sticky), DESKTOP_ITEM_MOVED

desktopHistoryStore (module singleton, zero imports from desktopStore)
  ├── pushSnapshot(id, state) / undo(id, state) / redo(id, state)
  ├── canUndo(id) / canRedo(id) / clearHistory(id) / loadHistory(id)
  └── SQLite: desktop_history table (undo_json + redo_json blobs)

selectionStore (module singleton, ephemeral, no persistence)
  ├── setSelection(ids) / clearSelection() / toggleSelection(id) / addToSelection(ids)
  ├── getSelectedIds() / isSelected(id) / useSelection() hook
  └── pub/sub pattern (separate from EventBus — canvas-local transient state)

clipboardService (shared module)
  ├── saveClipboardItem(blob, workDir, baseName?) → filePath
  └── isRealFilePath(path, timeoutMs=1000) → boolean

dataRegistry (standalone service, no longer WS-exposed)
  ├── registerDataSource(itemId, { queryHandler, opHandler })
  └── Internal only: AI creates/edits via opHandler (MCP replaces WS exposure)

desktopSummary (pure compute service)
  └── computeDesktopSummary({viewportW?, viewportH?}) → DesktopSummary

mcpBridge (Tauri event → store dispatch)
  ├── Listens for "mcp-request" events from Rust HTTP server
  ├── Dispatches 16 tools (summary/get/search/create/update/delete/move/connect/undo/redo)
  └── Responds via "mcp_response" Tauri command → oneshot channel → HTTP response
```

### Content Types

| Type | Component | User Interaction | AI Access |
|------|-----------|-----------------|-----------|
| Text | `TextItem` | contentEditable writing, 24-lang code highlight, markdown preview; **preview-first** when the format supports it (2026-08-05) | `queryHandler("text")` |
| Table | `TableItem` | Click-to-edit cells, add/delete rows/columns, rename headers | AI create/update via MCP |
| Chart | `ChartItem` | View only | `opHandler.update_data({data})` |
| Graphic | `GraphicItem` | Drag nodes + Auto Layout + SVG zoom/pan | `opHandler.update_data({nodes, edges})` |
| Ref | `RefItem` | Click to open files | `queryHandler("paths")` |
| FileGroup | `FileGroupItem` | Expand/collapse dirs, send files to Agent | N/A (file-system backed) |
| Image | `ImageItem` | View only (paste/drop creates) | N/A (file-system backed) |
| Form | `FormItem` | Fill values (view), configure fields (edit) | `opHandler.update_fields` / `opHandler.set_values` |

### Canvas

- **Transform**: `translate(panX, panY) scale(zoom)` with `transform-origin: 0 0` — no library
- **Zoom**: cursor-centered scroll wheel (0.1x–5x), native `addEventListener("wheel", {passive:false})` because React's onWheel is passive
- **Pan**: drag empty area (left-click)
- **Focus**: `tabIndex={0}` + `onClick` focus — enables Ctrl+V paste without interfering with drag operations
- **Grid**: CSS `repeating-linear-gradient`, toggleable via toolbar
- **Items**: absolute-positioned divs inside transformed container; drag via title bar, 8-dir resize, collapse toggle

### Paste & Drop

- **Ctrl+V**: detected text → `isRealFilePath()` (1s timeout) → dir: enumerate via `read_dir` → FileGroupItem, file: single ref, plain text: TextItem. Images → saved via `saveClipboardItem` → ImageItem
- **Drag & Drop**: files from filesystem — image files → ImageItem, directories → enumerate → FileGroupItem, others → FileGroupItem with refs. Clipboard files → saved to `.claude/pasted/`
- **Location**: paste → viewport center, drop → drop position

### @ref Integration

- **Send to Agent**: right-click any item → emits `CHAT_ADD_REFERENCE` with `@ref{desktop-item:<type>/<uuid>|<label>}` chip into InputArea (does NOT send message — AI decides what to do)
- **Chip click**: in message area → activates Super Desktop panel → auto-pans canvas to center target item → blue glow animation (3s pulse)
- **Path format**: `desktop-item:<contentType>/<itemUUID>` — AI can parse content type from the ref path without querying

### Connections

- **Anchors**: 4 per item (top/right/bottom/left), orange dots, hover-only, hidden during item drag/resize (`!dragging && !resizing`)
- **Drag**: mousedown anchor → `connDrag.current` → canvas-drawn rubber band (orange bezier, outside transform, zIndex 2) → geometry-based snap on mouseup
- **Snap detection**: Euclidean distance from mouse to all anchors in canvas coords → nearest within `16/zoom` px → `addConnection()`
- **Rendering**: `ConnectionOverlay` SVG **outside transform div** (avoids `overflow: hidden` clipping). All path coordinates converted to screen coords via `toScreen(x,y,pan,zoom)`
- **Style**: orange (#ff6b35), 2.5px, 16px transparent click zone. Selected connection → blue highlight + label editing
- **Interaction**: click to select (edit label), Delete to remove, Esc to deselect

### Canvas Interaction Model (2026-07-24)

```
Empty area left-drag     → Box-select (rubber band)
Space + left-drag        → Pan (hand tool, "grabbing" cursor)
Middle mouse drag        → Pan
Scroll wheel             → Zoom (cursor-centered, 0.1x–5x)
Delete / Backspace       → Delete all selected items
Escape                   → Cancel connection drag / clear selection
Click empty < 3px drag   → Deselect all
```

**Pointer capture (2026-08-06)**: canvas drags (pan / box-select / connection / multi-drag) use **pointer events + `setPointerCapture`** on drag start. Previously `mouseup` was bound to the canvas element, so releasing the button over another panel never fired it and the canvas kept following the cursor. Capture routes every `pointermove`/`pointerup` back to the canvas even outside it; `pointercancel` clears all drag state (system-gesture / window-blur interruption can't leave the canvas stuck). Item drag/resize already used window-level listeners.

### Box-Select

- **Rubber band**: Canvas 2D overlay (outside transform), blue fill `rgba(0,122,204,0.08)` + dashed border `#007acc`
- **Intersection**: AABB overlap test in canvas coords — `!(selRight < item.x || selBottom < item.y || selLeft > itemRight || selTop > itemBottom)`
- **Selection state**: `selectionStore` (ephemeral `Set<string>`, pub/sub pattern, not persisted)
- **Visual**: Selected items get `2px solid #007acc` border (no animation — `highlighted` flash uses CSS keyframes)
- **Multi-drag**: Drag any selected item → `batchMoveItems()` moves ALL selected. Snap-to-grid applies on mouseup.
- **Context menu**: Selected items ≥ 2 → "Delete N Items" / "Send N to Agent" / "Bring to Front"

### Undo/Redo

- **Stack**: Per-desktop, max 100 snapshots, persisted to SQLite `desktop_history` table
- **Snapshot**: `{ items[], connections[], panX, panY, zoom }` — full state clone via `JSON.parse(JSON.stringify())`
- **Merge**: Continuous ops (drag, resize, pan, wheel-zoom) push ONE snapshot at start; store auto-pushes before discrete ops (add, remove, connect)
- **Circular-dep free**: `desktopHistoryStore` never imports `desktopStore` — accepts `DesktopStateLike` as param. `desktopStore` provides `pushHistory()`/`undoHistory()`/`redoHistory()` wrappers
- **UUID stable**: Undo restores original items array with original UUIDs — `@ref` links survive

### Search

- **Store**: `searchItems(query, desktopId?)` — case-insensitive match against label + content text (type-dependent extraction)
- **UI**: `CanvasToolbar` search input → `SuperDesktopPanel` computes `matchedIds` → `SuperDesktopCanvas` passes `dimmed={!matched}` to items
- **Dimming**: `opacity: 0.25` + `pointerEvents: "none"` on non-matching items

### Smart Placement (simplified 2026-07-28)

- **`findSmartPlace(desktop, w, h)`**: Spiral search from canvas `(100, 100)`, AABB overlap avoidance, snap-to-grid aware. No longer depends on viewport size — items always appear near top-left.
- **Max search**: 100 steps, fallback to anchor + 20px offset
- **Standalone utility**: Caller passes desktop + dimensions, receives `{ x, y }`

### AI-Facing API

- **`DesktopSummary`** type: Lightweight snapshot — `{ desktops, activeId, activeDesktop: { viewport, items[summary], connections } }`
- **`DesktopItemSummary`**: `{ id, type, label, x, y, w, h, zIndex, screenX, screenY, visible, selected }` — no `content` payload
- **`computeDesktopSummary(opts?)`**: Builds summary from store state + selectionStore
- **Flow**: AI reads summary → decides target → `getDesktopItem(id)` for full content → operates

### MCP Server (Embedded Worker)

- **Rust side** (`mcp.rs`): TCP listener on `127.0.0.1:<auto-port>`, basic HTTP/JSON-RPC, `oneshot` channel per request
- **JS side** (`mcpBridge.ts`): Listens for `mcp-request` Tauri events → dispatches 16 tools → responds via `mcp_response` command
- **Worker panel**: Shows MCP worker entry with status dot + port number (alongside IDE Backend)
- **Tools**: `desktop_summary`, `desktop_get_items`, `desktop_search`, `desktop_create_item`, `desktop_update_item`, `desktop_delete_items`, `desktop_move_item`, `desktop_resize_item`, `desktop_connect`, `desktop_disconnect`, `desktop_undo`, `desktop_redo`, `desktop_list`, `desktop_create`, `desktop_delete`, `initialize`, `tools/list`

### FormItem

- **10 control types**: text, textarea, number, checkbox, select, date, switch, radio, color, slider
- **Dual mode**: ⚙ Configure (edit) / ✓ Done (view). View mode shows clean label+control only
- **Edit mode features**: per-field config panel (placeholder, required, min/max/step, options chips), drag reorder (mouse-based on ⠿ handle), double-click rename, type badge, delete button
- **Options editor**: chip-based — each option is a tag `[label ×]`, add via input+button or Enter
- **Data model**: `FormField { id, name, type, value, options?, placeholder?, required?, min?, max?, step?, maxlength?, rows? }`

### Desktop Item Viewer (2026-07-27)

Right-click any canvas block → pop out into a floating panel or native Tauri window for focused viewing/editing:

- **"Open in Floating Tab"** — creates a CSS floating panel in the same window. Renders `DesktopItemViewer` at full panel size.
- **"Open in New Window"** — spawns a Tauri child window. Item ID is embedded in the title as `[item:uuid]` (avoids Tauri label character restrictions).
- **Bidirectional sync** — edits in the viewer write back to `desktopStore`, syncing to the canvas block. Uses debounced input save (600ms) + immediate blur save.
- **All 7 content types** supported — reuses existing `TextItem`/`ChartItem`/etc. components.
- **Data passing**: `desktopItemViewerRegistry` module stores `currentItemId`. For floating panels: set before `createFloatingFromTab`. For Tauri windows: passed through URL hash, parsed by `FloatingApp`.

### Desktop DataBus Sync (2026-07-27)

`desktopStore` mutations now publish to DataBus for cross-window sync:

| Direction | Mechanism |
|-----------|-----------|
| Hub → Leaf | `desktopStore.notifyDesktopChanged()` publishes `desktop.list` + `desktop.items` to DataBus → BridgeOut → Leafs |
| Leaf → Hub | Same publish path; Hub's `dataBusHub` subscribes to `desktop.list` with `fromBridge=true` → calls `syncDesktopsFromBus()` |
| Loop prevention | `syncDesktopsFromBus()` emits EventBus only (no DataBus re-publish). Local mutations go through `notifyDesktopChanged()` which publishes to DataBus. |
| Init | Leaf Bridge handshake includes `desktop.list` in sticky snapshots → `syncDesktopList`/`syncDesktopItems` in `dataBusLeaf` were implemented (were stubs) |

### SQLite Persistence

- **Location**: `<workspace>/.claude/data.db` (per-workspace isolation)
- **Tables**: `desktops`, `desktop_items`, `desktop_connections` (sharing DB with plans)
- **DbState wrapper**: `{ conn, work_dir }` + `ensure_db()` auto-reopens DB on workspace switch
- **Frontend**: `desktopStore.loadDesktops()` on mount, debounced save on mutation
- **Loading state** (2026-07-28): `loadDesktops()` sets `_loading = true` → SuperDesktopPanel shows `LoadingSpinner` → `finally` resets flag. `isDesktopLoading()` + `onDesktopLoadChange()` exported for external consumers.
- **Reload on bind** (2026-08-05): the panel mounts while Rust `DbState.conn` still points at the *global* workDir's `data.db` (setup() opens it before a workspace is picked) — `bind_workspace` switches it to the per-workspace file afterwards. `loadDesktops()` installs a one-shot `BACKEND_PORT_READY` handler that re-fetches from the now-bound workspace DB (sticky event → also fires if the panel mounts after bind). An empty result clears the list so stale data from another workspace never lingers. Without this, every instance showed the shared global desktops and re-saved them into the wrong workspace DB (the `desktop id` colliding across `data.db` files was the tell).

### Canvas Interactions (2026-07-28)

| Feature | Behavior |
|---------|----------|
| **Click-to-select** | Clicking/dragging any item title bar calls `setSelection(new Set([item.id]))`. Ctrl+click toggles multi-select. |
| **Send-to-desktop focus** | Message "→ Desktop" + FileTree context menu now call `activatePanel("super-desktop")` + `setSelection` + `panToItem(item.id)` with 200ms delay (wait for panel mount). ActionBtn dropdown auto-closes on child click so canvas receives keyboard focus. |
| **Viewport animation** | `panToItem(itemId)` triggers a two-phase CSS transition (`0.4s cubic-bezier(0.16, 1, 0.3, 1)`). `_viewportAnimate` flag set before `updateDesktopViewport`; `SuperDesktopCanvas` uses `shouldAnimateViewport()` in a `useEffect` with `prevPanRef` to interpolate from old to new position. |
| **Zoom threshold** | Content area interactions disabled (`pointerEvents: none`, `opacity: 0.6`) when `scale < 0.3`. Title bar drag + anchors + resize remain active. |
| **`findSmartPlace`** | Simplified: always starts spiral from canvas origin `(100, 100)`, 30px step. No longer depends on viewport/zoom. |

### Smart Placement (replaced by findSmartPlace)

1. **AI-driven content** — Chart, Graphic are display-only with no manual editing UI. AI creates/edits via MCP tools (replaces dataRegistry WS). FileGroup, Image, Form are user+AI accessible.
2. **Canvas toolbar** — Text + Form buttons (user-created). Chart/Graphic/Ref are AI-only. Fit auto-adjusts viewport. Snap snaps to grid on move. Clear is two-step confirm. Undo/Redo persisted.
3. **ConnectionOverlay outside transform** — SVG rendered at container level with screen-coordinate paths, avoiding `overflow: hidden` clipping from the transform div.
4. **Anchors hidden during drag** — `!dragging && !resizing` prevents anchor dots from capturing title-bar mouse events.
5. **Canvas wheel isolation** — `target.closest("[data-desktop-item]")` blocks zoom on content scroll. Native `{passive: false}` wheel listener.
6. **Geometry-based connection snap** — Euclidean distance in canvas coords, avoids z-order/pointer-events issues.
7. **Box-select replaces empty-area pan** — Space+drag or middle-mouse for pan (Figma/Miro pattern). Selection is ephemeral (selectionStore), not in desktop state.
8. **Circular dependency prevention** — `desktopHistoryStore` never imports `desktopStore`. All functions accept `DesktopStateLike` as parameter.
9. **Undo merges continuous ops** — Drag/resize/pan push snapshot at mousedown (not per-frame). Wheel zoom debounced 500ms.
10. **Shared clipboardService** — `saveClipboardItem` extracted from InputArea, reused by canvas paste/drop.
11. **FileGroup lazy tree** — directories expand on demand via `read_dir`, cached in `childCache` Map.
12. **MCP embedded in Tauri** — Rust TCP server + JS event bridge, shown as Worker alongside IDE Backend. Tools access store functions via Tauri event round-trip.

## 14. DataBus — Multi-Window Data Bus (2026-07-26)

### Overview

DataBus replaces EventBus as the **cross-window** communication layer while EventBus remains for single-window intra-process events. In the Hub (main) window, all data flows through both. In Leaf (child) windows, stores are fed entirely by DataBus with no WebSocket connection.

### Architecture

```
IDE Backend (唯一 WebSocket)
    ↕
Hub 窗口 ─ WS Adapter ─ EventBus ─ DataBus ─ BridgeOut (Tauri emit)
    ↕                              ↕
Leaf 窗口 ─ BridgeIn (Tauri listen) ─ DataBus ─ Store 镜像
```

### Hub / Leaf Roles

| | Hub (主窗口) | Leaf (子窗口) |
|---|-------------|-------------|
| WebSocket | 唯一连接 | 无 |
| Store | 数据本源 | 镜像（DataBus 驱动） |
| Bridge | BridgeOut（管理订阅路由、推送数据） | BridgeIn（接收数据、回传命令） |
| 组件代码 | 完全相同 | 完全相同 |
| 面板 | 完全相同 | 完全相同 |

### Four-Channel Auto-Routing

All `dataBus.publish(topic, payload)` calls route to one of four channels based on topic prefix:

| 通道 | Topic 前缀 | 传输策略 | 举例 |
|------|-----------|---------|------|
| Stream | `chat.delta.*` `terminal.delta.*` `tool.progress` `chat.context` | RAF 帧合并，同 topic payload 合并后一帧一次 emit | text delta 拼接、partial_json 保留最后 |
| State | 所有 sticky topic + 默认 | 立即发送，JSON 序列化值对比，相同值跳过 | chat.message, plan.tasks, settings |
| Bulk | `chat.session.loaded` `editor.fileContent` `plan.history` `subagents.transcript` | 一次性发送，与 Stream 并发隔离 | 整套消息历史、文件内容 |
| Command | `cmd.*` | 立即发送，不合并不跳过 | cmd.send, cmd.interrupt, cmd.session.switch |

### Stream Merge Strategies

| Topic | 合并方式 |
|-------|---------|
| `chat.delta.text` `chat.delta.thinking` | 拼接 text，保留最大 index |
| `chat.delta.json` | 保留最后一条（partial_json 累积替换） |
| `terminal.delta.output` `tool.progress` `chat.context` | 保留最后一条 |

### API

```ts
import { dataBus } from "../services/dataBus";

// Subscribe (with wildcard support)
const unsub = dataBus.subscribe("chat.*", (payload, meta) => {
  // meta.topic, meta.mergeId, meta.fromBridge
});

// Publish (channel auto-routed)
dataBus.publish("chat.message", msg, { sticky: true });
dataBus.publish("chat.delta.text", { text: "hello", index: 0 });
dataBus.publish("cmd.send", { content: "hi" });

// Hub/Leaf bridge integration
dataBus.setBridgeOut((topic, payload, channel, meta) => { /* Tauri emit */ });
dataBus.bridgeReceive(topic, payload, { fromBridge: true });

// State dedup (same value → skip), sticky replay on subscribe
// Stream RAF batching (multi-publish in same frame → merged)
```

### Bridge Handshake

```
Leaf 窗口打开:
  1. Leaf → hello { windowId, subscriptions: ["chat.*", "plan.*", ...] }
  2. Hub  → init  { snapshots: { topic → sticky value } }
  3. Leaf → ready (init applied to local stores)
  4. Stream/Bulk 通道正常流转
```

### Heartbeat

Hub 每 5 秒 ping → Leaf 回 pong → 连续 3 次 (15s) 无回应 → 清理订阅 → 停止推送。Leaf 关闭发 goodbye → 立即清理。

### Hub Adapter (`dataBusHub.ts`)

Monitors EventBus events and republishes to DataBus. Key responsibilities:
- `CHAT_STATE_CHANGED` → text diff extraction → `chat.delta.text`/`chat.delta.thinking` + `chat.message` + state topics
- `PLAN_UPDATED` → `plan.tasks`
- `SUB_AGENTS_CHANGED` → `subagents.list`
- `TERMINAL_CHANGED` → `terminal.delta.output` + `terminal.output`
- `EDITOR_CHANGED` → `editor.tabs` + `editor.activePath`
- `SETTINGS_CHANGED` → `settings`
- `BACKEND_STATE_CHANGED` → `workers.status`
- `DESKTOP_CHANGED` → `desktop.list` + `desktop.items`
- `cmd.*` from Bridge → forward to WS via `useChatBridge.send()`
- Initial publish of current settings on startup

**Zero modification to useChatBridge or any Store** — pure subscriber.

### Leaf Adapter (`dataBusLeaf.ts`)

Subscribes to DataBus topics and writes to local stores. Each store function mirrors the Hub:
- `chat.delta.text` → `updateLastAssistant(m => ({ content: m.content + text }))`
- `chat.delta.thinking` → `updateLastAssistant(m => ({ thinking: m.thinking + text }))`
- `chat.message` → `addMessage(msg)`
- `chat.streaming` → `updateChatState({ streaming })`
- `chat.session.loaded` → `clearMessages()` + `addMessage()` for each
- `plan.tasks` → `updatePlan(tasks)`
- `settings` → `updateSettings(s)` (in-memory only, no disk write)
- `layout.mode` → `layoutMode.syncFromBus(v)`
- etc.

### useChatBridge Leaf Fallback

`useChatBridge.ts` `send()` function modified: when `ws` is null and no port (Leaf mode), publishes to `dataBus.publish("cmd.${type}", payload)` instead of queuing. Hub receives via Bridge → `dataBusHub` forwards to WS. Transparent to components.

## 15. Unified Layout System (2026-07-26)

### TauriWindow

`TauriWindow` is a first-class layout citizen alongside `SplitNode`, `TabGroup`, and `FloatingWindow`:

- **"Float Tab"** → remove tab from source → `createFloatingFromTab(tab)` → CSS floating panel
- **"Open in New Window"** → remove tab from source → `createTauriWindowFromTab(tab)` → spawn Tauri window + register in layoutStore
- **Both remove from source** — unified behavior

### Persistence

All three layout types persisted in `settings.json` under `layoutTree`:
```json
{
  "tree": { ... },
  "floatingPanels": [ ... ],
  "tauriWindows": [ ... ]
}
```

### Startup Restore

`restoreLayout()` at startup:
1. Restore main layout tree
2. Restore floating panels (CSS)
3. Restore TauriWindows — spawn each via `invoke("create_floating_window")` with dedup by panelId

### Cleanup

- Leaf window close → `FloatingApp` useEffect cleanup → `bridge.sendGoodbye()` → Hub removes from `_leafs` + calls `removeTauriWindow(label)`
- Heartbeat timeout (15s no pong) → also cleans up TauriWindow registry
- `createTauriWindowFromTab` dedups by panelId before adding

### Layout Mode Sync

`layoutMode.toggle()` publishes `layout.mode` to DataBus (sticky). Leafs subscribe and call `layoutMode.syncFromBus(v)` — all windows enter/exit edit mode together.

### FloatingApp

Now registers **all 15 panels with real components** (not placeholders). On mount: starts Bridge as Leaf → hello handshake → receives init snapshots → starts DataBus Leaf adapter → renders layout tree. On unmount: sends goodbye.

## 16. MCP Registration (2026-07-26)

### Fixes Applied

- **extractToolName**: Now handles `tools/call` method — extracts tool name from `params.name`. Previously only handled `tools/list` and `initialize`.
- **Response format**: `tools/call` results wrapped in MCP content envelope: `{ content: [{ type: "text", text: JSON.stringify(result) }] }`
- **Fixed port**: MCP server now listens on `127.0.0.1:13920` (was auto-port `127.0.0.1:0`)
- **Claude Code registration**: `.mcp.json` at project root + `~/.claude.json` user-level MCP server entry

### Profile Auto-Apply

`spawn_ide_backend()` in `lib.rs` now calls `apply_active_profile()` before spawning the IDE process. Reads the active profile from `~/.claude/.env.active` (or first available profile) and sets env vars on the child process. No manual model switching needed on GUI startup.

## 17. Feedback System (2026-07-28)

### Overview

Anonymous user feedback system with GUI submission form and web-based admin page. Reuses the existing skills-server (same FastAPI process, same port 8765). Feedback is publicly visible; status modification requires API key.

### Architecture

```
GUI Feedback Button (Toolbar 🐛)
  → openFeedbackFloat() → floating panel → FeedbackDialog
  → POST /api/feedback (multipart: type, message, app_version, image?)
  ↓
skills-server (port 8765)
  ├── models.py — feedback table CRUD
  ├── routes.py — 5 endpoints (list/create/get/update-status/serve-image)
  ├── static/admin.html — management page
  └── feedback-images/ — uploaded screenshots (UUID filenames)
```

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/feedback` | No | Submit feedback (multipart form) |
| GET | `/api/feedback` | No | List feedback (?status=&offset=&limit=) |
| GET | `/api/feedback/{id}` | No | Single feedback detail |
| PATCH | `/api/feedback/{id}?status=xxx` | API key | Update status |
| GET | `/api/feedback/images/{filename}` | No | Serve uploaded image |

### Data Model

**feedback** table (SQLite): id, type (bug/suggestion), message (max 5000 chars), image_path (nullable UUID.ext), app_version, status (open/in_progress/resolved/closed), created_at.

### Security

- **Image validation**: magic bytes check (PNG/JPEG/GIF/WebP only), max 10MB, UUID filename
- **Auth**: GET endpoints public; PATCH requires `X-API-Key` header (reuses existing auth middleware)
- **Anonymous**: no IP, UA, or identity recorded
- **Privacy warning**: GUI shows red warning box reminding users to redact sensitive data from screenshots before upload

### GUI — FeedbackDialog

- Floating panel registered as `feedback` (userManaged: false), opened via Toolbar 🐛 button (`openFeedbackFloat()`)
- Type selector: bug report / suggestion (2-column toggle)
- Message textarea (5000 char limit with counter)
- Screenshot picker: Tauri `invoke("read_bytes")` → base64 → canvas resize (max 1024px, JPEG q=0.85) → FormData upload
- Auto-fills `app_version` from `settings._version` (default `1.0.0-preview`)
- "Browse All" link opens admin page in system browser via `@tauri-apps/plugin-shell open()`
- Capability: `shell:allow-open` added to `capabilities/default.json`

### Admin Page

- URL: `http://192.168.186.96:8765/admin`
- Single-file HTML (`skills-server/static/admin.html`), no build tools
- Lists all feedback with status badges, color-coded type labels, version info
- Filter by status dropdown
- Click-to-expand image modal
- Status dropdown + update button (requires API key)
- API key input field for auth

## 18. UI Font Scaling (2026-07-28)

### Overview

User-configurable font size scaling via CSS variable. No layout changes, no coordinate system side effects, no `zoom`/`transform` hacks. Only text rendering scales.

### Mechanism

```
SettingsPanel Slider (70%–150%, step 10%, default 100%)
  → updateSettings({ uiFontSize: 120 })
    → SETTINGS_CHANGED event
      → App.tsx useEffect
        → document.documentElement.style.setProperty("--font-scale", "1.2")
          → All calc(var(--font-scale, 1) * Xpx) values rescale
```

- **CSS variable**: `--font-scale` (default `1`, i.e. 100%)
- **Slider**: 70–150%, release to apply (local state during drag, no twitching)
- **Application**: `fontSize: "calc(var(--font-scale, 1) * 14px)"` in inline styles
- **Zero side effects**: no `zoom`, no `transform`, no `-webkit-text-size-adjust`
- **Settings key**: `uiFontSize: number` (default 100, TS + Rust, `#[serde(default)]`)

### Files Covered (70+ edits across 11+ files)

| File | What scales |
|------|------------|
| `SettingsPanel.tsx` | All labels, inputs, selectors, about page text |
| `SkillsPanel.tsx` | Skill names, descriptions, buttons, tabs, search |
| `SessionPanel.tsx` | Session titles, action buttons |
| `Toolbar.tsx` | Dropdown items, trigger buttons, session/git labels |
| `StatusBar.tsx` | Message log expanded view |
| `ChatInputPanel.tsx` | Permission prompts, status bar |
| `PlanPanel.tsx` | Task content, history headers |
| `ContextMenu.tsx` | Menu item base style |
| `MessageItem.tsx` | Message bubbles, reference bar |
| `InputArea.tsx` | Input text, @ref chips |
| `FileTree.tsx` | File/folder names, empty state, rename input |
| `App.tsx` / `FloatingApp.tsx` | Loading overlay |

### 🔴 Design Rule: Font Scale Awareness

**When writing new UI code, always consider whether the fontSize should be included in the scaling system.**

- **SHOULD scale**: any text the user reads — labels, messages, descriptions, titles, button text, input text, tab names, menu items
- **Should NOT scale**: tiny utility sizes (≤10px — badges, arrows, counters), icon characters (● ✓ ▶ 🖼), editor/terminal fonts (have their own settings), monospace code blocks

**Pattern**:
```tsx
// ✅ Good — scales with user preference
fontSize: "calc(var(--font-scale, 1) * 14px)"

// ❌ Bad — hardcoded, won't scale
fontSize: 14
```

The `var(--font-scale, 1)` fallback ensures that even if the CSS variable is not set (e.g., in unit tests or SSR), the font renders at the base size.

## 19. System Reminder Injection (2026-07-29)

### Overview

The `<system-reminder>` mechanism injects system-level context into AI conversations without the user seeing it. Two injection types were added for the GUI client.

### GUI Context (`gui_context`)

Injected once per backend process lifetime, tells AI it's running inside the GUI:

```
You are running inside the Claude Code GUI desktop client (Tauri 2 + React).
When you see @ref{...} in user messages, read ~/.claude/gui-ref-system.md
For panels, MCP tools, and environment: read ~/.claude/gui-agent-guide.md
```

Implementation: `src/utils/attachments.ts` → `getGuiContextAttachment()` → `allThreadAttachments`. Gated by `CLAUDE_CODE_IDE` env var, one-shot via `_guiContextSent` flag.

### Force Chinese Thinking (`force_chinese`)

When enabled via Settings toggle, injects into the **system prompt** (not system-reminder) for stronger model obedience:

```
# CRITICAL Language Rule
Your thinking/reasoning blocks MUST be written entirely in Chinese (中文).
```

Implementation: `src/entrypoints/ideMode.ts` → `buildIDEContextPrompt()`. Checks `CLAUDE_CODE_GUI_FORCE_CHINESE` env var (set by Rust when `forceChineseThinking` is enabled in settings). The prompt is appended to the system message via `QueryEngine`'s `appendSystemPrompt`.

**Why system prompt instead of system-reminder:** System prompts are obeyed more strictly by models than `<system-reminder>` tags in user messages. The attachment-based approach was tried first but proved ineffective — some models ignored it and continued thinking in English.

### Document Auto-Copy

On backend startup, `spawn_ide_backend()` copies three docs to `~/.claude/`:
- `docs/gui/gui-agent-guide.md` → `~/.claude/gui-agent-guide.md`
- `docs/gui/ref-system.md` → `~/.claude/gui-ref-system.md`
- `docs/system-reminder.md` (reference, not injected)

AI can read these regardless of workspace directory via `~/.claude/` paths.

### Cross-Reference

| Document | Purpose |
|----------|---------|
| `docs/system-reminder.md` | 40+ attachment types reference |
| `docs/gui/ref-system.md` | @ref syntax (8 types) + MCP integration |
| `docs/gui/gui-agent-guide.md` | AI GUI operation manual + content type reference |

## 20. Session Management (2026-07-29)

### resetSession()

Unified session cleanup function called when creating a new session or loading an existing one. Located in `useChatBridge.ts`:

```ts
function resetSession() {
  clearMessages();       // chatStore
  clearPlan();           // planStore
  clearTerminal();       // terminalStore
  clearSubAgents();      // subAgentStore
  updateChatState({
    sessionId: null, tasks: [], contextPercent: 0,
    contextWindowSize: 0, usedTokens: 0, outputTokens: 0, model: "",
  });
}
```

Called from:
- `createSession()` — user clicks "+" in SessionPanel
- `session_loaded` handler — auto-load or manual session switch

### Session ID Tracking

GUI attaches `session_id` to every `user` WS message (`useChatBridge.ts` `send()` function). Backend checks incoming `message.session_id` against `getSessionId()` and calls `switchSession()` if they differ (lightweight, no message reload). This prevents the race condition where `current_session` (fresh UUID) arrives before `session_list` (500ms `setTimeout`), which previously caused each typed message to create a new session.

### Auto-Load Fixes

- `_autoLoaded` reset to `false` on WS reconnect (`ws.onopen`), ensuring auto-load re-fires after backend restart
- `_autoLoaded` set to `true` even when `session_list` has 0 sessions, preventing post-first-message auto-load that would reload the same session and flash the UI
- `handleLoadSession` changed from `void` to `await` — ensures session switch completes before next WS message is processed (race → new session per message)

### AskQuestionFloating StrictMode Guard

`<React.StrictMode>` in `main.tsx` causes useEffect cleanup to fire on first mount. `AskQuestionFloating` previously called `_onSkip()` (→ `respondToPermission(false)`) in cleanup, immediately denying the permission. Fixed with `realMount` ref + `setTimeout` guard that only fires `_onSkip` if the component doesn't remount within the same event loop tick.

### Permission Response Fix

`respondToPermission()` in `useChatBridge.ts` was passing nested `{ response: { allowed, ... } }` to `send()`, but `send("control_response")` expects flat params (`p.allowed`, not `p.response.allowed`). Fixed to pass `{ request_id, allowed, session, always, updatedInput }` flat. Additionally, `sendRef = useRef(send)` prevents HMR stale closure from keeping old `send` function reference.

### Session Favorites (2026-08-05)

Workspace-scoped session favorites, mirroring the skill-favorites pattern but scoped per-workspace (sessions themselves are per-workspace):

- **Storage**: `favoriteSessionIds?: string[]` in `AppSettings`, written with `saveSettings({ favoriteSessionIds }, "workspace")` → `<W>/.claude/settings.local.json` `gui.favoriteSessionIds`. Read back through Rust `AppSettings.favorite_session_ids` + `merge_workspace_overrides` (§34 layering) — a frontend-only field is dropped on `gui_to_app_settings`, so the Rust struct field + merge are mandatory.
- **Keyed by session id** (not title): rename survives, and a deleted session is reliably detected as "stale".
- **Pure partition** (`sessionFavorites.ts` `partitionSessions(sessions, favIds)`) → `{ favSessions (live order), staleFavIds (favorite order), regularSessions }`. Unit-tested.
- **UI** (`SessionPanel.tsx`): favorites pinned on top with a gold ★; un-favorited rows show a ☆ on hover. Stale favorites render first in the favorites section, grayed/italic with a "missing" hint + × to remove the favorite (clicking the row does nothing — no switch). Stale detection is live: `favIds ∩ currentSessions`.
- **Cross-workspace leak (2026-08-05)**: `loadSettings()` runs at App mount *before* the workspace binds, so it read `reload_effective_settings(global workDir)` — which merges that workspace's `favoriteSessionIds` into every instance's memory; binding another workspace kept the stale value (the `loaded` cache). Fixed: `reloadSettings()` (bypasses the cache) is called after `BackendService.bind()` resolves, and `SessionPanel` subscribes to `SETTINGS_CHANGED` so favorites re-render from the bound workspace.
- **Stale mislabeling (2026-08-05)**: before the backend reports `sessions_updated` the list is empty and every favorite would show as missing. `ChatState.sessionsLoaded` is set on the first `sessions_updated`; `SessionPanel` only renders the stale section once it's true.

## 21. MCP Bridge — Content Type Safety (2026-07-29)

### Content Type Auto-Injection

`desktop_create_item` auto-injects `content.type` from the item type parameter:

```ts
if (!rawContent.type) {
  rawContent.type = itemType === "drawing" ? "drawing" :
    itemType === "chart" ? "chart" : /* ... */ "text";
}
```

Prevents AI from creating items with missing type discriminators (e.g., `{ svg: "..." }` without `type: "drawing"`).

### Content Merge on Update

`desktop_update_item` merges content shallowly instead of replacing entirely:

```ts
if (partial.content && typeof partial.content === "object") {
  const existing = getDesktopItem(params.itemId);
  if (existing?.content) {
    partial.content = { ...existing.content, ...partial.content };
  }
}
```

Prevents `updateItem({ content: { svg: "new" } })` from overwriting the `type` field.

### Force Persistence

Each MCP mutation immediately persists to SQLite via `forceSaveDesktop()`:

```ts
const MUTATIONS = new Set(["desktop_create", "desktop_delete", "desktop_create_item", /* ... */]);
if (MUTATIONS.has(toolName)) forceSaveDesktop();
```

Eliminates the 500ms debounce risk for AI-generated content. `forceSaveDesktop()` clears any pending debounce timer and writes immediately.

### MCP Registration

On backend startup, `register_super_desktop_mcp()` writes the Super Desktop MCP server to `~/.claude/settings.json` root-level `mcpServers` (user-scope, available to all workspaces). Same tier as existing `memory` and `playwright` MCP servers.

**Rule:** All GUI-developed MCP servers must register in `~/.claude/settings.json` root-level `mcpServers`, NOT per-workspace in `~/.claude.json`. In "single file mode" (settings.json exists), per-workspace registration may not be picked up reliably.

## 22. Super Desktop — Drawing Content (2026-07-29)

### DrawElement Type

`DrawElement` is now defined in `gui/src/types/desktop.ts` alongside `DrawingContent`:

```ts
export type DrawElement =
  | { id: string; type: "freehand"; points: Pt[]; color: string; strokeWidth: number; opacity: number; }
  | { id: string; type: "rect"; x: number; y: number; w: number; h: number; color: string; strokeWidth: number; fillColor: string | null; opacity: number; }
  | { id: string; type: "circle"; cx: number; cy: number; r: number; /* ... */ }
  | { id: string; type: "line"; x1: number; y1: number; x2: number; y2: number; /* ... */ }
  | { id: string; type: "arrow"; x1: number; y1: number; x2: number; y2: number; /* ... */ }
  | { id: string; type: "text"; x: number; y: number; text: string; color: string; fontSize: number; opacity: number; };
```

### DrawingContent Updated

```ts
export interface DrawingContent {
  type: "drawing";
  svg: string;              // full SVG markup (for view mode)
  width: number;
  height: number;
  elements?: DrawElement[]; // editable strokes (AI or user-created)
}
```

- `svg` always present — used for static view mode (`dangerouslySetInnerHTML`)
- `elements` optional — when present, the user can select the block and edit individual strokes/shapes
- AI can create drawings with `elements` via `desktop_create_item` (MCP description lists all 6 element shapes)

### Editing Mode

- **Not selected**: renders static SVG
- **Selected + no elements**: renders static SVG + `✏️ 编辑` button (user can enter edit mode)
- **Selected + has elements**: enters edit mode directly (7 tools, color picker, undo/redo)
- **"完成" button**: exits edit mode, `persist()` saves both `svg` and `elements` for re-editing

### Drawing vs Graphic

| Type | Purpose | Content |
|------|---------|---------|
| `drawing` | Free-form vector art | Raw SVG + optional `DrawElement[]` |
| `graphic` | Structured flowchart/mindmap | `{ nodes: [...], edges: [...] }` with auto-layout |

## 23. Notes Panel (2026-07-29)

### Overview

A personal note-taking system built into the GUI. Notes support Markdown content with a Milkdown WYSIWYG editor, tags, scope, and weighted associations between notes. AI can create, read, search, and manage notes via MCP tools.

### Architecture

```
NotesPanel.tsx ←→ Tauri invoke() ←→ Rust notes.rs ←→ ~/.claude/notes/notes.db
     ↑
MCP Bridge (mcpBridge.ts) ← Rust TCP (13920) ← AI agent
```

### Data Model (SQLite)

- **`notes`**: id, title, content, scope (global/domain:*/project:*), created_at, updated_at
- **`tags`**: id, name (UNIQUE, lowercase)
- **`note_tags`**: note_id FK → notes, tag_id FK → tags (CASCADE delete)
- **`note_associations`**: source_id, target_id, weight (0.0–1.0), type (related_to/derived_from/contradicts/supports)

Storage is user-level at `~/.claude/notes/notes.db`, shared across all workspaces.

### Rust Commands (12)

| Command | Description |
|---------|-------------|
| `note_create` | INSERT note + tags |
| `note_update` | UPDATE partial fields (title/content/scope/tags) |
| `note_delete` | DELETE + CASCADE |
| `note_get` | SELECT by ID, returns note + tags + associations |
| `note_list` | SELECT list with scope/tag filters, ORDER BY updated_at DESC |
| `note_search` | SQL coarse-filter (title+content+tags, multi-word) → Rust weighted sort (title complete +3 / partial title or tag +2 / content +1) |
| `note_associate` | INSERT OR REPLACE association |
| `note_disassociate` | DELETE association (bidirectional) |
| `note_tags` | List all tags with usage counts |
| `note_get_all_tag_names` | Simple string array of all tag names |
| `note_apply_tag_mapping` | Apply `{old: canonical}` mapping, cleanup orphans |

### MCP Tools (9)

All available via the same MCP server on port 13920. mcpBridge.ts dispatches `note_*` tools directly to Rust invoke() calls.

| Tool | Description |
|------|-------------|
| `note_create` | Create note (title, content, scope?, tags?) |
| `note_update` | Update note (only provided fields changed) |
| `note_delete` | Delete by ID |
| `note_get` | Full content + tags + associations |
| `note_list` | List with scope/tag filters |
| `note_search` | Text search — title+content+tags, weighted (title > tag > content) |
| `note_associate` | Link two notes |
| `note_tags` | List all tags with counts |
| `note_normalize_tags` | LLM-based tag grouping (dry_run flag) |

After each mutation, `NOTES_CHANGED` event is emitted on EventBus so the NotesPanel auto-refreshes.

### Tag Normalization (LLM-based)

Unlike the Memory MCP's embedding-based clustering, notes use the current LLM:
1. Collect all tag names via `note_get_all_tag_names`
2. Construct prompt: "Group these tags by semantic similarity. Return JSON: {mappings: {old: canonical}}"
3. Call `run_cli_print` Rust command (non-blocking, uses backend Claude)
4. Parse JSON response → apply mapping via `note_apply_tag_mapping`
5. Return `{mappings, merged_count, dry_run}` to caller

Triggered manually by user clicking "归一化标签" or by AI calling `note_normalize_tags` MCP tool.

### Frontend (NotesPanel.tsx)

- **Scope tree**: Parse scope strings by `:` separator into hierarchical tree (e.g. `domain:rust` → domain → rust)
- **Multi-select**: "多选" button → checkboxes → batch delete in sticky bottom bar
- **Right-click menu**: 发送到聊天 (`@ref{note:id|title}`) / 发送到超级桌面 (Text block) / 删除
- **Milkdown editor**: WYSIWYG Markdown with toolbar (bold, italic, headings, lists, code blocks, tables, etc.)
- **Raw/WYSIWYG toggle**: "MD" button switches between Milkdown rendering and raw textarea
- **Auto-save**: 2s debounce, diff-based (only sends changed fields)
- **Search**: Client-side filtering on title + tags

### Editor Toolbar (ProseMirror/Milkdown commands)

Each button calls the corresponding Milkdown `$Command.run()`:
- `toggleStrongCommand` / `toggleEmphasisCommand` / `toggleStrikethroughCommand` (inline marks)
- `wrapInHeadingCommand(level)` (headings)
- `wrapInBulletListCommand` / `wrapInOrderedListCommand` (lists)
- `wrapInBlockquoteCommand` / `createCodeBlockCommand` (blocks)
- `insertTableCommand({row, col})` via popover (React component, prompts for row/col count)

### @ref Integration

New `note` reference type added to the ref system:
- `@ref{note:<uuid>|title}` — opens Notes panel and loads the note
- ReferenceLink component renders `📝` icon for note refs
- AI can emit note refs in responses to help users navigate to relevant notes

### Cross-Reference

| Document | Section |
|----------|---------|
| `docs/gui/gui-agent-guide.md` | Notes panel + MCP tools reference |
| `docs/gui/ref-system.md` | `note` reference type |
| `src/utils/messages.ts` | `gui_context` attachment mentions Notes MCP |

## 24. Update System (2026-07-30)

### Overview

Selective incremental update system for the GUI desktop application. **8 components** (gui, claude, bun, updater, tools, python, git, extensions) can be updated independently. **Comparison is done by comparing local manifest.json component hashes against the server manifest** — no filesystem hash computation at runtime. The release-platform server (port 8765, same as skill registry) serves manifests and component zips.

Since 2026-08-04 the client **no longer hardcodes the component list**: `check_for_updates` iterates the remote manifest's `components` directly, so a newly-published component (e.g. `updater`) shows up without a client rebuild. The UpdatePanel likewise renders whatever the server returns (fallback label = raw name). The server sorts versions numerically (`_version_key`), not lexically — otherwise `2026.08.03.10` sorts before `.9`.

All HTTP requests run async off the main thread (`std::thread::spawn` + `mpsc`) with 10s timeout and `no_proxy()` to avoid system proxy interference. Downloads use 120s timeout. The webview CSP (`tauri.conf.json`) allows `connect-src` to both intranet (192.168.186.96) and public (123.56.66.84) servers.

### Architecture

```
release-platform (192.168.186.96:8765)
  ├── /api/updates/latest                              → manifest.json
  ├── /api/updates/{version}/components/{name}/download → component.zip
  └── /api/updates/{version}/upload                    → (POST, API key)

GUI Client
  ├── Rust update.rs (gui/src-tauri/src/update.rs)
  │     ├── check_for_updates(base_url)                → compares local vs server manifest
  │     ├── download_and_install_component(name, url, hook?, sha256?, size?)
  │     │     ├── try_install (direct write)            → update local manifest
  │     │     └── install_via_stager (if PermissionDenied)
  │     │           └── PowerShell Start-Process -Verb RunAs → Update.exe
  │     ├── prepare_gui_update(url, sha256?, size?)    → Update.exe path + instructions
  │     └── launch_updater_and_exit(path)              → wait 500ms → exit(0)
  ├── updateService.ts (gui/src/services/)             → thin invoke wrappers
  └── UpdatePanel.tsx (gui/src/components/chat/)       → floating panel UI

Update.exe (updater/ — standalone Rust project, windows-subsystem)
  ├── KILLS ALL claude-code-gui.exe instances + orphaned claude.exe --ide-mode
  │     backends first (force-killing a GUI orphans its backend; terminal TUIs run
  │     claude.exe WITHOUT --ide-mode and must survive) — multi-instance update
  ├── gui_exe_src set → replace exe (rename→copy, 10 retries) → restart GUI
  ├── gui_exe_src empty → copy files only → exit (no restart)
  ├── Reads %TEMP%/claude-update.json
  └── Handles manifest.json updates (copy from temp, admin privileges)
```

### Components

| ID | Compare | Path(s) | Self-Updating |
|----|---------|---------|---------------|
| `gui` | local manifest vs server | `claude-code-gui.exe` | Yes (Update.exe stager) |
| `claude` | local manifest vs server | `claude.exe` | No |
| `bun` | local manifest vs server | `bun.exe` | No |
| `updater` | local manifest vs server | `Update.exe` | Yes (GUI Rust replaces it; stager fallback for Program Files) |
| `tools` | local manifest vs server | `bin/` | No |
| `python` | local manifest vs server | `python/` | No |
| `git` | local manifest vs server | `git/` | No |
| `extensions` | local manifest vs server | `extensions/` | No |

All components compare local `manifest.json` hashes against the server manifest. After a successful update, the server's hash is written directly into the local manifest — no filesystem hash recomputation. The local-manifest writer **upserts**: a newly-published component (no existing key) is added, not skipped, so its first install is recorded and it stops reporting "update available". For admin-protected installs (Program Files), the updated manifest is written to a temp file and copied in by Update.exe along with the component files.

### Updater (Update.exe) as a managed component

`Update.exe` ships in the `updater` component (`updater.zip`, built by `scripts/build.ts` from `updater/src/main.rs`). This means future stager fixes are pushed through the normal update panel instead of requiring a fresh installer. It is **not self-updating via the stager**: the GUI's Rust `download_and_install_component("updater")` copies the new `Update.exe` directly while it is idle. For Program Files installs the direct write is `PermissionDenied` → falls back to `install_via_stager`, which launches the old `Update.exe` elevated (`RunAs` → UAC); Windows allows renaming a running exe (`rename` old → `.old` + copy new in), so it can replace itself.

### Post-Install Hooks

Two hook types can be declared in the manifest per component:

| Type | Field | Behavior |
|------|-------|----------|
| `script` | `path` | Run `.bat`/`.cmd` shipped inside the component zip |
| `command` | `run` | Run a shell command directly (e.g. `setx`, `reg add`) |

- Executed AFTER files are installed to the target directory
- Working directory = component's install directory
- Hook failure is logged but does NOT fail the update
- Description shown in the GUI before install

### Manifest Format

```json
{
  "version": "2026.07.30",
  "release_notes": "修复权限持久化竞态 + 新增 WelcomeWizard",
  "published_at": "2026-07-30T12:00:00Z",
  "components": {
    "gui": {"sha256": "a1b2c3...", "size": 15728640},
    "python": {"sha256": "d4e5f6...", "size": 120000000,
      "post_install": {"type": "command", "run": "setx CLAUDE_GUI_VERSION 2026.07.30"}}
  }
}
```

### Frontend States

```
idle → checking → available → downloading → needsRestart (GUI) / idle
                              → upToDate / error
```

### GUI Self-Update Flow

```
1. User selects GUI component + clicks "Update Selected"
2. prepare_gui_update(url, sha256, size) → downloads new exe to %TEMP%
   → builds updated manifest.json with new GUI hash → writes to temp
   → writes %TEMP%/claude-update.json (gui_exe_src + manifest file in files[])
3. User clicks "Restart"
4. launch_updater_and_exit(path) → PowerShell Start-Process RunAs → wait 500ms → exit(0)
5. Update.exe: waits 3s for old GUI to release locks
   → renames old .exe → copies new .exe + manifest.json → launches new GUI
6. New GUI starts → check_for_updates reads local manifest → hash matches → "已安装"
```

### Non-GUI Component Update Flow

```
1. User selects component (tools/python/git/etc.) + clicks "Update Selected"
2. download_and_install_component(name, url, hook?, sha256, size) → downloads zip to %TEMP%
3. try_install: direct write to install dir
   → success: write_local_manifest (update manifest.json with server hash)
   → PermissionDenied: install_via_stager
     → build updated manifest.json → write to temp
     → write %TEMP%/claude-update.json (gui_exe_src="" + files + manifest)
     → PowerShell Start-Process -Verb RunAs -Wait → Update.exe
     → Update.exe copies files + manifest → exits
     → .status() unblocks → return success
4. Next check: local manifest hash == server hash → "已安装"
```

### Key Files

| File | Purpose |
|------|---------|
| `gui/src-tauri/src/update.rs` | Rust core: types, manifest, hash/ts compare, download, install, hooks |
| `updater/src/main.rs` | Standalone stager: file swap + relaunch |
| `gui/src/services/updateService.ts` | Frontend API wrappers over Tauri invoke |
| `gui/src/components/chat/UpdatePanel.tsx` | Floating panel with checkbox list + progress |
| `claude-code-gui-release-platform/server/updates.py` | Server routes for manifest + download + upload |

### Config

- `AppSettings.update_server_url` (Rust + TS) — default `http://192.168.186.96:8765`
- Auto-check: startup + 5s delay, non-blocking, silent on error
- Manual check: Toolbar Download button → floating UpdatePanel

## 25. Memory MCP — Lightweight Refactor (2026-07-30, updated 2026-07-30)

### Before vs After

| | Original | Lightweight |
|---|----------|-------------|
| Dependencies | PyTorch + sentence-transformers + numpy | fastapi + uvicorn + mcp only |
| Docker image | 1.2–1.8 GB | 248 MB |
| Runtime RAM | 500–800 MB | ~150 MB |
| Semantic search | all-MiniLM-L6-v2 (384-d) | Keyword + tag + importance (no embeddings) |
| Tag normalization | Embedding clustering (`cluster_tags`) | LLM-driven (`apply_tag_mapping(mapping={...})`) |
| Embedding API | Always available | Optional — `EMBEDDING_MODEL_PATH` for local model |

### Search Strategy

Without embeddings, `hybrid` mode degrades to:
- Text match: split query into tokens → OR-based LIKE search → rank by keyword match count (title=+10, content=+5 per token)
- Tag match: exact tag filtering
- Importance boost: 30% weight on importance score

### Tag Normalization (LLM-Driven)

```
1. memory_tags() → get all tag names with counts
2. LLM analyzes semantic duplicates (e.g. "rust" vs "rust-lang" vs "Rust")
3. LLM builds mapping: {"rust-lang": "rust", "Rust": "rust"}
4. memory_normalize_tags(mapping={...}, dry_run=true)  → preview
5. memory_normalize_tags(mapping={...})                  → apply
```

### Deployment (Dual)

| | Intranet (Primary) | Cloud |
|---|-------------------|-------|
| Server | **192.168.186.96** | 123.56.66.84 |
| MCP URL | `http://192.168.186.96:40020/mcp` | `http://123.56.66.84:8080/mcp` |
| API URL | `http://192.168.186.96:40021` | `http://123.56.66.84:40021` |
| Container | `claude-memory` | `claude-memory` |
| Data | `/data/claude-memory/claude-memory.db` | `/data/memory/claude-memory.db` |

- Server: 192.168.186.96 (`root` / `<SSH 密码>`), cloud: 123.56.66.84 (`root` / `<SSH 密码>`)
- Both Docker compose managed, bind mounts for persistence
- Memory Explorer password: `<密码>`
- Release Platform: port 8765 (same on both servers)
- 凭据（服务器/密钥/账号）汇总见内部凭证记录，不写入仓库文档

## 26. Help Panel (2026-07-31)

### Overview

A help guide panel for first-time users and quick reference. Covers all toolbar buttons and user-managed panels with detailed descriptions and HTML concept diagrams.

### Trigger

1. **Toolbar `?` button** — always available, opens help as a floating panel (`openHelpFloat()`, 680×520)
2. **First launch auto-open** — wizard + workspace selection complete → 2s delay → auto-opens help

### Content Structure

```
┌─────────────────────────────────┐
│ 💡 Tip: click ? to reopen       │
├─────────────────────────────────┤
│ 📐 Layout Overview              │
│ [4-zone CSS diagram]            │
├─────────────────────────────────┤
│ 🔧 Toolbar (16 items, grid)     │
│ icon + name + description       │
├─────────────────────────────────┤
│ 📦 Panels (13 sections)         │
│ Each section:                   │
│  - icon + name header            │
│  - 2-3 sentence description     │
│  - optional concept diagram     │
└─────────────────────────────────┘
```

### Concept Diagrams (pure HTML/CSS)

| Diagram | Illustrates |
|---------|-------------|
| Layout | 4-zone UI: left sidebar / center / right sidebar / bottom |
| Chat Split | Messages area (bubbles) + Input bar |
| File Tree | Indented directory structure |
| Editor Tabs | Tab bar + line numbers + syntax-colored code |
| Terminal Tabs | Tab bar + dark terminal with command output |
| Super Desktop | Tab bar + canvas items + SVG connection lines + toolbar |

### i18n

- `zh.ts` / `en.ts`: `help.*` section with 29 keys (title, layout, 16 toolbar descriptions, 13 panel descriptions, tip)
- Panel names reuse existing `panel.*` keys
- Toolbar names reuse existing `toolbar.*` / `workspace.*` / `update.*` / `feedback.*` / `permission.*` keys

### Registration

- Panel registered as `help` in `panelDefs.tsx` (`userManaged: false`)
- Icon: `HelpCircle` from lucide-react, registered in `icons.tsx`
- Floating window anti-duplication: second click on `?` brings existing float to front

### Files

| File | Purpose |
|------|---------|
| `gui/src/components/chat/HelpPanel.tsx` | Help panel component with diagrams |
| `gui/src/components/Toolbar.tsx` | `openHelpFloat()` + `?` button |
| `gui/src/App.tsx` | Auto-open on first launch |
| `gui/src/services/panelDefs.tsx` | `help` panel registration |
| `gui/src/utils/icons.tsx` | `help` icon |
| `gui/src/i18n/zh.ts` | Chinese help content |
| `gui/src/i18n/en.ts` | English help content |
| `.scratch/help-panel/PRD.md` | Design spec |

## 27. Monaco Editor — Local Assets (2026-08-03)

### Overview

Monaco Editor switched from CDN to a bundled local build (`gui/public/monaco/vs/`, ~175 files) so the editor works offline and in Tauri production, where the `tauri://` protocol can't reach CDN workers. Setup is lazy and protocol-agnostic.

### Setup (`Editor.tsx`)

```
baseUrl = window.location.origin + "/monaco/vs"   // works on http://, tauri://, https://tauri.localhost

MonacoEnvironment.getWorker(label):
  ts/js          → language/typescript/ts.worker.js
  json           → language/json/json.worker.js
  css/scss/less  → language/css/css.worker.js
  html/handlebars/razor → language/html/html.worker.js
  other          → editor/editor.worker.js

worker = fetch(url) → new Worker(blobURL)   // blob URL bypasses Tauri protocol worker restrictions
loader.config({ paths: { vs: baseUrl } })
```

### CSP

`tauri.conf.json` `security.csp` set to `null`. Tauri v2 rewrites/nonce-handles `unsafe-inline` for the `tauri://` origin, so Monaco's inline styles never applied under the old strict CSP. Null CSP is required for Monaco to render correctly in production.

### Devtools

`Cargo.toml`: `tauri = { version = "2", features = ["devtools"] }` — enables the built-in devtools feature for production debugging.

### Files

| File | Purpose |
|------|---------|
| `gui/public/monaco/vs/` | Bundled Monaco (editor + 40 language contributions + workers) |
| `gui/src/components/Editor.tsx` | `ensureMonaco()` lazy init + fetch-blob worker factory |
| `gui/src-tauri/tauri.conf.json` | `csp: null` |
| `gui/src-tauri/Cargo.toml` | tauri `devtools` feature |

## 28. GUI Production Fixes (2026-08-03)

Batch of production fixes shipped alongside the Monaco work:

| Fix | File(s) | Detail |
|-----|---------|--------|
| Terminal theme | `TerminalPanel.tsx`, `tokens.css` | xterm theme built from CSS tokens: Catppuccin **Mocha** (dark) / **Latte** (light). MutationObserver on `data-theme` updates colors live. `tokens.css` cascade-protects xterm colors. |
| Session rename | `SessionPanel.tsx`, `useChatBridge.ts` | `session_renamed` re-fetches the session list instead of applying locally — fixes the list being cleared |
| MCP SQL | `notes.rs` | `note_tags` adds `AS count` alias for the SQLite aggregate column |
| Paste interception | `SuperDesktopCanvas.tsx` | Paste/`@ref` interception extended to `textarea`/`contentEditable` targets; filegroup root dirs pinned to top |
| Skill fix | `processSlashCommand.tsx` | Resolves `commandName` ReferenceError in `disable-model-invocation` skills |
| Secrets hygiene | `.gitignore` | Excludes `.claude/profile.env` (contains API key) |

### Code-block theme consistency (2026-08-05)

**Root cause**: `--bg-code` was hardcoded dark (`#1e1e2e`, Catppuccin) in the *light* theme while every other code surface followed the theme — hljs theme manager (App.tsx) loads `github.min.css` vs `github-dark.min.css` on `data-theme`, `FileDiffView` and `TextItem` code preview use light backgrounds. Result: in light theme the bash-command block and markdown `<pre>` were dark while the file diff was light — "one dark, one light" side by side in a tool card.

| Fix | File(s) | Detail |
|-----|---------|--------|
| `--bg-code` light value | `tokens.css` | `#1e1e2e` → `#f6f8fa` (github code-block background) |
| Command block text color | `MessageItem.tsx` | `#cdd6f4` → theme-aware `isDark ? "#cdd6f4" : "#1f2328"` (was invisible-in-ink on the now-light bg) |
| Diff / header / thinking / status colors | `MessageItem.tsx` | Theme-aware: `#4f3434/#2f4433` (dark) vs `#ffebe9/#e6ffec` (light) kept; hardcoded light `#fff3cd/#f8d7da/#e8f4fd` headers, `#f9f9f9` thinking box, `#856404/#721c24` status text now dark-theme-aware |
| Preview toolbar | `FilePreview.tsx` | `#333` border + dark `ToolBtn` → CSS variables |

## 29. Profile Chain Unification (2026-08-03)

### Problem

The CLI (`scripts/claude-profile.ts`) and GUI (`lib.rs` `switch_model_profile` / `set_default_profile`) wrote **different files** for the same concept, so a profile switched in one place wasn't honored by the other consumers.

### Solution

Unify the "profile chain" — every consumer reads the same set of files:

```
switch <profile> (project):                 default <profile> (user):
  .claude/profile.env            (launcher)    ~/.claude/profile.env         (launcher)
  .claude/settings.local.json env (engine)     ~/.claude/settings.json env   (engine)
  .claude/active-profile        (marker)       ~/.claude/.env.active         (marker)
  ~/.claude/.env.active         (marker)
```

- **`MANAGED_KEYS`** (18 keys) is the single source of truth in both TS and Rust. Both clear-then-rewrite settings env, so no stale profile values survive. (Adds `CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD`, which the old Rust list missed.)
- `set_default_profile` now writes the engine-consumed `~/.claude/settings.json` instead of the GUI appdata settings — which the engine never reads.
- `apply_active_profile` marker fallback: **project → user → first available**.
- Shared Rust helpers: `apply_profile_env_to_settings()`, `env_file_string()`, `user_claude_dir()`, `write_user_marker()`.
- `ProfileDialog`: custom + preset profiles can set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` per model (was hardcoded `1000000`).

## 30. Session Restore — Atomic Load + Guarded Auto-Scroll (2026-08-03, superseded §39)

Session restore used to stream in one `addMessage` per message, flickering through the whole history. Now it loads atomically:

- `chatStore.setMessages()` replaces the entire message array in **one** EventBus emit (sticky) and resets the streaming flag.
- `session_loaded` handler uses `setMessages` instead of a loop.
- `MessageList` is keyed by `sessionId` — switching sessions remounts the list (fresh bottom-follow state).
- **2026-08-07**: the render-window/freeze/auto-scroll machinery below was replaced by full virtual scrolling — see §39.

## 31. Ripgrep Distribution in Compiled Exe (2026-08-03)

`bun build --compile` doesn't embed `vendor/ripgrep/` — it's resolved at runtime, not imported. `getRipgrepConfig()` (`src/utils/ripgrep.ts`) now resolves in order:

```
{exe}/bin/rg.exe                 ← install's bin/ (the "tools" update component)
vendor/ripgrep/<arch>-win32/rg.exe  ← repo vendor copy
system rg (via findExecutable)   ← PATH hijack-safe
(last resort: vendor path → callers degrade to grep)
```

- `rg.exe` deliberately stays in `bin/`, **not** beside `claude.exe`, so the update system manages it as a component.
- `build.ts`: added `mkdirSync(dist/bin)` — `copyFileSync` was failing with a misleading `ENOENT`.

## 32. Edit History — gitCommit (2026-08-02)

`edit-history.jsonl` entries now record the **HEAD commit hash at edit time**:

- `getGitHeadHash(projectCwd)` reads `.git/HEAD` — resolves `ref: refs/heads/x` to the hash, or reads a detached HEAD directly.
- After a `git reset`, edits made on the old base are traceable by `gitCommit` without time-based analysis.
- `getEditHistoryPrompt` documents the flow: read tail → summarize → rollback by reversing diff → filter by `gitCommit` after a reset.

## 33. Window State Persistence (2026-08-02)

### Fields

`AppSettings` gains `windowX`/`windowY` (`Option<f64>`) and `windowMaximized` (`bool`). `save_window_size` becomes `save_window_state(width, height, x, y, maximized)`.

### Restore (Rust `setup()`)

```
non-maximized → set_position(x, y) → set_size(w, h)   // no flicker
maximized     → window.maximize()                      // OS manages position, skip
```

`save_app_settings` preserves all five fields from Rust `State<Mutex<AppSettings>>`, so JS snapshots carrying stale `null`s can't clobber them.

### Persist (App.tsx)

- Seeds JS memory with current `innerSize`/`outerPosition`/`isMaximized` on startup (guards `saveSettings()` writing null).
- Listens to `resize` **and** Tauri `onMoved`; both debounced 500ms → `save_window_state`.

## 34. Multi-Instance — One Workspace Per GUI Process (2026-08-03)

### Overview

The GUI supports running **multiple `claude-code-gui.exe` processes simultaneously**, each bound to one workspace. This lets the user work in several directories at once without refactoring the single-backend/singleton-store architecture. Each instance is a fully isolated process with its own backend, its own stores, and its own per-workspace DB — no shared in-process state.

```
user launches N instances (taskbar / Start menu / shortcuts)
  each instance ──startup──▶ workspace selector ──pick W──▶ bind_workspace(W)
   or  claude-code-gui.exe --workspace <path>  (shortcut/CLI, skips selector)
                                                              ├─ init <W>/.claude/data.db
                                                              ├─ register super-desktop MCP → <W>/.mcp.json (project scope, dynamic port)
                                                              └─ spawn claude.exe --ide-mode (cwd=W)
```

Bindings are **not persisted per instance** — a no-arg launch shows the selector and the user re-picks, unless `autoEnterRecentWorkspace` is on (§9), in which case it binds straight to `recentWorkspaces[0]`. `--workspace` is the deterministic path (shortcuts/scripts).

### Settings layering

Settings split into **global baseline** + **workspace overrides**, both stored inside Claude Code's own config files under a `gui` top-level key. The engine tolerates the unknown key (`SettingsSchema` outer `.passthrough()` at `src/utils/settings/types.ts:1072`).

| Layer | File | Contents |
|-------|------|----------|
| Global | `~/.claude/settings.json` → `"gui": {…}` | theme, language, fonts, server URLs, permission mode, known `workspaces` list, `recentWorkspaces` |
| Workspace | `<W>/.claude/settings.local.json` → `"gui": {…}` | layout tree, window state, auto-load session, `favoriteSessionIds` |

- Effective `AppSettings = merge(global gui, workspace gui)`, workspace wins.
- Writes are **read-modify-write** on the `gui` key — engine keys (`env`, `hooks`, `mcpServers`, …) in the same file are preserved.
- Legacy `%APPDATA%/claude-code-gui/settings.json` migrates once into `~/.claude/settings.json` → `gui`. The old single global `workDir` is no longer a binding source.
- Settings panel has a **scope toggle (全局 / 当前工作区)**; only the dirty fields (tracked per session) are written to the chosen scope file.
- **Save path (2026-08-06)**: `saveSettings` defaults to **workspace** — a workspace-scoped write while unbound is **skipped** (not fallen back to global), which stops the startup default layout from polluting the global `layoutTree`. Global-only callers (theme, language, wizard baseline) pass `"global"` explicitly.
- **「保存布局到全局」** (`saveLayoutToGlobal`, global setting): when on, the debounced layout save also mirrors `layoutTree` into the global baseline; a workspace without its own layout then falls back to it via the normal merge (workspace layout still wins when present).

### Backend lifecycle

- `bind_workspace(path)` (Rust command): sets the process-level binding (`BOUND_WORK_DIR` static + AppSettings state), inits `<W>/.claude/data.db`, registers super-desktop MCP into W's `settings.local.json` with the instance's dynamic port, spawns the backend, records W in global `recentWorkspaces`. Idempotent — returns the existing port if already bound to W with a running backend.
- **No pre-start for no-arg instances** — the selector's `bind_workspace` spawns the backend after the user picks.
- `get_ide_port` / `restart_ide_backend` / `ensure_db` resolve the workspace from the process-level binding (not a global workDir), so each instance stays on its own backend + DB.

### MCP per-instance

- `mcp.rs::start_mcp_server` binds the **first free port from 13920** (was a fixed port that panicked on conflict — the hard blocker for multi-instance).
- `register_super_desktop_mcp(work_dir)` writes the config into the **workspace's `<W>/.mcp.json`** (`mcpServers`, project scope) with the actual port. This is where the IDE backend actually reads MCP config (`getMcpConfigsByScope`) — writing to `settings.local.json` `mcpServers` was dead config and the AI never saw the tools (see `docs/agents` lesson). The stale global entry in `~/.claude/settings.json` is removed.
- Startup order: `start_mcp_server()` **first**, then `bind_workspace` writes the config, then the backend spawn reads it. Rust probes MCP readiness (`wait_for_mcp_ready`) before spawning the backend.

### Process isolation / cleanup

- Each instance's `BackendState` registers its backend PID immediately on spawn; on app exit `kill_backend` runs a blocking `taskkill /T` (see §5). Force-killing a GUI orphans its `claude.exe --ide-mode` backend, so the **update flow explicitly kills all instances + orphaned `--ide-mode` backends** before replacing files (§24). Terminal TUIs run `claude.exe` without `--ide-mode` and are never killed.
- The window title shows `Claude Code Desktop (Preview) — <workspace basename>` and the toolbar folder button becomes a workspace chip (basename, hover = full path) so multi-instance windows are distinguishable in the taskbar / Alt-Tab.

### Data isolation

- Desktops / plans live in `<W>/.claude/data.db` — already per-workspace (no change).
- Notes are user-level shared (`~/.claude/notes/notes.db`, WAL-safe).
- **Gotcha (2026-08-05)**: desktops are per-workspace in the DB, but the frontend loaded them at panel-mount while Rust `DbState.conn` still pointed at the *global* workDir — every instance showed the shared global desktops and re-saved them into its own workspace DB (desktop IDs collided across `data.db` files). Fixed by reloading on `BACKEND_PORT_READY` (§13).

### Startup timing — no global-workDir reads before bind (2026-08-05)

The global `gui.workDir` is a **single-instance-era leftover**: after multi-instance it is only a fallback default (empty-workspace candidate, file-tree root, CLI cwd), NOT the current workspace. Before a workspace is bound, reads must not treat it as one — previously every unbound instance at startup merged the global workDir *workspace's* overrides (favoriteSessionIds, layoutTree) and read its `data.db`, flashing another workspace's data before the real bind landed.

| Read | Before | After |
|------|--------|-------|
| `settings::load_settings()` / `get_app_settings` | merged global workDir's workspace | return the **pure global** baseline while `bound_work_dir()` is empty; `bind_workspace` flips to the bound workspace's effective merge |
| `desktopStore.loadDesktops()` | fetched at panel-mount (DB still global-workDir-bound) | no mount fetch; loads once on `BACKEND_PORT_READY` (sticky) after `bind_workspace` switches `DbState.conn` to `<W>/.claude/data.db` |
| Frontend settings | `loadSettings()` cached before bind | `reloadSettings()` re-fetches after `BackendService.bind()` resolves (§20) |
| Layout restore | App mount only — restored the pure-global baseline (no workspace layout) | `WORKSPACE_BOUND` (sticky) fires as soon as `bind_workspace` returns → `reloadSettings()` + `restoreLayout(bound layoutTree)`. Restores BEFORE the backend finishes booting, so the layout never waits on the slow port poll |

### Key Files

| File | Change |
|------|--------|
| `gui/src-tauri/src/lib.rs` | layered gui storage, migration, `bind_workspace`, `get_cli_workspace`, MCP config relocation, setup reorder |
| `gui/src-tauri/src/mcp.rs` | dynamic port |
| `gui/src/services/backendService.ts` | `bind()` method |
| `gui/src/stores/settingsStore.ts` | `saveSettings(patch, scope)` |
| `gui/src/components/chat/SettingsPanel.tsx` | scope toggle + dirty-field tracking |
| `gui/src/App.tsx` | selector → `bind_workspace`; skip selector on `--workspace` or `autoEnterRecentWorkspace` |
| `gui/src/stores/desktopStore.ts` | reload desktops from bound workspace DB on `BACKEND_PORT_READY` (§13) |

## 35. Installer — Dual-Mode Install + Environment Handling (2026-08-03)

### Overview

`installer/setup.iss` lets the user choose install mode at startup via a **Chinese mode dialog** (added to `installer/ChineseSimplified.isl`):

| Mode | Install dir (`{autopf}`) | Elevation | Env vars / PATH |
|------|--------------------------|-----------|-----------------|
| 为所有用户安装 | Program Files | admin (UAC) | SYSTEM (`HKLM\...\Session Manager\Environment`) |
| 仅为当前用户安装 | `%LOCALAPPDATA%\Programs` | **none** | USER (`HKCU\Environment`) |

Mechanism: `PrivilegesRequired=admin` + `PrivilegesRequiredOverridesAllowed=commandline dialog`. The dialog is shown before elevation — picking "当前用户" never triggers UAC, so non-admin users can install. `{autopf}` resolves to the right Program Files per mode automatically. `[Code]` branches on **`IsAdminInstallMode`** (not the deprecated `IsAdminLoggedOn`) to route `CLAUDE_CODE_HAHA_HOME`, `CLAUDE_CODE_GIT_BASH_PATH`, and PATH entries to HKLM vs HKCU.

### REG_EXPAND_SZ requirement

PATH and `CLAUDE_CODE_GIT_BASH_PATH` are written with **`RegWriteExpandStringValue`** (REG_EXPAND_SZ), never REG_SZ. The system PATH holds `%SystemRoot%` etc.; a REG_SZ rewrite would stop them expanding and break the whole PATH. `%CLAUDE_CODE_HAHA_HOME%` is stored **symbolically** and expands at process-env build time — the install dir can move without stale PATH entries.

### PATH migration

- **All-users install** removes legacy **user**-PATH `%CLAUDE_CODE_HAHA_HOME%` entries (older installs wrote to user PATH) so there is one home. Git Bash `usr\bin` is **prepended** so `bash` resolves to Git Bash over `C:\Windows\System32\bash.exe` (WSL launcher).
- **Uninstall** cleans both HKLM + HKCU PATH and env vars.

## 36. CLAUDE.md @-Reference Injection (2026-08-03)

Global `~/.claude/CLAUDE.md` supports `@file.md` references. The installer no longer pastes prose into CLAUDE.md — it bundles a standalone MD, copies it to `~/.claude/`, and injects a single `@name.md` line:

| Guide | Source (repo) | Bundled (build.ts) | Injected |
|-------|---------------|--------------------|----------|
| Python env | `extensions/python/python-env.md` | `dist/extensions/python/` | `@python-env.md` |
| Office COM bridge | `extensions/office/office-bridge.md` | `dist/extensions/office/` | `@office-bridge.md` |

Updating a guide = edit the source MD + reinstall; CLAUDE.md itself never changes. `InjectPythonNote` also **removes the legacy inline note text** on upgrade to avoid duplication. `scripts/build.ts` step 6 copies both MD files into `dist/extensions/` (this was missing for `office-bridge.md` — fresh installs never got the bridge guide).

## 37. Git Bash Priority — WSL Shadowing (2026-08-03)

### Symptom

The Bash tool on Windows used **WSL bash** instead of the bundled Git Bash.

### Root cause chain

```
CLAUDE_CODE_GIT_BASH_PATH stored as REG_SZ with literal %CLAUDE_CODE_HAHA_HOME%
  → findGitBashPath() checks via cmd `dir` (cmd expands %VAR%) → passes → returns literal path
  → process.env.SHELL = literal "%CLAUDE_CODE_HAHA_HOME%\..." path
  → Shell.ts isExecutable() (fs check, no expansion) → rejects SHELL
  → falls back to which('bash') → PATH → System32\bash.exe (WSL) wins
```

### Fix

- **`src/utils/windowsPaths.ts`**: `expandEnvVars()` resolves `%VAR%` in `findGitBashPath()` before returning, so `SHELL` is a real filesystem path `isExecutable` accepts — works even for legacy REG_SZ values.
- **Installer**: `CLAUDE_CODE_GIT_BASH_PATH` written as REG_EXPAND_SZ so the env value is the expanded path for fresh installs.
- Bash tool picks Git Bash because `Shell.ts` prioritizes `SHELL` when it's executable. General shell `bash` resolution is left as-is (user chose not to reorder system PATH).

## 38. GUI Robustness + Updater Component (2026-08-04)

Batch of fixes from a bug-hunting session; two commits (`c5da1c6` fix(gui), `c32f90c` fix).

### Duplicate chat / terminal entries

Stream retries/fallbacks re-emit the same `message_start` / `content_block_start`. Two dedup points:
- `terminalStore.startCommand` and `chatStore.addMessage` dedup by `toolUseId` / `message.id` (reuse existing entry instead of appending a second).
- `useChatBridge` `tool_progress` appends the **delta** `output`, not the cumulative `fullOutput` (which ballooned on multi-chunk bash progress).

### Streaming state granularity

`message_stop` fires **per API request** in a multi-tool turn — it must only clear the *message's* spinner, never the global turn-streaming, or the status bar shows "ready" between tools while the backend is busy. Global `chatState.streaming` is reset only by the authoritative turn-end signals: `result` and `status 'ready'` (and `status 'thinking'` sets it true). `interrupt` optimistically resets so a missed stop signal can't leave the UI stuck.

### Markdown overflow in message bubbles

`marked` output uses browser-default styles where `<pre>` has `white-space: pre` (no wrap). Added `.md-body` CSS (tokens.css) applied to the markdown container in `MessageItem`: `pre` wraps (`pre-wrap` + `break-all`), tables scroll horizontally, images cap at 100%, links break anywhere.

### Workspace display (multi-instance distinguishability)

- Window title → `Claude Code Desktop (Preview) — <basename>` (set dynamically on bind/switch; unchanged when no workspace). `workspaceBasename()` in `gui/src/utils/workspace.ts` handles trailing separators / root paths.
- Toolbar folder button → **icon + basename chip** (truncate `…`, hover shows full path, click opens the workspace selector).

### Settings persistence round-trip

Rust `AppSettings` **must mirror every frontend-saved field**. `quickPrompts` / `favoriteSkills` were missing, so any `load → save_global_settings` round-trip (e.g. `add_to_workspaces` on every bind) silently dropped them. Fixed by adding the fields; QuickPromptPanel/SkillsPanel now save only that field rather than the whole settings object.

### Update-available badge

`updateService.setUpdateAvailability()` + a sticky event drives a red dot on the toolbar update button; startup background check and the panel's manual check both feed it.

### Server-side

- `updates.py`: numeric version sort (`_version_key`) so `2026.08.03.10` beats `.9`; `VALID_COMPONENTS` accepts `updater`.
- `build.ts`: `updater` in `exeComponents` → manifest includes `updater.zip`.

### Deploy notes

- 96 release-platform runs a **registry image** (`image:`), not `build: .` — after changing `server/updates.py` you must `docker build` → `docker push 192.168.186.96:5000/claude-release-platform:latest` → `docker compose up -d` to recreate.
- Cloud (123.56.66.84) is only reachable via local SOCKS5 proxy `127.0.0.1:17891`; its compose uses `build: .` (`docker compose up -d --build`). For update uploads, SFTP zips to `/tmp` and `curl localhost:8765` on the host is more reliable than proxying the HTTP upload.

## 39. Message List — Full Virtual Scrolling (2026-08-07)

The chat message list is rewritten around `@tanstack/react-virtual` (dynamic-height measurement), replacing the old `PAGE_SIZE=20` render window + freeze/unfreeze machinery (`messageWindow.ts` was deleted).

### Design

- **All messages render virtually** — the store already holds every message (backend sends the full session), so there is no pagination and no "Load earlier" button. DOM stays bounded (viewport + `overscan: 8`), so very long sessions scroll smoothly.
- **Bottom-anchored growth**: new messages only append at the end. The visible top never shifts on its own — scrolling up just reveals older history (they're already in memory).
- **Single anchor**: a no-deps `useLayoutEffect` pins `scrollTop = scrollHeight` on every render while `followRef` is true. This covers initial load (lands on the newest message), streaming follow, and post-measure correction.
- **`initialOffset: () => Number.MAX_SAFE_INTEGER`** seeds the virtualizer at the bottom so the first frame renders the latest rows (no "top-flash" before jumping down).

### Follow / un-follow contract (`handleScroll`)

The old code only stopped following after scrolling >100px from the bottom, so streaming renders kept yanking the user back down (the "locked to bottom" bug). Now:

- **Any scroll-up immediately sets `followRef = false`** — the user is free to read history; new messages accumulate below without touching the viewport.
- **Returning to the true bottom (within 2px)** restores following.
- **Content-shrink guard**: a turn-end tool-output collapse shrinks `scrollHeight`, and the browser clamps `scrollTop` downward — that's NOT a user scroll-up, so it must not stop following. Only a `scrollTop` decrease while `scrollHeight` didn't shrink counts as a deliberate scroll-up (`prevScrollTopRef` / `prevScrollHeightRef`).

### Row measurement

- `estimateHeight()` gives a rough per-message height (`content` length + thinking + toolUses); `measureElement` + ResizeObserver correct it after render (streaming tool outputs grow → auto re-measure → total size updates → the follow pin re-arms).
- Row wrappers use `display:flex` so `MessageItem`'s `marginBottom` is measured (block margins would collapse out of the row and under-count height).
- `MessageItem` gained an `animateIn` prop — only the newest message fades in on mount, so scrolling history doesn't replay the `msg-fade-in` animation.

### Edge behavior

- Session switch remounts via `key={sessionId}` → `followRef` starts true → lands on the new session's bottom.
- In-place `session_loaded` (compaction) with the same `sessionId` keeps the current follow state; the virtualizer re-keys rows by message `id`.
- `jumpToBottom` button (floating) sets `followRef = true` and pins.

## 40. Layout Persistence — Default Workspace Is Normal + No Startup Clobber (2026-08-07)

Two layout-persistence bugs fixed together (released 2026.08.07.2/.4):

**Default workspace is a normal workspace.** The default workspace (`user_home/claude-code-workspace`) was special-cased: `save_effective_patch` dropped workspace-scoped writes when `bound_wd == default_work_dir()`, and `reload_effective_settings` skipped merging its overrides. Both special cases were removed — the default workspace persists its own `settings.local.json` like any other. `save_target_path()` (pure, unit-tested) decides the write target and returns `None` (drop) only for unbound workspace-scoped writes.

**No startup layout-clobber.** `save_app_settings` read `state.work_dir` as the "bound workspace", but at startup the state holds the GLOBAL workDir (`load_settings()` returns pure global before a real bind). A workspace-scoped save then wrote the startup DEFAULT layout into the global workDir's workspace file on every launch, clobbering its saved layout ("adjust layout, restart, it reverts"). `save_app_settings` and `save_window_state` now derive the target from the TRUE process binding (`bound_work_dir()`, empty until a real bind), so an unbound startup write is dropped instead of clobbering.

## 41. Layout Presets (2026-08-07)

Replaces the toolbar's "restore default layout" button with a preset picker (C variant: popover with preview thumbnails + confirm dialog).

- `LAYOUT_PRESETS` registry in layoutStore: `default` (`createDefaultTree`), `chat` (chat pair centered 78%, skills in the lower left column, right column cleared), `dense` (mirrors the claude-code-haha-dev layout: files+plan+skills left / editor+terminal+input center / chat right).
- `applyLayoutPreset(id)`: builds the tree via the preset factory, refreshes titles, clears floating panels, emits change events → persists via the normal workspace-scoped layout save. `resetLayout()` kept as an alias (tests use it).
- Toolbar `LayoutPresetDropdown`: popover lists presets with mini-diagram thumbnails; selecting one shows a confirm dialog before applying. Panels a preset omits are recoverable via the command palette / `activatePanel` (adds to the default group).

## 42. Tauri Sub-Window Lifecycle — Close Drops the Layout Entry (2026-08-07)

Opening a panel as a native Tauri sub-window pushes a `tauriWindows` entry (persisted in the layout tree). Closing the OS window tears down the webview, so the React unmount "goodbye" was unreliable — the entry stayed and the window was recreated on every restart. Fix:
- Rust `create_floating_window` attaches `win.on_window_event`; on `WindowEvent::Destroyed` it emits `"floating-window-closed"` (the window label) app-wide.
- The Hub (`bridge.ts` `startHub`) listens and calls `removeTauriWindow(label)` → `notifyTauriWindowsChange` → the debounced layout save persists the removal.
- The JS goodbye (React unmount) and the 15s heartbeat cleanup remain as fallbacks — all three converge on `removeTauriWindow`.

## 43. Command Palette — Recent-Usage Ordering + Settings Navigation (2026-08-07)

- `utils/recentUsage.ts`: localStorage-backed MRU per kind (`panel`/`command`/`session`); `recordRecent`/`getRecent`/`sortByRecent` (pure, tested).
- `useCommandPalette`: panels/commands/sessions sorted by recent usage and recorded on click; new `setting` kind opens the settings panel and navigates to a category via DataBus `settings.navigate` (SettingsPanel subscribes; retries because the floating settings window mounts asynchronously).
- Toolbar gains a command-palette (search) button; sub-windows wire the same palette.
