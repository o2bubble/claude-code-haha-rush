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

Run 2-3 searches with different angles — don't just search for near-duplicates, but also for
**thematically related** memories that would benefit from being linked:

```
memory_search(query="<finding summary>", mode="hybrid", limit=5)
memory_search(query="<related angle 1>", mode="hybrid", limit=5)
memory_search(query="<related angle 2>", mode="hybrid", limit=5)
```

Separate results into buckets:

- **ASSOCIATION target** (related topic) → link later in step 4
- **Likely duplicate/merge candidate** → note its id; the server re-detects it automatically
  in step 3 (you don't need to decide merge-vs-create here)
- **No match** → create fresh

Note: `mode="hybrid"` scores are RRF fusion scores (~0.01–0.03 scale) — use them for
ranking, not as absolute similarity thresholds.

### 3. Store with conflict resolution

Call `memory_store` with NO `action` — the server pre-checks for similar memories:

- `{status: "stored"}` → done, note the id.
- `{status: "conflict_detected", candidates: [...]}` → **nothing was persisted yet**.
  Inspect the candidates and re-call with an action:

| Situation | Action |
|-----------|--------|
| Genuinely new information | `action="store"` (create anyway) |
| Same fact, better/more current wording; old one superseded | `action="update", target_ids=[<id>]` |
| Complementary details on the same topic → one richer memory | `action="merge", target_ids=[ids], merged_content="<combined>"` |
| Candidate `exact: true` (identical content_hash) | `action="skip"` (unless rewriting via update) |

Judgment guide:
- **State-like** (preferences, rules, facts): same thing described again → merge or skip;
  explicitly outdated → update.
- **Event-like** (what happened): same event's stages/causes → merge into one narrative.
- After a merge, raise `importance` if the result is more complete than its parts
  (e.g. two 0.7 memories can become 0.8).

```
memory_store(
  type=<fact|experience|lesson>,
  title=<one-line summary>,
  content=<## Context\n...\n## Key points\n...>,
  scope=<global|domain:<name>|project:<name>>,
  tags=[...],
  importance=<0.5 default, 0.7+ for critical lessons>,
  associations=[...],  # include association targets from step 2
  source=<session id / where learned>   # optional provenance
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

**Quality gate:** content must be 10+ CJK chars (or 20+ chars total), max 8000 chars —
write complete sentences, not fragments.

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
