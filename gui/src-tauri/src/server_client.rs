//! GUI-side JSON-RPC (jsonrpsee/WebSocket) client for the server daemon.
//!
//! This is the thin client used by the Tauri data commands to read/write the
//! per-workspace SQLite *through* the server (single writer + cross-GUI sync).
//! `connect`/`ping` are verified by an in-process test; the data methods mirror
//! the server's RPC surface (see `gui/src-tauri/server`).

use std::sync::{Arc, Mutex, OnceLock};

use jsonrpsee::core::client::ClientT;
use tauri::Emitter;
use jsonrpsee::ws_client::{WsClient, WsClientBuilder};
use serde::{Deserialize, Serialize};

use claude_gui_shared::note::{
    Note, NoteAssocInput, NoteInput, NoteSummary, NoteUpdate, TagCount,
};
use claude_gui_shared::presence::{PresenceEvent, SessionStatus};
use claude_gui_shared::{DesktopRecord, PlanRecord, PlanSession, ServerEvent};

/// Default loopback server address. The daemon claims this fixed port (bind-to-
/// claim) so a GUI can find it without a discovery handshake.
pub const DEFAULT_ADDR: &str = "127.0.0.1:8766";

/// Attach to a running server (best-effort). Returns None if not reachable —
/// the caller then falls back to local SQLite. Auto-spawning the daemon is the
/// degradation layer's job (ticket 06).
#[allow(dead_code)]
pub async fn try_attach() -> Option<ServerClient> {
    ServerClient::connect(DEFAULT_ADDR).await.ok()
}

/// Locate the bundled server daemon binary (next to the GUI exe).
fn find_server_exe() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let exe = dir.join(if cfg!(windows) {
        "claude-gui-server.exe"
    } else {
        "claude-gui-server"
    });
    if exe.is_file() {
        Some(exe)
    } else {
        None
    }
}

/// Spawn the server daemon as a detached, window-less child. Returns false if the
/// exe isn't bundled yet (→ caller degrades to local SQLite). On Windows,
/// CREATE_NO_WINDOW hides the console so the daemon runs truly in the background.
fn spawn_daemon() -> bool {
    let Some(exe) = find_server_exe() else {
        return false;
    };
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--port=8766");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map(|_| true).unwrap_or(false)
}

/// Degradation ladder (ticket 06): attach → spawn → re-attach → None (local).
/// On success caches the client in `server_state` and starts the event forwarder.
pub async fn ensure_server(
    server_state: &Mutex<Option<ServerClient>>,
    workspace: &str,
) -> Option<ServerClient> {
    if let Ok(g) = server_state.lock() {
        if let Some(c) = g.as_ref() {
            return Some(c.clone());
        }
    }
    if let Some(c) = ServerClient::connect(DEFAULT_ADDR).await.ok() {
        spawn_event_forwarder(c.clone(), workspace.to_string());
        if let Ok(mut g) = server_state.lock() {
            *g = Some(c.clone());
        }
        return Some(c);
    }
    // Attach failed → try to spawn the daemon, then re-attach.
    if spawn_daemon() {
        for _ in 0..30 {
            if let Some(c) = ServerClient::connect(DEFAULT_ADDR).await.ok() {
                spawn_event_forwarder(c.clone(), workspace.to_string());
                if let Ok(mut g) = server_state.lock() {
                    *g = Some(c.clone());
                }
                return Some(c);
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
    }
    None
}

#[derive(Debug, Serialize, Deserialize)]
struct MutateReq {
    workspace: String,
    entity: String,
    base_updated_at: String,
    origin: String,
    payload: serde_json::Value,
}

#[derive(Clone)]
pub struct ServerClient {
    client: Arc<WsClient>,
    /// Per-instance identity used as the `origin` of our writes; lets us skip
    /// our own db_changed echo (origin == self) instead of refetching.
    client_id: String,
}

impl ServerClient {
    #[allow(dead_code)]
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Connect to a running server at `addr` (host:port). The server must already
    /// be up — launching it is the caller's job (see degradation layer).
    pub async fn connect(addr: &str) -> Result<Self, String> {
        let client = WsClientBuilder::default()
            .build(format!("ws://{addr}"))
            .await
            .map_err(|e| e.to_string())?;
        let client_id = process_client_id().to_string();
        Ok(Self {
            client: Arc::new(client),
            client_id,
        })
    }

    /// Subscribe to the server's event stream. Consume with `StreamExt::next()`.
    /// Passes our client_id so the server can clean this client's presence +
    /// session-status entries when the subscription drops (GUI exit/crash).
    #[allow(dead_code)]
    pub async fn subscribe_events(
        &self,
        _workspace: &str,
    ) -> Result<jsonrpsee::core::client::Subscription<ServerEvent>, String> {
        use jsonrpsee::core::client::SubscriptionClientT;
        self.client
            .subscribe::<ServerEvent, _>("subscribe_events", (self.client_id.clone(),), "unsubscribe_events")
            .await
            .map_err(|e| e.to_string())
    }

    /// Health check — exercised by tests now, and by the degradation/self-heal
    /// layer to probe whether the server is still alive.
    #[allow(dead_code)]
    pub async fn ping(&self) -> Result<String, String> {
        self.client
            .request::<String, _>("ping", ("x",))
            .await
            .map_err(|e| e.to_string())
    }

    /// Coarse LWW mutate. Returns `{ok, superseded, updated_at}` from the server.
    pub async fn mutate(
        &self,
        workspace: &str,
        entity: &str,
        base_updated_at: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let req = MutateReq {
            workspace: workspace.into(),
            entity: entity.into(),
            base_updated_at: base_updated_at.into(),
            origin: self.client_id.clone(),
            payload,
        };
        self.client
            .request::<serde_json::Value, _>("mutate", (req,))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn list_desktops(&self, workspace: &str) -> Result<Vec<DesktopRecord>, String> {
        self.client
            .request::<Vec<DesktopRecord>, _>("list_desktops", (workspace,))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn list_plans(
        &self,
        workspace: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<PlanRecord>, String> {
        self.client
            .request::<Vec<PlanRecord>, _>("list_plans", (workspace, offset, limit))
            .await
            .map_err(|e| e.to_string())
    }

    /// 计划历史时间线（按会话分组）—— server 同源读，跨 GUI 一致。
    pub async fn list_plan_sessions(&self, workspace: &str) -> Result<Vec<PlanSession>, String> {
        self.client
            .request::<Vec<PlanSession>, _>("list_plan_sessions", (workspace,))
            .await
            .map_err(|e| e.to_string())
    }

    // ── Notes (user-level, not workspace-scoped). Writes inject our client_id as
    // the `origin` so the server's db_changed echo is skipped by our forwarder. ──

    pub async fn note_create(&self, input: NoteInput) -> Result<Note, String> {
        self.client
            .request::<Note, _>("note_create", (input, self.client_id.clone()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_update(&self, id: &str, input: NoteUpdate) -> Result<Note, String> {
        self.client
            .request::<Note, _>("note_update", (id.to_string(), input, self.client_id.clone()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_delete(&self, id: &str) -> Result<bool, String> {
        self.client
            .request::<bool, _>("note_delete", (id.to_string(), self.client_id.clone()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_get(&self, id: &str) -> Result<Note, String> {
        self.client
            .request::<Note, _>("note_get", (id.to_string(),))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_list(
        &self,
        scope: Option<String>,
        tag: Option<String>,
        limit: Option<u32>,
    ) -> Result<Vec<NoteSummary>, String> {
        self.client
            .request::<Vec<NoteSummary>, _>("note_list", (scope, tag, limit))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_search(
        &self,
        query: String,
        scope: Option<String>,
        limit: Option<u32>,
    ) -> Result<Vec<NoteSummary>, String> {
        self.client
            .request::<Vec<NoteSummary>, _>("note_search", (query, scope, limit))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_associate(&self, input: NoteAssocInput) -> Result<bool, String> {
        self.client
            .request::<bool, _>("note_associate", (input, self.client_id.clone()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_disassociate(&self, source_id: &str, target_id: &str) -> Result<bool, String> {
        self.client
            .request::<bool, _>("note_disassociate", (source_id.to_string(), target_id.to_string(), self.client_id.clone()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_tags(&self, scope: Option<String>) -> Result<Vec<TagCount>, String> {
        self.client
            .request::<Vec<TagCount>, _>("note_tags", (scope,))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_get_all_tag_names(&self) -> Result<Vec<String>, String> {
        self.client
            .request::<Vec<String>, _>("note_get_all_tag_names", ("x",))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn note_apply_tag_mapping(
        &self,
        mappings: std::collections::HashMap<String, String>,
    ) -> Result<Vec<TagCount>, String> {
        self.client
            .request::<Vec<TagCount>, _>("note_apply_tag_mapping", (mappings, self.client_id.clone()))
            .await
            .map_err(|e| e.to_string())
    }

    /// Tell the server this GUI's session list changed, so other GUIs re-request
    /// theirs. Sessions aren't stored on the server — purely a relay signal.
    pub async fn notify_sessions_changed(&self) -> Result<(), String> {
        self.client
            .request::<bool, _>("sessions_changed", (self.client_id.clone(),))
            .await
            .map_err(|e| e.to_string())
            .map(|_| ())
    }

    /// Report this GUI's currently-open session + binary agent state, so the
    /// server fans a SessionStatusChanged to the other GUIs (cross-GUI status).
    pub async fn session_status_report(&self, status: SessionStatus) -> Result<(), String> {
        self.client
            .request::<bool, _>("session_status_report", (status,))
            .await
            .map_err(|e| e.to_string())
            .map(|_| ())
    }

    /// Workspace-scoped snapshot of currently-open sessions (initial live state).
    pub async fn get_session_statuses(&self, workspace: &str) -> Result<Vec<SessionStatus>, String> {
        self.client
            .request::<Vec<SessionStatus>, _>("get_session_statuses", (workspace,))
            .await
            .map_err(|e| e.to_string())
    }

    /// Tell the server this GUI saved a workspace-scoped setting, so other GUIs
    /// reload their merged settings. Purely a relay signal.
    pub async fn notify_settings_changed(&self) -> Result<(), String> {
        self.client
            .request::<bool, _>("settings_changed", (self.client_id.clone(),))
            .await
            .map_err(|e| e.to_string())
            .map(|_| ())
    }

    // ── Startup intent (--intent <id>) ──
    // Frontend can't construct a client_id, so these bridge commands send it.

    /// Atomically claim a published intent; returns the payload (pending intent
    /// record with `payload`/`claims`). Err if already claimed/expired.
    pub async fn claim_intent(&self, intent_id: &str) -> Result<serde_json::Value, String> {
        self.client
            .request::<serde_json::Value, _>("claim_intent", (intent_id.to_string(), self.client_id.clone()))
            .await
            .map_err(|e| e.to_string())
    }

    /// Ack a claimed intent (done/result). Only the claimer may ack, once.
    pub async fn ack_intent(&self, intent_id: &str, result: Option<serde_json::Value>) -> Result<(), String> {
        self.client
            .request::<bool, _>("ack_intent", (intent_id.to_string(), self.client_id.clone(), result))
            .await
            .map_err(|e| e.to_string())
            .map(|_| ())
    }

    /// Publish a startup intent (launcher side). `origin` is our client_id.
    pub async fn publish_intent(&self, intent_id: &str, payload: serde_json::Value, ttl_ms: u64) -> Result<(), String> {
        self.client
            .request::<bool, _>("publish_intent", (intent_id.to_string(), payload, self.client_id.clone(), ttl_ms))
            .await
            .map_err(|e| e.to_string())
            .map(|_| ())
    }

    /// Query an intent's final status (P1 ack path: launcher polls this).
    pub async fn query_intent_status(&self, intent_id: &str) -> Result<serde_json::Value, String> {
        self.client
            .request::<serde_json::Value, _>("query_intent_status", (intent_id.to_string(),))
            .await
            .map_err(|e| e.to_string())
    }
}

/// Per-process unique suffix for the client_id.
fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// One client_id per process (OnceLock). Every ServerClient instance in this
/// process shares it, so `origin == self` holds regardless of which instance
/// wrote vs. forwarded — without this, concurrent first-connects spawned several
/// clients with different ids, and a stale forwarder mis-emitted our own change
/// back to the frontend (the "block disappears" revert bug).
fn process_client_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("gui-{}-{}", std::process::id(), rand_suffix()))
}

/// Registered once at app setup so the background forwarder can emit to the UI.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
}

/// 返回全局 AppHandle（供 lib.rs 等处分发事件用；未 setup 时为 None）。
pub fn app_handle() -> Option<tauri::AppHandle> {
    APP_HANDLE.get().cloned()
}

/// Start a background task that subscribes to the server's event stream and
/// re-emits `db_changed` from *other* clients to the frontend ("server:data-changed")
/// so it refetches. `origin == self` is skipped (we already have the latest).
pub fn spawn_event_forwarder(client: ServerClient, workspace: String) {
    let Some(app) = APP_HANDLE.get().cloned() else {
        return;
    };
    let client_id = client.client_id().to_string();
    tauri::async_runtime::spawn(async move {
        let mut sub = match client.subscribe_events(&workspace).await {
            Ok(s) => s,
            Err(_) => return,
        };
        while let Some(evt) = sub.next().await {
            match evt {
                Ok(ServerEvent::DbChanged { change }) => {
                    if change.origin == client_id {
                        continue;
                    }
                    let _ = app.emit("server:data-changed", &change);
                }
                // Cross-GUI session-open/agent-status upsert. Skip our own
                // (we already know our active session locally) so the marker
                // shows only sessions open in OTHER instances.
                Ok(ServerEvent::SessionStatusChanged { status }) => {
                    if status.client_id == client_id {
                        continue;
                    }
                    let _ = app.emit("server:session-status", &status);
                }
                // Another GUI closed → its session-status entries are dropped.
                Ok(ServerEvent::Presence { event: PresenceEvent::Leave { client_id: leaving } }) => {
                    let _ = app.emit("server:client-left", &leaving);
                }
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use jsonrpsee::server::{RpcModule, ServerBuilder};
    use super::*;

    /// Minimal in-process server: just `ping`. Confirms the client's connect +
    /// request plumbing against a real jsonrpsee server.
    async fn spawn_ping_server() -> (jsonrpsee::server::ServerHandle, std::net::SocketAddr) {
        let server = ServerBuilder::default().ws_only().build("127.0.0.1:0").await.unwrap();
        let mut module = RpcModule::new(());
        module.register_method("ping", |_p, _c, _e| "pong").unwrap();
        let addr = server.local_addr().unwrap();
        let handle = server.start(module);
        (handle, addr)
    }

    #[tokio::test]
    async fn connect_and_ping() {
        let (handle, addr) = spawn_ping_server().await;
        let client = ServerClient::connect(&addr.to_string()).await.unwrap();
        assert_eq!(client.ping().await.unwrap(), "pong");
        handle.stop().unwrap();
    }
}
