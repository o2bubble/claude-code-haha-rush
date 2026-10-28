use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use claude_gui_shared::presence::{ClientInfo, DbChanged, GuiMessage, PresenceEvent, ServerEvent, SessionStatus};
use claude_gui_shared::note as note;
use claude_gui_shared as shared;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use jsonrpsee::types::ErrorObjectOwned;
use jsonrpsee::server::{PendingSubscriptionSink, RpcModule, ServerBuilder, ServerHandle, SubscriptionMessage};
use jsonrpsee::ws_client::WsClientBuilder;
use tokio::sync::{broadcast, watch};

mod session_status;
#[cfg(windows)]
mod tray;

use session_status::{session_status_reduce, sessions_for_workspace, SessionStatusEvent};

/// Shared server context: presence registry, event fan-out bus, and the
/// "live GUI connections" ref-count that drives the daemon lifecycle.
/// Per-workspace SQLite connection cache. The server is the single writer;
/// each workspace's connection is owned behind a mutex (serialized writes).
struct DbStore {
    dbs: Mutex<HashMap<String, Arc<Mutex<rusqlite::Connection>>>>,
}

impl DbStore {
    fn new() -> Self {
        Self {
            dbs: Mutex::new(HashMap::new()),
        }
    }

    fn conn(&self, workspace: &str) -> Result<Arc<Mutex<rusqlite::Connection>>, String> {
        let mut dbs = self.dbs.lock().unwrap();
        if let Some(c) = dbs.get(workspace) {
            return Ok(c.clone());
        }
        let dir = std::path::Path::new(workspace).join(".claude");
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create .claude: {e}"))?;
        let conn = shared::init_db(&dir.join("data.db").to_string_lossy())?;
        let c = Arc::new(Mutex::new(conn));
        dbs.insert(workspace.to_string(), c.clone());
        Ok(c)
    }
}

#[derive(Clone)]
struct ServerCtx {
    registry: Arc<Mutex<HashMap<String, ClientInfo>>>,
    store: Arc<DbStore>,
    /// User-level notes DB (single, not per-workspace). Lazy-opened on first
    /// note RPC so tests that never touch notes don't open the real DB.
    note_store: Arc<Mutex<Option<Arc<Mutex<rusqlite::Connection>>>>>,
    /// Startup-intent rendezvous: intent_id → PendingIntent, for the
    /// `--intent <id>` launch flow (publish → claim → ack). Unlike notes/desktop,
    /// this is pure in-memory coordination, no DB.
    intents: Arc<Mutex<HashMap<String, PendingIntent>>>,
    /// Live "which session is open in which GUI + its agent state" registry
    /// (keyed by owner client id). Transient, in-memory, dropped on disconnect.
    sessions: Arc<Mutex<session_status::SessionRegistry>>,
    events_tx: broadcast::Sender<ServerEvent>,
    live: Arc<AtomicUsize>,
    shutdown_tx: watch::Sender<bool>,
    /// 「所有 GUI 都断开后，什么时候真正退出」。
    ///
    /// 2026-10-27 起托盘常驻在 server 里：如果最后一个 GUI 断开就立刻退出，
    /// 托盘会跟着消失 —— 而托盘恰恰是用户"找不到窗口"时的救命入口。
    /// 所以改成**延迟退出**：留一段宽限期，期间随时可以重开 GUI；
    /// 宽限期过后仍没人连 → 才真的退出。
    ///
    /// `None` = 还有 GUI 连着（不退出）；`Some(t)` = 从 t 起算宽限期。
    idle_deadline: Arc<Mutex<Option<std::time::Instant>>>,
    /// 是否启用"宽限期后退出"。`false` = 保持原有语义（最后一个 GUI 断开就退出），
    /// 测试走这条；`true` = 正式运行时给托盘留出常驻时间。
    idle_grace: bool,
}

/// 最后一个 GUI 断开后，server（含托盘）还活多久。
///
/// 2026-10-27 从 5 分钟改成 3 分钟（用户要求「5 分钟太长了」）。
/// 托盘菜单里会显示这个倒计时的剩余时间 —— 让用户知道它会自己退出、
/// 不是常驻占着后台，不用手动去清理。
pub const IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(180);

impl ServerCtx {
    fn new() -> Self {
        let (events_tx, _) = broadcast::channel(256);
        let (shutdown_tx, _) = watch::channel(false);
        Self {
            registry: Arc::new(Mutex::new(HashMap::new())),
            store: Arc::new(DbStore::new()),
            note_store: Arc::new(Mutex::new(None)),
            intents: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events_tx,
            live: Arc::new(AtomicUsize::new(0)),
            shutdown_tx,
            idle_deadline: Arc::new(Mutex::new(None)),
            idle_grace: false,
        }
    }
}

/// A published startup intent, claimed atomically by a new GUI and acked when
/// it has executed. `created_at`/`claimed_at` are epoch millis (see now_millis).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingIntent {
    intent_id: String,
    payload: serde_json::Value, // { workspace, kind, session_id?, panel_id?, ... }
    origin: String,
    created_at: u64,
    ttl_ms: u64,
    claimed_by: Option<String>,
    claimed_at: Option<u64>,
    status: String, // "pending" | "claimed" | "done" | "expired"
    result: Option<serde_json::Value>,
}

/// Get (lazy-opening) the server's user-level notes connection.
fn note_conn(ctx: &ServerCtx) -> Result<Arc<Mutex<rusqlite::Connection>>, ErrorObjectOwned> {
    let mut guard = ctx.note_store.lock().unwrap();
    if let Some(c) = guard.as_ref() {
        return Ok(c.clone());
    }
    let conn = shared::note::open_notes_db().map_err(rpc_err)?;
    let c = Arc::new(Mutex::new(conn));
    *guard = Some(c.clone());
    Ok(c)
}

/// The id of the note a `note_create` call actually touched, if any.
/// `None` for the phases that persist nothing (pre-check, skip, reject).
fn note_create_changed_id(result: &shared::note::NoteCreateResult) -> Option<String> {
    use shared::note::NoteCreateResult as R;
    match result {
        R::Stored { note, .. } | R::Updated { note } | R::Merged { note, .. } => {
            Some(note.id.clone())
        }
        R::ConflictDetected { .. } | R::Skipped { .. } | R::Rejected { .. } => None,
    }
}

/// Broadcast a coarse "note changed" signal with the writer's origin so other
/// GUIs refetch and the writer skips its own echo.
fn note_changed(ctx: &ServerCtx, id: String, op: String, origin: String) {
    let _ = ctx.events_tx.send(ServerEvent::DbChanged {
        change: DbChanged {
            entity: "note".into(),
            id,
            op,
            origin,
            updated_at: String::new(),
        },
    });
}

#[derive(Deserialize, Serialize)]
struct MutateReq {
    workspace: String,
    entity: String,
    base_updated_at: String,
    origin: String,
    payload: serde_json::Value,
}

fn rpc_err(msg: impl Into<String>) -> ErrorObjectOwned {
    ErrorObjectOwned::owned(-32000, msg, None::<()>)
}

fn now_iso() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}", d.as_secs()))
        .unwrap_or_default()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Sweep intents that outlived their TTL. Past TTL: drop unclaimed/done, but
/// keep a claimed-but-unacked one around as "expired" so query_intent_status can
/// report it (§5.3: "claimed 超时未 ack → 标记 expired"). Called on every intent
/// read/write so the map never grows unbounded.
fn gc_intents(ctx: &ServerCtx) {
    let now = now_millis();
    let mut intents = ctx.intents.lock().unwrap();
    intents.retain(|_, rec| {
        let over = now.saturating_sub(rec.created_at) > rec.ttl_ms;
        if !over {
            return true;
        }
        if rec.status == "claimed" {
            rec.status = "expired".into();
            return true;
        }
        false
    });
}

/// Read a row's `updated_at` (used for LWW superseded detection). Table name is
/// a fixed literal from the caller, never user input.
fn get_updated_at(conn: &rusqlite::Connection, table: &str, id: &str) -> Option<String> {
    conn.query_row(
        &format!("SELECT updated_at FROM {table} WHERE id = ?1"),
        params![id],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Coarse LWW mutate: unconditionally writes the record, but reports whether the
/// client's `base_updated_at` was stale (another writer got there first).
fn do_mutate(ctx: &ServerCtx, req: MutateReq) -> Result<serde_json::Value, ErrorObjectOwned> {
    let conn = ctx.store.conn(&req.workspace).map_err(rpc_err)?;
    let db = conn.lock().unwrap();
    let c = &*db;
    match req.entity.as_str() {
        "plan" => {
            let input: shared::PlanInput = serde_json::from_value(req.payload).map_err(|e| rpc_err(e.to_string()))?;
            let id = input.id.clone();
            let prior = get_updated_at(c, "plans", &id);
            // An empty base means the client had no version stamp (e.g. a fresh
            // build that never read one) — treat as "no conflict", not superseded,
            // so a save isn't falsely flagged. Superseded is only meaningful when
            // the client actually sent the base it read and that base is stale.
            let superseded = !req.base_updated_at.is_empty()
                && prior.as_deref().map(|p| p != req.base_updated_at.as_str()).unwrap_or(false);
            shared::save_plan(c, &input).map_err(|e| rpc_err(e))?;
            let updated_at = get_updated_at(c, "plans", &id).unwrap_or_default();
            let _ = ctx.events_tx.send(ServerEvent::DbChanged {
                change: DbChanged {
                    entity: "plan".into(), id: id.clone(), op: "upsert".into(),
                    origin: req.origin.clone(), updated_at: updated_at.clone(),
                },
            });
            Ok(serde_json::json!({"ok": true, "superseded": superseded, "updated_at": updated_at}))
        }
        "desktop" => {
            let rec: shared::DesktopRecord = serde_json::from_value(req.payload).map_err(|e| rpc_err(e.to_string()))?;
            let id = rec.id.clone();
            let prior = get_updated_at(c, "desktops", &id);
            // An empty base means the client had no version stamp (e.g. a fresh
            // build that never read one) — treat as "no conflict", not superseded,
            // so a save isn't falsely flagged. Superseded is only meaningful when
            // the client actually sent the base it read and that base is stale.
            let superseded = !req.base_updated_at.is_empty()
                && prior.as_deref().map(|p| p != req.base_updated_at.as_str()).unwrap_or(false);
            shared::save_desktop(c, &rec).map_err(|e| rpc_err(e))?;
            let updated_at = get_updated_at(c, "desktops", &id).unwrap_or_default();
            let _ = ctx.events_tx.send(ServerEvent::DbChanged {
                change: DbChanged {
                    entity: "desktop".into(), id: id.clone(), op: "upsert".into(),
                    origin: req.origin.clone(), updated_at: updated_at.clone(),
                },
            });
            Ok(serde_json::json!({"ok": true, "superseded": superseded, "updated_at": updated_at}))
        }
        "delete_desktop" => {
            let id = req.payload.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            shared::delete_desktop(c, &id).map_err(|e| rpc_err(e))?;
            let _ = ctx.events_tx.send(ServerEvent::DbChanged {
                change: DbChanged {
                    entity: "desktop".into(), id: id.clone(), op: "delete".into(),
                    origin: req.origin.clone(), updated_at: String::new(),
                },
            });
            Ok(serde_json::json!({"ok": true, "superseded": false, "updated_at": ""}))
        }
        other => Err(rpc_err(format!("unknown entity: {other}"))),
    }
}

/// Build the RPC module: presence methods + the event subscription stream.
fn build_module(ctx: ServerCtx) -> RpcModule<ServerCtx> {
    let mut module = RpcModule::new(ctx);

    module
        .register_method("ping", |_params, _ctx, _ext| "pong")
        .unwrap();

    // Register a client in presence, then fan a Join event to subscribers.
    module
        .register_method("register_client", |params, ctx: &ServerCtx, _ext| {
            let client: ClientInfo =
                params.parse::<(ClientInfo,)>().map(|t| t.0).unwrap_or(default_client());
            let mut reg = ctx.registry.lock().unwrap();
            reg.insert(client.client_id.clone(), client.clone());
            // Broadcast outside the registry lock.
            drop(reg);
            let evt = ServerEvent::Presence { event: PresenceEvent::Join { client: client.clone() } };
            let _ = ctx.events_tx.send(evt);
            Ok::<_, ErrorObjectOwned>(client)
        })
        .unwrap();

    // Explicit leave (GUI calls this on close).
    module
        .register_method("unregister_client", |params, ctx: &ServerCtx, _ext| {
            let (client_id,): (String,) = params.parse::<(String,)>().unwrap_or(("".into(),));
            let mut reg = ctx.registry.lock().unwrap();
            reg.remove(&client_id);
            drop(reg);
            // Drop the client's live session-status entries so a closed/crashed
            // GUI doesn't leave a zombie "working" marker (presence-cleanup).
            let mut sessions = ctx.sessions.lock().unwrap();
            session_status_reduce(&mut sessions, &SessionStatusEvent::ClientLeft { client_id: client_id.clone() });
            drop(sessions);
            let evt = ServerEvent::Presence { event: PresenceEvent::Leave { client_id: client_id.clone() } };
            let _ = ctx.events_tx.send(evt);
            Ok::<_, ErrorObjectOwned>(true)
        })
        .unwrap();

    // List clients for a workspace (presence).
    module
        .register_method("list_clients", |params, ctx: &ServerCtx, _ext| {
            let (workspace,): (String,) = params.parse::<(String,)>().unwrap_or(("".into(),));
            let reg = ctx.registry.lock().unwrap();
            Ok::<_, ErrorObjectOwned>(
                reg.values()
                    .filter(|c| c.workspace == workspace)
                    .cloned()
                    .collect::<Vec<ClientInfo>>(),
            )
        })
        .unwrap();

    // Coarse data plane: mutate (LWW + version stamp) + reads. The server is the
    // single writer for each workspace's SQLite.
    module
        .register_method("mutate", |params, ctx: &ServerCtx, _ext| {
            let req: MutateReq = params.parse::<(MutateReq,)>().map_err(|e| rpc_err(e.to_string()))?.0;
            do_mutate(ctx, req)
        })
        .unwrap();

    module
        .register_method("list_desktops", |params, ctx: &ServerCtx, _ext| {
            let (ws,): (String,) = params.parse::<(String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = ctx.store.conn(&ws).map_err(rpc_err)?;
            let db = conn.lock().unwrap();
            let v = shared::get_desktops(&*db).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    // Reserved per-GUI messaging: a `GuiMessage` kind rides the same event
    // stream. Adding new kinds is adding a ServerEvent variant — pipe unchanged.
    module
        .register_method("send_gui_message", |params, ctx: &ServerCtx, _ext| {
            let (from, target, body,): (String, String, String,) =
                params.parse::<(String, String, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let evt = ServerEvent::GuiMessage {
                message: GuiMessage {
                    from,
                    target,
                    body,
                    at: now_iso(),
                },
            };
            let _ = ctx.events_tx.send(evt);
            Ok::<_, ErrorObjectOwned>(true)
        })
        .unwrap();

    // Session-list cross-GUI relay: a GUI whose backend reported the list changed
    // (created/renamed/deleted) tells the server so other GUIs re-request theirs.
    // Sessions aren't stored here — this is a pure signal, no DB write.
    module
        .register_method("sessions_changed", |params, ctx: &ServerCtx, _ext| {
            let (origin,): (String,) = params.parse::<(String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let _ = ctx.events_tx.send(ServerEvent::DbChanged {
                change: DbChanged {
                    entity: "session".into(),
                    id: String::new(),
                    op: "changed".into(),
                    origin,
                    updated_at: String::new(),
                },
            });
            Ok::<_, ErrorObjectOwned>(true)
        })
        .unwrap();

    // Workspace settings cross-GUI relay: a GUI that saved a workspace-scoped
    // setting (e.g. favoriteSessionIds) tells the server so other GUIs reload
    // their merged settings. Pure signal — settings aren't stored here.
    module
        .register_method("settings_changed", |params, ctx: &ServerCtx, _ext| {
            let (origin,): (String,) = params.parse::<(String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let _ = ctx.events_tx.send(ServerEvent::DbChanged {
                change: DbChanged {
                    entity: "settings".into(),
                    id: String::new(),
                    op: "changed".into(),
                    origin,
                    updated_at: String::new(),
                },
            });
            Ok::<_, ErrorObjectOwned>(true)
        })
        .unwrap();

    // Live cross-GUI session status: a GUI reports its currently-open session +
    // binary agent state; the server aggregates (transient, in-memory) and fans a
    // SessionStatusChanged event so other GUIs can mark the session list.
    module
        .register_method("session_status_report", |params, ctx: &ServerCtx, _ext| {
            let status: SessionStatus = params
                .parse::<(SessionStatus,)>()
                .map_err(|e| rpc_err(e.to_string()))?
                .0;
            {
                let mut sessions = ctx.sessions.lock().unwrap();
                session_status_reduce(&mut sessions, &SessionStatusEvent::Report(status.clone()));
            }
            let _ = ctx.events_tx.send(ServerEvent::SessionStatusChanged { status });
            Ok::<_, ErrorObjectOwned>(true)
        })
        .unwrap();

    // Workspace-scoped snapshot for a joining GUI (initial live state).
    module
        .register_method("get_session_statuses", |params, ctx: &ServerCtx, _ext| {
            let (workspace,): (String,) =
                params.parse::<(String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let sessions = ctx.sessions.lock().unwrap();
            Ok::<_, ErrorObjectOwned>(sessions_for_workspace(&sessions, &workspace))
        })
        .unwrap();

    module
        .register_method("list_plans", |params, ctx: &ServerCtx, _ext| {
            let (ws, offset, limit,): (String, u32, u32,) =
                params.parse::<(String, u32, u32,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = ctx.store.conn(&ws).map_err(rpc_err)?;
            let db = conn.lock().unwrap();
            let v = shared::get_plans(&*db, offset, limit).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    // 计划历史时间线（按会话分组）—— 与 list_plans 同源 server 读，跨 GUI 一致
    module
        .register_method("list_plan_sessions", |params, ctx: &ServerCtx, _ext| {
            let (ws,): (String,) =
                params.parse::<(String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = ctx.store.conn(&ws).map_err(rpc_err)?;
            let db = conn.lock().unwrap();
            let v = shared::get_plan_sessions(&*db).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    // ── Notes (user-level store, not workspace-scoped) ──
    // Writes carry `origin` so subscribers can skip their own db_changed echo.

    module
        .register_method("note_create", |params, ctx: &ServerCtx, _ext| {
            let (input, origin,): (note::NoteInput, String,) =
                params.parse::<(note::NoteInput, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let result = note::note_create(&*db, &input).map_err(|e| rpc_err(e))?;
            // Only phases that actually wrote may broadcast: the pre-check phase
            // persists nothing, so signalling a change would make every GUI
            // refetch its note list for no reason.
            if let Some(id) = note_create_changed_id(&result) {
                note_changed(ctx, id, "upsert".into(), origin);
            }
            Ok::<_, ErrorObjectOwned>(result)
        })
        .unwrap();

    module
        .register_method("note_update", |params, ctx: &ServerCtx, _ext| {
            let (id, input, origin,): (String, note::NoteUpdate, String,) =
                params.parse::<(String, note::NoteUpdate, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let n = note::note_update(&*db, &id, &input).map_err(|e| rpc_err(e))?;
            note_changed(ctx, id, "upsert".into(), origin);
            Ok::<_, ErrorObjectOwned>(n)
        })
        .unwrap();

    module
        .register_method("note_delete", |params, ctx: &ServerCtx, _ext| {
            let (id, origin,): (String, String,) =
                params.parse::<(String, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let deleted = note::note_delete(&*db, &id).map_err(|e| rpc_err(e))?;
            if deleted {
                note_changed(ctx, id, "delete".into(), origin);
            }
            Ok::<_, ErrorObjectOwned>(deleted)
        })
        .unwrap();

    module
        .register_method("note_get", |params, ctx: &ServerCtx, _ext| {
            let (id,): (String,) =
                params.parse::<(String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let n = note::note_get(&*db, &id).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(n)
        })
        .unwrap();

    module
        .register_method("note_list", |params, ctx: &ServerCtx, _ext| {
            let (scope, tag, limit,): (Option<String>, Option<String>, Option<u32>,) =
                params.parse::<(Option<String>, Option<String>, Option<u32>,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let v = note::note_list(&*db, scope.as_deref(), tag.as_deref(), limit).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    module
        .register_method("note_search", |params, ctx: &ServerCtx, _ext| {
            let (query, scope, limit,): (String, Option<String>, Option<u32>,) =
                params.parse::<(String, Option<String>, Option<u32>,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let v = note::note_search(&*db, &query, scope.as_deref(), limit).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    module
        .register_method("note_associate", |params, ctx: &ServerCtx, _ext| {
            let (input, origin,): (note::NoteAssocInput, String,) =
                params.parse::<(note::NoteAssocInput, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let ok = note::note_associate(&*db, &input).map_err(|e| rpc_err(e))?;
            note_changed(ctx, input.source_id.clone(), "upsert".into(), origin);
            Ok::<_, ErrorObjectOwned>(ok)
        })
        .unwrap();

    module
        .register_method("note_disassociate", |params, ctx: &ServerCtx, _ext| {
            let (source_id, target_id, origin,): (String, String, String,) =
                params.parse::<(String, String, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let ok = note::note_disassociate(&*db, &source_id, &target_id).map_err(|e| rpc_err(e))?;
            note_changed(ctx, source_id, "upsert".into(), origin);
            Ok::<_, ErrorObjectOwned>(ok)
        })
        .unwrap();

    module
        .register_method("note_tags", |params, ctx: &ServerCtx, _ext| {
            let (scope,): (Option<String>,) =
                params.parse::<(Option<String>,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let v = note::note_tags(&*db, scope.as_deref()).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    module
        .register_method("note_get_all_tag_names", |_params, ctx: &ServerCtx, _ext| {
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let v = note::note_get_all_tag_names(&*db).map_err(|e| rpc_err(e))?;
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    module
        .register_method("note_apply_tag_mapping", |params, ctx: &ServerCtx, _ext| {
            let (mappings, origin,): (HashMap<String, String>, String,) =
                params.parse::<(HashMap<String, String>, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            let conn = note_conn(ctx)?;
            let db = conn.lock().unwrap();
            let v = note::note_apply_tag_mapping(&*db, &mappings).map_err(|e| rpc_err(e))?;
            note_changed(ctx, String::new(), "upsert".into(), origin);
            Ok::<_, ErrorObjectOwned>(v)
        })
        .unwrap();

    // ── Startup intent rendezvous (--intent <id>) ──
    // P1: ack returns to the launcher via query_intent_status polling.

    module
        .register_method("publish_intent", |params, ctx: &ServerCtx, _ext| {
            let (intent_id, payload, origin, ttl_ms,): (String, serde_json::Value, String, u64,) =
                params.parse::<(String, serde_json::Value, String, u64,)>().map_err(|e| rpc_err(e.to_string()))?;
            gc_intents(ctx);
            let mut intents = ctx.intents.lock().unwrap();
            intents.insert(intent_id.clone(), PendingIntent {
                intent_id,
                payload,
                origin,
                created_at: now_millis(),
                ttl_ms,
                claimed_by: None,
                claimed_at: None,
                status: "pending".into(),
                result: None,
            });
            Ok::<_, ErrorObjectOwned>(true)
        })
        .unwrap();

    module
        .register_method("claim_intent", |params, ctx: &ServerCtx, _ext| {
            let (intent_id, client_id,): (String, String,) =
                params.parse::<(String, String,)>().map_err(|e| rpc_err(e.to_string()))?;
            gc_intents(ctx);
            let mut intents = ctx.intents.lock().unwrap();
            let rec = intents.get_mut(&intent_id).ok_or_else(|| rpc_err("intent not found"))?;
            if rec.status != "pending" {
                return Err(rpc_err(format!("intent {intent_id} already {} by another client", rec.status)));
            }
            rec.claimed_by = Some(client_id);
            rec.claimed_at = Some(now_millis());
            rec.status = "claimed".into();
            Ok::<_, ErrorObjectOwned>(rec.clone())
        })
        .unwrap();

    module
        .register_method("ack_intent", |params, ctx: &ServerCtx, _ext| {
            let (intent_id, client_id, result,): (String, String, Option<serde_json::Value>,) =
                params.parse::<(String, String, Option<serde_json::Value>,)>().map_err(|e| rpc_err(e.to_string()))?;
            gc_intents(ctx);
            let mut intents = ctx.intents.lock().unwrap();
            let rec = intents.get_mut(&intent_id).ok_or_else(|| rpc_err("intent not found"))?;
            // Only the claimer may ack, and only once.
            if rec.status != "claimed" || rec.claimed_by.as_deref() != Some(client_id.as_str()) {
                return Err(rpc_err(format!("intent {intent_id} not claimable by {client_id} (status={})", rec.status)));
            }
            rec.status = "done".into();
            rec.result = result;
            Ok::<_, ErrorObjectOwned>(true)
        })
        .unwrap();

    module
        .register_method("query_intent_status", |params, ctx: &ServerCtx, _ext| {
            let (intent_id,): (String,) =
                params.parse::<(String,)>().map_err(|e| rpc_err(e.to_string()))?;
            gc_intents(ctx);
            let intents = ctx.intents.lock().unwrap();
            let Some(rec) = intents.get(&intent_id) else {
                return Err(rpc_err("intent not found"));
            };
            Ok::<_, ErrorObjectOwned>(serde_json::json!({
                "status": rec.status,
                "payload": rec.payload,
                "result": rec.result,
                "claimed_by": rec.claimed_by,
            }))
        })
        .unwrap();

    // Event stream: pushes ServerEvents to the subscriber until it closes.
    // The subscriber carries its client_id (the GUI passes it) so that when the
    // subscription drops (GUI exit/crash → WS drop), the server can clean that
    // client's presence + session-status entries and tell the others it left —
    // otherwise a closed GUI's "open elsewhere" marker would linger on reopen.
    module
        .register_subscription(
            "subscribe_events",
            "event",
            "unsubscribe_events",
            |params, pending: PendingSubscriptionSink, ctx: Arc<ServerCtx>, _ext| async move {
                let (client_id,): (String,) = params.parse().unwrap_or(("".into(),));
                let mut rx = ctx.events_tx.subscribe();
                let sink = match pending.accept().await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                ctx.live.fetch_add(1, Ordering::SeqCst);
                // 有新 GUI 连上 → 取消待定的空闲退出
                if let Ok(mut d) = ctx.idle_deadline.lock() {
                    *d = None;
                }
                loop {
                    tokio::select! {
                        evt = rx.recv() => match evt {
                            Ok(evt) => {
                                let msg = match SubscriptionMessage::from_json(&evt) {
                                    Ok(m) => m,
                                    Err(_) => continue,
                                };
                                if sink.send(msg).await.is_err() { break; }
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        },
                        _ = sink.closed() => break,
                    }
                }
                // 断连(退出/崩溃) → 清该 client 的 presence 与会话状态, 防僵尸标记; 广播 Leave 让他 GUI 清理
                if !client_id.is_empty() {
                    if let Ok(mut reg) = ctx.registry.lock() {
                        reg.remove(&client_id);
                    }
                    let mut sessions = ctx.sessions.lock().unwrap();
                    session_status_reduce(&mut sessions, &SessionStatusEvent::ClientLeft { client_id: client_id.clone() });
                    let _ = ctx.events_tx.send(ServerEvent::Presence { event: PresenceEvent::Leave { client_id } });
                }
                ctx.live.fetch_sub(1, Ordering::SeqCst);
                if ctx.live.load(Ordering::SeqCst) == 0 {
                    if ctx.idle_grace {
                        // 正式运行：留宽限期，托盘在这期间仍可管理实例。
                        if let Ok(mut d) = ctx.idle_deadline.lock() {
                            *d = Some(std::time::Instant::now() + IDLE_GRACE);
                        }
                    } else {
                        // 测试 / 无托盘：保持原有语义 —— 立刻退出。
                        ctx.shutdown_tx.send_replace(true);
                    }
                }
            },
        )
        .unwrap();

    module
}

fn default_client() -> ClientInfo {
    ClientInfo {
        client_id: "?".into(),
        name: "?".into(),
        platform: "?".into(),
        workspace: "?".into(),
        joined_at: "?".into(),
    }
}

/// Start an in-process jsonrpsee WS server with a fresh context.
///
/// 测试用这一版：**空闲即退出**（不跑宽限期），行为与历史一致。
pub async fn spawn_server(
    addr: &str,
) -> Result<(ServerHandle, std::net::SocketAddr), Box<dyn std::error::Error + Send + Sync>> {
    let ctx = ServerCtx::new();
    spawn_server_with_ctx(addr, ctx, false).await
}

/// 带自有 ctx 的启动 —— `main` 用它把托盘挂到同一个 ctx 上。
///
/// `idle_grace` 决定"最后一个 GUI 断开后"的行为：
/// - `false`（测试）：立即 stop，保持原有语义
/// - `true`（正式）：等 `IDLE_GRACE` 再 stop，期间托盘仍可用
pub async fn spawn_server_with_ctx(
    addr: &str,
    mut ctx: ServerCtx,
    idle_grace: bool,
) -> Result<(ServerHandle, std::net::SocketAddr), Box<dyn std::error::Error + Send + Sync>> {
    ctx.idle_grace = idle_grace;
    let mut shutdown_rx = ctx.shutdown_tx.subscribe();
    let idle_deadline = ctx.idle_deadline.clone();
    let live = ctx.live.clone();

    // 启动即起算宽限期。
    //
    // 原来只在"最后一个 GUI 断开"时才设置 deadline —— 于是**从未有 GUI 连过**的
    // server（典型：GUI 拉起 server 后立刻崩溃/被杀）deadline 恒为 None，托盘会
    // 永久常驻。用户明确不希望后台长期挂着。真有 GUI 连上时，订阅事件会把它清掉
    // （见 unsubscribe_events 里的 fetch_add + `*d = None`）。
    if idle_grace {
        if let Ok(mut d) = idle_deadline.lock() {
            *d = Some(std::time::Instant::now() + IDLE_GRACE);
        }
    }

    let module = build_module(ctx);

    let server = ServerBuilder::default().ws_only().build(addr).await?;
    let bound = server.local_addr()?;
    let handle = server.start(module);

    // Lifecycle watcher: stop the server when the shutdown signal fires.
    let stop_handle = handle.clone();
    tokio::spawn(async move {
        loop {
            if *shutdown_rx.borrow() {
                break;
            }
            if shutdown_rx.changed().await.is_err() {
                break;
            }
        }
        let _ = stop_handle.stop();
    });

    // 空闲守卫：没有 GUI 时按宽限期退出（托盘常驻的代价与收益，见 idle_deadline）。
    if idle_grace {
        let grace_stop = handle.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if live.load(Ordering::SeqCst) != 0 {
                    continue;
                }
                let expired = match idle_deadline.lock() {
                    Ok(d) => d.map(|t| std::time::Instant::now() >= t).unwrap_or(false),
                    Err(_) => false,
                };
                if expired {
                    eprintln!("[server] 空闲超时（无 GUI 连接），退出");
                    let _ = grace_stop.stop();
                    break;
                }
            }
        });
    }

    Ok((handle, bound))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Fixed port via arg, default 8766. Bind-to-claim gives singleton: an
    // existing server owns the port, so a second process fails the bind and
    // reports "already running" (the GUI then attaches instead of spawning).
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|a| a.strip_prefix("--port=").map(|p| p.to_string()).or(Some(a)))
        .and_then(|a| a.parse().ok())
        .unwrap_or(8766);
    let addr = format!("127.0.0.1:{port}");

    // 先建 ctx：托盘要挂到同一个 ctx 上（读实例列表、发消息、触发退出）
    let ctx = ServerCtx::new();

    // ── 托盘（仅 Windows）──
    //
    // 放 server 而不是 GUI：GUI 多开会有多个托盘图标，server 是单实例。
    // 详见 src/tray.rs 顶部注释。
    #[cfg(windows)]
    let tray_handle = {
        let (actions_tx, mut actions_rx) = tokio::sync::mpsc::unbounded_channel::<tray::TrayAction>();

        let h = tray::spawn(actions_tx);

        if h.is_some() {
            // 动作处理器：结束进程 / 切前台 / 退出
            let ctx_for_actions = ctx.clone();
            tokio::spawn(async move {
                while let Some(action) = actions_rx.recv().await {
                    match action {
                        tray::TrayAction::Kill(pid) => {
                            eprintln!("[tray] 结束实例 pid={pid}");
                            claude_gui_shared::proc::kill_process_tree(pid);
                        }
                        tray::TrayAction::KillAll => {
                            // 只关 GUI，**不动 server 自己** —— 托盘的退出走「退出」那一项。
                            // 关完 live 归零，宽限期开始倒数（菜单里能看到剩余时间）。
                            let list = collect_gui_instances();
                            eprintln!("[tray] 关闭所有实例，共 {} 个", list.len());
                            for rec in list {
                                claude_gui_shared::proc::kill_process_tree(rec.pid);
                            }
                        }
                        tray::TrayAction::Focus(pid) => {
                            eprintln!("[tray] 切前台 pid={pid}");
                            // 授权 + 请目标实例自己 focus（同 wake 链路）
                            request_focus(&ctx_for_actions, pid);
                        }
                        tray::TrayAction::NewInstance => {
                            eprintln!("[tray] 新开一个 GUI 实例");
                            spawn_new_gui();
                        }
                        tray::TrayAction::Quit => {
                            eprintln!("[tray] 用户要求退出");
                            // 立即进入空闲退出：把 deadline 设成"现在"
                            if let Ok(mut d) = ctx_for_actions.idle_deadline.lock() {
                                *d = Some(std::time::Instant::now());
                            }
                            ctx_for_actions.shutdown_tx.send_replace(true);
                            break;
                        }
                    }
                }
            });

            // 定期刷新菜单（2s 一次，够快且开销可忽略）
            if let Some(ref th) = h {
                let th_tx = th.tx.clone();
                let th_tid = th.thread_id_for_hint();
                // 倒计时要读空闲截止时间 —— 与 server 的退出守卫同一个源，
                // 菜单里显示的剩余时间与真正的退出时刻必然一致。
                let idle_deadline = ctx.idle_deadline.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        // 没有 GUI 连着且截止时间已设 → 按整秒向上取整显示剩余。
                        // 向上取整是为了不出现「还剩 0 秒」却还没退出的那一帧。
                        let idle_remaining_secs = idle_deadline
                            .lock()
                            .ok()
                            .and_then(|d| *d)
                            .map(|t| {
                                let left = t.saturating_duration_since(std::time::Instant::now());
                                let ms = left.as_millis() as u64;
                                ms.div_ceil(1000)
                            });
                        let state = tray::TrayMenuState {
                            instances: collect_gui_instances(),
                            idle_remaining_secs,
                        };
                        if th_tx.send(tray::TrayCmd::Update(state)).is_err() {
                            break;
                        }
                        tray::wake_by_thread_id(th_tid);
                    }
                });
            }
        }
        h
    };

    let (handle, bound) = match spawn_server_with_ctx(&addr, ctx, true).await {
        Ok(v) => v,
        Err(_) => {
            eprintln!("claude-gui-server: {addr} already in use — another server is running. Exiting.");
            std::process::exit(2);
        }
    };
    println!("claude-gui-server listening on {bound}");
    handle.stopped().await;

    #[cfg(windows)]
    if let Some(th) = tray_handle {
        th.shutdown();
    }
    Ok(())
}

/// 从托盘「新建窗口」：拉起一个新的 GUI 实例。
///
/// 与 GUI 自己的 `spawn_gui_instance`（新建窗口按钮）走同一条路径 ——
/// 带 `--new-instance`，跳过单实例唤醒逻辑（否则会被"聚焦已有窗口"接管，
/// 用户点了"新建"却什么都不发生）。
#[cfg(windows)]
fn spawn_new_gui() {
    // GUI 与 server 装在同一个目录（server 由 GUI 拉起）
    let Ok(exe) = std::env::current_exe() else { return };
    let Some(dir) = exe.parent() else { return };
    let gui = dir.join("claude-code-gui.exe");
    if !gui.is_file() {
        eprintln!("[tray] 找不到 GUI 可执行文件: {}", gui.display());
        return;
    }
    match std::process::Command::new(&gui).arg("--new-instance").spawn() {
        Ok(_) => eprintln!("[tray] 已拉起新实例"),
        Err(e) => eprintln!("[tray] 拉起新实例失败: {e}"),
    }
}

/// 读出所有存活的 GUI 实例（托盘菜单用）。
fn collect_gui_instances() -> Vec<claude_gui_shared::instances::InstanceRecord> {
    let Some(dir) = claude_gui_shared::instances::app_data_dir_early() else {
        return Vec::new();
    };
    claude_gui_shared::instances::collect_live_instances(
        &dir,
        claude_gui_shared::instances::is_instance_alive,
    )
}

/// 请求某个 GUI 把窗口拉到前台。
///
/// 走 server 自己的 `GuiMessage` 通道：目标 GUI 收到 `focus:<pid>` 后会 show+focus。
#[cfg(windows)]
fn request_focus(ctx: &ServerCtx, target_pid: u32) {
    use claude_gui_shared::presence::GuiMessage;

    // 托盘进程是"当前前台"的可能性不高，但仍显式授权一次
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
        let _ = AllowSetForegroundWindow(target_pid);
    }

    let _ = ctx.events_tx.send(ServerEvent::GuiMessage {
        message: GuiMessage {
            from: "tray".into(),
            target: target_pid.to_string(),
            body: "focus:0".into(), // from_pid=0：托盘发起，不需要 ack
            at: now_iso(),
        },
    });
}

#[cfg(test)]
mod tests {
    use jsonrpsee::core::client::{ClientT, SubscriptionClientT};
    use super::*;

    async fn client_for(addr: std::net::SocketAddr) -> jsonrpsee::ws_client::WsClient {
        WsClientBuilder::default().build(format!("ws://{addr}")).await.unwrap()
    }

    fn info(id: &str, ws: &str) -> ClientInfo {
        ClientInfo {
            client_id: id.into(),
            name: format!("win-{id}"),
            platform: "win".into(),
            workspace: ws.into(),
            joined_at: "2026-01-01T00:00:00".into(),
        }
    }

    #[tokio::test]
    async fn ping_roundtrips_over_ws() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let client = client_for(addr).await;
        let reply: String = client.request("ping", ("hello",)).await.unwrap();
        assert_eq!(reply, "pong");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn register_then_list_filters_by_workspace() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let a = client_for(addr).await;
        let b = client_for(addr).await;
        a.request::<ClientInfo, _>("register_client", (info("A", "w1"),)).await.unwrap();
        b.request::<ClientInfo, _>("register_client", (info("B", "w2"),)).await.unwrap();

        let in_w1: Vec<ClientInfo> = a.request("list_clients", ("w1",)).await.unwrap();
        let in_w2: Vec<ClientInfo> = b.request("list_clients", ("w2",)).await.unwrap();
        assert_eq!(in_w1.len(), 1);
        assert_eq!(in_w1[0].client_id, "A");
        assert_eq!(in_w2.len(), 1);
        assert_eq!(in_w2[0].client_id, "B");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn presence_join_is_broadcast_to_subscriber() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let sub_client = client_for(addr).await;
        let prober = client_for(addr).await;

        let mut sub = sub_client
            .subscribe::<ServerEvent, _>("subscribe_events", ("w1",), "unsubscribe_events")
            .await
            .unwrap();

        // Registering a client should push a Presence::Join event on the stream.
        prober
            .request::<ClientInfo, _>("register_client", (info("C", "w1"),))
            .await
            .unwrap();

        let evt = sub.next().await.unwrap().unwrap();
        match evt {
            ServerEvent::Presence { event: PresenceEvent::Join { client } } => {
                assert_eq!(client.client_id, "C");
            }
            other => panic!("expected Presence::Join, got {other:?}"),
        }

        // Explicit leave should push a Presence::Leave.
        prober
            .request::<bool, _>("unregister_client", ("C",))
            .await
            .unwrap();
        let evt2 = sub.next().await.unwrap().unwrap();
        match evt2 {
            ServerEvent::Presence { event: PresenceEvent::Leave { client_id } } => {
                assert_eq!(client_id, "C");
            }
            other => panic!("expected Presence::Leave, got {other:?}"),
        }

        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn server_stops_when_last_subscription_closes() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let sub = c
            .subscribe::<ServerEvent, _>("subscribe_events", ("w1",), "unsubscribe_events")
            .await
            .unwrap();

        // Drop the subscription → the server should observe 0 live and stop.
        drop(sub);
        drop(c);

        let stopped = tokio::time::timeout(std::time::Duration::from_secs(3), handle.stopped()).await;
        assert!(stopped.is_ok(), "server did not stop after last subscription closed");
    }

    /// 宽限期模式：最后一个 GUI 断开后**不立即**退出（托盘要留着）。
    ///
    /// 这是 2026-10-27 的改动：托盘常驻在 server 里，如果照旧立刻退，
    /// 用户"找不到窗口"时连托盘也没了。
    #[tokio::test]
    async fn idle_grace_keeps_server_alive_after_last_subscription() {
        let ctx = ServerCtx::new();
        let (handle, addr) = spawn_server_with_ctx("127.0.0.1:0", ctx, true).await.unwrap();
        let c = client_for(addr).await;
        let sub = c
            .subscribe::<ServerEvent, _>("subscribe_events", ("w1",), "unsubscribe_events")
            .await
            .unwrap();
        drop(sub);
        drop(c);

        // 宽限期内不应停止
        let stopped =
            tokio::time::timeout(std::time::Duration::from_millis(800), handle.clone().stopped()).await;
        assert!(stopped.is_err(), "宽限期内不该退出 —— 托盘还要用");

        handle.stop().unwrap();
    }

    /// 启动即起算：**从未有 GUI 连过**的 server 也必须在宽限期后退出。
    ///
    /// 没有这条的话，GUI 拉起 server 后立刻崩溃 → 托盘图标永久挂在系统托盘上，
    /// 而用户看到的正是他最不想要的东西：「一个不知道哪来的、一直在的后台」。
    /// （这里只断言 deadline 已装好，因为真等 180 秒不现实。）
    #[tokio::test]
    async fn fresh_server_arms_idle_deadline_without_any_client() {
        let ctx = ServerCtx::new();
        let deadline = ctx.idle_deadline.clone();
        let (handle, _addr) = spawn_server_with_ctx("127.0.0.1:0", ctx, true).await.unwrap();

        let armed = *deadline.lock().unwrap();
        assert!(armed.is_some(), "启动时就必须起算，否则没人连过的 server 会永久常驻");

        handle.stop().unwrap();
    }

    /// 截止时间一过**真的会退出**（不真的等 180 秒 —— 把 deadline 设成过去）。
    ///
    /// 这条覆盖的是"用户能不能相信它会自己关"：单测只能证明 deadline 装上了，
    /// 证明不了守卫真的在读它。
    #[tokio::test]
    async fn expired_deadline_shuts_the_server_down() {
        let ctx = ServerCtx::new();
        // 先埋一个"已经过期"的截止时间，再起 server。
        // 注意 spawn 内部在 idle_grace 时会把 deadline 重置成 now+IDLE_GRACE，
        // 所以这里改用"起完之后再改"的方式（守卫每秒读一次）。
        let deadline = ctx.idle_deadline.clone();
        let (handle, _addr) = spawn_server_with_ctx("127.0.0.1:0", ctx, true).await.unwrap();

        {
            let mut d = deadline.lock().unwrap();
            *d = Some(std::time::Instant::now() - std::time::Duration::from_secs(1));
        }

        let stopped = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            handle.clone().stopped(),
        )
        .await;
        assert!(stopped.is_ok(), "deadline 过期后守卫应当退出，但 5 秒内没停");
    }

    /// 不启用宽限（测试/无托盘）时**不**装 deadline —— 保持原有"断开即退"语义。
    #[tokio::test]
    async fn no_grace_mode_leaves_deadline_unarmed() {
        let ctx = ServerCtx::new();
        let deadline = ctx.idle_deadline.clone();
        let (handle, _addr) = spawn_server_with_ctx("127.0.0.1:0", ctx, false).await.unwrap();

        assert!(deadline.lock().unwrap().is_none());
        handle.stop().unwrap();
    }

    /// 宽限期内重新连上 → 取消待定退出。
    #[tokio::test]
    async fn reconnect_cancels_idle_shutdown() {
        let ctx = ServerCtx::new();
        let (handle, addr) = spawn_server_with_ctx("127.0.0.1:0", ctx, true).await.unwrap();

        let c1 = client_for(addr).await;
        let sub1 = c1
            .subscribe::<ServerEvent, _>("subscribe_events", ("w1",), "unsubscribe_events")
            .await
            .unwrap();
        drop(sub1);
        drop(c1);

        // 立刻重连（相当于用户重新打开 GUI）
        let c2 = client_for(addr).await;
        let sub2 = c2
            .subscribe::<ServerEvent, _>("subscribe_events", ("w1",), "unsubscribe_events")
            .await
            .unwrap();

        let stopped =
            tokio::time::timeout(std::time::Duration::from_millis(800), handle.clone().stopped()).await;
        assert!(stopped.is_err(), "有 GUI 连着时不该退出");

        drop(sub2);
        drop(c2);
        handle.stop().unwrap();
    }

    // ── ticket 03: per-workspace SQLite, mutate (LWW) + list ──

    use std::sync::atomic::{AtomicUsize, Ordering as SyncOrdering};
    static WS_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_ws(label: &str) -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = WS_SEQ.fetch_add(1, SyncOrdering::SeqCst);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("claude-server-t3-{label}-{n}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn desktop_json(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "name": "test", "pan_x": 0.0, "pan_y": 0.0, "zoom": 1.0,
            "show_grid": true, "grid_size": 20, "snap_to_grid": false, "sort_order": 0,
            "created_at": "2026-01-01T00:00:00", "updated_at": "2026-01-01T00:00:00",
            "items": [], "connections": []
        })
    }

    fn plan_json(id: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "session_id": "s1", "session_title": "t",
            "tasks_json": "[]", "plan_text": "x"})
    }

    fn mutate_req(ws: &str, entity: &str, base: &str, payload: serde_json::Value) -> MutateReq {
        MutateReq {
            workspace: ws.into(),
            entity: entity.into(),
            base_updated_at: base.into(),
            origin: String::new(),
            payload,
        }
    }

    #[tokio::test]
    async fn mutate_desktop_then_list() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let ws = temp_ws("mutate-desktop");
        let res: serde_json::Value =
            c.request("mutate", (mutate_req(&ws, "desktop", "", desktop_json("d1")),)).await.unwrap();
        assert_eq!(res["superseded"], false);
        assert!(!res["updated_at"].as_str().unwrap().is_empty());
        let desktops: Vec<shared::DesktopRecord> = c.request("list_desktops", (ws,)).await.unwrap();
        assert_eq!(desktops.len(), 1);
        assert_eq!(desktops[0].id, "d1");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn lww_superseded_detected() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let ws = temp_ws("lww");
        let r1: serde_json::Value =
            c.request("mutate", (mutate_req(&ws, "desktop", "", desktop_json("d2")),)).await.unwrap();
        assert_eq!(r1["superseded"], false);
        assert!(!r1["updated_at"].as_str().unwrap().is_empty());

        // Stale base → superseded (and writes a new version stamp).
        let r2: serde_json::Value =
            c.request("mutate", (mutate_req(&ws, "desktop", "STALE", desktop_json("d2")),)).await.unwrap();
        assert_eq!(r2["superseded"], true);
        let v2 = r2["updated_at"].as_str().unwrap().to_string();

        // The latest base → not superseded.
        let r3: serde_json::Value =
            c.request("mutate", (mutate_req(&ws, "desktop", &v2, desktop_json("d2")),)).await.unwrap();
        assert_eq!(r3["superseded"], false);

        // Empty base on an EXISTING record → NOT superseded (the client had no
        // version stamp; don't falsely flag every save of an existing row).
        let r4: serde_json::Value =
            c.request("mutate", (mutate_req(&ws, "desktop", "", desktop_json("d2")),)).await.unwrap();
        assert_eq!(r4["superseded"], false);
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn workspace_isolation() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let ws1 = temp_ws("iso-1");
        let ws2 = temp_ws("iso-2");
        let _: serde_json::Value =
            c.request("mutate", (mutate_req(&ws1, "desktop", "", desktop_json("iso")),)).await.unwrap();
        let d1: Vec<shared::DesktopRecord> = c.request("list_desktops", (ws1,)).await.unwrap();
        let d2: Vec<shared::DesktopRecord> = c.request("list_desktops", (ws2,)).await.unwrap();
        assert_eq!(d1.len(), 1);
        assert_eq!(d2.len(), 0);
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn mutate_plan_then_list() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let ws = temp_ws("plan");
        let _: serde_json::Value =
            c.request("mutate", (mutate_req(&ws, "plan", "", plan_json("p1")),)).await.unwrap();
        let plans: Vec<shared::PlanRecord> =
            c.request("list_plans", (ws, 0u32, 10u32)).await.unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].id, "p1");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn db_changed_broadcast_to_subscriber() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let sub = client_for(addr).await;
        let prober = client_for(addr).await;
        let ws = temp_ws("dbchg");

        let mut stream = sub
            .subscribe::<ServerEvent, _>("subscribe_events", (ws.clone(),), "unsubscribe_events")
            .await
            .unwrap();

        let origin = "gui-A";
        let mut req = mutate_req(&ws, "desktop", "", desktop_json("dbx"));
        req.origin = origin.into();
        let _: serde_json::Value = prober.request("mutate", (req,)).await.unwrap();

        let evt = stream.next().await.unwrap().unwrap();
        match evt {
            ServerEvent::DbChanged { change } => {
                assert_eq!(change.entity, "desktop");
                assert_eq!(change.id, "dbx");
                assert_eq!(change.origin, origin);
                assert_eq!(change.op, "upsert");
            }
            other => panic!("expected DbChanged, got {other:?}"),
        }
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn sessions_changed_broadcasts_db_changed_session() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let sub = client_for(addr).await;
        let sender = client_for(addr).await;
        let ws = temp_ws("sess");

        let mut stream = sub
            .subscribe::<ServerEvent, _>("subscribe_events", (ws,), "unsubscribe_events")
            .await
            .unwrap();

        let origin = "gui-A";
        let _: bool = sender.request("sessions_changed", (origin,)).await.unwrap();
        let evt = stream.next().await.unwrap().unwrap();
        match evt {
            ServerEvent::DbChanged { change } => {
                assert_eq!(change.entity, "session");
                assert_eq!(change.origin, origin);
                assert_eq!(change.op, "changed");
            }
            other => panic!("expected DbChanged session, got {other:?}"),
        }
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn session_status_report_broadcasts_and_snapshot() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let sub = client_for(addr).await;
        let sender = client_for(addr).await;
        let ws = temp_ws("stat");

        let mut stream = sub
            .subscribe::<ServerEvent, _>("subscribe_events", (ws.clone(),), "unsubscribe_events")
            .await
            .unwrap();

        let status = SessionStatus {
            workspace: ws.clone(),
            session_id: "S1".into(),
            state: claude_gui_shared::presence::SessionState::Working,
            client_id: "gui-A".into(),
        };
        let _: bool = sender.request("session_status_report", (status.clone(),)).await.unwrap();

        let evt = stream.next().await.unwrap().unwrap();
        match evt {
            ServerEvent::SessionStatusChanged { status: got } => {
                assert_eq!(got.session_id, "S1");
                assert_eq!(got.client_id, "gui-A");
                assert_eq!(got.state, claude_gui_shared::presence::SessionState::Working);
            }
            other => panic!("expected SessionStatusChanged, got {other:?}"),
        }

        // Snapshot returns the report for this workspace; a different workspace stays empty.
        let list: Vec<SessionStatus> = sender.request("get_session_statuses", (ws.clone(),)).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].session_id, "S1");
        let other: Vec<SessionStatus> = sender.request("get_session_statuses", (temp_ws("other"),)).await.unwrap();
        assert!(other.is_empty());
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn settings_changed_broadcasts_db_changed_settings() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let sub = client_for(addr).await;
        let sender = client_for(addr).await;
        let ws = temp_ws("set");

        let mut stream = sub
            .subscribe::<ServerEvent, _>("subscribe_events", (ws,), "unsubscribe_events")
            .await
            .unwrap();

        let origin = "gui-A";
        let _: bool = sender.request("settings_changed", (origin,)).await.unwrap();
        let evt = stream.next().await.unwrap().unwrap();
        match evt {
            ServerEvent::DbChanged { change } => {
                assert_eq!(change.entity, "settings");
                assert_eq!(change.origin, origin);
                assert_eq!(change.op, "changed");
            }
            other => panic!("expected DbChanged settings, got {other:?}"),
        }
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn gui_message_kind_reaches_subscriber() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let sub = client_for(addr).await;
        let sender = client_for(addr).await;
        let ws = temp_ws("msg");

        let mut stream = sub
            .subscribe::<ServerEvent, _>("subscribe_events", (ws,), "unsubscribe_events")
            .await
            .unwrap();

        let _: bool = sender.request("send_gui_message", ("gui-A", "", "hello world")).await.unwrap();
        let evt = stream.next().await.unwrap().unwrap();
        match evt {
            ServerEvent::GuiMessage { message } => {
                assert_eq!(message.from, "gui-A");
                assert_eq!(message.body, "hello world");
            }
            other => panic!("expected GuiMessage, got {other:?}"),
        }
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn note_crud_and_db_changed_broadcast() {
        // Point the note store at an isolated temp DB so this never touches the
        // real user notes. Env is read lazily inside the first note RPC.
        let notes_path = temp_notes_db();
        std::env::set_var("CLAUDE_GUI_NOTES_DB", &notes_path);
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;

        let new_note: note::Note = c
            .request("note_create", (
                note::NoteInput {
                    title: "t".into(), content: "c".into(), scope: "global".into(), tags: vec![],
                    action: None, merged_content: None, target_ids: None,
                },
                "gui-A".to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(new_note.title, "t");

        let list: Vec<note::NoteSummary> =
            c.request("note_list", (None::<String>, None::<String>, Some(10u32))).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, new_note.id);

        // Subscribe, then update → a db_changed{entity:"note", origin:"gui-A"}.
        let mut stream = c
            .subscribe::<ServerEvent, _>("subscribe_events", ("w1",), "unsubscribe_events")
            .await
            .unwrap();
        let updated: note::Note = c
            .request("note_update", (
                new_note.id.clone(),
                note::NoteUpdate { title: Some("t2".into()), content: None, scope: None, tags: None },
                "gui-A".to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(updated.title, "t2");

        let evt = stream.next().await.unwrap().unwrap();
        match evt {
            ServerEvent::DbChanged { change } => {
                assert_eq!(change.entity, "note");
                assert_eq!(change.id, new_note.id);
                assert_eq!(change.origin, "gui-A");
                assert_eq!(change.op, "upsert");
            }
            other => panic!("expected DbChanged note, got {other:?}"),
        }

        let del: bool = c
            .request("note_delete", (new_note.id.clone(), "gui-A".to_string()))
            .await
            .unwrap();
        assert!(del);
        let list2: Vec<note::NoteSummary> =
            c.request("note_list", (None::<String>, None::<String>, Some(10u32))).await.unwrap();
        assert_eq!(list2.len(), 0);
        handle.stop().unwrap();
    }

    fn temp_notes_db() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("claude-server-note-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("notes.db").to_string_lossy().to_string()
    }

    // ── ticket 01: startup intent rendezvous (publish → claim → ack → query) ──

    fn intent_payload(ws: &str, session_id: &str) -> serde_json::Value {
        serde_json::json!({"workspace": ws, "kind": "open_session", "session_id": session_id})
    }

    #[tokio::test]
    async fn intent_publish_claim_ack_query_roundtrip() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let id = "intent-uuid-1";
        let ws = temp_ws("intent-rt");

        let _: bool = c
            .request("publish_intent", (id.to_string(), intent_payload(&ws, "sess-9"), "gui-A".to_string(), 60000u64))
            .await
            .unwrap();

        // Claim: atomic — returns the payload and marks claimed_by.
        let claimed: PendingIntent = c
            .request("claim_intent", (id.to_string(), "gui-B".to_string()))
            .await
            .unwrap();
        assert_eq!(claimed.status, "claimed");
        assert_eq!(claimed.claimed_by.as_deref(), Some("gui-B"));
        assert_eq!(claimed.payload["workspace"], ws);
        assert_eq!(claimed.payload["session_id"], "sess-9");

        // Ack by claimer marks done with result.
        let _: bool = c
            .request("ack_intent", (id.to_string(), "gui-B".to_string(), Some(serde_json::json!({"ok": true}))))
            .await
            .unwrap();

        let status: serde_json::Value =
            c.request("query_intent_status", (id.to_string(),)).await.unwrap();
        assert_eq!(status["status"], "done");
        assert_eq!(status["result"]["ok"], true);
        assert_eq!(status["claimed_by"], "gui-B");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn intent_claim_is_atomic_second_claimer_rejected() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let id = "intent-uuid-2";
        let ws = temp_ws("intent-atomic");

        let _: bool = c
            .request("publish_intent", (id.to_string(), intent_payload(&ws, "s1"), "gui-A".to_string(), 60000u64))
            .await
            .unwrap();

        let _: PendingIntent = c.request("claim_intent", (id.to_string(), "gui-B".to_string())).await.unwrap();
        // Second claim (even by a different client) must fail.
        let dup = c.request::<PendingIntent, _>("claim_intent", (id.to_string(), "gui-C".to_string())).await;
        assert!(dup.is_err(), "second claim must be rejected");

        // Non-claimer cannot ack.
        let bad_ack = c.request::<bool, _>("ack_intent", (id.to_string(), "gui-C".to_string(), None::<serde_json::Value>)).await;
        assert!(bad_ack.is_err(), "non-claimer ack must be rejected");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn intent_publish_with_same_id_overwrites() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let id = "intent-uuid-3";
        let ws = temp_ws("intent-overwrite");

        let _: bool = c
            .request("publish_intent", (id.to_string(), intent_payload(&ws, "v1"), "gui-A".to_string(), 60000u64))
            .await
            .unwrap();
        // Re-publish same id with a fresh payload overwrites (status resets to pending).
        let _: bool = c
            .request("publish_intent", (id.to_string(), intent_payload(&ws, "v2"), "gui-A".to_string(), 60000u64))
            .await
            .unwrap();
        let claimed: PendingIntent = c.request("claim_intent", (id.to_string(), "gui-B".to_string())).await.unwrap();
        assert_eq!(claimed.payload["session_id"], "v2");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn intent_ttl_expires_and_claim_of_expired_fails() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let id = "intent-ttl-1";
        let ws = temp_ws("intent-ttl");

        let _: bool = c
            .request("publish_intent", (id.to_string(), intent_payload(&ws, "s1"), "gui-A".to_string(), 50u64))
            .await
            .unwrap();

        // Let the TTL elapse, then the intent must be gone (GC on next op).
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let st = c.request::<serde_json::Value, _>("query_intent_status", (id.to_string(),)).await;
        assert!(st.is_err(), "expired intent should be GC'd");

        // Claiming an expired/unknown id fails too.
        let claim = c.request::<PendingIntent, _>("claim_intent", (id, "gui-B".to_string())).await;
        assert!(claim.is_err(), "claim of expired intent must fail");
        handle.stop().unwrap();
    }

    #[tokio::test]
    async fn intent_claimed_then_ttl_elapses_reports_expired() {
        let (handle, addr) = spawn_server("127.0.0.1:0").await.unwrap();
        let c = client_for(addr).await;
        let id = "intent-exp-claimed";
        let ws = temp_ws("intent-exp");

        let _: bool = c
            .request("publish_intent", (id.to_string(), intent_payload(&ws, "s1"), "gui-A".to_string(), 50u64))
            .await
            .unwrap();
        let _: PendingIntent = c.request("claim_intent", (id.to_string(), "gui-B".to_string())).await.unwrap();

        // Claimed but never acked; let the TTL elapse → must surface "expired",
        // not vanish (spec §5.3: claimed 超时未 ack → 标记 expired).
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let st: serde_json::Value = c.request("query_intent_status", (id.to_string(),)).await.unwrap();
        assert_eq!(st["status"], "expired");

        // A late ack is rejected (no longer claimable).
        let ack = c.request::<bool, _>("ack_intent", (id.to_string(), "gui-B".to_string(), None::<serde_json::Value>)).await;
        assert!(ack.is_err(), "ack of expired intent must fail");
        handle.stop().unwrap();
    }
}
