---
name: recall
description: Search memory before starting work — find relevant facts, experiences, and lessons to avoid repeating mistakes.
---

# /recall — Pre-task memory search

Search memory BEFORE starting any non-trivial work. Do NOT skip this step — the whole point
of `/recall` is to inform your approach with past knowledge, not to just acknowledge memories
after the fact.

## Pipeline

### 1. Search FIRST, then work

Before you write a single line of code or run a single command:

1. Understand the task — extract 2-3 key search terms
2. Run 2-3 searches with different angles (step 2)
3. Expand relevant hits (step 3)
4. **Only then** decide your approach based on what you found

If you skip the search and dive straight into the work, `/recall` is useless.

### 2. Multi-angle search

Run 2-3 searches with different queries to maximize coverage:

```
memory_search(query="<angle 1>", mode="hybrid", scope=["project:<current>", "domain:<relevant>"], limit=5)
memory_search(query="<angle 2>", mode="hybrid", limit=5)
```

For debugging tasks, also search specifically for lessons:

```
memory_search(query="<error keyword>", mode="hybrid", type=["lesson"], limit=5)
```

### 3. Expand the most relevant hits

For each result with similarity ≥ 0.4:

```
memory_get(id=<id>)
```

Read the full content. If the memory has `content_refs` or `referenced_by`, note them —
these are directly relevant linked memories.

**Optimization**: search results include `content_hash`. If you already have this memory's
content in your current context from a prior `memory_get`, compare hashes — skip re-reading
if they match to save tokens.

### 4. Leverage the knowledge graph

If you find a highly relevant memory, traverse its neighborhood:

```
memory_traverse(start_id=<id>, max_depth=1, min_weight=0.5)
```

This reveals related memories that may not have scored high on the initial search.

### 5. Use findings to guide your work

The purpose of `/recall` is to let past experience inform your decisions. When you find
relevant memories:

- **Lessons**: prefer the documented fix or workaround — it's a proven starting point.
  But memories can be outdated; if the stored approach no longer works, adapt and later
  update the memory via `/remember`.
- **Experiences**: use the proven approach as your default, but adjust for the current context.
- **Facts**: apply the stored knowledge, but verify if it seems stale.

Start by briefly telling the user what you found, then proceed with your approach informed
by those memories. Don't ignore them — but don't follow them blindly either.

If no relevant approach is found, say so — then proceed as normal.

## Example

```
User: I need to update the VSIX packaging for all 3 IDE plugins.

Agent:
→ memory_search("VSIX packaging IDE plugins", scope=["project:claude-code-haha"])
→ memory_search("Visual Studio VSIX build", type=["lesson"])
→ Found: "VS VSIX webview flat structure" (similarity 0.82) —
  webview files are flat under media/webview/ unlike source tree
→ memory_traverse(start_id=<that>)
→ Found linked: "Inno Setup ISPP limitations" — compute dates externally

Agent response:
"Found 2 relevant memories about VSIX packaging. The webview uses a flat structure
under media/webview/, and ISPP can't compute dates — I'll compute them externally
and pass via /D flags. I'll use these as my starting point."

Then proceeds to DO the task, guided by those memories.
```
