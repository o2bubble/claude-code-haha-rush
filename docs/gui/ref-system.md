# @ref System — Reference Link System

The `@ref{...}` syntax is the GUI's universal resource locator. Users send references to specific resources, and the GUI renders them as clickable links. AI can also emit `@ref{...}` in responses, and the GUI will render them as actionable links for the user.

## Syntax

```
@ref{<type>:<path>[:<range>][|<label>]}
```

| Part | Required | Description |
|------|----------|-------------|
| `type` | Yes | One of: `file`, `dir`, `line`, `panel`, `session`, `paste`, `desktop`, `desktop-item`, `note` |
| `path` | Yes | Resource path (file path, panel ID, session ID, etc.) |
| `range` | No | For `file`/`line`: `:42` (single line) or `:10-20` (range) |
| `label` | No | Display text (after `\|`), defaults to basename |

## Reference Types

### file — Open a file

```
@ref{file:/path/to/file.ts}
@ref{file:/path/to/file.ts:42}
@ref{file:/path/to/file.ts:10-20}
@ref{file:/path/to/file.ts|Click here}
```

**Action**: Opens the file in the editor panel (Monaco for text, FilePreview for images/PDF/SVG). If a line number is specified, the editor jumps to that line.

### dir — Navigate to directory

```
@ref{dir:/path/to/folder}
@ref{dir:/path/to/folder|Open folder}
```

**Action**: Shows a status message with the directory path. (File tree auto-navigation not yet implemented.)

### line — Open file at specific line

```
@ref{line:/path/to/file.ts:42}
@ref{line:/path/to/file.ts:101-150|Function body}
```

**Action**: Same as `file` with line numbers. The distinction is semantic.

### panel — Activate a panel

```
@ref{panel:editor}
@ref{panel:terminal}
@ref{panel:plan}
@ref{panel:files}
@ref{panel:super-desktop}
@ref{panel:sessions}
@ref{panel:skills}
@ref{panel:workers}
@ref{panel:subagents}
@ref{panel:settings}
```

**Action**: Expands the panel group if hidden, activates the target tab within it.

### session — Switch conversation session

```
@ref{session:<session-id>}
@ref{session:abc123|Yesterday's chat}
```

**Action**: Switches to the specified session in the chat panel.

### paste — Display inline paste content

```
@ref{paste:/tmp/pasted-content.txt}
```

**Action**: Initially shows as a clickable link. Click to expand and view the full content inline. Click again to collapse.

### desktop — Open Super Desktop

```
@ref{desktop:<desktop-id>}
@ref{desktop:default}
```

**Action**: Activates the Super Desktop panel and switches to the specified desktop tab.

### desktop-item — Focus a specific desktop item

```
@ref{desktop-item:text/<uuid>}
@ref{desktop-item:chart/<uuid>|Sales chart}
@ref{desktop-item:form/<uuid>}
```

**When user sends this**: Call `desktop_get_items` MCP tool to read the block content, then act on it. Pass the item's raw id (the part **after** the leading `<type>/` — the item id is a bare UUID with no `/`). The tool also tolerates the full `type/<uuid>` form (it strips the leading type segment automatically), so either works.

**Action**: Activates the Super Desktop panel, focuses and pans to the target item (blue glow animation 3s pulse). The item UUID comes from `desktop_get_items` MCP tool output.

Content types in path: `text`, `table`, `chart`, `graphic`, `ref`, `filegroup`, `image`, `form`, `drawing`.

**To read/write desktop items**: See `~/.claude/gui-agent-guide.md` — MCP tools section for full API (15 tools: create, update, delete, move, resize, connect, undo/redo, etc.).

### note — Open a note in the Notes panel

```
@ref{note:<note-id>}
@ref{note:abc123|Rust ownership notes}
```

**When user sends this**: Call `note_get` MCP tool with the ID to read the full note content.

**Action**: Activates the Notes panel and loads the specified note. The note ID comes from `note_list` or `note_create` MCP tool output.

**To read/write notes**: Use the `note_*` MCP tools (9 tools: create, update, delete, get, list, search, associate, tags, normalize_tags). Notes are user-level and shared across workspaces. **Read/write notes ONLY through these MCP tools — never open the notes database file directly** (the GUI holds it open).

## How AI Can Use @ref

### In responses to user

When your message contains `@ref{...}` text, the GUI automatically parses and renders it as a clickable link. Use this to:

- **Point to files**: `"The fix is in @ref{file:src/utils/auth.ts:142|the auth handler}"`
- **Open panels**: `"Check @ref{panel:plan} for the current task list"`
- **Show desktop items**: `"I've updated @ref{desktop-item:text/abc123|the summary block}"`
- **Link notes**: `"See @ref{note:abc123|Rust ownership notes} for details"`
- **Share sessions**: `"See @ref{session:xyz789|yesterday's analysis} for context"`

### When user sends @ref

When a user sends a message containing `@ref{file:src/main.ts}`, the link appears in their message bubble. AI should:

1. Parse the reference from the user's text
2. Use `Read` tool to get file content
3. Use `desktop_get_items` MCP tool to read desktop item content
4. Act on the referenced resource

## Implementation

| File | Role |
|------|------|
| `gui/src/utils/referenceParser.ts` | `parseReferences(text)` → `ParsedReference[]`, `formatReference(ref)` → string |
| `gui/src/types/reference.ts` | `Reference`, `ParsedReference`, `ReferenceType` type definitions |
| `gui/src/services/referenceActions.ts` | `openReference(ref)` — executes the action for each type |
| `gui/src/components/chat/ReferenceLink.tsx` | Clickable chip rendering in message bubbles |

## Encoding Notes

- `:` `|` `}` in paste paths are percent-encoded (`%3A`, `%7C`, `%7D`)
- Labels are free-text after the last `|` in the ref body
- Unknown types are silently skipped by the parser
