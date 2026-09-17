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
    // ⚠️ 必须用 `splitn(2, ...)`（只切一次），不能用 `split(...).nth(1)`：
    // 后者只返回**第一段** —— body 里若含 `\r\n\r\n` 就会被**静默截断**
    // （实测：`{"a":"x\r\n\r\ny"}` 解析成 `{"a":"x`，后面的内容全丢）。
    // 后果很难查：请求本身看起来正常，JS 侧只是 JSON.parse 失败报个模糊的错。
    // 合法 JSON body 里换行会被转义成 `\n`，所以触发条件罕见但非不可能
    // （非 JSON body、或客户端未转义的原始多行文本）。
    let body = raw.splitn(2, "\r\n\r\n").nth(1).unwrap_or("");
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
///
/// ⚠️ **必须有进程内计数器，不能只靠时钟。**
/// 原实现是 `秒 + 纳秒低16位` —— 而 `SystemTime::now()` 在 Windows 上精度约
/// 100ns，**同一 tick 内连续调用会返回相同的时间戳**。实测：快速循环到第 1793 次
/// 就撞出重复 id。
///
/// 这个 id 是 `pending` map 的 key（每个在途请求一个）—— **重复的后果很严重**：
/// 两个并发请求共用一个 key → 后插入的 channel 覆盖先插入的 → **前一个请求永远
/// 等不到响应，直到 10 秒超时**。而 AI 是会并行调工具的。
fn uuid_v4() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "mcp-{:x}-{:04x}-{:x}",
        now.as_secs(),
        now.subsec_nanos() & 0xFFFF,
        seq,
    )
}


#[cfg(test)]
mod tests {
    use super::*;

    // ── find_subslice ──
    // 用途：在原始字节流里找 `\r\n\r\n`（HTTP 头结束标记）。
    // 找错位置 → 头/体切分错 → 请求解析整体失败。

    #[test]
    fn find_subslice_basic_positions() {
        assert_eq!(find_subslice(b"abcdef", b"cd"), Some(2));
        assert_eq!(find_subslice(b"abcdef", b"ab"), Some(0), "开头");
        assert_eq!(find_subslice(b"abcdef", b"ef"), Some(4), "结尾");
        assert_eq!(find_subslice(b"abcdef", b"xyz"), None, "不存在");
        assert_eq!(find_subslice(b"abcdef", b"abcdefg"), None, "needle 比 haystack 长");
        assert_eq!(find_subslice(b"aXbXc", b"X"), Some(1), "返回**首个**匹配");
    }

    #[test]
    fn find_subslice_finds_http_header_terminator() {
        let raw = b"POST /mcp HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}";
        // 偏移：18（请求行）+ 2（CRLF）+ 17（Content-Length: 2）= 37
        assert_eq!(find_subslice(raw, b"\r\n\r\n"), Some(37));
    }

    // ── parse_content_length ──
    // 用途：决定"body 读够了没有"。解析错 → 要么读不完整、要么死等。

    #[test]
    fn parse_content_length_normal() {
        assert_eq!(parse_content_length("Content-Length: 42"), Some(42));
        assert_eq!(parse_content_length("Host: x\r\nContent-Length: 7\r\n"), Some(7));
    }

    #[test]
    fn parse_content_length_case_insensitive() {
        // HTTP 头名大小写不敏感（客户端实际会发各种形态）
        assert_eq!(parse_content_length("content-length: 5"), Some(5));
        assert_eq!(parse_content_length("CONTENT-LENGTH: 5"), Some(5));
        assert_eq!(parse_content_length("CoNtEnT-LeNgTh: 5"), Some(5));
    }

    #[test]
    fn parse_content_length_whitespace_and_missing() {
        assert_eq!(parse_content_length("Content-Length:   9  "), Some(9), "多余空格");
        assert_eq!(parse_content_length("Host: x"), None, "没有该头");
        assert_eq!(parse_content_length(""), None, "空头");
    }

    #[test]
    fn parse_content_length_invalid_values() {
        assert_eq!(parse_content_length("Content-Length: abc"), None);
        assert_eq!(parse_content_length("Content-Length: -1"), None, "负数不是合法的 usize");
        assert_eq!(parse_content_length("Content-Length:"), None, "无值");
        assert_eq!(parse_content_length("Content-Length: 12.5"), None);
    }

    #[test]
    fn parse_content_length_duplicate_takes_first() {
        // 重复 Content-Length 是 HTTP 请求走私的经典载体。
        // 本实现**取第一个**（拒绝比取最后一个安全）—— 这条测试把这个选择钉住，
        // 以后若有人改成"取最后一个"会被抓出来。
        let h = "Content-Length: 5\r\nContent-Length: 99";
        assert_eq!(parse_content_length(h), Some(5));
    }

    // ── parse_http ──
    // 用途：切出 (method, path, body)。body 直接交给 JS 做 JSON.parse，
    // 所以**切错 = AI 的工具调用失败**，且报错模糊（JSON.parse 失败）。

    #[test]
    fn parse_http_normal_request() {
        let raw = "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 13\r\n\r\n{\"tool\":\"a\"}";
        let (m, p, b) = parse_http(raw);
        assert_eq!(m, "POST");
        assert_eq!(p, "/mcp");
        assert_eq!(b, "{\"tool\":\"a\"}");
    }

    #[test]
    fn parse_http_no_body() {
        let (m, p, b) = parse_http("GET /x HTTP/1.1\r\nHost: y\r\n\r\n");
        assert_eq!((m, p, b), ("GET", "/x", ""));
    }

    #[test]
    fn parse_http_empty_and_malformed() {
        assert_eq!(parse_http(""), ("", "", ""));
        assert_eq!(parse_http("garbage"), ("garbage", "", ""));
        assert_eq!(parse_http("POST"), ("POST", "", ""), "只有 method");
    }

    /// 🔴 **回归测试**：body 含 `\r\n\r\n` 时不能被截断。
    ///
    /// 原实现是 `raw.split("\r\n\r\n").nth(1)` —— 只返回**第一段**，
    /// 实测 `{"a":"x\r\n\r\ny"}` 被解析成 `{"a":"x`（后面的内容全丢）。
    /// 修法是 `splitn(2, ...)`（只切一次，返回分隔符之后的全部）。
    #[test]
    fn parse_http_body_containing_header_terminator_is_not_truncated() {
        let raw = "POST /mcp HTTP/1.1\r\nContent-Length: 18\r\n\r\n{\"a\":\"x\r\n\r\ny\"}";
        let (_m, _p, body) = parse_http(raw);
        assert!(
            body.contains("y"),
            "body 被截断了 —— 必须用 splitn(2) 而非 split().nth(1)。实际得到: {body:?}"
        );
        assert_eq!(body, "{\"a\":\"x\r\n\r\ny\"}");
    }

    #[test]
    fn parse_http_multiline_body_preserved() {
        // 多行 body（每行 \r\n）—— 旧实现下第一行之后就被切掉
        let raw = "POST /mcp HTTP/1.1\r\n\r\nline1\r\nline2\r\nline3";
        let (_m, _p, body) = parse_http(raw);
        assert!(body.contains("line2") && body.contains("line3"), "多行 body 应完整保留: {body:?}");
    }

    // ── uuid_v4（request_id）──
    // 用途：`pending` map 的 key —— 每个在途请求一个。
    // **冲突的后果很严重**：两个请求共用一个 key → 响应张冠李戴 →
    // AI 拿到**别的工具调用**的结果。所以唯一性是硬要求。

    #[test]
    fn uuid_v4_format() {
        let id = uuid_v4();
        assert!(id.starts_with("mcp-"), "前缀: {id}");
        assert!(id.len() > 8);
        assert!(!id.contains(' '), "不该有空格: {id}");
    }

    #[test]
    fn uuid_v4_distinct_across_many_calls() {
        // 现有实现是 `秒 + 纳秒低16位`。同一纳秒内连调两次会**撞车** ——
        // 这条测试把这个风险钉住（若红了，说明并发下 request_id 可能重复，
        // 需要引入真正的随机源或计数器）。
        let mut seen = std::collections::HashSet::new();
        let n = 10_000;
        for _ in 0..n {
            let id = uuid_v4();
            assert!(seen.insert(id.clone()), "request_id 重复: {id}（第 {} 次插入失败）", seen.len());
        }
    }
}
