//! Notes — user-level (not workspace-scoped) note store shared between the GUI
//! and the server daemon. The GUI and server both read/write the same
//! `~/.claude/notes/notes.db`; the server owns writes so it can broadcast
//! `db_changed{entity:"note"}` to every GUI for cross-GUI sync.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

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
    #[serde(default)]
    pub bidirectional: bool,
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
        PRAGMA foreign_keys = ON;
        "
    ).map_err(|e| format!("schema: {}", e))
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

pub fn note_create(conn: &Connection, input: &NoteInput) -> Result<Note, String> {
    let id = uuid_v4();
    let now = now_iso();
    conn.execute(
        "INSERT INTO notes (id, title, content, scope, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, input.title, input.content, input.scope, now, now],
    ).map_err(|e| format!("create: {}", e))?;
    set_note_tags(conn, &id, &input.tags)?;
    Ok(Note {
        id, title: input.title.clone(), content: input.content.clone(), scope: input.scope.clone(),
        tags: input.tags.clone(), associations: vec![], created_at: now.clone(), updated_at: now,
    })
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
    note_get(conn, id)
}

pub fn note_delete(conn: &Connection, id: &str) -> Result<bool, String> {
    let n = conn.execute("DELETE FROM notes WHERE id=?1", params![id])
        .map_err(|e| format!("delete: {}", e))?;
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
        NoteSummary { id, title, scope, tags, snippet, updated_at }
    })
    .collect();
    Ok(summaries)
}

pub fn note_search(conn: &Connection, query: &str, scope: Option<&str>, limit: Option<u32>) -> Result<Vec<NoteSummary>, String> {
    let limit = limit.unwrap_or(20).min(100);
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
        (score, NoteSummary { id, title, scope, tags, snippet, updated_at })
    })
    .collect();

    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
        .then(b.1.updated_at.cmp(&a.1.updated_at)));
    Ok(candidates.into_iter().take(limit as usize).map(|(_, s)| s).collect())
}

pub fn note_associate(conn: &Connection, input: &NoteAssocInput) -> Result<bool, String> {
    conn.execute(
        "INSERT OR REPLACE INTO note_associations (source_id, target_id, weight, type) VALUES (?1,?2,?3,?4)",
        params![input.source_id, input.target_id, input.weight, input.r#type],
    ).map_err(|e| format!("associate: {}", e))?;
    if input.bidirectional {
        conn.execute(
            "INSERT OR REPLACE INTO note_associations (source_id, target_id, weight, type) VALUES (?1,?2,?3,?4)",
            params![input.target_id, input.source_id, input.weight, input.r#type],
        ).map_err(|e| format!("associate rev: {}", e))?;
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
        let n = note_create(&conn, &NoteInput {
            title: "hello".into(), content: "world".into(),
            scope: "global".into(), tags: vec!["a".into(), "b".into()],
        }).unwrap();
        assert_eq!(note_get(&conn, &n.id).unwrap().title, "hello");
        assert_eq!(note_get(&conn, &n.id).unwrap().tags.len(), 2);
        assert_eq!(note_list(&conn, None, None, Some(10)).unwrap().len(), 1);
        assert_eq!(note_search(&conn, "hello", None, None).unwrap().len(), 1);
        assert_eq!(note_tags(&conn, None).unwrap().iter().find(|t| t.name == "a").unwrap().count, 1);
        assert!(note_delete(&conn, &n.id).unwrap());
    }

    /// Test helper: use an isolated temp file so tests never touch the real DB.
    fn open_notes_db_memory() -> Connection {
        let tmp = std::env::temp_dir().join(format!("claude-note-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let conn = Connection::open(&tmp).unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }
}
