---
name: memory-status
description: Show memory system health — total counts, type/scope breakdown, tag hygiene, and normalization suggestions.
---

# /memory-status — Memory system overview

Check the current state of the memory system. Use periodically to understand what knowledge has
accumulated and whether maintenance is needed.

## Pipeline

### 1. Get stats

```
memory_stats()
```

Parse the output. Note especially:
- **Total memories** — is the knowledge base growing?
- **By type** — balance of facts vs experiences vs lessons
- **By scope** — which projects/domains dominate?

### 2. Get tag overview

```
memory_tags()
```

Look for tag hygiene issues:
- **Duplicate tags**: semantically identical but spelled differently (e.g. "rust" and "rust-lang")
- **Stray tags**: tags used only once — consider if the memory should use a broader tag instead
- **Missing tags**: important memories with no tags at all

### 3. Recommend actions

Present a summary table:

| Metric | Value |
|--------|-------|
| Total memories | N |
| Facts / Experiences / Lessons | N / N / N |
| Scopes | N |
| Tags | N |
| Associations | N (content refs: N) |
| DB size | X KB |

If you notice tags that look like duplicates, suggest:

> Tags look a bit messy — want me to normalize them? I'll figure out which are duplicates.

If the system is nearly empty (< 10 memories):

> Memory system is still small. Consider using `/remember` after completing tasks to build it up.

### 4. Follow-up

If user says yes to normalization, the agent should:

1. Call `memory_tags()` to get all tags
2. Analyze the tag list for semantic duplicates (e.g. "rust" vs "rust-lang" vs "Rust")
3. Build a mapping dict: `{"old_tag": "canonical_tag", ...}`
4. Preview: `memory_normalize_tags(mapping={...}, dry_run=true)`
5. If correct, apply: `memory_normalize_tags(mapping={...})`
