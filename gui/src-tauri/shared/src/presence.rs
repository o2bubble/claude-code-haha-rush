//! Presence + event envelope shared between the GUI (client) and the server.
//!
//! `ServerEvent` is the "reserved envelope": tagged by `kind`. Adding a new
//! kind (e.g. `DbChanged`) is a new enum variant — the transport/pipe does not
//! change. This is the extensibility seam the server layer is built around.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub client_id: String,
    pub name: String,
    pub platform: String,
    pub workspace: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceEvent {
    Join { client: ClientInfo },
    Leave { client_id: String },
}

/// A coarse "some record changed" signal. Subscribers refetch the entity;
/// `origin` is the client that caused it so the writer skips its own refetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbChanged {
    pub entity: String,
    pub id: String,
    pub op: String, // "upsert" | "delete"
    pub origin: String,
    pub updated_at: String,
}

/// A GUI-to-GUI message delivered over the same event stream. This is the
/// extensibility proof: adding a new kind is a new enum variant — the pipe is
/// untouched. `target` empty = broadcast to the whole workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuiMessage {
    pub from: String,
    pub target: String,
    pub body: String,
    pub at: String,
}

/// A GUI's currently-open session's agent state, reported to the server so other
/// instances can show "open elsewhere" + a working/idle dot on the session list.
/// Binary (not token-level): `working` = backend busy/streaming; `idle` = ready.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Working,
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionStatus {
    pub workspace: String,
    pub session_id: String,
    pub state: SessionState,
    /// The GUI instance reporting it (matches `ClientInfo.client_id`).
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ServerEvent {
    #[serde(rename = "presence")]
    Presence { event: PresenceEvent },
    #[serde(rename = "db_changed")]
    DbChanged { change: DbChanged },
    #[serde(rename = "gui_message")]
    GuiMessage { message: GuiMessage },
    #[serde(rename = "session_status")]
    SessionStatusChanged { status: SessionStatus },
}
