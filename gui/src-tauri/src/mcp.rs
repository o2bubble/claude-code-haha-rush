/// Lightweight MCP (Model Context Protocol) server embedded in the Tauri process.
///
/// Architecture:
///   HTTP Client → TCP Listener → emit Tauri event "mcp-request" → JS bridge
///   JS bridge dispatches to store → calls "mcp_response" Tauri command → channel → HTTP response
///
/// Uses a oneshot channel per request, keyed by request_id, for async request/response bridging.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, mpsc, OnceLock};
use std::thread;

use tauri::Emitter;

type PendingMap = Arc<Mutex<HashMap<String, mpsc::Sender<String>>>>;

/// The global pending-request map. Populated by the server thread, consumed by `mcp_response`.
static PENDING: OnceLock<PendingMap> = OnceLock::new();
static MCP_PORT: OnceLock<u16> = OnceLock::new();

fn pending() -> &'static PendingMap {
    PENDING.get().expect("MCP server not initialized")
}

pub fn mcp_port() -> u16 {
    *MCP_PORT.get().unwrap_or(&0)
}

/// Start the MCP HTTP server in a background thread. Returns the assigned port.
/// Binds the first free port starting at 13920 so multiple GUI instances can
/// each run their own embedded MCP server (multi-workspace support).
pub fn start_mcp_server(app_handle: tauri::AppHandle) -> u16 {
    let mut bound: Option<TcpListener> = None;
    for port in 13920..=14000 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            bound = Some(listener);
            break;
        }
    }
    let listener = bound
        .unwrap_or_else(|| panic!("MCP server: no free port in 13920-14000. Close another GUI instance."));
    let port = listener.local_addr().unwrap().port();
    let map: PendingMap = Arc::new(Mutex::new(HashMap::new()));

    PENDING.set(map.clone()).ok();
    MCP_PORT.set(port).ok();

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app_handle.clone();
                    let map = map.clone();
                    thread::spawn(move || handle_request(stream, app, map));
                }
                Err(_) => break,
            }
        }
    });

    port
}

fn handle_request(mut stream: TcpStream, app: tauri::AppHandle, pending: PendingMap) {
    let raw = read_http_request(&mut stream);
    if raw.trim().is_empty() {
        return;
    }

    let (method, path, body) = parse_http(&raw);
    let request_id = uuid_v4();

    // Only handle POST /mcp
    if method != "POST" || path != "/mcp" {
        respond(&mut stream, 404, r#"{"error":"not found"}"#);
        return;
    }

    let (tx, rx) = mpsc::channel();

    // Register pending request
    {
        let mut lock = pending.lock().unwrap();
        lock.insert(request_id.clone(), tx);
    }

    // Emit event to JS bridge
    let _ = app.emit("mcp-request", serde_json::json!({
        "requestId": request_id,
        "body": body,
    }));

    // Wait for JS response (timeout 10s)
    match rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(result) => {
            respond(&mut stream, 200, &result);
        }
        Err(_) => {
            respond(&mut stream, 500, r#"{"error":"timeout"}"#);
        }
    }

    // Cleanup
    let mut lock = pending.lock().unwrap();
    lock.remove(&request_id);
}

/// Called from JS via Tauri command to respond to an MCP request.
#[tauri::command]
pub fn mcp_response(request_id: String, result: String) -> Result<(), String> {
    let mut lock = pending().lock().map_err(|e| e.to_string())?;
    if let Some(tx) = lock.remove(&request_id) {
        tx.send(result).map_err(|e| format!("send error: {}", e))?;
    }
    Ok(())
}

// ── Helpers ──

/// Read a full HTTP request from the stream. A single `TcpStream::read` may
/// return only part of the request when the body arrives in separate TCP
/// segments — an incomplete body makes the MCP client's `initialize` handshake
/// fail with -32700 parse errors, so Claude Code disables the whole server.
/// Loop until the complete headers + Content-Length bytes are read.
fn read_http_request(stream: &mut TcpStream) -> String {
    let mut raw: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
        if let Some(he) = find_subslice(&raw, b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&raw[..he]).to_string();
            let content_length = parse_content_length(&headers).unwrap_or(0);
            let have = raw.len().saturating_sub(he + 4);
            if have >= content_length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&raw).to_string()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_content_length(headers: &str) -> Option<usize> {
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            return v.trim().parse().ok();
        }
    }
    None
}

fn parse_http(raw: &str) -> (&str, &str, &str) {
    let first_line = raw.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let method = parts.first().copied().unwrap_or("");
    let path = parts.get(1).copied().unwrap_or("");
    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("");
    (method, path, body.trim())
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let status_text = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_text,
        body.len(),
        body,
    );
    let _ = stream.write_all(resp.as_bytes());
}

#[tauri::command]
pub fn get_mcp_port() -> u16 {
    mcp_port()
}

/// Simple UUID v4 generation (no external crate needed).
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!(
        "mcp-{:x}-{:04x}",
        now.as_secs(),
        now.subsec_nanos() & 0xFFFF,
    )
}
