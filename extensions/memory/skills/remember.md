---
name: remember
description: Smart deposition — review recent conversation, search for related memories, merge or create, and build associations. No brute-force appending.
---

# /remember — Smart memory deposition

When the user invokes `/remember`, follow this pipeline. The goal is NOT to blindly create new
memories — it is to keep the knowledge base lean by merging with existing entries where possible.

## Pipeline

### 1. Review the recent conversation

Scan the last ~20 turns. Identify:

- **Key decisions** — what was chosen and why
- **Problems solved** — what was broken and how it was fixed
- **Mistakes / pitfalls** — what went wrong, what would prevent it next time
- **Facts discovered** — non-obvious knowledge (API quirks, tool behavior, config gotchas)

### 2. Search for related memories (multi-angle)

This is the MOST IMPORTANT step. For each candidate finding, run 2-3 searches with different
angles — don't just search for near-duplicates, but also for **thematically related** memories
that would benefit from being linked:

```
memory_search(query="<finding summary>", mode="hybrid", limit=5)
memory_search(query="<related angle 1>", mode="hybrid", limit=5)
memory_search(query="<related angle 2>", mode="hybrid", limit=5)
```

Separate results into three buckets:

- **MERGE target** (similarity ≥ 0.7 AND same scope/topic) → merge content instead of duplicating
- **ASSOCIATION target** (similarity 0.3–0.7 OR different scope but related topic) → link later in step 4
- **No match** → create fresh

### 3. Merge or create

**MERGE** (similarity ≥ 0.7, same scope):
```
memory_update(id=<id>, content=<merged content>)
```

- Append the new insight to existing content, or rewrite to combine both
- Bump `importance` by 0.1 if this finding reinforces the old memory (cap at 1.0)
- Update `tags` to include any new relevant tags

**CREATE** (no good merge target):
```
memory_store(
  type=<fact|experience|lesson>,
  title=<one-line summary>,
  content=<## Context\n...\n## Key points\n...>,
  scope=<global|domain:<name>|project:<name>>,
  tags=[...],
  importance=<0.5 default, 0.7+ for critical lessons>,
  associations=[...]   # include association targets from step 2
)
```

**Content format** for content field (Markdown):

```markdown
## Context
<when/where this was learned>

## Key points
- <bullet 1>
- <bullet 2>

## See also
[Rust async overview](memory://<id>)
```

Use `memory://<id>` links to reference related memories within the content body.

### 4. Build associations

After ALL memories are stored/updated, call `memory_associate` to link:

- **New/updated → association targets** from step 2: `type="related_to"`, weight=0.6–0.8
- **New/updated → merge source**: `type="derived_from"`, weight=0.7
- **Within same batch**: `type="related_to"`, weight=0.6
- **Contradictions**: `type="contradicts"`, weight=0.5 (and lower the contradicted memory's importance)

Only add associations when there's a **meaningful connection**. Don't force links just
to avoid "orphan" memories — a standalone memory is better than a bogus association.

### 5. Report

Summarize what was done:

| Action | Title | Type | Scope |
|--------|-------|------|-------|
| Created | ... | fact | domain:rust |
| Merged  | ... | experience | project:foo |
| Linked  | A → B | related_to | — |

## Scope selection rules

- `global` — applies to ANY project (e.g. "always read code before editing")
- `domain:<name>` — specific tech stack (e.g. `domain:rust`, `domain:docker`)
- `project:<name>` — only matters in current project
- When in doubt, go narrower (`project:`) — it's safer to miss a broad match than to pollute
