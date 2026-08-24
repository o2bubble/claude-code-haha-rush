use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

/// A saved plan record.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanRecord {
    pub id: String,
    pub session_id: String,
    pub session_title: String,
    pub tasks_json: String,
    pub plan_text: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Summary of plans grouped by session.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanSession {
    pub session_id: String,
    pub title: String,
    pub plan_count: u32,
    pub latest_at: String,
}

/// Input for saving a plan.
#[derive(Debug, Deserialize)]
pub struct PlanInput {
    pub id: String,
    pub session_id: String,
    #[serde(default)]
    pub session_title: String,
    #[serde(default)]
    pub tasks_json: String,
    #[serde(default)]
    pub plan_text: String,
}

pub fn init_db(db_path: &str) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plans (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL,
            session_title TEXT DEFAULT '',
            tasks_json  TEXT NOT NULL DEFAULT '[]',
            plan_text   TEXT DEFAULT '',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);
        CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at DESC);

        CREATE TABLE IF NOT EXISTS desktops (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            pan_x       REAL DEFAULT 0,
            pan_y       REAL DEFAULT 0,
            zoom        REAL DEFAULT 1,
            show_grid   INTEGER DEFAULT 1,
            grid_size   INTEGER DEFAULT 20,
            sort_order  INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS desktop_items (
            id          TEXT PRIMARY KEY,
            desktop_id  TEXT NOT NULL REFERENCES desktops(id) ON DELETE CASCADE,
            x           REAL,
            y           REAL,
            width       REAL,
            height      REAL,
            z_index     INTEGER DEFAULT 0,
            content_type TEXT NOT NULL,
            content_json TEXT NOT NULL,
            label       TEXT,
            color       TEXT,
            collapsed   INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_items_desktop ON desktop_items(desktop_id);

        CREATE TABLE IF NOT EXISTS desktop_connections (
            id          TEXT PRIMARY KEY,
            desktop_id  TEXT NOT NULL REFERENCES desktops(id) ON DELETE CASCADE,
            from_item_id TEXT NOT NULL,
            from_side   TEXT NOT NULL,
            to_item_id  TEXT NOT NULL,
            to_side     TEXT NOT NULL,
            label       TEXT,
            stroke_color TEXT,
            stroke_width REAL,
            stroke_dasharray TEXT,
            created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_connections_desktop ON desktop_connections(desktop_id);

        CREATE TABLE IF NOT EXISTS desktop_history (
            desktop_id   TEXT PRIMARY KEY REFERENCES desktops(id) ON DELETE CASCADE,
            undo_json    TEXT NOT NULL DEFAULT '[]',
            redo_json    TEXT NOT NULL DEFAULT '[]',
            updated_at   TEXT NOT NULL
        );"
    ).map_err(|e| format!("Failed to create tables: {}", e))?;

    // Migration: add snap_to_grid column (ignore error if already exists)
    let _ = conn.execute("ALTER TABLE desktops ADD COLUMN snap_to_grid INTEGER DEFAULT 0", []);

    Ok(conn)
}

pub fn save_plan(conn: &Connection, input: &PlanInput) -> Result<(), String> {
    let now = chrono_now();
    conn.execute(
        "INSERT INTO plans (id, session_id, session_title, tasks_json, plan_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           session_title = excluded.session_title,
           tasks_json = excluded.tasks_json,
           plan_text = excluded.plan_text,
           updated_at = excluded.updated_at",
        params![input.id, input.session_id, input.session_title, input.tasks_json, input.plan_text, now, now],
    ).map_err(|e| format!("Failed to save plan: {}", e))?;
    Ok(())
}

pub fn get_plans(conn: &Connection, offset: u32, limit: u32) -> Result<Vec<PlanRecord>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, session_title, tasks_json, plan_text, created_at, updated_at
         FROM plans ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt.query_map(params![limit, offset], |row| {
        Ok(PlanRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            session_title: row.get(2)?,
            tasks_json: row.get(3)?,
            plan_text: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    }).map_err(|e| format!("Failed to query plans: {}", e))?;

    let mut plans = Vec::new();
    for row in rows {
        plans.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(plans)
}

pub fn get_plan_sessions(conn: &Connection) -> Result<Vec<PlanSession>, String> {
    let mut stmt = conn.prepare(
        "SELECT session_id, MAX(session_title) as title, COUNT(*) as plan_count, MAX(created_at) as latest_at
         FROM plans GROUP BY session_id ORDER BY latest_at DESC"
    ).map_err(|e| format!("Failed to prepare session query: {}", e))?;

    let rows = stmt.query_map([], |row| {
        Ok(PlanSession {
            session_id: row.get(0)?,
            title: row.get(1)?,
            plan_count: row.get(2)?,
            latest_at: row.get(3)?,
        })
    }).map_err(|e| format!("Failed to query sessions: {}", e))?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(sessions)
}

fn chrono_now() -> String {
    // Simple ISO 8601 without pulling in the chrono crate
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Convert unix timestamp to a basic ISO string
    // Format: YYYY-MM-DDTHH:MM:SS
    let days_since_epoch = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Calculate year/month/day from days since epoch (1970-01-01)
    let mut y = 1970i64;
    let mut d = days_since_epoch as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if d < days_in_year { break; }
        d -= days_in_year;
        y += 1;
    }
    let m_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0usize;
    for (i, &md) in m_days.iter().enumerate() {
        if d < md as i64 { m = i; break; }
        d -= md as i64;
        m = i + 1;
    }
    let month = m + 1;
    let day = d + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", y, month, day, hours, minutes, seconds)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// ── Desktop records ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DesktopRecord {
    pub id: String,
    pub name: String,
    pub pan_x: f64,
    pub pan_y: f64,
    pub zoom: f64,
    pub show_grid: bool,
    pub grid_size: i32,
    pub snap_to_grid: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
    pub items: Vec<ItemRecord>,
    pub connections: Vec<ConnectionRecord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ItemRecord {
    pub id: String,
    pub desktop_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i32,
    pub content_type: String,
    pub content_json: String,
    pub label: String,
    pub color: Option<String>,
    pub collapsed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionRecord {
    pub id: String,
    pub desktop_id: String,
    pub from_item_id: String,
    pub from_side: String,
    pub to_item_id: String,
    pub to_side: String,
    pub label: Option<String>,
    pub stroke_color: Option<String>,
    pub stroke_width: Option<f64>,
    pub stroke_dasharray: Option<String>,
    pub created_at: String,
}

// ── Desktop CRUD ──

pub fn save_desktop(conn: &Connection, rec: &DesktopRecord) -> Result<(), String> {
    let now = chrono_now();
    conn.execute(
        "INSERT INTO desktops (id, name, pan_x, pan_y, zoom, show_grid, grid_size, snap_to_grid, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           pan_x = excluded.pan_x, pan_y = excluded.pan_y, zoom = excluded.zoom,
           show_grid = excluded.show_grid, grid_size = excluded.grid_size,
           snap_to_grid = excluded.snap_to_grid,
           sort_order = excluded.sort_order, updated_at = excluded.updated_at",
        params![rec.id, rec.name, rec.pan_x, rec.pan_y, rec.zoom,
                rec.show_grid as i32, rec.grid_size, rec.snap_to_grid as i32, rec.sort_order, now, now],
    ).map_err(|e| format!("Failed to save desktop: {}", e))?;

    // Delete old items and connections for this desktop, then re-insert
    conn.execute("DELETE FROM desktop_items WHERE desktop_id = ?1", params![rec.id])
        .map_err(|e| format!("Failed to clear items: {}", e))?;
    conn.execute("DELETE FROM desktop_connections WHERE desktop_id = ?1", params![rec.id])
        .map_err(|e| format!("Failed to clear connections: {}", e))?;

    for item in &rec.items {
        save_item(conn, item)?;
    }
    for conn_rec in &rec.connections {
        save_connection(conn, conn_rec)?;
    }
    Ok(())
}

fn save_item(conn: &Connection, rec: &ItemRecord) -> Result<(), String> {
    let now = chrono_now();
    conn.execute(
        "INSERT INTO desktop_items (id, desktop_id, x, y, width, height, z_index,
         content_type, content_json, label, color, collapsed, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height,
           z_index = excluded.z_index, content_type = excluded.content_type,
           content_json = excluded.content_json, label = excluded.label,
           color = excluded.color, collapsed = excluded.collapsed,
           updated_at = excluded.updated_at",
        params![rec.id, rec.desktop_id, rec.x, rec.y, rec.width, rec.height, rec.z_index,
                rec.content_type, rec.content_json, rec.label, rec.color,
                rec.collapsed as i32, now, now],
    ).map_err(|e| format!("Failed to save item: {}", e))?;
    Ok(())
}

fn save_connection(conn: &Connection, rec: &ConnectionRecord) -> Result<(), String> {
    let now = chrono_now();
    conn.execute(
        "INSERT INTO desktop_connections (id, desktop_id, from_item_id, from_side,
         to_item_id, to_side, label, stroke_color, stroke_width, stroke_dasharray, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           from_item_id = excluded.from_item_id, from_side = excluded.from_side,
           to_item_id = excluded.to_item_id, to_side = excluded.to_side,
           label = excluded.label, stroke_color = excluded.stroke_color,
           stroke_width = excluded.stroke_width, stroke_dasharray = excluded.stroke_dasharray",
        params![rec.id, rec.desktop_id, rec.from_item_id, rec.from_side,
                rec.to_item_id, rec.to_side, rec.label, rec.stroke_color,
                rec.stroke_width, rec.stroke_dasharray, now],
    ).map_err(|e| format!("Failed to save connection: {}", e))?;
    Ok(())
}

pub fn get_desktops(conn: &Connection) -> Result<Vec<DesktopRecord>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, name, pan_x, pan_y, zoom, show_grid, grid_size, snap_to_grid, sort_order, created_at, updated_at
         FROM desktops ORDER BY sort_order ASC, created_at ASC"
    ).map_err(|e| format!("Failed to prepare desktop query: {}", e))?;

    let desktop_rows: Vec<DesktopRecord> = stmt.query_map([], |row| {
        Ok(DesktopRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            pan_x: row.get(2)?,
            pan_y: row.get(3)?,
            zoom: row.get(4)?,
            show_grid: row.get::<_, i32>(5)? != 0,
            grid_size: row.get(6)?,
            snap_to_grid: row.get::<_, i32>(7)? != 0,
            sort_order: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            items: Vec::new(),
            connections: Vec::new(),
        })
    }).map_err(|e| format!("Failed to query desktops: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    let mut result = Vec::new();
    for mut d in desktop_rows {
        d.items = get_items_for_desktop(conn, &d.id)?;
        d.connections = get_connections_for_desktop(conn, &d.id)?;
        result.push(d);
    }
    Ok(result)
}

fn get_items_for_desktop(conn: &Connection, desktop_id: &str) -> Result<Vec<ItemRecord>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, desktop_id, x, y, width, height, z_index, content_type,
                content_json, label, color, collapsed, created_at, updated_at
         FROM desktop_items WHERE desktop_id = ?1 ORDER BY z_index ASC"
    ).map_err(|e| format!("Failed to prepare items query: {}", e))?;

    let rows = stmt.query_map(params![desktop_id], |row| {
        Ok(ItemRecord {
            id: row.get(0)?,
            desktop_id: row.get(1)?,
            x: row.get(2)?,
            y: row.get(3)?,
            width: row.get(4)?,
            height: row.get(5)?,
            z_index: row.get(6)?,
            content_type: row.get(7)?,
            content_json: row.get(8)?,
            label: row.get(9)?,
            color: row.get(10)?,
            collapsed: row.get::<_, i32>(11)? != 0,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        })
    }).map_err(|e| format!("Failed to query items: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(items)
}

fn get_connections_for_desktop(conn: &Connection, desktop_id: &str) -> Result<Vec<ConnectionRecord>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, desktop_id, from_item_id, from_side, to_item_id, to_side,
                label, stroke_color, stroke_width, stroke_dasharray, created_at
         FROM desktop_connections WHERE desktop_id = ?1"
    ).map_err(|e| format!("Failed to prepare connections query: {}", e))?;

    let rows = stmt.query_map(params![desktop_id], |row| {
        Ok(ConnectionRecord {
            id: row.get(0)?,
            desktop_id: row.get(1)?,
            from_item_id: row.get(2)?,
            from_side: row.get(3)?,
            to_item_id: row.get(4)?,
            to_side: row.get(5)?,
            label: row.get(6)?,
            stroke_color: row.get(7)?,
            stroke_width: row.get(8)?,
            stroke_dasharray: row.get(9)?,
            created_at: row.get(10)?,
        })
    }).map_err(|e| format!("Failed to query connections: {}", e))?;

    let mut conns = Vec::new();
    for row in rows {
        conns.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(conns)
}

pub fn delete_desktop(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM desktop_connections WHERE desktop_id = ?1", params![id])
        .map_err(|e| format!("Failed to delete connections: {}", e))?;
    conn.execute("DELETE FROM desktop_items WHERE desktop_id = ?1", params![id])
        .map_err(|e| format!("Failed to delete items: {}", e))?;
    conn.execute("DELETE FROM desktops WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete desktop: {}", e))?;
    delete_desktop_history(conn, id)?;
    Ok(())
}

// ── Desktop history persistence ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DesktopHistoryRecord {
    pub desktop_id: String,
    pub undo_json: String,
    pub redo_json: String,
}

pub fn save_desktop_history(conn: &Connection, desktop_id: &str, undo_json: &str, redo_json: &str) -> Result<(), String> {
    let now = chrono_now();
    conn.execute(
        "INSERT INTO desktop_history (desktop_id, undo_json, redo_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(desktop_id) DO UPDATE SET
           undo_json = excluded.undo_json,
           redo_json = excluded.redo_json,
           updated_at = excluded.updated_at",
        params![desktop_id, undo_json, redo_json, now],
    ).map_err(|e| format!("Failed to save history: {}", e))?;
    Ok(())
}

pub fn load_desktop_history(conn: &Connection, desktop_id: &str) -> Result<Option<DesktopHistoryRecord>, String> {
    let mut stmt = conn.prepare(
        "SELECT desktop_id, undo_json, redo_json FROM desktop_history WHERE desktop_id = ?1"
    ).map_err(|e| format!("Failed to prepare history query: {}", e))?;

    let mut rows = stmt.query_map(params![desktop_id], |row| {
        Ok(DesktopHistoryRecord {
            desktop_id: row.get(0)?,
            undo_json: row.get(1)?,
            redo_json: row.get(2)?,
        })
    }).map_err(|e| format!("Failed to query history: {}", e))?;

    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| format!("Row error: {}", e))?)),
        None => Ok(None),
    }
}

pub fn delete_desktop_history(conn: &Connection, desktop_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM desktop_history WHERE desktop_id = ?1", params![desktop_id])
        .map_err(|e| format!("Failed to delete history: {}", e))?;
    Ok(())
}
