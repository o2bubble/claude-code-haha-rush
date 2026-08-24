// ── BackendProcess — owns the IDE backend process lifecycle ──
// The process seam: async spawn thread, port read, kill/reap, and the poll
// state. Command construction (MCP wait / profile / embedded docs / env) stays
// in the caller (lib.rs `build_ide_backend_command`) — this module owns the
// process itself. Previously buried in lib.rs as BackendState + kill_backend +
// spawn_ide_backend, with the state written from three threads.

use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Holds the IDE backend process and its WebSocket port.
pub struct BackendState {
    pub process: Option<Child>,
    /// PID registered immediately after spawn — lets cleanup kill a backend
    /// that hangs before announcing its port (its Child handle is never stored).
    pub backend_pid: Option<u32>,
    pub port: Option<u16>,
    pub work_dir: String,
    /// True while a spawn is in flight. Lets the bind guard return "poll" only
    /// for an actual in-progress spawn; after a failed spawn it re-spawns
    /// instead of returning Ok(0) forever.
    pub spawning: bool,
}

/// Pure: extract the IDE port from a stdout line.
pub fn parse_port_line(line: &str) -> Option<u16> {
    line.split("CLAUDE_CODE_IDE_PORT=").nth(1)?.trim().parse().ok()
}

/// Kill the process tree + reap the Child handle. Prefer the registered PID —
/// it covers backends that hung before the Child handle was stored.
pub fn kill(state: &mut BackendState) {
    // Windows 需要进程树击杀（PID 注册兜底挂起后端）；mac/Linux 直接 kill 子进程即可
    #[cfg(target_os = "windows")]
    {
        let pid = state.backend_pid.take().or_else(|| state.process.as_ref().map(|c| c.id()));
        if let Some(p) = pid {
            log::info!("Killing IDE backend process tree (PID={})", p);
            // Native in-proc tree-kill — spawning `taskkill` pops "0xc0000142 /
            // DLL init failed" when launched at early logon or during shutdown
            // under a restricted token, and flashes a console.
            crate::prockill::kill_process_tree(p);
        }
    }
    if let Some(ref mut child) = state.process {
        let _ = child.kill();
        let _ = child.wait(); // reap — avoids a zombie after the tree-kill
    }
    state.process = None;
}

/// Spawn `cmd`, read the IDE port line from stdout within `timeout`, and kill
/// the tree on timeout. `on_spawned` fires with the child PID immediately after
/// spawn — lets the caller register the PID before the port-read blocks.
pub fn spawn_blocking<F>(cmd: &mut Command, timeout: Duration, on_spawned: F) -> Result<(Child, u16), String>
where
    F: FnOnce(u32),
{
    // The module reads the port from stdout — own the pipe setup here so a
    // caller-provided Command doesn't need to remember it.
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn IDE backend: {}", e))?;
    on_spawned(child.id());

    let stdout = child.stdout.take().ok_or("No stdout from child process")?;
    let reader = std::io::BufReader::new(stdout);

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    log::info!("[IDE stderr] {}", l);
                }
            }
        });
    }

    let start = Instant::now();
    for line in reader.lines() {
        if let Ok(l) = line {
            log::info!("[IDE stdout] {}", l);
            if let Some(p) = parse_port_line(&l) {
                return Ok((child, p));
            }
        }
        if start.elapsed() > timeout {
            break;
        }
    }

    // Timed out — kill the tree so no orphan survives.
    #[cfg(target_os = "windows")]
    crate::prockill::kill_process_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
    Err("IDE backend did not announce port within timeout".to_string())
}

/// Spawn the backend on a background thread, then store (child, port) in state.
/// `build_command` runs on that thread (MCP wait / profile / docs are slow).
pub fn spawn_async<F>(app: &tauri::AppHandle, work_dir: &str, build_command: F) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<Command, String> + Send + 'static,
{
    let app = app.clone();
    let ws_path = work_dir.to_string();
    std::thread::spawn(move || {
        let app2 = app.clone();
        let result = build_command(&ws_path).and_then(|mut cmd| {
            spawn_blocking(&mut cmd, Duration::from_secs(30), move |pid| {
                // Register the PID immediately so cleanup can always find this
                // backend, even if it hangs before announcing its port.
                if let Some(state) = app2.try_state::<Mutex<BackendState>>() {
                    if let Ok(mut b) = state.lock() {
                        b.backend_pid = Some(pid);
                    }
                }
            })
        });
        let bs = app.state::<Mutex<BackendState>>();
        match result {
            Ok((child, port)) => {
                if let Ok(mut b) = bs.lock() {
                    b.process = Some(child);
                    b.port = Some(port);
                    b.work_dir = ws_path.clone();
                    b.spawning = false;
                }
                log::info!("IDE backend ready on port {}", port);
            }
            Err(e) => {
                log::error!("Failed to spawn IDE backend: {}", e);
                if let Ok(mut b) = bs.lock() {
                    b.spawning = false;
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_port_line_extracts_port() {
        assert_eq!(parse_port_line("CLAUDE_CODE_IDE_PORT=1234"), Some(1234));
        assert_eq!(parse_port_line("CLAUDE_CODE_IDE_PORT= 5678 "), Some(5678));
        assert_eq!(parse_port_line("hello CLAUDE_CODE_IDE_PORT=99"), Some(99));
        assert_eq!(parse_port_line("no port here"), None);
    }

    #[test]
    fn spawn_blocking_reads_port_from_cmd() {
        let mut cmd = Command::new("cmd");
        cmd.arg("/c").arg("echo CLAUDE_CODE_IDE_PORT=4321");
        let (mut child, port) = spawn_blocking(&mut cmd, Duration::from_secs(5), |_pid| {}).unwrap();
        assert_eq!(port, 4321);
        let _ = child.wait();
    }

    #[test]
    fn kill_noop_on_empty_state() {
        let mut state = BackendState {
            process: None,
            backend_pid: None,
            port: None,
            work_dir: String::new(),
            spawning: false,
        };
        kill(&mut state);
        assert!(state.process.is_none());
        assert!(state.backend_pid.is_none());
    }
}
