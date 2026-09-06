// ── PluginProcess — owns plugin background process lifecycle ──
// T3: 插件声明后台进程 — spawn → 读 stdout `PLUGIN_PORT=` 发现端口 → kill。
// 状态机 stopped|starting|running|error|killed, 经 `plugin-process-status`
// Tauri event 上报前端(WorkerPanel + 插件面板订阅同一源)。
// 模式仿 backend.rs(线程持有 child, PID 注册兜底), plugin 用 PLUGIN_PORT=。

use std::io::BufRead;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 运行中的插件事进程描述(状态信息, 无 Child 句柄——Child 由管理线程持有)。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PluginProcessInfo {
    pub process_id: String,
    pub status: String, // stopped|starting|running|error|killed
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

/// 进程表: 进程 id → 状态字段(无 Child, Child 在管理线程的局部)。
pub struct PluginProcessRegistry {
    pub pids: Mutex<std::collections::HashMap<String, u32>>,
    pub ports: Mutex<std::collections::HashMap<String, u16>>,
    pub statuses: Mutex<std::collections::HashMap<String, String>>,
    /// spawn 时记录进程声明(command/args/env)——WorkerPanel 重启时从这取, 不需前端传。
    pub commands: Mutex<std::collections::HashMap<String, (String, Vec<String>, std::collections::HashMap<String, String>)>>,
}

impl PluginProcessRegistry {
    fn new() -> Self {
        Self {
            pids: Mutex::new(Default::default()),
            ports: Mutex::new(Default::default()),
            statuses: Mutex::new(Default::default()),
            commands: Mutex::new(Default::default()),
        }
    }
}

/// 全局进程表(static 单例, 非 Tauri state——进程表天然全局, 多窗口共享)。
pub fn registry() -> &'static PluginProcessRegistry {
    static REG: std::sync::LazyLock<PluginProcessRegistry> = std::sync::LazyLock::new(PluginProcessRegistry::new);
    &REG
}

/// 纯函数: 从 stdout 行提取 PLUGIN_PORT。取 PLUGIN_PORT= 后首个连续数字
/// (日志前后缀/尾部文本容错, 如 "some log PLUGIN_PORT= 8301 tail" → 8301)。
pub fn parse_plugin_port_line(line: &str) -> Option<u16> {
    let rest = line.split("PLUGIN_PORT=").nth(1)?;
    let token: String = rest.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    if token.is_empty() {
        return None;
    }
    token.parse().ok()
}

fn emit_status(app: &AppHandle, process_id: &str, status: &str, port: Option<u16>, pid: Option<u32>, error: Option<String>) {
    let _ = app.emit(
        "plugin-process-status",
        serde_json::json!({
            "processId": process_id,
            "status": status,
            "port": port,
            "pid": pid,
            "error": error,
        }),
    );
}

fn set_status(process_id: &str, status: &str) {
    registry().statuses.lock().unwrap().insert(process_id.to_string(), status.to_string());
}

/// 查询全部进程状态(前端 WorkerPanel 轮询/刷新用)。
pub fn list_all() -> Vec<PluginProcessInfo> {
    let reg = registry();
    let pids = reg.pids.lock().unwrap().clone();
    let ports = reg.ports.lock().unwrap().clone();
    let statuses = reg.statuses.lock().unwrap().clone();
    let mut out: Vec<PluginProcessInfo> = pids.iter().map(|(id, pid)| PluginProcessInfo {
        process_id: id.clone(),
        status: statuses.get(id).cloned().unwrap_or_else(|| "stopped".to_string()),
        port: ports.get(id).copied(),
        pid: Some(*pid),
        error: None,
    }).collect();
    // 加上 stopped(从未 spawn) 的占位
    for (id, st) in &statuses {
        if !pids.contains_key(id) {
            out.push(PluginProcessInfo {
                process_id: id.clone(),
                status: st.clone(),
                port: None,
                pid: None,
                error: None,
            });
        }
    }
    out.sort_by(|a, b| a.process_id.cmp(&b.process_id));
    out
}

/// Spawn 一个插件事后台进程。后台线程: spawn → 读 PLUGIN_PORT → 状态 running;
/// 线程内持有 Child, 读 stdout + wait(崩溃 → error)。PID 注册表早注册(兜底 kill)。
pub fn spawn_plugin_process(
    app: AppHandle,
    process_id: &str,
    command: &str,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let pid_str = process_id.to_string();
    emit_status(&app, &pid_str, "starting", None, None, None);

    let mut cmd = Command::new(command);
    cmd.args(&args);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn failed: {e}");
            set_status(&pid_str, "error");
            emit_status(&app, &pid_str, "error", None, None, Some(msg.clone()));
            return Err(msg);
        }
    };
    let pid = child.id();
    registry().pids.lock().unwrap().insert(pid_str.clone(), pid);
    // 记录进程声明(重启用)——command/args/env 来自插件 manifest。
    registry().commands.lock().unwrap().insert(pid_str.clone(), (command.to_string(), args.clone(), env.clone()));
    set_status(&pid_str, "starting"); // still starting until port

    // 管理线程: 读 stdout 找 PLUGIN_PORT; stderr 日志; 后台检查 wait/崩溃。
    std::thread::spawn(move || {
        let app = app.clone();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(se) = stderr {
            let stderr_pid = pid_str.clone();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(se).lines().flatten() {
                    log::info!("[plugin:{stderr_pid} stderr] {line}");
                }
            });
        }
        let mut found_port = false;
        if let Some(so) = stdout {
            let start = Instant::now();
            for line in std::io::BufReader::new(so).lines() {
                match &line {
                    Ok(l) => {
                        log::info!("[plugin:{pid_str} stdout] {l}");
                        if !found_port {
                            if let Some(p) = parse_plugin_port_line(l) {
                                registry().ports.lock().unwrap().insert(pid_str.clone(), p);
                                set_status(&pid_str, "running");
                                emit_status(&app, &pid_str, "running", Some(p), Some(pid), None);
                                found_port = true;
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
                if start.elapsed() > Duration::from_secs(20) { break; }
            }
        }
        // 等待进程退出(maintenance/崩溃监控)。
        // 超时未报告端口时先杀(否则 wait 会阻塞到进程自己退出 → 永久挂住线程)。
        if !found_port {
            #[cfg(target_os = "windows")]
            crate::prockill::kill_process_tree(pid);
        }
        let _ = child.wait();
        // ⚠️ kill/wait 竞态防护: wait 返回时(1)可能是用户 kill(状态已被置 killed),
        // (2)可能是 restart(旧 wait)新的 spawn 已插入新 pid——两种都不能覆盖状态/
        // 误删新 pid。只有"当前 registry 的 pid 仍是我这个 spawn 的 pid"才上报 error。
        let current_pid = registry().pids.lock().unwrap().get(&pid_str).copied();
        let current_status = registry().statuses.lock().unwrap().get(&pid_str).cloned();
        if current_pid != Some(pid) {
            // 已被 restart 换新 → 旧 wait 线程退场, 不动新pid/状态。
            return;
        }
        if current_status.as_deref() == Some("killed") {
            // 用户 kill → 保持 killed(不覆盖 error); 清理 pid 记录。
            registry().pids.lock().unwrap().remove(&pid_str);
            return;
        }
        registry().pids.lock().unwrap().remove(&pid_str);
        if !found_port {
            // 超时未报告端口 → 杀进程 + error(之前 break 未杀)。
            #[cfg(target_os = "windows")]
            crate::prockill::kill_process_tree(pid);
            set_status(&pid_str, "error");
            emit_status(&app, &pid_str, "error", None, Some(pid), Some("进程未在超时内报告端口, 已终止".to_string()));
        } else {
            // running 后自然退出 → 视为 error(崩溃) 上报(不自动重启, 用户手动)。
            set_status(&pid_str, "error");
            emit_status(&app, &pid_str, "error", None, Some(pid), Some("进程已退出".to_string()));
        }
    });
    Ok(())
}

/// 杀插件事进程(WorkerPanel kill)。更新状态 + 上报。
pub fn kill_plugin_process(app: &AppHandle, process_id: &str) -> bool {
    let pid = registry().pids.lock().unwrap().get(process_id).copied();
    if let Some(p) = pid {
        #[cfg(target_os = "windows")]
        crate::prockill::kill_process_tree(p);
        #[cfg(not(target_os = "windows"))]
        {
            // 非 Windows(mac/Linux): 用系统 kill 命令送 SIGTERM(避免 libc 依赖)。
            if let Ok(mut k) = std::process::Command::new("kill").arg(p.to_string()).spawn() {
                let _ = k.wait();
            }
        }
    }
    registry().pids.lock().unwrap().remove(process_id);
    set_status(process_id, "killed");
    emit_status(app, process_id, "killed", None, None, None);
    true
}

/// 杀全部插件事进程(GUI 退出清理——防孤儿, 占端口)。遍历 pid 表 kill tree。
pub fn kill_all_plugin_processes() {
    let pids: Vec<u32> = registry().pids.lock().unwrap().values().copied().collect();
    for pid in pids {
        #[cfg(target_os = "windows")]
        crate::prockill::kill_process_tree(pid);
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(mut k) = std::process::Command::new("kill").arg(pid.to_string()).spawn() {
                let _ = k.wait();
            }
        }
    }
    registry().pids.lock().unwrap().clear();
}

/// 重启: kill 旧(若有) → spawn 新。command/args/env 优先用 registry 里记录的
/// 进程声明(WorkerPanel 重启只需传 process_id); 若传了非空 command 则用新的。
pub fn restart_plugin_process(
    app: &AppHandle,
    process_id: &str,
    command: &str,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let (cmd, a, e) = if !command.is_empty() {
        (command.to_string(), args, env)
    } else {
        let guard = registry().commands.lock().unwrap();
        guard.get(process_id).cloned().unwrap_or_else(|| {
            let msg = format!("unknown process_id: {process_id} (no saved command)");
            emit_status(app, process_id, "error", None, None, Some(msg.clone()));
            (String::new(), Vec::new(), Default::default())
        })
        // 解锁后使用(克隆出来)
    };
    if cmd.is_empty() {
        return Err(format!("unknown process_id: {process_id} (no saved command)"));
    }
    let _ = kill_plugin_process(app, process_id);
    spawn_plugin_process(app.clone(), process_id, &cmd, a, e)
}

// ── 单元测试: 纯函数 ──
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plugin_port_line() {
        assert_eq!(parse_plugin_port_line("PLUGIN_PORT=8300"), Some(8300));
        assert_eq!(parse_plugin_port_line("some log PLUGIN_PORT= 8301 tail"), Some(8301));
        assert_eq!(parse_plugin_port_line("no port here"), None);
    }
}
