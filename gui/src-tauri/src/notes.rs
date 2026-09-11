//! Notes — local-degradation facade over the shared note store.
//!
//! The note SQL/types live in `claude-gui-shared` (`shared::note`) so the server
//! daemon and the GUI reference the same definitions. This module keeps the
//! GUI's Tauri command signatures (`notes::Note`, `notes::note_create`, ...)
//! unchanged, and is the **local fallback** used when no server is reachable —
//! with the server up, the lib.rs commands route through `ServerClient` instead.
//! Both paths read/write the same user-level `~/.claude/notes/notes.db`.

use rusqlite::Connection;

pub use claude_gui_shared::note::{
    Note, NoteAssocInput, NoteInput, NoteSummary, NoteUpdate, TagCount,
};

/// Open the user-level notes DB (path overridable via `CLAUDE_GUI_NOTES_DB`).
pub fn open_notes_db() -> Result<Connection, String> {
    claude_gui_shared::note::open_notes_db()
}

// ─── Commands (thin wrappers: open local conn → shared store) ───

pub fn note_create(input: NoteInput) -> Result<Note, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_create(&conn, &input)
}

pub fn note_update(id: &str, input: NoteUpdate) -> Result<Note, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_update(&conn, id, &input)
}

pub fn note_delete(id: &str) -> Result<bool, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_delete(&conn, id)
}

pub fn note_get(id: &str) -> Result<Note, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_get(&conn, id)
}

pub fn note_list(scope: Option<String>, tag: Option<String>, limit: Option<u32>) -> Result<Vec<NoteSummary>, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_list(&conn, scope.as_deref(), tag.as_deref(), limit)
}

pub fn note_search(query: String, scope: Option<String>, limit: Option<u32>) -> Result<Vec<NoteSummary>, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_search(&conn, &query, scope.as_deref(), limit)
}

pub fn note_associate(input: NoteAssocInput) -> Result<bool, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_associate(&conn, &input)
}

pub fn note_disassociate(source_id: &str, target_id: &str) -> Result<bool, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_disassociate(&conn, source_id, target_id)
}

pub fn note_tags(scope: Option<String>) -> Result<Vec<TagCount>, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_tags(&conn, scope.as_deref())
}

pub fn note_get_all_tag_names() -> Result<Vec<String>, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_get_all_tag_names(&conn)
}

pub fn note_apply_tag_mapping(mappings: std::collections::HashMap<String, String>) -> Result<Vec<TagCount>, String> {
    let conn = open_notes_db()?;
    claude_gui_shared::note::note_apply_tag_mapping(&conn, &mappings)
}
