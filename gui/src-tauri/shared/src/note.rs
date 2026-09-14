//! Notes — user-level (not workspace-scoped) note store shared between the GUI
//! and the server daemon. The GUI and server both read/write the same
//! `~/.claude/notes/notes.db`; the server owns writes so it can broadcast
//! `db_changed{entity:"note"}` to every GUI for cross-GUI sync.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::tokenizer;

// ─── Data models ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub scope: String,
    pub tags: Vec<String>,
    pub associations: Vec<NoteAssoc>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteAssoc {
    pub id: String,
    pub title: String,
    pub r#type: String,
    pub weight: f64,
    pub direction: String, // "outgoing" | "incoming"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub scope: String,
    pub tags: Vec<String>,
    pub snippet: String,
    pub updated_at: String,
    /// Relevance hint. Present only on search results (BM25-normalized for the
    /// FTS channel; the legacy weighted score for LIKE). Ranking is done in SQL
    /// — this is informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    /// Which retrieval path actually ran: "fts" or "like". Reported explicitly
    /// so a degradation is visible rather than silently different.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagCount {
    pub name: String,
    pub count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteInput {
    pub title: String,
    pub content: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Two-phase create. Absent = pre-check phase: the server looks for similar
    /// notes and returns `conflict_detected` WITHOUT persisting. Present =
    /// decision phase: "store" (create anyway) | "update" | "merge" | "skip".
    #[serde(default)]
    pub action: Option<String>,
    /// Target note ids for update/merge (required for both).
    #[serde(default)]
    pub target_ids: Option<Vec<String>>,
    /// Content used for update/merge; defaults to `content`.
    #[serde(default)]
    pub merged_content: Option<String>,
}

/// A near-duplicate surfaced by the pre-check phase.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteConflictCandidate {
    pub id: String,
    pub title: String,
    pub scope: String,
    pub score: f64,
    /// First 120 chars of content, for the caller to judge against.
    pub snippet: String,
    /// True when title and content match the candidate exactly.
    pub exact: bool,
}

/// Outcome of `note_create`.
///
/// `Stored`/`Updated`/`Merged` flatten their `Note` so the JSON carries both
/// `status` and the note fields at the top level — a client written against the
/// old `Note`-only return shape can still read `.id` and friends.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NoteCreateResult {
    Stored {
        #[serde(flatten)]
        note: Note,
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback_reason: Option<String>,
    },
    ConflictDetected {
        candidates: Vec<NoteConflictCandidate>,
        message: String,
    },
    Updated {
        #[serde(flatten)]
        note: Note,
    },
    Merged {
        #[serde(flatten)]
        note: Note,
        merged_ids: Vec<String>,
    },
    Skipped {
        message: String,
    },
    Rejected {
        reason: String,
        message: String,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteUpdate {
    pub title: Option<String>,
    pub content: Option<String>,
    pub scope: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteAssocInput {
    pub source_id: String,
    pub target_id: String,
    #[serde(default = "default_weight")]
    pub weight: f64,
    #[serde(default = "default_assoc_type")]
    pub r#type: String,
}

fn default_scope() -> String { "global".into() }
fn default_weight() -> f64 { 0.5 }
fn default_assoc_type() -> String { "related_to".into() }

// ─── DB path and connection ───

/// User-level notes DB. Overridable via `CLAUDE_GUI_NOTES_DB` so tests can point
/// at an isolated temp file instead of the real `~/.claude/notes/notes.db`.
pub fn notes_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("CLAUDE_GUI_NOTES_DB") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = dirs_next().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("notes").join("notes.db")
}

pub fn open_notes_db() -> Result<Connection, String> {
    let path = notes_db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("open: {}", e))?;

    // The GUI opens a fresh connection per command while the server daemon holds
    // a long-lived one, both writing this file. Without a busy timeout the
    // second writer fails immediately with SQLITE_BUSY.
    let _ = conn.execute_batch("PRAGMA busy_timeout = 30000");

    // WAL is a persistent database property, so it only needs to be set once by
    // whichever opener gets there first. Checking before setting matters:
    // `PRAGMA journal_mode` does NOT honor busy_timeout — it returns SQLITE_BUSY
    // instantly when a peer holds the write lock, so this must tolerate failure
    // rather than retry or abort.
    if let Ok(mode) = conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)) {
        if !mode.eq_ignore_ascii_case("wal") {
            let _ = conn.execute_batch("PRAGMA journal_mode = WAL");
        }
    }

    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            scope TEXT NOT NULL DEFAULT 'global',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        );
        CREATE TABLE IF NOT EXISTS note_tags (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (note_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS note_associations (
            source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            target_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            weight REAL NOT NULL DEFAULT 0.5,
            type TEXT NOT NULL DEFAULT 'related_to'
                CHECK (type IN ('related_to','derived_from','contradicts','supports')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (source_id, target_id, type)
        );
        CREATE TABLE IF NOT EXISTS note_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        PRAGMA foreign_keys = ON;
        "
    ).map_err(|e| format!("schema: {}", e))?;
    ensure_fts(conn);
    Ok(())
}

// ─── FTS5 index ─────────────────────────────────────────────────────────────
//
// Tokenized text lives here; display text always comes from the `notes` JOIN.
// FTS5 availability is recorded in note_meta rather than assumed — see
// `fts_enabled()`.

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM note_meta WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO note_meta (key, value) VALUES (?1, ?2)",
        [key, value],
    );
}

/// True when the FTS index exists and was not deliberately disabled.
pub fn fts_enabled(conn: &Connection) -> bool {
    meta_get(conn, "fts_enabled").as_deref() == Some("1")
}

/// Create the FTS table and keep it in sync with `notes` whenever the tokenizer
/// or the index state says a rebuild is due.
///
/// There is no schema-version table in this project; the established idiom is an
/// idempotent guarded step run on every open. A rebuild is cheap (milliseconds
/// for hundreds of notes) so re-running it is harmless — the guards exist to
/// avoid doing it on every single open, not for correctness.
fn ensure_fts(conn: &Connection) {
    let created = conn
        .execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
                 note_id UNINDEXED,
                 title_tokens,
                 content_tokens,
                 tags_tokens
             );",
        )
        .is_ok();
    if !created {
        // SQLite built without FTS5 (or the table is otherwise unusable).
        // Record it so callers stop probing and fall back to LIKE.
        log::warn!("note FTS5 unavailable — search falls back to LIKE");
        meta_set(conn, "fts_enabled", "0");
        return;
    }

    // An explicit "0" means FTS was disabled on purpose; do not resurrect it by
    // rebuilding. Checked before the flag is (re)set below.
    if meta_get(conn, "fts_enabled").as_deref() == Some("0") {
        return;
    }
    meta_set(conn, "fts_enabled", "1");

    let status = tokenizer::tokenizer_status();
    let indexed: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_fts", [], |r| r.get(0))
        .unwrap_or(0);
    let notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap_or(0);

    let engine_changed = meta_get(conn, "tokenizer").as_deref() != Some(status);
    let missing_rows = indexed == 0 && notes > 0;

    if engine_changed || missing_rows {
        match rebuild_fts(conn) {
            Ok(n) if n > 0 => log::info!("rebuilt note FTS index: {} note(s)", n),
            Ok(_) => {}
            Err(e) => log::warn!("note FTS rebuild failed: {}", e),
        }
    }
    meta_set(conn, "tokenizer", status);
}

/// Rewrite the whole index from `notes`. Returns the number of notes indexed.
pub fn rebuild_fts(conn: &Connection) -> Result<u32, String> {
    if !fts_enabled(conn) {
        return Ok(0);
    }
    let mut stmt = conn
        .prepare("SELECT id, title, content FROM notes")
        .map_err(|e| format!("rebuild prep: {}", e))?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("rebuild query: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let _ = conn.execute("DELETE FROM note_fts", []);
    for (id, title, content) in &rows {
        let tags = load_tags(conn, id).unwrap_or_default();
        let _ = fts_upsert(conn, id, title, content, &tags);
    }
    Ok(rows.len() as u32)
}

/// Replace this note's index row.
///
/// DELETE-then-INSERT rather than UPDATE: FTS5's UPDATE path is equivalent but
/// more convoluted, and the row is always rewritten wholesale anyway.
fn fts_upsert(
    conn: &Connection,
    id: &str,
    title: &str,
    content: &str,
    tags: &[String],
) -> Result<(), String> {
    if !fts_enabled(conn) {
        return Ok(());
    }
    conn.execute("DELETE FROM note_fts WHERE note_id = ?1", [id])
        .map_err(|e| format!("fts del: {}", e))?;
    conn.execute(
        "INSERT INTO note_fts (note_id, title_tokens, content_tokens, tags_tokens)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            id,
            tokenizer::tokenize_for_index(title),
            tokenizer::tokenize_for_index(content),
            tokenizer::tokenize_for_index(&tags.join(" ")),
        ],
    )
    .map_err(|e| format!("fts ins: {}", e))?;
    Ok(())
}

fn fts_delete(conn: &Connection, id: &str) -> Result<(), String> {
    if !fts_enabled(conn) {
        return Ok(());
    }
    conn.execute("DELETE FROM note_fts WHERE note_id = ?1", [id])
        .map_err(|e| format!("fts del: {}", e))?;
    Ok(())
}

fn dirs_next() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    { std::env::var("USERPROFILE").ok().map(PathBuf::from) }
    #[cfg(not(target_os = "windows"))]
    { std::env::var("HOME").ok().map(PathBuf::from) }
}

// ─── Tag helpers ───

fn get_tag_id(conn: &Connection, name: &str) -> Result<i64, String> {
    let canonical = name.to_lowercase().trim().to_string();
    if canonical.is_empty() { return Err("empty tag".into()); }
    conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", params![canonical])
        .map_err(|e| format!("tag insert: {}", e))?;
    conn.query_row("SELECT id FROM tags WHERE name = ?1", params![canonical], |r| r.get(0))
        .map_err(|e| format!("tag select: {}", e))
}

fn set_note_tags(conn: &Connection, note_id: &str, tags: &[String]) -> Result<(), String> {
    conn.execute("DELETE FROM note_tags WHERE note_id = ?1", params![note_id])
        .map_err(|e| format!("tag delete: {}", e))?;
    for t in tags {
        let tid = get_tag_id(conn, t)?;
        conn.execute("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)", params![note_id, tid])
            .map_err(|e| format!("tag link: {}", e))?;
    }
    Ok(())
}

fn load_tags(conn: &Connection, note_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t JOIN note_tags nt ON t.id = nt.tag_id WHERE nt.note_id = ?1 ORDER BY t.name"
    ).map_err(|e| format!("tags load: {}", e))?;
    let tags: Vec<String> = stmt.query_map(params![note_id], |r| r.get(0))
        .map_err(|e| format!("tags map: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

fn load_associations(conn: &Connection, note_id: &str) -> Result<Vec<NoteAssoc>, String> {
    let mut stmt = conn.prepare(
        "SELECT a.source_id, a.target_id, a.type, a.weight, n.id, n.title
         FROM note_associations a
         JOIN notes n ON (CASE WHEN a.source_id = ?1 THEN a.target_id ELSE a.source_id END) = n.id
         WHERE a.source_id = ?1 OR a.target_id = ?1"
    ).map_err(|e| format!("assoc load: {}", e))?;
    let assocs: Vec<NoteAssoc> = stmt.query_map(params![note_id], |r| {
        Ok((
            r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?,
            r.get::<_,f64>(3)?, r.get::<_,String>(4)?, r.get::<_,String>(5)?,
        ))
    }).map_err(|e| format!("assoc map: {}", e))?
    .filter_map(|r| r.ok())
    .map(|(src, _tgt, tp, wt, nid, ntitle)| {
        let direction = if src == note_id { "outgoing" } else { "incoming" };
        NoteAssoc { id: nid, title: ntitle, r#type: tp, weight: wt, direction: direction.into() }
    })
    .collect();
    Ok(assocs)
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let d = secs / 86400;
    let rem = secs % 86400;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        1970 + d / 365,
        ((d % 365) / 30 + 1).min(12).max(1),
        (d % 30 + 1).min(31).max(1),
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60)
}

// ─── CRUD (all take `&Connection`; caller owns the DB) ───

/// Insert a note and index it. No duplicate checking — the caller decides
/// whether to pre-check first (see `note_create`).
fn insert_note(conn: &Connection, input: &NoteInput) -> Result<Note, String> {
    let id = uuid_v4();
    let now = now_iso();
    conn.execute(
        "INSERT INTO notes (id, title, content, scope, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, input.title, input.content, input.scope, now, now],
    ).map_err(|e| format!("create: {}", e))?;
    set_note_tags(conn, &id, &input.tags)?;
    // Indexing failure only loses recall for this note, never correctness —
    // the next `ensure_fts` rebuild heals it. Log rather than fail the write.
    if let Err(e) = fts_upsert(conn, &id, &input.title, &input.content, &input.tags) {
        log::warn!("note FTS upsert failed for {}: {}", id, e);
    }
    Ok(Note {
        id, title: input.title.clone(), content: input.content.clone(), scope: input.scope.clone(),
        tags: input.tags.clone(), associations: vec![], created_at: now.clone(), updated_at: now,
    })
}

/// Create a note under a two-phase duplicate-check contract.
///
/// Without `action`, similar notes are looked up first and — if any are found —
/// the call returns `ConflictDetected` having persisted NOTHING. The caller then
/// re-invokes with an explicit `action`. This keeps deduplication a decision the
/// calling agent makes (a passive MCP server has no LLM of its own), while the
/// server still enforces that nothing is written until that decision is made.
pub fn note_create(conn: &Connection, input: &NoteInput) -> Result<NoteCreateResult, String> {
    let action = input.action.as_deref();

    if let Some(a) = action {
        if !matches!(a, "store" | "update" | "merge" | "skip") {
            return Ok(NoteCreateResult::Rejected {
                reason: "invalid_action".into(),
                message: format!(
                    "action must be one of store|update|merge|skip, got: {:?}", a
                ),
            });
        }
    }

    match action {
        Some("skip") => {
            return Ok(NoteCreateResult::Skipped {
                message: "nothing was persisted".into(),
            })
        }
        Some("update") => return apply_update(conn, input),
        Some("merge") => return apply_merge(conn, input),
        Some("store") => {
            let note = insert_note(conn, input)?;
            return Ok(NoteCreateResult::Stored { note, fallback_reason: None });
        }
        _ => {}
    }

    // ── pre-check phase ──
    let candidates = find_conflicts(conn, &input.title, &input.content);
    if !candidates.is_empty() {
        return Ok(NoteCreateResult::ConflictDetected {
            candidates,
            message: "Similar notes found; nothing was persisted. Re-call note_create with \
                      action=store (create anyway), update or merge (+target_ids, +merged_content), \
                      or skip. Ignoring this response also leaves the note unstored."
                .into(),
        });
    }
    let note = insert_note(conn, input)?;
    Ok(NoteCreateResult::Stored { note, fallback_reason: None })
}

/// Similar notes for the pre-check phase.
///
/// Failure posture: return no candidates rather than an error — a broken index
/// must never block a write (duplicates are recoverable, lost notes are not).
fn find_conflicts(conn: &Connection, title: &str, content: &str) -> Vec<NoteConflictCandidate> {
    let probe: String = format!("{} {}", title, content).chars().take(200).collect();
    let fts_q = crate::tokenizer::build_fts_query(&probe);
    if fts_q.is_empty() {
        return vec![];
    }
    // Scope is deliberately unset: the same knowledge filed under project:x and
    // global is one of the most common sources of duplicates.
    let hits = match search_fts(conn, &fts_q, None, 5) {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    // Small corpora have unreliable absolute BM25 scores (IDF collapses toward
    // zero as N shrinks), so a threshold would discard valid hits. Accept
    // everything until there are enough notes for the scores to mean something.
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap_or(0);
    let exempt = total <= 20;

    hits.into_iter()
        .filter(|h| exempt || h.score.unwrap_or(0.0) >= 0.3)
        .map(|h| {
            let full = note_get(conn, &h.id).ok();
            let exact = full
                .as_ref()
                .map(|n| n.title == title && n.content == content)
                .unwrap_or(false);
            NoteConflictCandidate {
                id: h.id,
                title: h.title,
                scope: h.scope,
                score: h.score.unwrap_or(0.0),
                snippet: h.snippet.chars().take(120).collect(),
                exact,
            }
        })
        .collect()
}

fn apply_update(conn: &Connection, input: &NoteInput) -> Result<NoteCreateResult, String> {
    let targets = input.target_ids.as_deref().unwrap_or(&[]);
    if targets.is_empty() {
        return Ok(NoteCreateResult::Rejected {
            reason: "target_not_found".into(),
            message: "update requires target_ids".into(),
        });
    }
    let tid = &targets[0];
    if note_get(conn, tid).is_err() {
        return Ok(NoteCreateResult::Rejected {
            reason: "target_not_found".into(),
            message: format!("missing or nonexistent target_ids: [{}]", tid),
        });
    }
    let content = input.merged_content.clone().unwrap_or_else(|| input.content.clone());
    let note = note_update(conn, tid, &NoteUpdate {
        title: Some(input.title.clone()),
        content: Some(content),
        scope: None,
        tags: if input.tags.is_empty() { None } else { Some(input.tags.clone()) },
    })?;
    Ok(NoteCreateResult::Updated { note })
}

/// Fold the targets into `target_ids[0]`, then delete the rest.
///
/// Notes have no `superseded_by` column and the UI has no "retired" concept, so
/// unlike the memory store's merge this keeps one note and removes the others.
/// Association edges are re-pointed at the survivor BEFORE the victims are
/// deleted, so no relationship is lost.
fn apply_merge(conn: &Connection, input: &NoteInput) -> Result<NoteCreateResult, String> {
    let targets = input.target_ids.as_deref().unwrap_or(&[]);
    if targets.is_empty() {
        return Ok(NoteCreateResult::Rejected {
            reason: "target_not_found".into(),
            message: "merge requires target_ids".into(),
        });
    }
    // Every target must exist — silently dropping a typo'd id would merge fewer
    // notes than the caller asked for.
    let missing: Vec<&String> = targets.iter().filter(|t| note_get(conn, t).is_err()).collect();
    if !missing.is_empty() {
        return Ok(NoteCreateResult::Rejected {
            reason: "target_not_found".into(),
            message: format!("missing or nonexistent target_ids: {:?}", missing),
        });
    }

    let carrier = targets[0].clone();
    let victims: Vec<String> = targets[1..].to_vec();
    let content = input.merged_content.clone().unwrap_or_else(|| input.content.clone());

    // Merge is the only path that deletes data, so it runs in one transaction —
    // a half-applied merge would leave edges pointing at deleted notes.
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| format!("merge begin: {}", e))?;
    let result = (|| -> Result<(), String> {
        // Tags: union across all targets when the caller supplied none.
        let tags = if input.tags.is_empty() {
            let mut all: Vec<String> = Vec::new();
            for t in targets {
                if let Ok(n) = note_get(conn, t) {
                    for tag in n.tags {
                        if !all.contains(&tag) {
                            all.push(tag);
                        }
                    }
                }
            }
            all
        } else {
            input.tags.clone()
        };
        note_update(conn, &carrier, &NoteUpdate {
            title: Some(input.title.clone()),
            content: Some(content),
            scope: None,
            tags: if tags.is_empty() { None } else { Some(tags) },
        })?;

        for victim in &victims {
            // Re-point outgoing edges, skipping the self-loop case.
            conn.execute(
                "INSERT OR IGNORE INTO note_associations (source_id, target_id, weight, type)
                 SELECT ?1, target_id, weight, type FROM note_associations
                 WHERE source_id = ?2 AND target_id != ?1",
                params![carrier, victim],
            ).map_err(|e| format!("merge out-edges: {}", e))?;
            // Re-point incoming edges, likewise.
            conn.execute(
                "INSERT OR IGNORE INTO note_associations (source_id, target_id, weight, type)
                 SELECT source_id, ?1, weight, type FROM note_associations
                 WHERE target_id = ?2 AND source_id != ?1",
                params![carrier, victim],
            ).map_err(|e| format!("merge in-edges: {}", e))?;
            // ON DELETE CASCADE clears the victim's remaining edges and tags.
            conn.execute("DELETE FROM notes WHERE id = ?1", params![victim])
                .map_err(|e| format!("merge delete: {}", e))?;
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute("COMMIT", [])
                .map_err(|e| format!("merge commit: {}", e))?;
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            return Err(e);
        }
    }

    let _ = fts_delete(conn, &carrier);
    let note = note_get(conn, &carrier)?;
    if let Err(e) = fts_upsert(conn, &note.id, &note.title, &note.content, &note.tags) {
        log::warn!("note FTS upsert failed for {}: {}", note.id, e);
    }
    for v in &victims {
        let _ = fts_delete(conn, v);
    }
    Ok(NoteCreateResult::Merged { note, merged_ids: victims })
}

pub fn note_update(conn: &Connection, id: &str, input: &NoteUpdate) -> Result<Note, String> {
    let now = now_iso();
    if let Some(ref title) = input.title {
        conn.execute("UPDATE notes SET title=?1, updated_at=?2 WHERE id=?3", params![title, now, id])
            .map_err(|e| format!("update title: {}", e))?;
    }
    if let Some(ref content) = input.content {
        conn.execute("UPDATE notes SET content=?1, updated_at=?2 WHERE id=?3", params![content, now, id])
            .map_err(|e| format!("update content: {}", e))?;
    }
    if let Some(ref scope) = input.scope {
        conn.execute("UPDATE notes SET scope=?1, updated_at=?2 WHERE id=?3", params![scope, now, id])
            .map_err(|e| format!("update scope: {}", e))?;
    }
    if let Some(ref tags) = input.tags {
        set_note_tags(conn, id, tags)?;
        conn.execute("UPDATE notes SET updated_at=?1 WHERE id=?2", params![now, id])
            .map_err(|e| format!("update ts: {}", e))?;
    }
    // The FTS row is replaced wholesale, so ANY field change — including a
    // title-only edit — must re-index from the current row. Read it back rather
    // than reusing `input`, which holds only the fields that were provided.
    let updated = note_get(conn, id)?;
    if let Err(e) = fts_upsert(conn, id, &updated.title, &updated.content, &updated.tags) {
        log::warn!("note FTS upsert failed for {}: {}", id, e);
    }
    Ok(updated)
}

pub fn note_delete(conn: &Connection, id: &str) -> Result<bool, String> {
    let n = conn.execute("DELETE FROM notes WHERE id=?1", params![id])
        .map_err(|e| format!("delete: {}", e))?;
    if n > 0 {
        // An orphaned FTS row would keep matching searches; the JOIN in
        // search_fts would filter it out, but leaving it wastes the index.
        if let Err(e) = fts_delete(conn, id) {
            log::warn!("note FTS delete failed for {}: {}", id, e);
        }
    }
    Ok(n > 0)
}

pub fn note_get(conn: &Connection, id: &str) -> Result<Note, String> {
    let result = conn.query_row(
        "SELECT id, title, content, scope, created_at, updated_at FROM notes WHERE id=?1",
        params![id],
        |r| Ok((r.get::<_,String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
    ).map_err(|e| format!("get: {}", e))?;
    let tags = load_tags(conn, id)?;
    let associations = load_associations(conn, id)?;
    Ok(Note {
        id: result.0, title: result.1, content: result.2, scope: result.3,
        tags, associations,
        created_at: result.4, updated_at: result.5,
    })
}

pub fn note_list(conn: &Connection, scope: Option<&str>, tag: Option<&str>, limit: Option<u32>) -> Result<Vec<NoteSummary>, String> {
    let limit = limit.unwrap_or(50).min(200);
    let (where_clause, params_vec): (String, Vec<String>) = {
        let mut clauses = vec![];
        let mut vals = vec![];
        if let Some(ref s) = scope {
            if s.ends_with('*') {
                clauses.push(format!("n.scope LIKE ?{}", vals.len() + 1));
                vals.push(s.replace('*', "%"));
            } else {
                clauses.push(format!("n.scope = ?{}", vals.len() + 1));
                vals.push(s.to_string());
            }
        }
        if let Some(ref t) = tag {
            clauses.push(format!("EXISTS (SELECT 1 FROM note_tags nt2 JOIN tags t2 ON nt2.tag_id=t2.id WHERE nt2.note_id=n.id AND t2.name=?{})", vals.len() + 1));
            vals.push(t.to_lowercase());
        }
        let wc = if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) };
        (wc, vals)
    };

    let sql = format!(
        "SELECT n.id, n.title, n.scope, SUBSTR(n.content, 1, 140), n.updated_at FROM notes n {} ORDER BY n.updated_at DESC LIMIT {}",
        where_clause, limit
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("list prep: {}", e))?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
    let summaries: Vec<NoteSummary> = stmt.query_map(params_refs.as_slice(), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    }).map_err(|e| format!("list map: {}", e))?
    .filter_map(|r| r.ok())
    .map(|(id, title, scope, snippet, updated_at)| {
        let tags = load_tags(conn, &id).unwrap_or_default();
        let snippet = snippet.replace('\n', " ").trim().to_string();
        NoteSummary { id, title, scope, tags, snippet, updated_at, score: None, strategy: None }
    })
    .collect();
    Ok(summaries)
}

pub fn note_search(conn: &Connection, query: &str, scope: Option<&str>, limit: Option<u32>) -> Result<Vec<NoteSummary>, String> {
    let limit = limit.unwrap_or(20).min(100);
    let fts_q = tokenizer::build_fts_query(query);
    if fts_q.is_empty() {
        // Nothing indexable (all stop-words / punctuation) — an empty MATCH is
        // a syntax error, so this is "no query", not "no results".
        return Ok(vec![]);
    }
    match search_fts(conn, &fts_q, scope, limit) {
        Ok(v) => Ok(v),
        Err(e) => {
            log::warn!("note FTS search failed, falling back to LIKE: {}", e);
            search_like(conn, query, scope, limit)
        }
    }
}

/// Rows a scope filter contributes, shared by both search channels.
/// Returns `(sql_fragment, value)`; `fragment` is None when no scope was given.
fn scope_clause(scope: Option<&str>) -> (Option<String>, Option<String>) {
    match scope {
        Some(s) if s.ends_with('*') => (Some("n.scope LIKE ?".into()), Some(s.replace('*', "%"))),
        Some(s) => (Some("n.scope = ?".into()), Some(s.to_string())),
        None => (None, None),
    }
}

/// FTS5 channel — BM25 ranking over the tokenized index.
///
/// Returns Err only when the index is unusable (disabled, or SQL failed), never
/// merely because nothing matched: an empty hit set from a working index is a
/// real answer, and silently re-running the query as LIKE would mask tokenizer
/// bugs and resurface stop-word matches.
fn search_fts(conn: &Connection, fts_q: &str, scope: Option<&str>, limit: u32) -> Result<Vec<NoteSummary>, String> {
    if !fts_enabled(conn) {
        return Err("fts disabled".into());
    }
    let (scope_sql, scope_val) = scope_clause(scope);
    let mut where_parts = vec!["note_fts MATCH ?1".to_string()];
    if let Some(ref frag) = scope_sql {
        where_parts.push(frag.replace("n.scope", "n.scope"));
    }
    // bm25() weights follow column order: (note_id, title_tokens, content_tokens,
    // tags_tokens). note_id is UNINDEXED so its weight slot must be present but
    // is inert.
    let sql = format!(
        "SELECT n.id, n.title, n.scope, n.content, n.updated_at,
                bm25(note_fts, 0.0, 10.0, 1.0, 6.0) AS rank
         FROM note_fts
         JOIN notes n ON n.id = note_fts.note_id
         WHERE {}
         ORDER BY rank, n.updated_at DESC
         LIMIT ?2",
        where_parts.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("fts prep: {}", e))?;
    let mut params_vec: Vec<&dyn rusqlite::types::ToSql> = vec![&fts_q];
    if let Some(ref v) = scope_val {
        params_vec.push(v);
    }
    params_vec.push(&limit);

    let rows: Vec<(String, String, String, String, String, f64)> = stmt
        .query_map(params_vec.as_slice(), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|e| format!("fts query: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows
        .into_iter()
        .map(|(id, title, scope, content, updated_at, rank)| {
            let tags = load_tags(conn, &id).unwrap_or_default();
            let relevance = -rank; // bm25() is negative; more negative = better
            let score = if relevance > 0.0 { relevance / (1.0 + relevance) } else { 0.0 };
            let snippet = content.replace('\n', " ").trim().chars().take(140).collect::<String>();
            NoteSummary { id, title, scope, tags, snippet, updated_at, score: Some(score), strategy: Some("fts".into()) }
        })
        .collect())
}

/// LIKE channel — the pre-FTS implementation, kept as the degradation path when
/// FTS5 is unavailable (SQLite without FTS5, or `fts_enabled = '0'`).
fn search_like(conn: &Connection, query: &str, scope: Option<&str>, limit: u32) -> Result<Vec<NoteSummary>, String> {
    // 按空白拆词；空查询或全空词 → 空结果（搜索需要至少一个词）
    let terms: Vec<&str> = query.split_whitespace().collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }

    // ── SQL 粗筛：scope 叠加(AND) + 任一词命中 title / content / tag 即进候选(OR) ──
    let mut conds: Vec<String> = Vec::new();
    let mut params_vec: Vec<String> = Vec::new();
    if let Some(ref s) = scope {
        if s.ends_with('*') {
            conds.push("n.scope LIKE ?".to_string() + &(params_vec.len() + 1).to_string());
            params_vec.push(s.replace('*', "%"));
        } else {
            conds.push("n.scope = ?".to_string() + &(params_vec.len() + 1).to_string());
            params_vec.push(s.to_string());
        }
    }
    let term_groups: Vec<String> = terms.iter().map(|term| {
        let like = format!("%{}%", term);
        let t = format!("n.title LIKE ?{}", params_vec.len() + 1); params_vec.push(like.clone());
        let c = format!("n.content LIKE ?{}", params_vec.len() + 1); params_vec.push(like.clone());
        let g = format!("EXISTS (SELECT 1 FROM note_tags nt JOIN tags tg ON nt.tag_id = tg.id WHERE nt.note_id = n.id AND tg.name LIKE ?{})", params_vec.len() + 1); params_vec.push(like);
        format!("({} OR {} OR {})", t, c, g)
    }).collect();
    let mut where_sql = String::new();
    if !conds.is_empty() || !term_groups.is_empty() {
        let mut all: Vec<String> = conds;
        if !term_groups.is_empty() {
            all.push(format!("({})", term_groups.join(" OR ")));
        }
        where_sql = format!("WHERE {}", all.join(" AND "));
    }

    let sql = format!(
        "SELECT n.id, n.title, n.scope, n.content, n.updated_at FROM notes n {}",
        where_sql
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("search prep: {}", e))?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();

    let mut candidates: Vec<(f64, NoteSummary)> = stmt.query_map(params_refs.as_slice(), |r| {
        Ok((
            r.get::<_, String>(0)?,  // id
            r.get::<_, String>(1)?,  // title
            r.get::<_, String>(2)?,  // scope
            r.get::<_, String>(3)?,  // content
            r.get::<_, String>(4)?,  // updated_at
        ))
    }).map_err(|e| format!("search map: {}", e))?
    .filter_map(|r| r.ok())
    .map(|(id, title, scope, content, updated_at)| {
        let tags = load_tags(conn, &id).unwrap_or_default();
        let score = score_note(&terms, &title, &content, &tags);
        let snippet = content.replace('\n', " ").trim().chars().take(140).collect::<String>();
        (score, NoteSummary { id, title, scope, tags, snippet, updated_at, score: None, strategy: Some("like".into()) })
    })
    .collect();

    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
        .then(b.1.updated_at.cmp(&a.1.updated_at)));
    Ok(candidates.into_iter().take(limit as usize).map(|(_, s)| s).collect())
}

/// Edge types whose meaning does not depend on direction ("A relates to B" ==
/// "B relates to A"). For these, storing the swapped pair as well is pure
/// duplication: `load_associations` already matches either endpoint, so a mirror
/// row makes the relation render twice. `derived_from` is excluded — there the
/// direction carries meaning.
pub const SYMMETRIC_ASSOC_TYPES: &[&str] = &["related_to", "contradicts", "supports"];

pub fn note_associate(conn: &Connection, input: &NoteAssocInput) -> Result<bool, String> {
    conn.execute(
        "INSERT OR REPLACE INTO note_associations (source_id, target_id, weight, type) VALUES (?1,?2,?3,?4)",
        params![input.source_id, input.target_id, input.weight, input.r#type],
    ).map_err(|e| format!("associate: {}", e))?;
    if SYMMETRIC_ASSOC_TYPES.contains(&input.r#type.as_str()) {
        // Drop a pre-existing mirror edge: an agent that calls associate(A,B)
        // then associate(B,A) would otherwise create two rows that both match at
        // either endpoint and render as a duplicate.
        conn.execute(
            "DELETE FROM note_associations WHERE source_id=?1 AND target_id=?2 AND type=?3",
            params![input.target_id, input.source_id, input.r#type],
        ).map_err(|e| format!("associate dedup: {}", e))?;
    }
    Ok(true)
}

pub fn note_disassociate(conn: &Connection, source_id: &str, target_id: &str) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM note_associations WHERE (source_id=?1 AND target_id=?2) OR (source_id=?2 AND target_id=?1)",
        params![source_id, target_id],
    ).map_err(|e| format!("disassociate: {}", e))?;
    Ok(true)
}

pub fn note_tags(conn: &Connection, scope: Option<&str>) -> Result<Vec<TagCount>, String> {
    let sql = if let Some(ref s) = scope {
        format!(
            "SELECT t.name, COUNT(DISTINCT nt.note_id) AS count FROM tags t
             JOIN note_tags nt ON t.id = nt.tag_id
             JOIN notes n ON nt.note_id = n.id
             WHERE n.scope = '{}'
             GROUP BY t.name ORDER BY count DESC",
            s.replace('\'', "''")
        )
    } else {
        "SELECT t.name, COUNT(DISTINCT nt.note_id) AS count FROM tags t
         JOIN note_tags nt ON t.id = nt.tag_id
         GROUP BY t.name ORDER BY count DESC".into()
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("tags prep: {}", e))?;
    let tags: Vec<TagCount> = stmt.query_map([], |r| {
        Ok(TagCount { name: r.get(0)?, count: r.get(1)? })
    }).map_err(|e| format!("tags map: {}", e))?
    .filter_map(|r| r.ok())
    .collect();
    Ok(tags)
}

pub fn note_get_all_tag_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare("SELECT name FROM tags ORDER BY name")
        .map_err(|e| format!("all tags: {}", e))?;
    let tags: Vec<String> = stmt.query_map([], |r| r.get(0))
        .map_err(|e| format!("all tags map: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

pub fn note_apply_tag_mapping(conn: &Connection, mappings: &HashMap<String, String>) -> Result<Vec<TagCount>, String> {
    for (old, canonical) in mappings {
        if old == canonical { continue; }
        let old_lower = old.to_lowercase();
        let new_lower = canonical.to_lowercase();
        // Get or create new tag
        let new_id = get_tag_id(conn, &new_lower)?;
        // Find all notes with old tag, replace
        conn.execute(
            "INSERT OR REPLACE INTO note_tags (note_id, tag_id)
             SELECT nt.note_id, ?1 FROM note_tags nt JOIN tags t ON nt.tag_id = t.id WHERE t.name = ?2",
            params![new_id, old_lower]
        ).map_err(|e| format!("tag map insert: {}", e))?;
        conn.execute("DELETE FROM note_tags WHERE tag_id = (SELECT id FROM tags WHERE name = ?1)", params![old_lower])
            .map_err(|e| format!("tag map delete: {}", e))?;
    }
    // Clean orphan tags
    conn.execute("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)", [])
        .map_err(|e| format!("tag cleanup: {}", e))?;
    // Renamed tags change the indexed tag tokens. Tag normalization is a rare
    // batch operation, so a full rebuild is simpler than tracking which notes
    // were touched — and it cannot miss one.
    if let Err(e) = rebuild_fts(conn) {
        log::warn!("note FTS rebuild after tag mapping failed: {}", e);
    }
    note_tags(conn, None)
}

fn uuid_v4() -> String {
    let r: Vec<u8> = (0..16).map(|_| rand_byte()).collect();
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15])
}

fn rand_byte() -> u8 {
    // Simple xorshift
    static mut STATE: u64 = 0;
    let s = unsafe {
        if STATE == 0 {
            STATE = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64;
        }
        let mut x = STATE;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        STATE = x;
        x
    };
    (s & 0xFF) as u8
}

// ─── 搜索权重算分（纯函数，可单测）───

fn is_complete_hit(title_lower: &str, term_lower: &str) -> bool {
    title_lower == term_lower || title_lower.starts_with(term_lower)
}

/// 计算一篇笔记对给定关键词集合的加权总分。
pub fn score_note(terms: &[&str], title: &str, content: &str, tags: &[String]) -> f64 {
    if terms.is_empty() {
        return 0.0;
    }
    let title_lower = title.to_lowercase();
    let content_lower = content.to_lowercase();
    let tags_lower: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();

    let mut score = 0.0;
    for term in terms {
        let term_lower = term.to_lowercase();
        if term_lower.is_empty() {
            continue;
        }
        if is_complete_hit(&title_lower, &term_lower) {
            score += 3.0;
        } else if title_lower.contains(&term_lower) {
            score += 2.0;
        }
        if tags_lower.iter().any(|t| t.contains(&term_lower)) {
            score += 2.0;
        }
        if content_lower.contains(&term_lower) {
            score += 1.0;
        }
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_title_beats_partial_beats_tag_beats_content() {
        assert!(score_note(&["登录"], "登录模块", "", &[]) > score_note(&["登录"], "用户登录页", "", &[]));
        assert_eq!(score_note(&["登录"], "用户登录页", "", &[]), 2.0);
        assert_eq!(score_note(&["登录"], "x", "abc", &[String::from("登录")]), 2.0);
        assert_eq!(score_note(&["登录"], "x", "登录正文", &[]), 1.0);
        assert!(score_note(&["登录"], "x", "abc", &[String::from("登录")]) > score_note(&["登录"], "x", "登录正文", &[]));
    }

    #[test]
    fn title_equal_or_starts_with_counts_as_complete() {
        assert_eq!(score_note(&["登录"], "登录", "", &[]), 3.0);
        assert_eq!(score_note(&["登录"], "登录模块", "", &[]), 3.0);
        assert_eq!(score_note(&["登录"], "用户登录页", "", &[]), 2.0);
    }

    #[test]
    fn multi_term_scores_accumulate() {
        let both = score_note(&["登录", "重构"], "登录重构", "", &[]);
        let one = score_note(&["登录", "重构"], "登录", "", &[]);
        assert!(both > one);
        assert_eq!(score_note(&["登录", "重构"], "登录重构", "", &[]), 5.0);
        assert_eq!(score_note(&["登录", "重构"], "x", "登录重构", &[]), 2.0);
    }

    #[test]
    fn dimensions_accumulate_within_one_term() {
        assert_eq!(score_note(&["登录"], "登录", "正文提到登录", &[]), 4.0);
        assert_eq!(score_note(&["登录"], "用户登录页", "登录正文", &[String::from("登录")]), 5.0);
    }

    #[test]
    fn no_match_returns_zero_and_case_insensitive() {
        assert_eq!(score_note(&["登录"], "标题", "正文", &[]), 0.0);
        assert_eq!(score_note(&["login"], "Login模块", "", &[]), 3.0);
        assert_eq!(score_note(&["Login"], "login模块", "", &[]), 3.0);
    }

    #[test]
    fn empty_terms_or_empty_term_ignored() {
        assert_eq!(score_note(&[], "任何", "", &[]), 0.0);
        assert_eq!(score_note(&["", "登录"], "登录", "", &[]), 3.0);
    }

    #[test]
    fn note_crud_on_memory_db() {
        let conn = open_notes_db_memory();
        let n = create_forced(&conn, &new_note("hello", "world"));
        assert_eq!(note_get(&conn, &n.id).unwrap().title, "hello");
        assert_eq!(note_get(&conn, &n.id).unwrap().tags.len(), 2);
        assert_eq!(note_list(&conn, None, None, Some(10)).unwrap().len(), 1);
        assert_eq!(note_search(&conn, "hello", None, None).unwrap().len(), 1);
        assert_eq!(note_tags(&conn, None).unwrap().iter().find(|t| t.name == "a").unwrap().count, 1);
        assert!(note_delete(&conn, &n.id).unwrap());
    }

    fn new_note(title: &str, content: &str) -> NoteInput {
        NoteInput {
            title: title.into(), content: content.into(),
            scope: "global".into(), tags: vec!["a".into(), "b".into()],
            action: None, target_ids: None, merged_content: None,
        }
    }

    /// Most tests care about the created note, not the phase bookkeeping.
    /// Asserts the store phase succeeded and unwraps it.
    fn create(conn: &Connection, input: &NoteInput) -> Note {
        match note_create(conn, input).unwrap() {
            NoteCreateResult::Stored { note, .. } => note,
            other => panic!("expected Stored, got {:?}", other),
        }
    }

    /// Bypasses the pre-check so setup code can create similar notes on purpose.
    fn create_forced(conn: &Connection, input: &NoteInput) -> Note {
        let mut i = input.clone();
        i.action = Some("store".into());
        create(conn, &i)
    }

    // ── FTS index lifecycle ──

    #[test]
    fn fts_row_written_on_create() {
        let conn = open_notes_db_memory();
        let n = create_forced(&conn, &new_note("标题", "内容"));
        let hits: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_fts WHERE note_id=?1", [&n.id], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// The proof that the dual channel earns its keep: jieba may segment
    /// "有龙猫这个词" as 有龙|猫, so a whole-word query for 龙猫 only matches
    /// because the bigram channel indexed "龙猫".
    #[test]
    fn unknown_chinese_term_matches_via_bigram() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("随笔", "有龙猫这个词"));
        let hits = note_search(&conn, "龙猫", None, None).unwrap();
        assert_eq!(hits.len(), 1, "bigram bridge failed");
    }

    #[test]
    fn subword_query_matches_longer_document_term() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("笔记", "机器学习与人工智能"));
        assert_eq!(note_search(&conn, "智能", None, None).unwrap().len(), 1);
    }

    #[test]
    fn search_reports_fts_strategy() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("hello", "world"));
        let hits = note_search(&conn, "hello", None, None).unwrap();
        assert_eq!(hits[0].strategy.as_deref(), Some("fts"));
        assert!(hits[0].score.is_some());
    }

    #[test]
    fn delete_removes_index_row() {
        let conn = open_notes_db_memory();
        let n = create_forced(&conn, &new_note("火星车", "独特词汇"));
        note_delete(&conn, &n.id).unwrap();
        let hits: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_fts WHERE note_id=?1", [&n.id], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 0);
    }

    #[test]
    fn update_reindexes_old_and_new_terms() {
        let conn = open_notes_db_memory();
        let n = create_forced(&conn, &new_note("临时标题", "里面有龙猫"));
        assert_eq!(note_search(&conn, "龙猫", None, None).unwrap().len(), 1);
        note_update(&conn, &n.id, &NoteUpdate {
            title: Some("新标题".into()), content: Some("换成别的内容".into()),
            scope: None, tags: None,
        }).unwrap();
        assert_eq!(note_search(&conn, "龙猫", None, None).unwrap().len(), 0, "stale index entry");
        assert_eq!(note_search(&conn, "别的内容", None, None).unwrap().len(), 1);
    }

    /// A title-only edit must still rewrite the index row (it is replaced
    /// wholesale, not patched).
    ///
    /// The terms are deliberately unrelated: the bigram channel OR-joins
    /// overlapping 2-grams, so similar strings (旧标题词 vs 新标题词, which share
    /// 标题/题词) legitimately still match — that is recruit-first recall, not a
    /// stale index.
    #[test]
    fn title_only_update_reindexes() {
        let conn = open_notes_db_memory();
        let n = create_forced(&conn, &new_note("火星车", "正文"));
        note_update(&conn, &n.id, &NoteUpdate {
            title: Some("海豚计划".into()), content: None, scope: None, tags: None,
        }).unwrap();
        assert_eq!(note_search(&conn, "火星车", None, None).unwrap().len(), 0);
        assert_eq!(note_search(&conn, "海豚计划", None, None).unwrap().len(), 1);
    }

    #[test]
    fn search_falls_back_to_like_when_fts_disabled() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("hello", "world"));
        // Simulate an SQLite build without FTS5 / an operator disabling it.
        meta_set(&conn, "fts_enabled", "0");
        let hits = note_search(&conn, "hello", None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].strategy.as_deref(), Some("like"));
    }

    #[test]
    fn disabled_fts_is_not_resurrected_by_reopen() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("hello", "world"));
        meta_set(&conn, "fts_enabled", "0");
        ensure_schema(&conn).unwrap();
        assert!(!fts_enabled(&conn), "explicit disable was overwritten");
    }

    #[test]
    fn rebuild_repopulates_missing_rows() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("甲", "苹果"));
        create_forced(&conn, &new_note("乙", "香蕉"));
        conn.execute("DELETE FROM note_fts", []).unwrap();
        let n = rebuild_fts(&conn).unwrap();
        assert_eq!(n, 2);
        assert_eq!(note_search(&conn, "苹果", None, None).unwrap().len(), 1);
    }

    // ── Association edges ──

    #[test]
    fn single_edge_visible_from_both_endpoints() {
        let conn = open_notes_db_memory();
        let a = create_forced(&conn, &new_note("甲", "苹果"));
        let b = create_forced(&conn, &new_note("乙", "香蕉"));
        note_associate(&conn, &NoteAssocInput {
            source_id: a.id.clone(), target_id: b.id.clone(),
            weight: 0.8, r#type: "related_to".into(),
        }).unwrap();
        assert_eq!(load_associations(&conn, &a.id).unwrap().len(), 1);
        assert_eq!(load_associations(&conn, &b.id).unwrap().len(), 1);
    }

    #[test]
    fn mirror_call_does_not_duplicate_symmetric_edge() {
        let conn = open_notes_db_memory();
        let a = create_forced(&conn, &new_note("甲", "苹果"));
        let b = create_forced(&conn, &new_note("乙", "香蕉"));
        for (s, t) in [(&a.id, &b.id), (&b.id, &a.id)] {
            note_associate(&conn, &NoteAssocInput {
                source_id: s.clone(), target_id: t.clone(),
                weight: 0.8, r#type: "related_to".into(),
            }).unwrap();
        }
        assert_eq!(load_associations(&conn, &a.id).unwrap().len(), 1);
    }

    #[test]
    fn derived_from_keeps_direction() {
        let conn = open_notes_db_memory();
        let a = create_forced(&conn, &new_note("甲", "苹果"));
        let b = create_forced(&conn, &new_note("乙", "香蕉"));
        for (s, t) in [(&a.id, &b.id), (&b.id, &a.id)] {
            note_associate(&conn, &NoteAssocInput {
                source_id: s.clone(), target_id: t.clone(),
                weight: 0.8, r#type: "derived_from".into(),
            }).unwrap();
        }
        assert_eq!(load_associations(&conn, &a.id).unwrap().len(), 2, "directed edges must keep both");
    }

    // ── Two-phase create ──

    #[test]
    fn fresh_store_persists_directly() {
        let conn = open_notes_db_memory();
        match note_create(&conn, &new_note("独一份", "内容唯一")).unwrap() {
            NoteCreateResult::Stored { note, .. } => assert_eq!(note.title, "独一份"),
            other => panic!("expected Stored, got {:?}", other),
        }
    }

    #[test]
    fn conflict_detected_does_not_persist() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("海豚计划", "关于海豚的详细说明"));
        let res = note_create(&conn, &new_note("海豚计划", "关于海豚的详细说明")).unwrap();
        match res {
            NoteCreateResult::ConflictDetected { candidates, .. } => {
                assert_eq!(candidates.len(), 1);
                assert!(candidates[0].exact, "identical note should be flagged exact");
            }
            other => panic!("expected ConflictDetected, got {:?}", other),
        }
        // The decisive property: nothing was written.
        assert_eq!(note_list(&conn, None, None, None).unwrap().len(), 1);
    }

    #[test]
    fn action_store_creates_anyway() {
        let conn = open_notes_db_memory();
        create_forced(&conn, &new_note("海豚计划", "关于海豚的详细说明"));
        let mut i = new_note("海豚计划", "关于海豚的详细说明");
        i.action = Some("store".into());
        assert!(matches!(note_create(&conn, &i).unwrap(), NoteCreateResult::Stored { .. }));
        assert_eq!(note_list(&conn, None, None, None).unwrap().len(), 2);
    }

    #[test]
    fn action_skip_persists_nothing() {
        let conn = open_notes_db_memory();
        let mut i = new_note("任意", "内容");
        i.action = Some("skip".into());
        assert!(matches!(note_create(&conn, &i).unwrap(), NoteCreateResult::Skipped { .. }));
        assert_eq!(note_list(&conn, None, None, None).unwrap().len(), 0);
    }

    #[test]
    fn invalid_action_is_rejected() {
        let conn = open_notes_db_memory();
        let mut i = new_note("任意", "内容");
        i.action = Some("delete-everything".into());
        match note_create(&conn, &i).unwrap() {
            NoteCreateResult::Rejected { reason, .. } => assert_eq!(reason, "invalid_action"),
            other => panic!("expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn update_action_overwrites_target() {
        let conn = open_notes_db_memory();
        let t = create_forced(&conn, &new_note("旧标题", "旧内容"));
        let mut i = new_note("新标题", "新内容");
        i.action = Some("update".into());
        i.target_ids = Some(vec![t.id.clone()]);
        assert!(matches!(note_create(&conn, &i).unwrap(), NoteCreateResult::Updated { .. }));
        let got = note_get(&conn, &t.id).unwrap();
        assert_eq!(got.title, "新标题");
        assert_eq!(note_list(&conn, None, None, None).unwrap().len(), 1, "update must not add a row");
    }

    #[test]
    fn missing_target_is_rejected_not_silently_skipped() {
        let conn = open_notes_db_memory();
        let mut i = new_note("任意", "内容");
        i.action = Some("merge".into());
        i.target_ids = Some(vec!["does-not-exist".into()]);
        match note_create(&conn, &i).unwrap() {
            NoteCreateResult::Rejected { reason, .. } => assert_eq!(reason, "target_not_found"),
            other => panic!("expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn merge_keeps_carrier_and_removes_victims() {
        let conn = open_notes_db_memory();
        let a = create_forced(&conn, &new_note("甲", "苹果"));
        let b = create_forced(&conn, &new_note("乙", "香蕉"));
        let mut i = new_note("甲乙合并", "苹果与香蕉");
        i.action = Some("merge".into());
        i.target_ids = Some(vec![a.id.clone(), b.id.clone()]);
        match note_create(&conn, &i).unwrap() {
            NoteCreateResult::Merged { note, merged_ids } => {
                assert_eq!(note.id, a.id);
                assert_eq!(merged_ids, vec![b.id.clone()]);
            }
            other => panic!("expected Merged, got {:?}", other),
        }
        assert_eq!(note_list(&conn, None, None, None).unwrap().len(), 1);
        assert!(note_get(&conn, &b.id).is_err(), "victim should be gone");
    }

    /// The reason merge re-points edges before deleting: a relationship must not
    /// disappear along with the note that carried it.
    #[test]
    fn merge_repoints_associations_without_self_loops() {
        let conn = open_notes_db_memory();
        let a = create_forced(&conn, &new_note("甲", "苹果"));
        let b = create_forced(&conn, &new_note("乙", "香蕉"));
        let c = create_forced(&conn, &new_note("丙", "樱桃"));
        note_associate(&conn, &NoteAssocInput {
            source_id: c.id.clone(), target_id: b.id.clone(),
            weight: 0.7, r#type: "related_to".into(),
        }).unwrap();
        let mut i = new_note("合并", "内容");
        i.action = Some("merge".into());
        i.target_ids = Some(vec![a.id.clone(), b.id.clone()]);
        note_create(&conn, &i).unwrap();

        let c_edges = load_associations(&conn, &c.id).unwrap();
        assert_eq!(c_edges.len(), 1, "edge should survive the merge");
        assert_eq!(c_edges[0].id, a.id, "edge should now point at the carrier");
        for n in [&a, &c] {
            assert!(
                load_associations(&conn, &n.id).unwrap().iter().all(|e| e.id != n.id),
                "self-loop created"
            );
        }
    }

    #[test]
    fn merge_unions_tags_when_none_given() {
        let conn = open_notes_db_memory();
        let mut na = new_note("甲", "苹果");
        na.tags = vec!["红".into()];
        let mut nb = new_note("乙", "香蕉");
        nb.tags = vec!["黄".into()];
        let a = create_forced(&conn, &na);
        let b = create_forced(&conn, &nb);
        let mut i = new_note("合并", "内容");
        i.action = Some("merge".into());
        i.target_ids = Some(vec![a.id.clone(), b.id.clone()]);
        i.tags = vec![]; // none given → union
        match note_create(&conn, &i).unwrap() {
            NoteCreateResult::Merged { note, .. } => {
                let mut tags = note.tags.clone();
                tags.sort();
                assert_eq!(tags, vec!["红".to_string(), "黄".to_string()]);
            }
            other => panic!("expected Merged, got {:?}", other),
        }
    }

    #[test]
    fn merged_notes_are_searchable_under_new_content() {
        let conn = open_notes_db_memory();
        let a = create_forced(&conn, &new_note("甲", "苹果"));
        let b = create_forced(&conn, &new_note("乙", "香蕉"));
        let mut i = new_note("合并标题", "苹果与香蕉");
        i.action = Some("merge".into());
        i.target_ids = Some(vec![a.id.clone(), b.id.clone()]);
        note_create(&conn, &i).unwrap();
        assert_eq!(note_search(&conn, "合并标题", None, None).unwrap().len(), 1);
        // The victim's index row must be gone too.
        assert!(note_search(&conn, "乙", None, None).unwrap().iter().all(|h| h.id != b.id));
    }

    /// Test helper: an isolated in-memory DB so tests never touch the real file
    /// and never collide with each other. (The previous version keyed the temp
    /// file by process id, so tests in the same binary shared one file.)
    fn open_notes_db_memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }
}
