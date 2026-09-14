# Memory MCP — Agent Instruction

You have access to a **Memory MCP Server** that provides persistent, cross-session memory for your work. Unlike auto-memory (flat markdown files) or session memory (in-session compaction), this system offers BM25 full-text search (Chinese word segmentation + character bigrams), tag filtering, RRF-fused ranking, weighted associations between memories, and experience accumulation across sessions and machines.

## Core concepts

### Memory types

| Type | Purpose | Example |
|------|---------|---------|
| `fact` | Knowledge, facts, reference info | "The Inno Setup ISPP preprocessor has no `DayOfTheYear` function" |
| `experience` | A successful approach or solution that worked | "When ISPP is too limited, compute values externally in the build script and pass via `/D` flags" |
| `lesson` | A pitfall, mistake, or thing to avoid | "Don't forget to bump version numbers for ALL 3 IDE plugins, not just the one you edited" |

### Scope hierarchy

Memories are scoped to prevent information pollution across contexts:

```
global              — Universal methodology (e.g. "Always read code before editing")
domain:<name>       — Technology/domain specific (e.g. domain:rust, domain:react, domain:devops)
project:<name>      — Specific to one project (e.g. project:claude-code-haha)
```

**Rules for choosing scope:**
- If the memory applies to ANY project → `global`
- If it applies to a specific tech stack, but any project using it → `domain:<name>`
- If it only matters in the current project → `project:<name>`
- When in doubt, use `project:<name>` — it's safer to be too narrow than too broad

### Knowledge graph

Memories can be linked with **weighted edges** (0.0–1.0):

| Edge type | Meaning |
|-----------|---------|
| `related_to` | General connection between two memories |
| `derived_from` | This memory was learned from / inspired by another |
| `contradicts` | This memory contradicts another (superseded knowledge) |
| `supports` | This memory reinforces another with additional evidence |

These edges form a traversable graph — you can start from one memory and follow associations to discover related knowledge.

### Inline content references

Content supports referencing other memories with standard Markdown links. Use this to build narrative chains:

```markdown
See [the async runtime overview](memory://<memory-id>) for context.
This builds on [the original Docker setup](memory://<memory-id>).
```

When you `memory_get()` a memory, the content's Markdown links to other memories are preserved. This complements formal associations — use inline refs for narrative flow, `memory_associate` for machine-traversable graph edges. A well-linked memory has both: inline refs for human reading, graph edges for `memory_traverse()`.

**Auto-parsing**: `memory_store` automatically extracts `memory://<id>` links from content and stores them in a `content_refs` table. `memory_get` returns both `content_refs` (outgoing) and `referenced_by` (incoming), enabling bidirectional graph navigation and future web-based knowledge graph rendering.

## Tool reference

### memory_store — Save a memory (two-phase contract)

```
memory_store(type, title, content, scope?, tags?, importance?, associations?, source?,
             action?, target_ids?, merged_content?)
```

- `type`: `"fact"` | `"experience"` | `"lesson"`
- `title`: Short, descriptive (used in search results)
- `content`: Full Markdown content
- `scope`: Optional, defaults to `"global"`
- `tags`: List of tag strings (free-form, will be normalized later)
- `importance`: 0.0–1.0, defaults to 0.5. Set higher for critical lessons
- `associations`: `[{target_id, weight, type}]` — link to existing memories
- `source`: Optional provenance (session id / where this was learned)
- `action` / `target_ids` / `merged_content`: used to resolve a conflict (below)

**Two-phase flow (IMPORTANT):**

1. Call WITHOUT `action`. The server pre-checks for similar memories:
   - No similar memory → `{status: "stored", id}` — done.
   - Similar found → `{status: "conflict_detected", candidates: [...]}` and **nothing is
     persisted**. Each candidate has `id/title/type/scope/score/content_hash/exact/snippet`.
2. Decide and re-call with an `action`:
   - `action="store"` — create anyway (new information)
   - `action="update"` + `target_ids=[id]` — overwrite that memory (corrections, same fact)
   - `action="merge"` + `target_ids=[ids]` + `merged_content` — combine complementary
     memories into one; targets are marked superseded (hidden from search, still auditable)
   - `action="skip"` — nothing was worth persisting

**Judgment guide:** state-like info (preferences, rules, facts) describing the same thing →
usually merge; no new information → skip; explicitly outdated → update. An `exact: true`
candidate (identical content_hash) is almost always skip or merge.

**Quality gate:** content needs 10+ CJK chars (or 20+ chars total), max 8000 chars; junk is
rejected with a closed reason enum (`empty_content` / `too_short` / `too_long` / `noise`).

**When to call:**
- After solving a problem → `type="experience"`, with tags for the domain
- After encountering a surprising fact → `type="fact"`
- After making a mistake or encountering a gotcha → `type="lesson"`, importance ≥ 0.7
- After discovering how something works → `type="fact"`

### memory_update — Modify an existing memory

```
memory_update(id, title?, content?, type?, scope?, tags?, importance?)
```

- `id`: Memory ID (UUID) to update
- `title` / `content` / `type` / `scope` / `importance`: New values (omit to keep current)
- `tags`: Replace ALL tags with this list (omit to keep current)

**When to call:**
- Merging new knowledge into an existing memory (instead of creating a duplicate)
- Correcting outdated or inaccurate information
- Bumping importance after a memory proves valuable again

### memory_search — Find relevant memories

```
memory_search(query, mode?, scope?, type?, tags?, limit?, min_similarity?)
```

- `query`: Natural language, describe what you're looking for
- `mode`: `"hybrid"` (default, BM25 + tags fused via RRF) | `"keyword"` (BM25 only) |
  `"tag"` (tag filter only) | `"semantic"` (**not available** — no embedding provider;
  returns an explicit message instead of results)
- `scope`: Filter by scopes (list). Exact match by default: `["project:claude-code-haha",
  "domain:devops"]`. A trailing `*` matches by prefix — `["project:*"]` returns memories from
  every project scope, `["domain:*"]` every domain. Prefixes can be mixed with exact values.
- `type`: Filter by memory type, e.g. `["lesson"]` to find only pitfalls
- `tags`: In tag/hybrid mode, require ALL these tags
- `limit`: Default 10, max 50
- `min_similarity`: Default 0.3; applies to single-channel scores only (RRF-fused scores
  are on a different scale)

**Return shape:** `{results: [...], total, strategy, message}`. `strategy` reports which
retrieval path actually ran (`hybrid` / `fts` / `tag` / `like` / `none`) — check it when
results look off. Each result has `match_type` (`fts`/`tag`/`both`), a `score` (ranking
hint), and `content_hash` (SHA256 of title+content) — compare hashes to skip re-reading
unchanged memories and save tokens.

**Retrieval advice:** start with `hybrid`. If empty, rephrase with synonyms / distinctive
terms (search is keyword-based — Chinese queries match sub-words and character bigrams, so
shorter distinctive terms work well). At most ~3 search attempts per turn, then proceed.

**When to call:**
- BEFORE starting any non-trivial task → search for related experiences and lessons
- When you're about to touch a specific domain → filter by scope
- When debugging → search for `type="lesson"` related to the error pattern
- Proactively — it's better to find out "we tried this before and it failed" before coding

### memory_get — Read full memory + associations

```
memory_get(id)
```

Returns full content, tags, all associated memories (both directions), `content_refs`
(outgoing `memory://` links) and `referenced_by` (incoming links). Increments the memory's
`access_count`, which drives the "most accessed" ordering in the web UI — it does not change
`importance`.

**When to call:**
- After `memory_search` returns something interesting → get full details
- Before following an association chain → get the complete context
- To check what a memory is connected to before adding new associations

### memory_associate — Link two memories

```
memory_associate(source_id, target_id, weight?, type?, bidirectional?)
```

**When to call:**
- After storing a new memory that is clearly derived from an existing one → `derived_from`
- When two memories describe complementary aspects of the same topic → `related_to`, weight ≥ 0.7
- When a new lesson contradicts old knowledge → `contradicts` (also consider updating the old memory's importance down)

### memory_traverse — Explore the graph

```
memory_traverse(start_id, max_depth?, min_weight?, direction?)
```

BFS traversal following association edges. Returns connected subgraph (nodes + edges).

**When to call:**
- When you want to understand all knowledge related to a topic
- After finding a key memory → traverse to discover the full neighborhood
- `max_depth=1` for direct neighbors, `max_depth=2` or `3` for broader exploration

### memory_tags — Browse available tags

```
memory_tags(scope?)
```

**When to call:**
- Before a tag-based search → discover what tags exist
- Periodically → check if tag vocabulary is drifting (then run `memory_normalize_tags`)

### memory_forget — Remove a memory

```
memory_forget(id, confirm=True, hard?)
```

Default is a **soft delete** (`deleted_at` set): hidden from search/traverse but still
readable via `memory_get` for auditing. Pass `hard=true` to physically delete (also
cascades associations). Prefer a soft delete unless the content is actively harmful.

**When to call:**
- Memory is objectively wrong or dangerously misleading
- Memory has been superseded (store the superseding memory first, then associate with `contradicts`)

### memory_stats — System overview

```
memory_stats()
```

Returns counts by type/scope, tags, associations, DB size, and `capabilities`
(`{fts, jieba, tags, like_fallback, embedding}`) — capabilities tells you which retrieval
channels are actually available (e.g. if `fts` is false, search degraded to LIKE).

### memory_normalize_tags — Clean up tags

```
memory_normalize_tags(mapping, dry_run?)
```

Applies a tag normalization mapping provided by the caller (LLM-driven). **No** server-side embedding clustering — the caller first reads all tags via `memory_tags`, determines which are semantically similar, and passes a `{old_tag: canonical_tag}` dict. Use `dry_run=true` to preview without applying changes.

**When to call:**
- After adding many new tags (every ~50 memories)
- When `memory_tags` shows obviously duplicate tags
- Call `memory_tags()` first, analyze duplicates as the LLM, build a mapping, then call with `dry_run=true` to preview

## Workflow patterns

### Before starting a task
```
1. memory_search(query="<task description>", scope=["project:<current>", "domain:<relevant>"])
2. If results found: memory_get() on the most relevant ones
3. If a memory has associations: memory_traverse(start_id, max_depth=1) to find related knowledge
```

### During a task (recording discoveries)
```
# Mid-task fact
memory_store(type="fact", title="...", content="...", scope="project:<name>", tags=[...])

# If you get {status: "conflict_detected", candidates}, decide and re-call:
#   same fact, better wording → action="update", target_ids=[<id>]
#   complementary details      → action="merge", target_ids=[...], merged_content="..."
#   genuinely new              → action="store"
#   nothing new                → action="skip"

# Note: don't wait until the end — store facts as you discover them
```

### After completing a task
```
# Record the solution
memory_store(type="experience", title="How to ...", content="## Problem\n...\n## Solution\n...", 
             scope="domain:<name>", tags=[...])
             
# Link to related memories
memory_associate(source_id="<new_id>", target_id="<related_id>", type="derived_from")
```

### After making a mistake
```
# Record the lesson (importance ≥ 0.7 for critical pitfalls)
memory_store(type="lesson", title="Don't ...", content="## The mistake\n...\n## The fix\n...", 
             importance=0.8, scope="domain:<name>", tags=[...])
```

### Periodic maintenance
```
# Every ~50 memories, or when tags feel messy
tags = memory_tags()
# As the LLM, analyze the tag list for semantic duplicates
# e.g. "rust-lang" → "rust", "Rust" → "rust", "ai" → "artificial-intelligence"
mapping = {"rust-lang": "rust", "Rust": "rust", "ai": "artificial-intelligence"}
memory_normalize_tags(mapping=mapping, dry_run=True)  # preview first
memory_normalize_tags(mapping=mapping)                 # apply if correct
```

## Anti-patterns

- **Too granular**: Don't store "the foo function takes 3 parameters" — that's what code search is for. Store "the foo module has a non-obvious initialization requirement".
- **Too vague**: Don't store "there were some issues with the build" — describe what went wrong and how to fix it.
- **Forced associations**: A memory with no genuinely related neighbours is fine as a standalone entry — a bogus edge is worse than no edge, because `memory_traverse` will surface it as if it were relevant. Link when there's a real relationship, not to avoid "orphans".
- **Wrong scope**: A universal truth about Docker stored as `project:claude-code-haha` won't be found when working on other projects.
- **Skipping the pre-task search**: The most valuable memories are the ones that PREVENT you from repeating mistakes. Search first.
- **Over-normalizing**: Don't `memory_normalize_tags` after every single `memory_store`. It's a batch operation for periodic cleanup.

## /remember skill

When the user invokes `/remember` (or asks you to remember something), follow this process:

1. **Review** the recent conversation — identify key decisions, problems solved, mistakes made, and insights discovered.
2. **Search** existing memories for related content (`memory_search`) to avoid duplicates and find association targets.
3. **Extract** each distinct piece of knowledge into one memory:
   - One clear title
   - Detailed content (Markdown: what, why, how)
   - Appropriate type and scope
   - Relevant tags
4. **Resolve conflicts** — if `memory_store` returns `conflict_detected`, apply the
   appropriate action (store/update/merge/skip) as described above. This is the
   primary deduplication mechanism — use it, don't blindly re-store.
5. **Associate** new memories with existing ones where there's a clear relationship.
6. **Summarize** what was stored, so the user can verify.

## Example transcript

**User**: I need to set up Docker healthchecks for a Python service.

**Agent**: (internal: search first)
```
memory_search(query="Docker healthcheck Python service", scope=["domain:devops", "global"])
```

**Agent**: I found a related experience: "Docker HEALTHCHECK for Python containers" (domain:devops). 
The key point: always use `python -c` instead of `curl` for slim Python images where curl isn't installed.

Following the stored approach, I'll add:
```dockerfile
HEALTHCHECK --interval=30s --start-period=10s \
  CMD python -c "..." || exit 1
```

**[After the task]**

**Agent**: (stores the specific implementation)
```
memory_store(
  type="experience", 
  title="Docker HEALTHCHECK with Python for FastAPI services",
  content="## Context\n...\n## Implementation\n...",
  scope="domain:devops",
  tags=["docker", "healthcheck", "fastapi", "python"],
  associations=[{target_id="<previous-memory-id>", weight=0.8, type="derived_from"}]
)
```
