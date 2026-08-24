use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::Emitter;
use std::sync::MutexGuard;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Embedded docs — compiled into binary, written to ~/.claude/ at runtime.
// No filesystem dependency on the docs/ directory (works in packaged exe).
const GUI_AGENT_GUIDE: &str = include_str!("../../../docs/gui/gui-agent-guide.md");
const GUI_REF_SYSTEM: &str = include_str!("../../../docs/gui/ref-system.md");
const GUI_CONFIG_FILES: &str = include_str!("../../../docs/gui/config-files.md");

use std::collections::HashMap;
use serde::Serialize;
use tauri::Manager;
use base64::Engine;

mod notes;
mod update;

mod backend;
mod db;
mod diagnostics;
mod guard;
mod mcp;
mod prockill;
mod settings;

/// Holds the SQLite connection and the workspace it was opened for.
struct DbState {
    conn: rusqlite::Connection,
    work_dir: String,
}

/// The `--workspace <path>` CLI argument, if this instance was launched with one.
static CLI_WORKSPACE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// 本进程当前持有的工作区锁路径（切换工作区时释放旧的，避免另一实例误判）。
static HELD_WORKSPACE_LOCK: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);
/// 本进程是否是「当前绑定工作区」的第一个实例。第二个实例绑定同一工作区为 false，
/// 前端据此跳过"自动加载最近会话"；绑定不同工作区互不影响。
static IS_FIRST_INSTANCE: std::sync::Mutex<bool> = std::sync::Mutex::new(true);

/// pid 进程是否存活（Windows）。
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}
#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    false
}

/// 尝试成为「绑定工作区」的第一个实例：独占创建锁文件（写 PID）。
/// 已存在则检查 PID 存活——活跃 → 非首个；已死（崩溃残留）→ 删锁接管。
/// 切换工作区时先释放本进程之前的锁。
fn acquire_workspace_lock(workdir: &str) -> bool {
    let path = std::path::PathBuf::from(workdir).join(".claude").join("gui-instance.lock");
    // 切换工作区：释放本进程之前的锁，避免它让另一实例误判该工作区仍被占用
    if let Some(old) = HELD_WORKSPACE_LOCK.lock().unwrap().take() {
        if old != path {
            let _ = std::fs::remove_file(&old);
        }
    }
    let pid = std::process::id();
    let try_acquire = || -> std::io::Result<bool> {
        use std::io::Write;
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let _ = writeln!(f, "{}", pid);
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(_) => Ok(false),
        }
    };
    match try_acquire() {
        Ok(true) => {
            *HELD_WORKSPACE_LOCK.lock().unwrap() = Some(path);
            true
        }
        Ok(false) => {
            let stale = std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
                .map(|p| !process_alive(p))
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_file(&path);
                if try_acquire().unwrap_or(false) {
                    *HELD_WORKSPACE_LOCK.lock().unwrap() = Some(path);
                    return true;
                }
            }
            false
        }
        Err(_) => false,
    }
}

/// Return a locked DbState, re-initializing the DB if the bound workspace changed.
/// The bound workspace comes from the AppSettings state (set by bind_workspace),
/// not a fresh disk read, so multiple instances stay on their own workspace DB.
fn ensure_db<'a>(
    db_state: &'a Mutex<DbState>,
    settings_state: &Mutex<settings::AppSettings>,
) -> Result<MutexGuard<'a, DbState>, String> {
    let bound_wd = {
        let s = settings_state.lock().map_err(|e| format!("Lock error: {}", e))?;
        s.work_dir.clone()
    };
    let mut guard = db_state.lock().map_err(|e| format!("Lock error: {}", e))?;
    if guard.work_dir != bound_wd {
        let new_dir = std::path::PathBuf::from(&bound_wd).join(".claude");
        std::fs::create_dir_all(&new_dir).map_err(|e| format!("Cannot create .claude dir: {}", e))?;
        let new_path = new_dir.join("data.db");
        let new_conn = db::init_db(&new_path.to_string_lossy())?;
        log::info!("DB switched to workspace: {}", new_path.display());
        guard.conn = new_conn;
        guard.work_dir = bound_wd;
    }
    Ok(guard)
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_dir = dirs_next().unwrap_or_else(|| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&log_dir).ok();
    let log_file = log_dir.join("claude-code-gui.log");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .unwrap_or_else(|e| {
            eprintln!("Cannot open log file: {}, falling back to stderr", e);
            panic!("Fatal: cannot open log file");
        });
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .target(env_logger::Target::Pipe(Box::new(file)))
        .init();

    log::info!("=== Claude Code GUI starting ===");

    // --workspace <path>: bind this instance directly to a workspace (skips the
    // workspace selector). Used by shortcuts / scripts for multi-instance.
    let mut cli_workspace: Option<String> = None;
    {
        let mut args = std::env::args().skip(1);
        while let Some(a) = args.next() {
            if a == "--workspace" {
                if let Some(v) = args.next() {
                    cli_workspace = Some(v);
                }
            }
        }
        if let Some(ws) = &cli_workspace {
            log::info!("CLI --workspace: {}", ws);
            CLI_WORKSPACE.set(ws.clone()).ok();
            // Set the process-level binding early so setup()'s settings::load_settings()
            // merges this workspace's gui (window state, layout) before restore.
            settings::set_bound_work_dir(ws);
        }
    }

    let settings = settings::load_settings();
    log::info!("Settings loaded: workDir={}", settings.work_dir);
    let work_dir = settings.work_dir.clone();
    let saved_window_w = settings.window_width;
    let saved_window_h = settings.window_height;
    let saved_window_x = settings.window_x;
    let saved_window_y = settings.window_y;
    let saved_window_maximized = settings.window_maximized;

    let db_dir = std::path::PathBuf::from(&work_dir).join(".claude");
    std::fs::create_dir_all(&db_dir).expect("Failed to create .claude directory");
    let db_path = db_dir.join("data.db");
    let db_conn = db::init_db(&db_path.to_string_lossy())
        .expect("Failed to initialize app data database");
    log::info!("App data DB initialized at {}", db_path.display());

    // ── 进程级环境（GUI 及其子进程自足，不依赖系统注册表）──

    /// 启动早期调用：设置进程级环境变量，让所有子进程（IDE 后端/系统终端）继承。
    /// 系统级只保留 CLAUDE_CODE_HAHA_HOME（非 GUI 场景锚点）；PATH 前置工具目录在此完成。
    /// 免提权、装完免重启、Windows/macOS 统一。
    fn apply_process_env() {
        let Some(install_dir) = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        else {
            return;
        };
        std::env::set_var("CLAUDE_CODE_HAHA_HOME", &install_dir);
        // claude.exe 后端 findGitBashPath() 优先读 CLAUDE_CODE_GIT_BASH_PATH（指向真实
        // git\usr\bin\bash.exe，防 WSL bash 截胡）；未设置才回退 PATH 找 git 的
        // bin\bash.exe（shim）。进程级设上，系统注册表就不必再持久化该变量（新策略
        // 只留 CLAUDE_CODE_HAHA_HOME）。仅在真实 bash 存在时设——缺失则回退逻辑兜底。
        let bash = install_dir.join("git").join("usr").join("bin").join("bash.exe");
        if bash.is_file() {
            std::env::set_var("CLAUDE_CODE_GIT_BASH_PATH", &bash);
        }
        let orig = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", prepend_tool_dirs(&install_dir, &orig));
    }

    /// 前置工具目录到 PATH（平台化）。Windows: bin / git\usr\bin / git\bin / python / python\Scripts；
    /// macOS: bin（自包含工具 rg/fd/jq/yq/shellcheck）。目录不存在则跳过。
    fn prepend_tool_dirs(install_dir: &std::path::Path, orig: &str) -> String {
        let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
        let suffixes: &[&str] = if cfg!(target_os = "windows") {
            &["", "\\bin", "\\git\\usr\\bin", "\\git\\bin", "\\python", "\\python\\Scripts"]
        } else {
            &["", "/bin"]
        };
        let mut dirs: Vec<String> = Vec::new();
        for sfx in suffixes {
            let d = install_dir.join(sfx);
            if d.is_dir() {
                dirs.push(d.to_string_lossy().to_string());
            }
        }
        for entry in orig.split(sep).filter(|s| !s.is_empty()) {
            if !dirs.iter().any(|d| d.eq_ignore_ascii_case(entry)) {
                dirs.push(entry.to_string());
            }
        }
        dirs.join(&sep.to_string())
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(DbState {
            conn: db_conn,
            work_dir: work_dir.clone(),
        }))
        .manage(Mutex::new(settings.clone()))
        .manage(Mutex::new(backend::BackendState {
            process: None,
            backend_pid: None,
            port: None,
            work_dir: work_dir.clone(),
            spawning: false,
        }))
        .manage(guard::GuardRuntime::default())
        .setup(move |app| {
            // 进程级环境：GUI 及其所有子进程（IDE 后端/系统终端）不需要系统注册表
            // 即可工作。系统级只保留 CLAUDE_CODE_HAHA_HOME（非 GUI 场景锚点），
            // PATH 等工具目录在进程内前置——免提权、装完免重启、mac/win 统一。
            apply_process_env();

            // Clean stale per-PID WebView2 data dirs from prior runs BEFORE the
            // webview is built (the in-use one is the current PID). Prevent the
            // ~200-dir / multi-GB junk pile reported by disk-cleanup scans.
            cleanup_old_webview_dirs(app.handle());

            // Create the main window programmatically with a per-instance WebView2
            // user data folder. WebView2 only allows one browser process per data
            // folder — a shared default folder makes a second GUI instance's webview
            // fail with HRESULT 0x8007139F (process survives, but the webview never
            // loads → no window). Keying by PID isolates every instance.
            let main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Claude Code Desktop (Preview)")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 500.0)
            .resizable(true)
            .data_directory(webview_data_dir(app.handle()))
            // 纵深防御：主窗口只允许应用自身 origin 导航，外部链接无法替换 GUI。
            // （点击 http(s) 链接由前端委托走 open_url_window 内置窗口打开）
            .on_navigation(is_allowed_navigation)
            .build()?;

            // Restore window position first (only if not maximized).
            // When maximized, the OS manages position — skip to avoid
            // restoring a snapped-to-edge position as a normal position.
            if !saved_window_maximized {
                if let (Some(x), Some(y)) = (saved_window_x, saved_window_y) {
                    let _ = main_window.set_position(tauri::PhysicalPosition::new(x, y));
                }
                if let (Some(w), Some(h)) = (saved_window_w, saved_window_h) {
                    let _ = main_window.set_size(tauri::LogicalSize::new(w, h));
                }
            }
            // Restore maximized state last — it overrides position/size.
            if saved_window_maximized {
                let _ = main_window.maximize();
            }
            // 迁移旧版散落的项目/工作区级 profile 到用户级（幂等）。
            migrate_legacy_profiles();
            // 单文件→双文件回退：把 settings.json 根 mcpServers 迁到 ~/.claude.json，
            // 必须在 spawn 后端之前跑（后端启动时读全局配置）。
            settings::migrate_single_file_mcp_to_claude_json();
            // office MCP 自动注册到 ~/.claude.json（stdio MCP，Windows→win32com / mac→osascript），
            // 同样要在 spawn 后端之前，后端启动即能看到 office 工具。
            settings::register_office_mcp();
            // office 操作指南同步到 ~/.claude/ + 注入 @office-bridge.md（每次启动幂等，
            // 更新免重装；安装器只管装文件，不碰用户配置）。
            settings::sync_office_guide();

            // Windows: kill the IDE backend synchronously when the user logs off
            // or shuts down. tao never forwards WM_QUERYENDSESSION, so without
            // this the GUI is force-killed and the backend orphans — forcing the
            // next launch to clean it up (the moment taskkill used to pop
            // 0xc0000142). Native kill (prockill) works under any token/session.
            #[cfg(windows)]
            {
                let app_for_end = app.handle().clone();
                if let Err(e) = prockill::install_session_end_cleanup(move || {
                    if let Some(state) = app_for_end.try_state::<Mutex<backend::BackendState>>() {
                        if let Ok(mut guard) = state.lock() {
                            backend::kill(&mut guard);
                        }
                    }
                }) {
                    log::error!("Failed to install session-end cleanup: {}", e);
                }
            }

            log::info!("Tauri app setup complete");

            // Start MCP server FIRST — the dynamic port must be known before any
            // backend spawn writes the per-workspace super-desktop MCP config.
            let mcp_port = mcp::start_mcp_server(app.handle().clone());
            log::info!("MCP server started on port {}", mcp_port);

            if let Some(ws) = cli_workspace {
                // --workspace instance: bind synchronously (init DB, register MCP,
                // spawn backend) so BackendState is populated before the webview
                // loads — the frontend's bind call then short-circuits via the
                // idempotency guard in bind_workspace_internal.
                match bind_workspace_internal(&app.handle().clone(), &ws) {
                    Ok(port) => log::info!("Bound --workspace {} → backend port {}", ws, port),
                    Err(e) => log::error!("bind_workspace({}) failed: {}", ws, e),
                }
            } else {
                // No --workspace: no pre-start. The frontend shows the workspace
                // selector and calls bind_workspace when the user picks one.
                log::info!("No --workspace arg — waiting for workspace selection");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mcp::mcp_response,
            mcp::get_mcp_port,
            bind_workspace,
            get_cli_workspace,
            is_first_instance,
            db_save_plan,
            db_get_plans,
            db_get_plan_sessions,
            db_save_desktop,
            db_get_desktops,
            db_delete_desktop,
            db_save_desktop_history,
            db_load_desktop_history,
            get_ide_port,
            read_dir,
            read_file,
            read_bytes,
            save_file,
            save_bytes,
            create_path,
            path_exists,
            delete_path,
            rename_path,
            get_app_settings,
            save_app_settings,
            diagnostics::run_env_diagnostics,
            diagnostics::run_network_diagnostics,
            diagnostics::run_workspace_diagnostics,
            diagnostics::fix_environment_vars,
            diagnostics::fix_profiles,
            save_permission_mode,
            save_window_state,
            get_default_work_dir,
            restart_ide_backend,
            fix_restart_ide_backend,
            list_model_profiles,
            switch_model_profile,
            create_profile,
            delete_profile,
            set_default_profile,
            open_system_terminal,
            create_floating_window,
            open_url_window,
            open_in_explorer,
            guard::guard_event,
            copy_file,
            read_clipboard_text,
            get_git_branch,
            run_cli_print,
            save_skills_i18n,
            load_skills_i18n,
            close_me,
            get_skills_dir,
            install_skill,
            install_package,
            delete_skill,
            // Notes
            note_create,
            note_update,
            note_delete,
            note_get,
            note_list,
            note_search,
            note_associate,
            note_disassociate,
            note_tags,
            note_get_all_tag_names,
            note_apply_tag_mapping,
            // Updates
            update::check_for_updates,
            update::download_and_install_component,
            update::prepare_gui_update,
            update::launch_updater_and_exit,
            update::get_local_manifest,
            update::get_install_dir_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                log::info!("App exiting, cleaning up IDE backend...");
                if let Some(state) = app_handle.try_state::<Mutex<backend::BackendState>>() {
                    let mut guard = state.lock().unwrap();
                    backend::kill(&mut guard);
                }
                log::info!("Cleanup complete");
            }
        });
}

// ── File I/O commands ──

#[derive(Debug, Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn read_dir(path: String, show_hidden_files: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let dir = std::path::PathBuf::from(&path);
    log::info!("read_dir: {} (show_hidden={})", dir.display(), show_hidden_files.unwrap_or(false));
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Cannot read dir: {}", e))?;
    let show_hidden = show_hidden_files.unwrap_or(false);
    let mut result: Vec<DirEntry> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Entry error: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        if name == "node_modules" || name == "target" {
            continue;
        }
        result.push(DirEntry { name, path, is_dir });
    }
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(result)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    log::info!("read_file: {}", path);
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {}", e))
}

#[tauri::command]
fn read_bytes(path: String) -> Result<String, String> {
    use std::io::Read;
    use base64::Engine;
    log::info!("read_bytes: {}", path);
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err("File not found".to_string());
    }
    let mut file = std::fs::File::open(&p).map_err(|e| format!("Cannot open: {}", e))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| format!("Cannot read: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    log::info!("save_file: {}", path);
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent dir: {}", e))?;
    }
    std::fs::write(&path, &content).map_err(|e| format!("Cannot write file: {}", e))
}

#[tauri::command]
fn save_bytes(path: String, base64_data: String) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 decode error: {}", e))?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent dir: {}", e))?;
    }
    std::fs::write(&path, &data).map_err(|e| format!("Cannot write file: {}", e))
}

#[tauri::command]
fn create_path(path: String, is_dir: bool) -> Result<(), String> {
    log::info!("create_path: {} (dir={})", path, is_dir);
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        return Err("Path already exists".to_string());
    }
    if is_dir {
        std::fs::create_dir_all(&p).map_err(|e| format!("Cannot create dir: {}", e))?;
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent dir: {}", e))?;
        }
        std::fs::write(&p, "").map_err(|e| format!("Cannot create file: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::PathBuf::from(&path).exists()
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    log::info!("delete_path: {}", path);
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Cannot delete dir: {}", e))?;
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Cannot delete file: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn rename_path(path: String, new_name: String) -> Result<String, String> {
    log::info!("rename_path: {} -> {}", path, new_name);
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    let parent = p.parent().ok_or("Cannot determine parent directory")?;
    let new_path = parent.join(&new_name);
    if new_path.exists() {
        return Err("Target path already exists".to_string());
    }
    std::fs::rename(&p, &new_path).map_err(|e| format!("Cannot rename: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

// ── DB commands ──

#[tauri::command]
fn db_save_plan(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>, plan: db::PlanInput) -> Result<(), String> {
    let db = ensure_db(&state, &settings)?;
    db::save_plan(&db.conn, &plan)
}

#[tauri::command]
fn db_get_plans(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>, offset: u32, limit: u32) -> Result<Vec<db::PlanRecord>, String> {
    let db = ensure_db(&state, &settings)?;
    db::get_plans(&db.conn, offset, limit)
}

#[tauri::command]
fn db_get_plan_sessions(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>) -> Result<Vec<db::PlanSession>, String> {
    let db = ensure_db(&state, &settings)?;
    db::get_plan_sessions(&db.conn)
}

#[tauri::command]
fn db_save_desktop(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>, desktop: db::DesktopRecord) -> Result<(), String> {
    let db = ensure_db(&state, &settings)?;
    db::save_desktop(&db.conn, &desktop)
}

#[tauri::command]
fn db_get_desktops(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>) -> Result<Vec<db::DesktopRecord>, String> {
    let db = ensure_db(&state, &settings)?;
    db::get_desktops(&db.conn)
}

#[tauri::command]
fn db_delete_desktop(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>, id: String) -> Result<(), String> {
    let db = ensure_db(&state, &settings)?;
    db::delete_desktop(&db.conn, &id)
}

#[tauri::command]
fn db_save_desktop_history(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>, desktop_id: String, undo_json: String, redo_json: String) -> Result<(), String> {
    let db = ensure_db(&state, &settings)?;
    db::save_desktop_history(&db.conn, &desktop_id, &undo_json, &redo_json)
}

#[tauri::command]
fn db_load_desktop_history(state: tauri::State<Mutex<DbState>>, settings: tauri::State<Mutex<settings::AppSettings>>, desktop_id: String) -> Result<Option<db::DesktopHistoryRecord>, String> {
    let db = ensure_db(&state, &settings)?;
    db::load_desktop_history(&db.conn, &desktop_id)
}

// ── Settings commands ──

#[tauri::command]
fn get_app_settings(state: tauri::State<Mutex<settings::AppSettings>>) -> Result<settings::AppSettings, String> {
    let s = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    // Before a workspace is bound the state holds reload_effective_settings(global
    // workDir) — that would leak one workspace's overrides (favoriteSessionIds,
    // layoutTree, …) into every instance at startup. Return the pure global
    // baseline until a workspace is bound; the frontend reloads after bind.
    if settings::bound_work_dir().is_empty() {
        return Ok(settings::load_global_settings());
    }
    Ok(s.clone())
}

/// Returns the `--workspace <path>` CLI arg (if any). The frontend uses this to
/// skip the workspace selector for shortcut/CLI-launched instances.
#[tauri::command]
fn get_cli_workspace() -> Option<String> {
    CLI_WORKSPACE.get().cloned()
}

/// 本实例是否是「当前绑定工作区」的第一个实例（第二个实例绑定同一工作区应跳过
/// "自动加载最近会话"）。
#[tauri::command]
fn is_first_instance() -> bool {
    IS_FIRST_INSTANCE.lock().map(|v| *v).unwrap_or(true)
}

#[tauri::command]
fn save_app_settings(
    state: tauri::State<Mutex<settings::AppSettings>>,
    patch: serde_json::Value,
    scope: Option<String>,
) -> Result<(), String> {
    // Use the TRUE process binding (empty until a real bind), NOT state.work_dir.
    // At startup the state holds the GLOBAL workDir (load_settings() returns pure
    // global before bind) — a workspace-scoped save would then write the startup
    // default layout into the global workDir's workspace file, clobbering its
    // saved layout on every launch ("adjust layout, restart, it reverts").
    let bound_wd = settings::bound_work_dir();
    settings::save_effective_patch(&bound_wd, &patch, scope.as_deref())?;
    // Refresh in-memory effective state (workspace overrides global).
    let mut s = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    *s = settings::reload_effective_settings(&bound_wd);
    Ok(())
}

#[tauri::command]
fn get_ide_port(state: tauri::State<Mutex<backend::BackendState>>) -> Result<u16, String> {
    let s = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    s.port.ok_or_else(|| "IDE backend not started yet".to_string())
}

#[tauri::command]
fn save_permission_mode(
    settings: tauri::State<Mutex<settings::AppSettings>>,
    mode: String,
) -> Result<(), String> {
    let mut s = settings.lock().map_err(|e| format!("Lock error: {}", e))?;
    s.permission_mode = mode.clone();
    settings::merge_gui_patch(&settings::global_settings_path(), &serde_json::json!({ "permissionMode": mode }))
}

#[tauri::command]
fn save_window_state(
    settings: tauri::State<Mutex<settings::AppSettings>>,
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    maximized: bool,
) -> Result<(), String> {
    let mut s = settings.lock().map_err(|e| format!("Lock error: {}", e))?;
    s.window_width = Some(width);
    s.window_height = Some(height);
    s.window_x = x;
    s.window_y = y;
    s.window_maximized = maximized;
    drop(s);
    // Window state is workspace-scoped so each workspace window restores its own
    // position — including the default workspace (it's a normal workspace now).
    // Use the TRUE binding; at startup (unbound) the state still holds the global
    // workDir, which would redirect window state into that workspace's file.
    let wd = settings::bound_work_dir();
    let path = if !wd.is_empty() {
        settings::workspace_settings_path(&wd)
    } else {
        settings::global_settings_path()
    };
    let patch = serde_json::json!({
        "windowWidth": width, "windowHeight": height,
        "windowX": x, "windowY": y, "windowMaximized": maximized,
    });
    settings::merge_gui_patch(&path, &patch)
}

/// Bind this GUI instance to a workspace: init the per-workspace DB, spawn the
/// IDE backend (which registers super-desktop MCP into this workspace with the
/// instance's dynamic MCP port), and record the workspace in the global recent
/// list. Returns the backend port.
fn bind_workspace_internal(app: &tauri::AppHandle, path: &str) -> Result<u16, String> {
    if path.trim().is_empty() {
        return Err("Empty workspace path".to_string());
    }
    std::fs::create_dir_all(std::path::PathBuf::from(path))
        .map_err(|e| format!("Cannot create workspace dir: {}", e))?;

    // 0. Record the process-level workspace binding (used by helpers).
    settings::set_bound_work_dir(path);

    // 工作区实例锁：绑定同一工作区的第二个实例记为"非首个"，前端跳过自动加载
    // 最近会话；绑定不同工作区互不影响。
    *IS_FIRST_INSTANCE.lock().unwrap() = acquire_workspace_lock(path);
    log::info!("is_first_instance(workspace) = {}", *IS_FIRST_INSTANCE.lock().unwrap());

    // Idempotency / spawn-in-progress guard. With the async backend spawn, the
    // frontend may call bind twice for the same workspace (setup() pre-binds a
    // --workspace instance, then the frontend binds again). work_dir == path with
    // port == None means a spawn is already in flight — return 0 so the frontend
    // polls get_ide_port instead of double-spawning. A non-zero port means fully
    // bound — return it directly.
    {
        let bs = app.state::<Mutex<backend::BackendState>>();
        let mut b = bs.lock().map_err(|e| format!("Lock error: {}", e))?;
        if b.work_dir == path {
            if let Some(p) = b.port {
                return Ok(p);
            }
            if b.spawning {
                return Ok(0);
            }
            // Previous spawn ended without a port — fall through to re-spawn.
        }
        b.work_dir = path.to_string();
        b.port = None;
        b.spawning = true;
    }

    // 1. Effective settings for the bound workspace (global gui + workspace overrides).
    {
        let settings_state = app.state::<Mutex<settings::AppSettings>>();
        let mut s = settings_state.lock().map_err(|e| format!("Lock error: {}", e))?;
        *s = settings::reload_effective_settings(path);
    }

    // 2. Init the per-workspace DB eagerly.
    {
        let db_state = app.state::<Mutex<DbState>>();
        let mut d = db_state.lock().map_err(|e| format!("Lock error: {}", e))?;
        let db_dir = std::path::PathBuf::from(path).join(".claude");
        std::fs::create_dir_all(&db_dir).map_err(|e| format!("Cannot create .claude dir: {}", e))?;
        let conn = db::init_db(&db_dir.join("data.db").to_string_lossy())?;
        d.conn = conn;
        d.work_dir = path.to_string();
        log::info!("DB bound to workspace: {}", path);
    }

    // 3. Spawn the IDE backend ASYNCHRONOUSLY — the bind call returns
    //    immediately so the UI stays responsive. The background thread registers
    //    the MCP config, waits for the MCP to be ready, spawns the backend, and
    //    stores the port in BackendState (the frontend polls get_ide_port).
    {
        let bs = app.state::<Mutex<backend::BackendState>>();
        let mut b = bs.lock().map_err(|e| format!("Lock error: {}", e))?;
        if b.process.is_some() || b.backend_pid.is_some() {
            log::info!("Killing pre-started backend before rebinding workspace");
            backend::kill(&mut b);
        }
        b.port = None;
    }

    // 3b. Spawn on a background thread (owned by backend module).
    backend::spawn_async(&app, path, build_ide_backend_command)?;

    // 4. Record the workspace in the global recent list.
    add_to_workspaces(path);

    Ok(0)
}

fn add_to_workspaces(path: &str) {
    let mut global = settings::load_global_settings();
    if !global.workspaces.iter().any(|w| w == path) {
        global.workspaces.push(path.to_string());
    }
    global.recent_workspaces.retain(|w| w != path);
    global.recent_workspaces.insert(0, path.to_string());
    if global.recent_workspaces.len() > 10 {
        global.recent_workspaces.truncate(10);
    }
    let _ = settings::save_global_settings(&global);
}

#[tauri::command]
fn bind_workspace(app: tauri::AppHandle, path: String) -> Result<u16, String> {
    bind_workspace_internal(&app, &path)
}

#[tauri::command]
fn get_default_work_dir() -> Result<String, String> {
    let s = settings::AppSettings::default();
    // Ensure the default directory exists
    let path = std::path::PathBuf::from(&s.work_dir);
    if !path.exists() {
        std::fs::create_dir_all(&path).ok();
    }
    Ok(s.work_dir)
}

// ── Model profile commands ──

#[derive(Debug, Serialize)]
struct ModelProfile {
    id: String,
    label: String,
    model: String,
}

#[derive(Debug, Serialize)]
struct ModelProfilesResult {
    profiles: Vec<ModelProfile>,
    active: Option<String>,
}

/// Profile 目录只认用户级 ~/.claude/.env.profiles（全局共享，跨项目/工作区
/// 列表一致）。旧版曾按「IDE 脚本项目根 → 工作区 → 用户级」碰运气复用目录，
/// 导致 profile 散落各项目、跨项目找不到——遗留目录由 migrate_legacy_profiles
/// 迁移后用不到这里。
pub(crate) fn find_profiles_dir() -> Option<std::path::PathBuf> {
    let candidate = user_claude_dir().join(".env.profiles");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

/// Parse a simple .env file into key-value pairs.
pub(crate) fn parse_env_file(content: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let key = trimmed[..eq].trim().to_string();
            let val = trimmed[eq + 1..].trim();
            // Strip surrounding quotes if present
            let val = if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                &val[1..val.len() - 1]
            } else {
                val
            };
            result.push((key, val.to_string()));
        }
    }
    result
}

#[tauri::command]
fn list_model_profiles() -> Result<ModelProfilesResult, String> {
    let mut profiles = Vec::new();

    if let Some(profiles_dir) = find_profiles_dir() {
        if let Ok(entries) = std::fs::read_dir(&profiles_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(true, |e| e != "env") {
                    continue;
                }
                let id = path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let label = id.clone();
                let mut model = String::new();
                if let Ok(content) = std::fs::read_to_string(&path) {
                    for (k, v) in parse_env_file(&content) {
                        if k == "ANTHROPIC_MODEL" || k == "ANTHROPIC_DEFAULT_SONNET_MODEL" {
                            model = v;
                            break;
                        }
                    }
                }
                profiles.push(ModelProfile { id, label, model });
            }
        }
    }

    // Read active profile
    let active = {
        let settings = settings::load_settings();
        let active_path = std::path::PathBuf::from(&settings.work_dir)
            .join(".claude")
            .join("active-profile");
        if active_path.exists() {
            std::fs::read_to_string(&active_path).ok().map(|s| s.trim().to_string())
        } else {
            None
        }
    };

    Ok(ModelProfilesResult { profiles, active })
}

#[tauri::command]
fn switch_model_profile(
    app: tauri::AppHandle,
    state: tauri::State<Mutex<backend::BackendState>>,
    profile_id: String,
) -> Result<(), String> {
    let profiles_dir = find_profiles_dir()
        .ok_or_else(|| "Cannot find .env.profiles directory".to_string())?;
    let profile_path = profiles_dir.join(format!("{}.env", profile_id));
    if !profile_path.exists() {
        return Err(format!("Profile '{}' not found", profile_id));
    }

    let content = std::fs::read_to_string(&profile_path)
        .map_err(|e| format!("Cannot read profile: {}", e))?;
    let env_vars = parse_env_file(&content);

    // Write env to workspace's .claude/settings.local.json
    let settings = settings::load_settings();
    let workspace = std::path::PathBuf::from(&settings.work_dir);
    let claude_dir = workspace.join(".claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| format!("Cannot create .claude dir: {}", e))?;
    let local_settings_path = claude_dir.join("settings.local.json");

    let mut local_settings: serde_json::Value = if local_settings_path.exists() {
        let raw = std::fs::read_to_string(&local_settings_path)
            .map_err(|e| format!("Cannot read settings.local.json: {}", e))?;
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    apply_profile_env_to_settings(&mut local_settings, &env_vars);

    std::fs::write(&local_settings_path,
        serde_json::to_string_pretty(&local_settings).unwrap_or_default())
        .map_err(|e| format!("Cannot write settings.local.json: {}", e))?;

    // Write active profile markers — both GUI and CLI consumers
    let active_path = claude_dir.join("active-profile");
    std::fs::write(&active_path, &profile_id)
        .map_err(|e| format!("Cannot write active-profile: {}", e))?;
    write_user_marker(&profile_id);

    // Restart IDE backend to apply new env
    restart_ide_backend(app, state)
}

const COMMON_DEFAULTS: &str = "\
API_TIMEOUT_MS=120000
MAX_TOKENS=131072
CLAUDE_CODE_MAX_OUTPUT_TOKENS=131072
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD=999999
";

/// Profile-managed env keys — single source of truth shared with the CLI
/// (scripts/claude-profile.ts MANAGED_KEYS). Keep in sync: scripts and Rust
/// must clear/rewrite the same set so no stale profile values survive in
/// settings env files.
const MANAGED_KEYS: [&str; 17] = [
    "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "API_TIMEOUT_MS", "MAX_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_TELEMETRY",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD",
];

/// Replace profile-managed keys in a settings JSON's `env`, preserving other fields.
fn apply_profile_env_to_settings(
    settings: &mut serde_json::Value,
    env_vars: &[(String, String)],
) {
    if !settings.get("env").map_or(false, |v| v.is_object()) {
        settings["env"] = serde_json::json!({});
    }
    if let Some(env_obj) = settings["env"].as_object_mut() {
        for key in MANAGED_KEYS {
            env_obj.remove(key);
        }
        for (k, v) in env_vars {
            env_obj.insert(k.clone(), serde_json::Value::String(v.clone()));
        }
    }
}

/// Serialize env vars as KEY=VALUE lines (optionally with common defaults).
/// Keys already present in `env_vars` are skipped from `COMMON_DEFAULTS`
/// so user-chosen values override the baked-in defaults.
fn env_file_string(env_vars: &[(String, String)], with_defaults: bool) -> String {
    let mut content = String::new();
    for (k, v) in env_vars {
        content.push_str(&format!("{}={}\n", k, v));
    }
    if with_defaults {
        let present: std::collections::HashSet<&str> =
            env_vars.iter().map(|(k, _)| k.as_str()).collect();
        for line in COMMON_DEFAULTS.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some(eq) = trimmed.find('=') {
                let key = trimmed[..eq].trim();
                if !present.contains(key) {
                    content.push_str(trimmed);
                    content.push('\n');
                }
            }
        }
    }
    content
}

/// Profile 一律创建在用户级 ~/.claude/.env.profiles（全局共享）。
fn ensure_profiles_dir() -> Result<std::path::PathBuf, String> {
    let dir = user_claude_dir().join(".env.profiles");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create .env.profiles directory: {}", e))?;
    Ok(dir)
}

/// 迁移旧版散落在项目/工作区级的 .env.profiles：复制 *.env 到用户级，
/// 同名不覆盖（用户级优先）。旧目录保留不删，避免破坏 git 仓库内已提交内容。
pub(crate) fn migrate_legacy_profiles() {
    let user_dir = user_claude_dir().join(".env.profiles");
    std::fs::create_dir_all(&user_dir).ok();

    let mut legacy_dirs = Vec::new();
    if let Ok(script) = find_ide_script() {
        legacy_dirs.push(find_project_root(&script).join(".env.profiles"));
    }
    let ws = settings::load_settings().work_dir;
    legacy_dirs.push(std::path::PathBuf::from(&ws).join(".env.profiles"));
    legacy_dirs.dedup();

    for dir in legacy_dirs {
        if dir == user_dir || !dir.exists() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map_or(true, |x| x != "env") {
                continue;
            }
            let Some(name) = p.file_name() else { continue };
            let dst = user_dir.join(&name);
            if dst.exists() {
                continue;
            }
            match std::fs::copy(&p, &dst) {
                Ok(_) => log::info!("[profile] 迁移 {} → {}", p.display(), dst.display()),
                Err(err) => log::warn!("[profile] 迁移失败 {} → {}: {}", p.display(), dst.display(), err),
            }
        }
    }
}

#[tauri::command]
fn create_profile(profile_name: String, env_vars: HashMap<String, String>) -> Result<(), String> {
    let dir = ensure_profiles_dir()?;
    let path = dir.join(format!("{}.env", profile_name));
    let env_pairs: Vec<(String, String)> = env_vars.into_iter().collect();
    let content = env_file_string(&env_pairs, true);
    std::fs::write(&path, content).map_err(|e| format!("Cannot write profile: {}", e))?;
    log::info!("Profile created: {}", profile_name);
    Ok(())
}

#[tauri::command]
fn delete_profile(profile_name: String) -> Result<(), String> {
    let dir = find_profiles_dir()
        .ok_or_else(|| "Cannot find .env.profiles directory".to_string())?;
    let path = dir.join(format!("{}.env", profile_name));
    if !path.exists() {
        return Err(format!("Profile '{}' not found", profile_name));
    }
    std::fs::remove_file(&path).map_err(|e| format!("Cannot delete profile: {}", e))?;
    log::info!("Profile deleted: {}", profile_name);
    Ok(())
}

#[tauri::command]
fn set_default_profile(profile_name: String) -> Result<(), String> {
    let dir = find_profiles_dir()
        .ok_or_else(|| "Cannot find .env.profiles directory".to_string())?;
    let path = dir.join(format!("{}.env", profile_name));
    if !path.exists() {
        return Err(format!("Profile '{}' not found", profile_name));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read profile: {}", e))?;
    let env_vars = parse_env_file(&content);

    // Write to user-level engine settings (~/.claude/settings.json env section)
    // plus profile.env (launcher --env-file) and the user active marker, so
    // the CLI, launchers, and engine all see the same user default.
    let claude_dir = user_claude_dir();
    std::fs::create_dir_all(&claude_dir).ok();

    let settings_path = claude_dir.join("settings.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let raw = std::fs::read_to_string(&settings_path)
            .unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    apply_profile_env_to_settings(&mut settings, &env_vars);

    std::fs::write(&settings_path,
        serde_json::to_string_pretty(&settings).unwrap_or_default())
        .map_err(|e| format!("Cannot write settings.json: {}", e))?;

    // profile.env for launcher --env-file compatibility
    let profile_env_path = claude_dir.join("profile.env");
    std::fs::write(&profile_env_path, env_file_string(&env_vars, false))
        .map_err(|e| format!("Cannot write profile.env: {}", e))?;

    write_user_marker(&profile_name);

    log::info!("Default profile set: {}", profile_name);
    Ok(())
}

// ── Floating window commands ──

/// Per-instance WebView2 user data folder. WebView2 only allows one browser
/// process per data folder — two instances share the default folder make
/// the second one's webview fail with HRESULT 0x8007139F. Keying by PID keeps
/// every concurrently-running instance isolated.
fn webview_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"));
    base.join(format!("EBWebView-{}", std::process::id()))
}

/// Clean up stale per-PID WebView2 user data folders from previous runs.
/// Every GUI start creates `EBWebView-{PID}`; old ones are never removed and
/// WebView2 never cleans them, so they pile up (Session/IndexedDB/Cache junk).
/// Call BEFORE the main window is built: the in-use folder is the current PID,
/// so removing all others is always safe (a concurrently-running second
/// instance keeps its own live PID folder untouched).
fn cleanup_old_webview_dirs(app: &tauri::AppHandle) {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"));
    if !base.exists() {
        return;
    }
    let current_pid = format!("EBWebView-{}", std::process::id());
    let mut removed = 0usize;
    let mut freed: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            if !p.is_dir() || e.file_type().map(|t| !t.is_dir()).unwrap_or(true) {
                continue;
            }
            if name == current_pid {
                continue; // 正在使用的目录，跳过
            }
            if let Some(rest) = name.strip_prefix("EBWebView-") {
                if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
                    continue; // 只清纯 PID 命名的目录，避免误删其他文件
                }
                let size = dir_size(&p);
                let ok = std::fs::remove_dir_all(&p).is_ok();
                if ok {
                    removed += 1;
                    freed += size;
                }
            }
        }
    }
    if removed > 0 {
        log::info!(
            "cleanup_old_webview_dirs: removed {} stale EBWebView dirs, freed ~{} MB",
            removed,
            freed / (1024 * 1024)
        );
    }
}

/// Best-effort recursive size of a directory in bytes.
fn dir_size(path: &std::path::Path) -> u64 {
    fn walk(p: &std::path::Path, acc: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(p) {
            for e in entries.flatten() {
                let f = e.path();
                if f.is_dir() {
                    walk(&f, acc);
                } else if let Ok(md) = f.metadata() {
                    *acc += md.len();
                }
            }
        }
    }
    let mut total = 0u64;
    walk(path, &mut total);
    total
}

#[tauri::command]
fn create_floating_window(
    app: tauri::AppHandle,
    label: String,
    panel_id: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let path = format!(
        "index.html#floating/{}/{}/{}",
        urlencoding(&panel_id),
        urlencoding(&title),
        urlencoding(&label)
    );
    log::info!("[Rust] create_floating_window: label={} path={}", label, path);
    let title_clone = title.clone();
    let label_clone = label.clone();
    std::thread::spawn(move || {
        match tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App(path.into()),
        )
        // Window titles may be any string (only LABELS are charset-restricted).
        .title(&title_clone)
        .inner_size(width, height)
        .data_directory(webview_data_dir(&app))
        .build()
        {
            Ok(win) => {
                let emit_label = win.label().to_string();
                let app_for_event = app.clone();
                // Closing the OS window tears down the webview, so the React unmount
                // "goodbye" may never fire — the Hub would keep the tauriWindows
                // entry and recreate the window on restart. Emit on actual
                // destruction so the Hub can drop the entry (and persist the removal).
                win.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        let _ = app_for_event.emit("floating-window-closed", emit_label.as_str());
                    }
                });
                log::info!("[Rust] create_floating_window SUCCESS: {}", label_clone);
            }
            Err(e) => log::error!("[Rust] create_floating_window FAILED: {}", e),
        }
    });
    Ok(())
}

fn urlencoding(s: &str) -> String {
    s.replace('%', "%25")
        .replace('#', "%23")
        .replace('&', "%26")
        .replace('+', "%2B")
}

// ── 外部链接窗口 ──

/// 主窗口导航守卫：URL 是否允许在主窗口导航（返回 true = 放行）。
/// 只放行应用自身入口页（`tauri://` 或 `tauri.localhost` / dev `localhost`，且路径为入口）；
/// 其余（外部 http(s)、相对/绝对路径 href 解析到 app origin 的导航）一律拦截，
/// GUI 永不被替换。应用用哈希路由——片段导航不触发 on_navigation，无需放行其它路径。
fn is_allowed_navigation(url: &tauri::Url) -> bool {
    let is_app_host = match (url.scheme(), url.host_str()) {
        ("tauri", _) => true,
        (_, Some("tauri.localhost")) => true,
        // dev: frontendDist devUrl http://localhost:1420
        #[cfg(debug_assertions)]
        (_, Some("localhost")) => true,
        _ => false,
    };
    if !is_app_host {
        return false;
    }
    let p = url.path();
    p.is_empty() || p == "/" || p == "/index.html"
}

/// URL 去重键：同一 URL 复用窗口，不同 URL 各开一个。
fn url_window_label(url: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    url.hash(&mut h);
    format!("urlview-{:08x}", h.finish())
}

/// 在应用内新窗口渲染外部 URL（无 iframe，顶层文档）。
/// 同 URL 已开 → 聚焦 + 导航到最新 URL；未开 → 新建原生窗口。
/// label `urlview-*` 不在 capabilities 白名单 → 外部站点无 IPC，调不到 Rust 命令。
#[tauri::command]
fn open_url_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Only http(s) URLs supported: {}", url));
    }
    let label = url_window_label(&url);
    log::info!("[Rust] open_url_window: label={} url={}", label, url);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.navigate(parsed);
        let _ = existing.set_focus();
        return Ok(());
    }

    let host = parsed.host_str().unwrap_or("link").to_string();
    let title_clone = host.clone();
    let app_for_spawn = app.clone();
    std::thread::spawn(move || {
        match tauri::WebviewWindowBuilder::new(
            &app_for_spawn,
            &label,
            tauri::WebviewUrl::External(parsed),
        )
        .title(&title_clone)
        .inner_size(1000.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .data_directory(webview_data_dir(&app_for_spawn))
        .on_page_load(|window, payload| {
            if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            // 页面加载完成后把窗口标题更新为网页真实标题
            let w = window.clone();
            let _ = window.eval_with_callback("document.title", move |title| {
                let t = title.trim().to_string();
                if !t.is_empty() {
                    let _ = w.set_title(&t);
                }
            });
        })
        .build()
        {
            Ok(win) => {
                let _ = win.set_focus();
                log::info!("[Rust] open_url_window SUCCESS: {} {}", label, title_clone);
            }
            Err(e) => log::error!("[Rust] open_url_window FAILED: {}", e),
        }
    });
    Ok(())
}

#[tauri::command]
fn close_me(window: tauri::WebviewWindow) -> Result<(), String> {
    log::info!("[Rust] close_me called by window: {}", window.label());
    window
        .close()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn restart_ide_backend(
    app: tauri::AppHandle,
    state: tauri::State<Mutex<backend::BackendState>>,
) -> Result<(), String> {
    // Kill existing process tree and update work_dir from settings
    let wd = {
        let mut guard = state.lock().map_err(|e| format!("Lock error: {}", e))?;
        // A spawn is already in flight (e.g. from a workspace rebind). The
        // frontend's 3s quick-poll just timed out waiting for its port — killing
        // it here would restart the same spawn and loop forever. Let it finish.
        if guard.spawning {
            return Ok(());
        }
        backend::kill(&mut guard);
        guard.port = None;
        guard.spawning = true;
        let settings = settings::load_settings();
        let wd = settings.work_dir.clone();
        guard.work_dir = wd.clone();
        wd
    };

    log::info!("Spawning IDE backend in background thread");
    backend::spawn_async(&app, &wd, build_ide_backend_command)
}

/// 诊断修复: 先杀掉所有残留 GUI 后端（孤儿/卡死进程，命令行带 --ide-mode），
/// 再按当前工作区重启 IDE 后端。原生 API 杀进程，未匹配到进程时直接忽略。
#[tauri::command]
fn fix_restart_ide_backend(
    app: tauri::AppHandle,
    state: tauri::State<Mutex<backend::BackendState>>,
) -> Result<String, String> {
    // 只杀 GUI 后端（命令行带 --ide-mode）——不再按镜像名全杀，避免误杀
    // 终端里不带 --ide-mode 的 TUI。
    #[cfg(windows)]
    prockill::kill_by_command_line("--ide-mode");

    let wd = {
        let mut guard = state.lock().map_err(|e| format!("Lock error: {}", e))?;
        if guard.spawning {
            return Ok("IDE 后端已在启动中，跳过重复重启".into());
        }
        backend::kill(&mut guard);
        guard.port = None;
        guard.spawning = true;
        let settings = settings::load_settings();
        let wd = settings.work_dir.clone();
        guard.work_dir = wd.clone();
        wd
    };

    log::info!("[diagnostics-fix] killed stray claude/bun, respawning IDE backend");
    let _ = backend::spawn_async(&app, &wd, build_ide_backend_command);
    Ok("已杀死残留后台进程并重启 IDE 后端".into())
}

// ── IDE backend spawning ──

fn strip_extended_prefix(path: &std::path::Path) -> std::path::PathBuf {
    let s = path.to_string_lossy();
    if s.starts_with("\\\\?\\") {
        std::path::PathBuf::from(&s[4..])
    } else {
        path.to_path_buf()
    }
}

/// Register the Super Desktop MCP server in ~/.claude/settings.json (root-level mcpServers,
/// user-scope, available to all workspaces — same tier as memory/playwright MCPs).
/// Register the super-desktop MCP server in the WORKSPACE's settings.local.json
/// (scoped per workspace so multiple GUI instances each connect to their own
/// embedded MCP port). Also removes the legacy global registration that a
/// single-instance build wrote to ~/.claude/settings.json, so stale 13920
/// entries never leak into other workspaces.
fn register_super_desktop_mcp(work_dir: &str) {
    let mcp_port = mcp::mcp_port();
    if mcp_port == 0 { return; }

    // The IDE backend reads MCP servers from the workspace's `.mcp.json`
    // (project scope) — `settings.local.json` → `mcpServers` is NOT read by
    // claude.exe (see src/services/mcp/config.ts getMcpConfigsByScope). Writing
    // here is what actually exposes note_*/desktop_* tools to the AI.
    let config_path = std::path::PathBuf::from(work_dir).join(".mcp.json");
    let mut config: serde_json::Value = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let mcp = config
        .as_object_mut()
        .and_then(|root| root.entry("mcpServers").or_insert(serde_json::json!({})).as_object_mut());

    if let Some(servers) = mcp {
        servers.insert(
            "super-desktop".to_string(),
            serde_json::json!({
                "type": "http",
                "url": format!("http://127.0.0.1:{}/mcp", mcp_port)
            }),
        );
        if let Ok(json) = serde_json::to_string_pretty(&config) {
            let _ = std::fs::write(&config_path, json);
            log::info!("Registered super-desktop MCP server (port {}) in {}", mcp_port, config_path.display());
        }
    }

    // Remove the now-ineffective super-desktop entry from settings.local.json
    // (claude.exe ignores mcpServers there) to avoid confusion.
    let local_path = settings::workspace_settings_path(work_dir);
    if let Ok(content) = std::fs::read_to_string(&local_path) {
        if let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&content) {
            let mut changed = false;
            if let Some(servers) = root.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
                if servers.remove("super-desktop").is_some() {
                    changed = true;
                }
            }
            if changed {
                if let Ok(json) = serde_json::to_string_pretty(&root) {
                    let _ = std::fs::write(&local_path, json);
                    log::info!("Removed super-desktop MCP from settings.local.json (moved to .mcp.json)");
                }
            }
        }
    }

    // Remove stale global registration from ~/.claude/settings.json.
    let global_path = settings::global_settings_path();
    if let Ok(content) = std::fs::read_to_string(&global_path) {
        if let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&content) {
            let mut changed = false;
            if let Some(servers) = root.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
                if servers.remove("super-desktop").is_some() {
                    changed = true;
                }
            }
            if changed {
                if let Ok(json) = serde_json::to_string_pretty(&root) {
                    let _ = std::fs::write(&global_path, json);
                    log::info!("Removed legacy global super-desktop MCP registration");
                }
            }
        }
    }
}

/// Poll the embedded MCP server until it answers a tools/list request (the
/// Rust listener AND the JS bridge must both be up). Used before spawning the
/// IDE backend so it never connects to a half-initialized MCP.
fn wait_for_mcp_ready(port: u16) {
    if port == 0 {
        return;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        if probe_mcp(port) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    log::warn!("MCP server did not answer within 8s — starting IDE backend anyway");
}

fn probe_mcp(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#;
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 2048];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let resp = String::from_utf8_lossy(&buf[..n]);
    resp.contains("\"result\"") || resp.contains("\"tools\"")
}

/// Build the IDE backend Command for a workspace — does the slow pre-spawn
/// work (embedded docs, MCP registration + readiness wait, profile, env) on
/// the spawn thread. The process lifecycle itself lives in backend.rs.
fn build_ide_backend_command(work_dir: &str) -> Result<Command, String> {
    let script = find_ide_script()?;
    let script = strip_extended_prefix(&script);
    log::info!("Starting IDE backend: {} (CWD={})", script.display(), work_dir);

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(&script);
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        c
    } else {
        let mut c = Command::new("bash");
        c.arg(&script);
        c
    };

    let project_root = find_project_root(&script);
    let project_root = strip_extended_prefix(&project_root);

    // Write embedded docs to ~/.claude/ so AI can find them regardless of
    // workspace or filesystem layout (works in dev + release + packaged exe).
    // Overwrite when the embedded content differs — keeps docs in sync with the
    // GUI version (a stale guide misleads the AI), while skipping the write on
    // every launch when unchanged (content compare is cheap, no disk churn).
    {
        let home = user_home();
        let dest_dir = home.join(".claude");
        let _ = std::fs::create_dir_all(&dest_dir);
        let docs: &[(&str, &str)] = &[
            ("gui-agent-guide.md", GUI_AGENT_GUIDE),
            ("gui-ref-system.md", GUI_REF_SYSTEM),
            ("gui-config-files.md", GUI_CONFIG_FILES),
        ];
        for (name, content) in docs {
            let dst = dest_dir.join(name);
            let needs_write = match std::fs::read(&dst) {
                Ok(existing) => existing != content.as_bytes(),
                Err(_) => true, // missing or unreadable → (re)write
            };
            if needs_write {
                let _ = std::fs::write(&dst, content);
            }
        }
    }

    // Ensure Super Desktop MCP is registered for this workspace
    register_super_desktop_mcp(work_dir);

    // Block until the MCP server actually responds (Rust listener + JS bridge
    // both up) before starting the IDE backend. If the backend connects to the
    // MCP before it is ready, Claude Code marks the server failed and the
    // note_*/desktop_* tools never mount. Runs on the background spawn thread,
    // so it does not block the UI.
    wait_for_mcp_ready(mcp::mcp_port());
    log::info!("Super-desktop MCP ready — starting IDE backend");

    cmd.current_dir(&project_root);

    cmd.env("CLAUDE_CODE_CWD", work_dir)
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

    // Stream idle watchdog — default-off in the engine, but without it a hung or
    // silently-dropped model API stream waits forever (SDK timeout only covers
    // the initial fetch, not the streaming body). 5 min between chunks is
    // generous enough for huge-context requests (582k+ tokens) while still
    // recovering a genuinely stuck call instead of hanging the session.
    cmd.env("CLAUDE_ENABLE_STREAM_WATCHDOG", "1")
        .env("CLAUDE_STREAM_IDLE_TIMEOUT_MS", "300000");

    // Pass GUI settings to backend via env vars
    if settings::load_settings().force_chinese_thinking.unwrap_or(false) {
        cmd.env("CLAUDE_CODE_GUI_FORCE_CHINESE", "1");
    }

    // Auto-apply active profile to backend process
    apply_active_profile(&mut cmd);

    Ok(cmd)
}

pub(crate) fn find_ide_script() -> Result<std::path::PathBuf, String> {
    let script_name = if cfg!(target_os = "windows") {
        "claude-ide.cmd"
    } else {
        "claude-ide"
    };

    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        for _ in 0..6 {
            // Installed layout: claude-ide.cmd sits next to claude-code-gui.exe
            // in {app}, NOT in bin/. Check the exe's own dir first so the launch
            // never depends on CLAUDE_CODE_HAHA_HOME / PATH — a stale env block
            // inherited from Explorer (env changed after Explorer started) makes
            // normal launches miss the PATH fallback; only admin launches re-read
            // the registry and see it.
            let candidate = dir.join(script_name);
            if candidate.exists() {
                return Ok(candidate);
            }
            let candidate_bin = dir.join("bin").join(script_name);
            if candidate_bin.exists() {
                return Ok(candidate_bin);
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }

    let rel_paths = vec![
        std::path::PathBuf::from("../bin").join(script_name),
        std::path::PathBuf::from("../../bin").join(script_name),
        std::path::PathBuf::from("bin").join(script_name),
    ];
    for p in &rel_paths {
        if p.exists() {
            return Ok(p.clone());
        }
    }

    if let Ok(path) = std::env::var("PATH") {
        let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
        for dir in path.split(sep) {
            let candidate = std::path::PathBuf::from(dir).join(script_name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    Err(format!("Could not find {}", script_name))
}

/// Resolve the active profile id + marker source. Priority: workspace
/// .claude/active-profile (GUI switch writes it — per-workspace independent
/// memory) → ~/.claude/.env.active (CLI + fallback) → first available .env
/// profile. Shared by apply_active_profile and the diagnostics module so the
/// two can never drift about which profile is active.
pub(crate) fn resolve_active_profile() -> Option<(String, &'static str)> {
    let profiles_dir = find_profiles_dir()?;

    let mut active_id = None;
    let mut source = "";
    let ws_marker = std::path::PathBuf::from(settings::load_settings().work_dir)
        .join(".claude")
        .join("active-profile");
    if let Some(id) = read_marker(&ws_marker) {
        active_id = Some(id);
        source = "工作区 active-profile";
    }
    if active_id.is_none() {
        if let Some(id) = read_marker(&user_claude_dir().join(".env.active")) {
            active_id = Some(id);
            source = "~/.claude/.env.active";
        }
    }
    if active_id.is_none() {
        active_id = std::fs::read_dir(&profiles_dir).ok()?.flatten()
            .find(|e| e.path().extension().map_or(false, |ext| ext == "env"))
            .and_then(|e| e.path().file_stem().map(|s| s.to_string_lossy().to_string()));
        if active_id.is_some() {
            source = "兜底（第一个 profile）";
        }
    }

    active_id.map(|id| (id, source))
}

/// Auto-detect the user's active profile (project .claude/active-profile, then
/// ~/.claude/.env.active, then first available) and set its env vars on the
/// child process so the IDE backend uses the right model.
fn apply_active_profile(cmd: &mut Command) {
    let profiles_dir = match find_profiles_dir() {
        Some(d) => d,
        None => { log::info!("[profile] No profiles dir found"); return; }
    };

    let Some((profile_id, _)) = resolve_active_profile() else {
        log::info!("[profile] No active profile");
        return;
    };

    let profile_path = profiles_dir.join(format!("{}.env", profile_id));
    if !profile_path.exists() {
        log::warn!("[profile] Profile file not found: {}", profile_path.display());
        return;
    }

    let content = match std::fs::read_to_string(&profile_path) {
        Ok(c) => c,
        Err(e) => { log::warn!("[profile] Cannot read profile: {}", e); return; }
    };

    let vars = parse_env_file(&content);
    for (key, value) in &vars {
        cmd.env(key, value);
    }

    log::info!("[profile] Applied '{}' ({} vars) from {}", profile_id, vars.len(), profile_path.display());
}

pub(crate) fn find_project_root(script: &std::path::Path) -> std::path::PathBuf {
    if let Some(parent) = script.parent() {
        if let Some(root) = parent.parent() {
            return root.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
}

pub(crate) fn dirs_next() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|p| std::path::PathBuf::from(p).join("claude-code-gui"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .ok()
            .map(|p| std::path::PathBuf::from(p).join(".config").join("claude-code-gui"))
    }
}

pub(crate) fn user_home() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }
}

pub(crate) fn user_claude_dir() -> std::path::PathBuf {
    user_home().join(".claude")
}

/// Read a marker file (trimmed non-empty content) or None.
pub(crate) fn read_marker(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Write the user-level active marker (~/.claude/.env.active), best-effort.
fn write_user_marker(profile_id: &str) {
    let path = user_claude_dir().join(".env.active");
    if let Err(e) = std::fs::write(&path, profile_id) {
        log::warn!("[profile] Cannot write user active marker: {}", e);
    }
}

// ── System terminal ──

#[cfg(target_os = "windows")]
/// Locate Windows Terminal (wt.exe). 通常以 WindowsApps 执行别名存在, PATH 兜底。
fn find_wt() -> Option<String> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = std::path::Path::new(&local).join("Microsoft").join("WindowsApps").join("wt.exe");
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    if let Ok(output) = Command::new("where").arg("wt").output() {
        if let Ok(stdout) = String::from_utf8(output.stdout) {
            for line in stdout.lines() {
                let t = line.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

fn find_git_bash() -> Option<String> {
    let candidates = [
        r"C:\Program Files\Git\git-bash.exe",
        r"C:\Program Files (x86)\Git\git-bash.exe",
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    // Derive from git in PATH: git.exe is in .../Git/cmd/ or .../Git/bin/
    if let Ok(output) = Command::new("where").arg("git").output() {
        if let Ok(stdout) = String::from_utf8(output.stdout) {
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                for ancestor in std::path::Path::new(trimmed).ancestors().skip(1) {
                    let bash = ancestor.join("git-bash.exe");
                    if bash.exists() {
                        return Some(bash.to_string_lossy().to_string());
                    }
                }
                break;
            }
        }
    }
    None
}

// ── Clipboard ──

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("{}", e))?;
    clipboard.get_text().map_err(|e| format!("{}", e))
}

// ── File tree context menu helpers ──

/// 把划词文本里的路径解析成绝对路径（纯函数，可单测）。
/// 相对路径以工作区根为基准拼接——划词文本常含项目内相对路径
/// （如 `src/utils/pathDetector.ts`），若原样传给 explorer，它会在
/// 默认位置找不到文件，退化为打开桌面/文档库。
fn resolve_explorer_path(raw: &str, work_dir: &str) -> String {
    let p = std::path::Path::new(raw);
    if p.is_absolute() {
        return raw.to_string();
    }
    // 以工作区根为基准拼接, 并用 components 规范化: 去 `.` 段、压平 `..` 段,
    // 让 explorer 拿到的就是文件真实位置(带 `.\`/`..` 的路径在默认位置解析会失败)
    let joined = std::path::PathBuf::from(work_dir).join(p);
    let mut out = std::path::PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().to_string()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    use std::process::Command;
    // explorer 要求 /select, 与路径合成单个参数：分离传参时 explorer 会忽略
    // 选择指令，退化为打开默认「文档」库（实测分离参数打开了文档而非目标目录）。
    let abs = resolve_explorer_path(&path, &crate::settings::load_settings().work_dir);
    // 先确认路径真实存在——不存在时打开资源管理器只会退化为「文档」库或空窗口
    if !std::path::Path::new(&abs).exists() {
        return Err(format!("Path not found: {}", abs));
    }
    Command::new("explorer")
        .arg(format!("/select,{}", abs))
        .spawn()
        .map_err(|e| format!("Failed to open explorer: {}", e))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    // macOS: open -R (Finder 中显示并选中文件); Linux: xdg-open 打开父目录
    use std::process::Command;
    #[cfg(target_os = "macos")]
    Command::new("open").args(["-R", &path]).spawn().map_err(|e| format!("Failed: {}", e))?;
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path).parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        Command::new("xdg-open").arg(&parent).spawn().map_err(|e| format!("Failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn copy_file(src: String, dst: String) -> Result<(), String> {
    let src_path = std::path::Path::new(&src);
    if !src_path.exists() { return Err(format!("Source not found: {}", src)); }
    if std::path::Path::new(&dst).exists() {
        std::fs::remove_file(&dst).map_err(|e| format!("Cannot remove existing: {}", e))?;
    }
    if src_path.is_dir() {
        copy_dir_recursive(src_path, std::path::Path::new(&dst))
            .map_err(|e| format!("Failed to copy directory: {}", e))?;
    } else {
        if let Some(parent) = std::path::Path::new(&dst).parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}", e))?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("Failed to copy file: {}", e))?;
    }
    Ok(())
}

pub(crate) fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_child = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_child)?;
        } else {
            std::fs::copy(entry.path(), &dst_child)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
/// Build the child PATH for a toolbar-spawned terminal. The GUI's own env block
/// is frozen at launch (inherited from Explorer); if the installer / diagnostics
/// wrote the env vars afterwards, the GUI's PATH lacks the install dir where
/// cla.cmd / claude-ide.cmd live. Every terminal spawned from the toolbar is a
/// child of the GUI, so without this it inherits the stale PATH and fails to
/// resolve `cla` / `claude-ide`. (Admin launches appear to "just work" only
/// because UAC rebuilds the env from the registry.)
fn child_path_with_install_dir(existing_path: &str, install_dir: &std::path::Path) -> String {
    let dir = install_dir.to_string_lossy();
    let norm = dir.trim_end_matches('\\');
    let already = existing_path
        .split(';')
        .any(|p| p.trim_end_matches('\\').eq_ignore_ascii_case(norm));
    if already {
        existing_path.to_string()
    } else if existing_path.is_empty() {
        dir.into_owned()
    } else {
        format!("{}\\;{}", dir, existing_path)
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn open_system_terminal(terminal_type: String, work_dir: String, claude_launch: Option<bool>) -> Result<(), String> {
    let launch = claude_launch.unwrap_or(false);
    // Guarantee cla.cmd / claude-ide.cmd (installed next to this exe) are on the
    // child's PATH even when this GUI's env block predates the env write.
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let child_path = child_path_with_install_dir(
        &std::env::var("PATH").unwrap_or_default(),
        &install_dir,
    );
    match terminal_type.as_str() {
        "cmd" => {
            // 优先 Windows Terminal (wt new-tab -d <workdir>); 没有 wt 则回退直接 cmd (legacy)。
            // 旧实现 cmd /c start cmd 的宿主选择依赖父进程上下文(WT/legacy), 时老时新。
            if let Some(wt) = find_wt() {
                let mut base = vec!["new-tab", "-d", &work_dir, "--", "cmd", "/K"];
                if launch {
                    base.push("set CLAUDE_CODE_SKIP_PROMPT_HISTORY=true && claude");
                }
                Command::new(&wt).args(&base).env("PATH", &child_path).spawn()
                    .map_err(|e| format!("Failed to open cmd in Windows Terminal: {}", e))?;
            } else if launch {
                let cmdline = format!("cd /d {} && set CLAUDE_CODE_SKIP_PROMPT_HISTORY=true && claude", &work_dir);
                Command::new("cmd").args(["/K", &cmdline]).env("PATH", &child_path).spawn()
                    .map_err(|e| format!("Failed to open cmd: {}", e))?;
            } else {
                Command::new("cmd").args(["/K", "cd", "/d", &work_dir]).env("PATH", &child_path).spawn()
                    .map_err(|e| format!("Failed to open cmd: {}", e))?;
            }
        }
        "powershell" => {
            // 同样优先 Windows Terminal, 回退直接 powershell (确定性, 不再走 start)
            let safe = work_dir.replace('\'', "''");
            let pw_cmd = if launch {
                format!("Set-Location '{}'; $env:CLAUDE_CODE_SKIP_PROMPT_HISTORY='true'; claude", safe)
            } else {
                format!("Set-Location '{}'", safe)
            };
            if let Some(wt) = find_wt() {
                Command::new(&wt)
                    .args(["new-tab", "-d", &work_dir, "--", "powershell", "-NoExit", "-Command", &pw_cmd])
                    .env("PATH", &child_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open PowerShell in Windows Terminal: {}", e))?;
            } else {
                Command::new("powershell")
                    .args(["-NoExit", "-Command", &pw_cmd])
                    .env("PATH", &child_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open PowerShell: {}", e))?;
            }
        }
        "git-bash" => {
            let git_bash = find_git_bash()
                .ok_or_else(|| "Git Bash not found on this system".to_string())?;
            if launch {
                Command::new(&git_bash)
                    .arg(format!("--cd={}", work_dir))
                    .args(&["-c", "export CLAUDE_CODE_SKIP_PROMPT_HISTORY=true && claude; exec bash"])
                    .env("PATH", &child_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open Git Bash: {}", e))?;
            } else {
                Command::new(&git_bash)
                    .arg(format!("--cd={}", work_dir))
                    .env("PATH", &child_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open Git Bash: {}", e))?;
            }
        }
        _ => return Err(format!("Unknown terminal type: {}", terminal_type)),
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn open_system_terminal(_terminal_type: String, work_dir: String, claude_launch: Option<bool>) -> Result<(), String> {
    use std::process::Command;
    let launch = claude_launch.unwrap_or(false);
    // 转义 work_dir 供 bash 引号内使用，再整体作为 AppleScript 字符串字面量转义。
    // 两层：`"` → `\"`（AppleScript 字面量），`\` → `\\`（保持 bash 路径原样）。
    let work = work_dir.replace('\\', "\\\\").replace('"', "\\\"");
    let body = if launch {
        format!("cd \"{}\" && CLAUDE_CODE_SKIP_PROMPT_HISTORY=true claude", work)
    } else {
        format!("cd \"{}\"", work)
    };
    let script = format!(
        "tell application \"Terminal\" to activate\ntell application \"Terminal\" to do script \"{}\"",
        body
    );
    Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    Ok(())
}

#[tauri::command]
fn get_git_branch(path: String) -> Result<String, String> {
    let head = std::path::PathBuf::from(&path).join(".git").join("HEAD");
    let content = std::fs::read_to_string(&head).map_err(|_| "".to_string())?;
    if let Some(branch) = content.strip_prefix("ref: refs/heads/") {
        Ok(branch.trim().to_string())
    } else {
        // Detached HEAD — show short hash
        Ok(content.trim().chars().take(7).collect())
    }
}

// ── Skills i18n ──

#[tauri::command]
fn run_cli_print(app: tauri::AppHandle, prompt: String, work_dir: String) -> Result<String, String> {
    // Check if any profile is configured
    let has_profile = find_profiles_dir().map_or(false, |dir| {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            entries.flatten().any(|e| e.path().extension().map_or(true, |ext| ext == "env"))
        } else {
            false
        }
    });
    if !has_profile {
        return Err("请先配置 API Profile（工具栏 → Profile 管理）".into());
    }

    // Generate a request ID so the frontend can match the result event
    let request_id = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos());
    let rid = request_id.clone();

    // Spawn CLI in background — return immediately, emit result via Tauri event
    std::thread::spawn(move || {
        let result = run_cli_print_blocking(&prompt, &work_dir);
        let payload = match result {
            Ok(stdout) => serde_json::json!({
                "request_id": &rid,
                "ok": true,
                "output": stdout,
            }),
            Err(e) => serde_json::json!({
                "request_id": &rid,
                "ok": false,
                "error": e,
            }),
        };
        let _ = app.emit("cli-translate-result", payload);
    });

    Ok(request_id)
}

fn run_cli_print_blocking(prompt: &str, work_dir: &str) -> Result<String, String> {
    let script_name = if cfg!(target_os = "windows") { "claude-haha.cmd" } else { "claude-haha" };
    let script = find_cli_script(script_name)?;
    let script = strip_extended_prefix(&script);

    let project_root = find_project_root(&script);
    let project_root = strip_extended_prefix(&project_root);

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(&script).arg("-p");
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        c
    } else {
        let mut c = Command::new("bash");
        c.arg(&script).arg("-p");
        c
    };

    cmd.current_dir(&project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd.env("CLAUDE_CODE_CWD", work_dir)
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "true");

    apply_active_profile(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn CLI: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(prompt.as_bytes()).map_err(|e| format!("Failed to write stdin: {}", e))?;
    }

    let output = child.wait_with_output()
        .map_err(|e| format!("CLI wait error: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("CLI 执行失败: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    log::info!("[translate] CLI output length: {}", stdout.len());
    Ok(stdout)
}

fn find_cli_script(script_name: &str) -> Result<std::path::PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        for _ in 0..6 {
            let candidate = dir.join("bin").join(script_name);
            if candidate.exists() {
                return Ok(candidate);
            }
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }
    // Fallback relative paths
    for prefix in &["../bin", "../../bin", "bin"] {
        let candidate = std::path::PathBuf::from(prefix).join(script_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    // PATH search
    if let Ok(path) = std::env::var("PATH") {
        let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
        for dir in path.split(sep) {
            let candidate = std::path::PathBuf::from(dir).join(script_name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    Err(format!("Could not find {}", script_name))
}

#[tauri::command]
fn save_skills_i18n(json: String) -> Result<(), String> {
    let dir = dirs_next().unwrap_or_else(|| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("skills-i18n.json");
    std::fs::write(&path, &json).map_err(|e| format!("Cannot save: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_skills_i18n() -> Result<String, String> {
    let dir = dirs_next().unwrap_or_else(|| std::path::PathBuf::from("."));
    let path = dir.join("skills-i18n.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot load: {}", e))
}

// ── Skill Marketplace ──

#[tauri::command]
fn get_skills_dir() -> Result<String, String> {
    let dir = user_home().join(".claude").join("skills");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create skills directory: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_skill(skill_name: String) -> Result<(), String> {
    let dir = user_home().join(".claude").join("skills").join(&skill_name);
    if !dir.exists() {
        return Err(format!("Skill '{}' not found", skill_name));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Cannot delete skill '{}': {}", skill_name, e))
}

/// 把阻塞的下载+解压搬到后台线程，async 命令只等 channel → UI 不再卡死。
/// 与 update.rs 的 download_and_install_component 同模式。
#[tauri::command]
async fn install_skill(zip_url: String, skill_name: String) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let skills_dir = user_home().join(".claude").join("skills");
            std::fs::create_dir_all(&skills_dir)
                .map_err(|e| format!("Cannot create skills dir: {}", e))?;

            let target_dir = skills_dir.join(&skill_name);
            let temp_dir = skills_dir.join(format!(".tmp_install_{}", skill_name));

            download_and_extract(&zip_url, &temp_dir)?;

            let skill_root = find_skill_root(&temp_dir)?;

            if target_dir.exists() {
                std::fs::remove_dir_all(&target_dir).ok();
            }
            copy_dir_recursive(&skill_root, &target_dir)
                .map_err(|e| format!("Cannot install skill: {}", e))?;

            std::fs::remove_dir_all(&temp_dir).ok();
            log::info!("Skill installed: {}", skill_name);
            Ok(())
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("Install panicked: {}", e))?
}

#[tauri::command]
async fn install_package(zip_url: String, package_name: String) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let skills_dir = user_home().join(".claude").join("skills");
            std::fs::create_dir_all(&skills_dir)
                .map_err(|e| format!("Cannot create skills dir: {}", e))?;

            let temp_dir = skills_dir.join(format!(".tmp_pkg_{}", package_name));

            download_and_extract(&zip_url, &temp_dir)?;

            let pkg_root = find_package_root(&temp_dir)?;

            let entries = std::fs::read_dir(&pkg_root)
                .map_err(|e| format!("Cannot read package root: {}", e))?;
            let mut installed = 0u32;
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if entry.path().join("SKILL.md").exists() {
                        let skill_name = entry.file_name().to_string_lossy().to_string();
                        let target = skills_dir.join(&skill_name);
                        if target.exists() {
                            std::fs::remove_dir_all(&target).ok();
                        }
                        copy_dir_recursive(&entry.path(), &target)
                            .map_err(|e| format!("Cannot install skill '{}': {}", skill_name, e))?;
                        installed += 1;
                        log::info!("Package skill installed: {}", skill_name);
                    }
                }
            }

            std::fs::remove_dir_all(&temp_dir).ok();

            if installed == 0 {
                return Err("No skills found in package zip".to_string());
            }
            log::info!("Package '{}' installed: {} skills", package_name, installed);
            Ok(())
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("Install panicked: {}", e))?
}

// ── Helpers ──

/// 下载 zip 字节，传输中断（decode/超时/连接）时自动重试一次。
/// 公网大文件易被代理掐断 chunked 流 → 带重试显著降低偶发失败。
fn download_zip_retry(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut last_err: Option<String> = None;
    for attempt in 0..2 {
        match download_zip_once(client, url) {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                last_err = Some(e);
                if attempt == 0 {
                    log::warn!("Skill download failed (attempt {}), retrying: {}", attempt + 1, last_err.as_deref().unwrap_or(""));
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "download failed".to_string()))
}

fn download_zip_once(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client.get(url).send()
        .map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download returned HTTP {}", response.status()));
    }
    response.bytes()
        .map_err(|e| format!("Download read failed: {}", e))
        .map(|b| b.to_vec())
}

pub(crate) fn download_and_extract(url: &str, temp_dir: &std::path::Path) -> Result<(), String> {
    if temp_dir.exists() {
        std::fs::remove_dir_all(temp_dir).ok();
    }
    std::fs::create_dir_all(temp_dir)
        .map_err(|e| format!("Cannot create temp dir: {}", e))?;

    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Cannot create HTTP client: {}", e))?;
    let bytes = download_zip_retry(&client, url)?;

    let zip_path = temp_dir.join("download.zip");
    std::fs::write(&zip_path, &bytes)
        .map_err(|e| format!("Cannot write temp zip: {}", e))?;

    let file = std::fs::File::open(&zip_path)
        .map_err(|e| format!("Cannot open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Cannot read zip: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Zip entry {} error: {}", i, e))?;
        let name = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => continue,
        };
        if entry.is_dir() {
            continue;
        }
        let out_path = temp_dir.join(&name);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create dir: {}", e))?;
        }
        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|e| format!("Cannot create file: {}", e))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("Cannot write extracted file: {}", e))?;
    }

    std::fs::remove_file(&zip_path).ok();
    Ok(())
}

/// Find the directory containing SKILL.md within an extracted temp dir.
/// Checks temp dir itself first, then immediate subdirectories.
fn find_skill_root(temp_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if temp_dir.join("SKILL.md").exists() {
        return Ok(temp_dir.to_path_buf());
    }
    let entries = std::fs::read_dir(temp_dir)
        .map_err(|e| format!("Cannot read temp dir: {}", e))?;
    let mut found: Option<std::path::PathBuf> = None;
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if entry.path().join("SKILL.md").exists() {
                if found.is_some() {
                    return Err("Multiple skill roots found in zip".to_string());
                }
                found = Some(entry.path());
            }
        }
    }
    found.ok_or_else(|| "No SKILL.md found in extracted zip".to_string())
}

/// Find the package root within an extracted temp dir.
fn find_package_root(temp_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if temp_dir.join("manifest.yaml").exists() || has_skill_dirs(temp_dir) {
        return Ok(temp_dir.to_path_buf());
    }
    let entries = std::fs::read_dir(temp_dir)
        .map_err(|e| format!("Cannot read temp dir: {}", e))?;
    let mut found: Option<std::path::PathBuf> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && (path.join("manifest.yaml").exists() || has_skill_dirs(&path)) {
            if found.is_some() {
                return Err("Multiple package roots found in zip".to_string());
            }
            found = Some(path);
        }
    }
    found.ok_or_else(|| "No package root found in zip".to_string())
}

fn has_skill_dirs(dir: &std::path::Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir) {
        entries.flatten().any(|e| {
            e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && e.path().join("SKILL.md").exists()
        })
    } else {
        false
    }
}

// ─── Notes commands ───

#[tauri::command]
fn note_create(input: notes::NoteInput) -> Result<notes::Note, String> {
    notes::note_create(input)
}

#[tauri::command]
fn note_update(id: String, input: notes::NoteUpdate) -> Result<notes::Note, String> {
    notes::note_update(&id, input)
}

#[tauri::command]
fn note_delete(id: String) -> Result<bool, String> {
    notes::note_delete(&id)
}

#[tauri::command]
fn note_get(id: String) -> Result<notes::Note, String> {
    notes::note_get(&id)
}

#[tauri::command]
fn note_list(scope: Option<String>, tag: Option<String>, limit: Option<u32>) -> Result<Vec<notes::NoteSummary>, String> {
    notes::note_list(scope, tag, limit)
}

#[tauri::command]
fn note_search(query: String, scope: Option<String>, limit: Option<u32>) -> Result<Vec<notes::NoteSummary>, String> {
    notes::note_search(&query, scope, limit)
}

#[tauri::command]
fn note_associate(input: notes::NoteAssocInput) -> Result<bool, String> {
    notes::note_associate(input)
}

#[tauri::command]
fn note_disassociate(source_id: String, target_id: String) -> Result<bool, String> {
    notes::note_disassociate(&source_id, &target_id)
}

#[tauri::command]
fn note_tags(scope: Option<String>) -> Result<Vec<notes::TagCount>, String> {
    notes::note_tags(scope)
}

#[tauri::command]
fn note_get_all_tag_names() -> Result<Vec<String>, String> {
    notes::note_get_all_tag_names()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_path_absolute_stays() {
        assert_eq!(
            resolve_explorer_path(r"C:\Users\SZH\a.txt", r"C:\ws"),
            r"C:\Users\SZH\a.txt"
        );
    }

    #[test]
    fn explorer_path_relative_joins_work_dir() {
        // 划词文本里的相对路径必须以工作区根解析, 否则 explorer 落到桌面/文档库;
        // components 会把 `/` 归一为 Windows 分隔符 `\`
        assert_eq!(
            resolve_explorer_path("src/utils/pathDetector.ts", r"C:\Storage\proj"),
            r"C:\Storage\proj\src\utils\pathDetector.ts"
        );
    }

    #[test]
    fn explorer_path_dot_signs_normalized() {
        assert_eq!(
            resolve_explorer_path(r".\gui\src\lib.rs", r"C:\Storage\proj"),
            r"C:\Storage\proj\gui\src\lib.rs"
        );
        // `..` 压平掉上一级
        assert_eq!(
            resolve_explorer_path(r"..\other\x.txt", r"C:\Storage\proj"),
            r"C:\Storage\other\x.txt"
        );
    }

    /// 真机验证（手动跑：cargo test -- --ignored）：
    /// 旧项目级 .env.profiles 迁移到用户级，且工作区激活标记能解析出来。
    #[test]
    #[ignore]
    fn legacy_profiles_migrate_and_ws_marker_resolves() {
        migrate_legacy_profiles();
        let user_dir = user_claude_dir().join(".env.profiles");
        assert!(user_dir.join("plan-ds-v4-flash.env").exists(),
            "旧项目级 plan-ds-v4-flash 未迁移到用户级");
        let active = resolve_active_profile();
        assert!(active.is_some(), "无法解析激活 profile（迁移后应有可用 profile）");
        assert_eq!(active.unwrap().1, "工作区 active-profile");
    }

    // ── 链接导航守卫：主窗口只放行应用自身入口页，其余一律拦截 ──

    fn u(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    #[test]
    fn nav_app_origin_allowed() {
        assert!(is_allowed_navigation(&u("tauri://localhost")));
        assert!(is_allowed_navigation(&u("http://tauri.localhost")));
        assert!(is_allowed_navigation(&u("http://tauri.localhost/")));
        assert!(is_allowed_navigation(&u("https://tauri.localhost/index.html")));
    }

    #[test]
    fn nav_app_relative_path_blocked() {
        // 相对/绝对路径 href 会解析到 app origin → 必须拦，防主窗口被导航到 404/空白页
        assert!(!is_allowed_navigation(&u("http://tauri.localhost/docs/guide")));
        assert!(!is_allowed_navigation(&u("http://tauri.localhost/foo/bar")));
    }

    #[test]
    fn nav_dev_localhost_allowed() {
        assert!(is_allowed_navigation(&u("http://localhost:1420")));
        assert!(is_allowed_navigation(&u("http://localhost:1420/index.html")));
    }

    #[test]
    fn nav_external_http_blocked() {
        assert!(!is_allowed_navigation(&u("https://example.com")));
        assert!(!is_allowed_navigation(&u("http://192.168.1.1/x")));
        assert!(!is_allowed_navigation(&u("https://tauri.localhost.evil.com")));
    }

    #[test]
    fn nav_other_schemes_blocked() {
        assert!(!is_allowed_navigation(&u("mailto:a@b.c")));
        assert!(!is_allowed_navigation(&u("file:///C:/x")));
    }
}

#[tauri::command]
fn note_apply_tag_mapping(mappings: HashMap<String, String>) -> Result<Vec<notes::TagCount>, String> {
    notes::note_apply_tag_mapping(mappings)
}
