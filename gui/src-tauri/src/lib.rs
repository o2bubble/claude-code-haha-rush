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
mod server_client;
mod update;

mod backend;
mod db;
mod diagnostics;
mod guard;
mod mcp;
mod migrations;
mod plugin_process;
mod prockill;
mod settings;
#[path = "plugin_pubkey.rs"]
mod plugin_pubkey;
mod plugin_signature;

/// Holds the SQLite connection and the workspace it was opened for.
struct DbState {
    conn: rusqlite::Connection,
    work_dir: String,
}

/// The `--workspace <path>` CLI argument, if this instance was launched with one.
static CLI_WORKSPACE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The `--intent <intentId>` CLI argument, if this instance was launched in
/// intent mode. Mutually exclusive with CLI_WORKSPACE: when set, regular args
/// (including --workspace) are ignored and the server supplies everything.
static CLI_INTENT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// True when launched via `--intent <id>`. Intent-mode startup must ensure the
/// server is up BEFORE binding (the intent payload picks the workspace).
fn is_intent_mode() -> bool {
    CLI_INTENT_ID.get().is_some()
}

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


/// 前置工具目录到 PATH（平台化）。Windows: bin / git\usr\bin / git\bin / python / python\Scripts；
/// macOS: bin（自包含工具 rg/fd/jq/yq/shellcheck）。目录不存在则跳过。
pub(crate) fn prepend_tool_dirs(install_dir: &std::path::Path, orig: &str) -> String {
    let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
    // ⚠️ 后缀必须用相对路径（无前导分隔符）：Windows 上 Path::join("\\bin")
    // 解析为「当前盘根 \bin」(C:\bin) 而非 install_dir\bin——旧写法带前导
    // 反斜杠导致 bin/python/python\Scripts 永远 is_dir=false 被跳过，
    // fd/jq/yq（装于 bin/）一直进不了 PATH。
    let suffixes: &[&str] = if cfg!(target_os = "windows") {
        &["", "bin", "git\\usr\\bin", "git\\bin", "python", "python\\Scripts"]
    } else {
        &["", "bin"]
    };
    let mut dirs: Vec<String> = Vec::new();
    for sfx in suffixes {
        // 空后缀 = install_dir 本身（join("") 会产生尾部反斜杠，避免重复条目）
        let d = if sfx.is_empty() { install_dir.to_path_buf() } else { install_dir.join(sfx) };
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

/// 定位 git 的真实 bash.exe（`git\usr\bin\bash.exe`，非 shim）——供
/// CLAUDE_CODE_GIT_BASH_PATH 使用。优先安装目录自带 git；否则探系统
/// Git for Windows 常见安装位置（开发机/精简安装无自带 git 时）。
/// 返回 None = 找不到——后端将回退 PATH 查找（可能被 WSL bash 截胡）。
/// 供 GUI 启动的 apply_process_env 与诊断修复共用（单一定位逻辑）。
/// 注：区别于 find_git_bash()（找 git-bash.exe 给终端用，另一用途）。
pub(crate) fn find_git_usrin_bash(install_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let bundled = install_dir.join("git").join("usr").join("bin").join("bash.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    let rel = std::path::Path::new("Git").join("usr").join("bin").join("bash.exe");
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(key) {
            let p = std::path::Path::new(&base).join(&rel);
            if p.is_file() {
                candidates.push(p);
            }
        }
    }
    // 用户级安装: %LOCALAPPDATA%/Programs/Git/usr/bin/bash.exe
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let p = std::path::Path::new(&la)
            .join("Programs").join("Git").join("usr").join("bin").join("bash.exe");
        if p.is_file() {
            candidates.push(p);
        }
    }
    candidates.into_iter().next()
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

    // --intent <intentId>: intent mode (mutex). The real intent — including which
    // workspace/kind — lives on the server (published by the launcher). This
    // instance attaches, claims it, and executes instead of showing landing.
    // --intent swallows all regular args, so --workspace is ignored when present.
    // --workspace <path>: (non-intent) bind directly, skipping the selector.
    let mut cli_workspace: Option<String> = None;
    let mut cli_intent: Option<String> = None;
    {
        let mut args = std::env::args().skip(1);
        while let Some(a) = args.next() {
            match a.as_str() {
                "--intent" => {
                    if let Some(v) = args.next() {
                        cli_intent = Some(v);
                    }
                    // Intent mode: ignore the rest of the command line.
                    break;
                }
                "--workspace" => {
                    if let Some(v) = args.next() {
                        cli_workspace = Some(v);
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(id) = &cli_intent {
        log::info!("CLI --intent: {} (intent mode — regular args ignored)", id);
        CLI_INTENT_ID.set(id.clone()).ok();
        // Do NOT set_bound_work_dir here — the workspace comes from the intent
        // payload (claimed on the server), not the command line.
    } else if let Some(ws) = &cli_workspace {
        log::info!("CLI --workspace: {}", ws);
        CLI_WORKSPACE.set(ws.clone()).ok();
        // Set the process-level binding early so setup()'s settings::load_settings()
        // merges this workspace's gui (window state, layout) before restore.
        settings::set_bound_work_dir(ws);
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
        if let Some(bash) = find_git_usrin_bash(&install_dir) {
            std::env::set_var("CLAUDE_CODE_GIT_BASH_PATH", &bash);
        }
        let orig = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", prepend_tool_dirs(&install_dir, &orig));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        // OS 级全局热键（GUI 失焦也生效）。**注册由前端发起**（见
        // services/globalShortcutService.ts）：快捷键表的唯一真相源在前端
        // （shortcuts.ts + settings.shortcuts），在 Rust 再建一份"键位→动作"映射
        // 会立刻产生两份会漂移的真相。
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // GV-T1: 插件面板 iframe 内容源 —— plugins://<pluginName>/<src> 从
        // app_data_dir()/plugins/<pluginName>/ 读静态文件。插件 HTML 与 GUI
        // 同源（allow-same-origin 沙箱下可 fetch GUI / 本地接口）；路径穿越
        // 由 URL 前缀（本协议只服务 plugins 根）+ 规范后前缀检查双重防护。
        .register_uri_scheme_protocol("plugins", |app, request| {
            serve_plugin_asset(app, request)
        })
        .manage(Mutex::new(DbState {
            conn: db_conn,
            work_dir: work_dir.clone(),
        }))
        .manage(Mutex::new(settings.clone()))
        .manage(Mutex::new(Option::<server_client::ServerClient>::None))
        .manage(Mutex::new(backend::BackendState {
            process: None,
            backend_pid: None,
            port: None,
            work_dir: work_dir.clone(),
            spawning: false,
        }))
        .manage(guard::GuardRuntime::default())
        .setup(move |app| {
            // 全局 AppHandle：供 server 事件转发器 emit 到前端。
            server_client::set_app_handle(app.handle().clone());

            // 进程级环境：GUI 及其所有子进程（IDE 后端/系统终端）不需要系统注册表
            // 即可工作。系统级只保留 CLAUDE_CODE_HAHA_HOME（非 GUI 场景锚点），
            // PATH 等工具目录在进程内前置——免提权、装完免重启、mac/win 统一。
            apply_process_env();

            // Clean stale per-PID WebView2 data dirs from prior runs BEFORE the
            // webview is built (the in-use one is the current PID). Prevent the
            // ~200-dir / multi-GB junk pile reported by disk-cleanup scans.
            cleanup_old_webview_dirs(app.handle());

            // 清扫孤儿插件进程: 父进程已死 + cwd 在插件根内 → 杀。GUI 被强杀/崩溃/
            // 更新(exit 绕过 RunEvent::Exit)都会遗留, 它们的 cwd 是插件目录句柄
            // → 卸载报「另一个程序正在使用此文件」(os error 32)。只杀孤儿——
            // 活跃实例的插件进程父进程在, 条件不命中。
            #[cfg(windows)]
            if let Ok(root) = plugins_base_dir(app.handle()) {
                let n = prockill::kill_orphan_plugin_processes(&root);
                if n > 0 {
                    log::info!("startup: killed {} orphan plugin processes", n);
                }
            }

            // 清理卸载时改名留下的 `.trash-*`（见 uninstall_plugin 的改名兜底）：
            // 那时目录被占用删不掉，只能先改名让卸载"成功"。现在重启过了，
            // 占用者（孤儿进程）已被上面的清扫杀掉，这里真删。
            if let Ok(root) = plugins_base_dir(app.handle()) {
                cleanup_trash_plugin_dirs(&root);
            }

            // Create the main window programmatically with a per-instance WebView2
            // user data folder. WebView2 only allows one browser process per data
            // folder — a shared default folder makes a second GUI instance's webview
            // fail with HRESULT 0x8007139F (process survives, but the webview never
            // loads → no window). Keying by PID isolates every instance.
            let main_builder = tauri::WebviewWindowBuilder::new(
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
            .on_navigation(is_allowed_navigation);

            // 调试：CCGUI_CDP_PORT=<port> 开 WebView2 远程调试。**所有窗口统一走这个函数**。
            let main_builder = with_debug_args(main_builder);

            // Windows: 自绘标题栏（前端 TitleBar 组件），关掉系统标题栏让工具栏
            // 与标题栏合并成一条。mac 保留原生装饰 —— 红绿灯与系统整合更好，
            // 且 Tauri 在 mac 上对无装饰窗口的处理方式不同（titleBarStyle 而非
            // decorations(false)）。见 docs/gui/window-chrome.md。
            #[cfg(windows)]
            let main_builder = main_builder.decorations(false);
            let main_window = main_builder.build()?;

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
            // The OS may have placed the window at the hidden sentinel before
            // assigning a slot (or the saved position points at a removed monitor)
            // — bring it back on-screen so the GUI is never invisible.
            ensure_window_on_screen(app.handle(), &main_window);
            // 启动期迁移（旧 profile 目录 / 单文件 MCP → 双文件）——
            // 全清单见 src/migrations.rs 的 MIGRATION_REGISTRY。
            // 必须在 spawn 后端之前跑（后端启动时读全局配置）。
            migrations::run_startup_migrations();
            // office MCP 自动注册到 ~/.claude.json（stdio MCP，Windows→win32com / mac→osascript），
            // 同样要在 spawn 后端之前，后端启动即能看到 office 工具。
            settings::register_office_mcp();
            // office 操作指南同步到 ~/.claude/ + 注入 @office-bridge.md（每次启动幂等，
            // 更新免重装；安装器只管装文件，不碰用户配置）。
            settings::sync_office_guide();
            // python-env 指南同步（同模式）：mac 无安装器，靠 GUI 启动把 python-env.md
            // 同步到 ~/.claude/ + 注入 @python-env.md，bundled python 路径按平台动态生成。
            settings::sync_python_env();
            // CLI 工具提示词同步（同模式）：install-tools 在 Windows 注入过文本表格，
            // mac 手动 .app 无 install-tools，靠 GUI 启动把 cli-tools.md 同步 + 注入 @cli-tools.md。
            settings::sync_cli_tools();

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

            if is_intent_mode() {
                // Intent-mode startup: the intent payload (including which
                // workspace) lives on the server, so we CANNOT bind until we
                // claim it. Ensure the server is up FIRST (attach→spawn→local);
                // the frontend's intent flow then claims → binds → executes. A
                // `workspace` of "" is fine — subscribe_events is all-broadcast.
                let server_state = app.state::<Mutex<Option<server_client::ServerClient>>>();
                let ensured = tauri::async_runtime::block_on(server_client::ensure_server(&server_state, ""));
                if ensured.is_some() {
                    log::info!("Intent-mode startup: server connected");
                } else {
                    log::warn!("Intent-mode startup: server unavailable — degraded to local");
                }
            } else if let Some(ws) = cli_workspace {
                // --workspace instance: bind synchronously (init DB, register MCP,
                // spawn backend) so BackendState is populated before the webview
                // loads — the frontend's bind call then short-circuits via the
                // idempotency guard in bind_workspace_internal.
                match bind_workspace_internal(&app.handle().clone(), &ws) {
                    Ok(port) => log::info!("Bound --workspace {} → backend port {}", ws, port),
                    Err(e) => log::error!("bind_workspace({}) failed: {}", ws, e),
                }
            } else {
                // No --workspace, no intent: no pre-start. The frontend shows the
                // workspace selector and calls bind_workspace when the user picks one.
                log::info!("No --workspace arg — waiting for workspace selection");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mcp::mcp_response,
            mcp::get_mcp_port,
            bind_workspace,
            get_cli_workspace,
            get_startup_intent_mode,
            get_startup_intent_id,
            claim_startup_intent,
            ack_startup_intent,
            publish_startup_intent,
            query_intent_status,
            spawn_intent_gui,
            get_gui_server_status,
            restart_gui_server,
            is_first_instance,
            notify_sessions_changed,
            notify_settings_changed,
            session_status_report,
            get_session_statuses,
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
            list_plugin_manifests,
            get_plugins_base_dir,
            get_platform,
            get_plugin_settings,
            save_plugin_settings,
            verify_plugin_signature,
            app_relaunch,
            list_plugin_processes,
            kill_plugin_process_cmd,
            forget_plugin_processes_cmd,
            restart_plugin_process_cmd,
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
            #[cfg(target_os = "macos")]
            diagnostics::fix_mac_exec_bits,
            save_permission_mode,
            save_window_state,
            get_default_work_dir,
            restart_ide_backend,
            fix_restart_ide_backend,
            list_model_profiles,
            get_profile_env,
            switch_model_profile,
            create_profile,
            delete_profile,
            set_default_profile,
            open_system_terminal,
            spawn_gui_instance,
            create_floating_window,
            open_plugin_overlay,
            show_plugin_overlay,
            close_plugin_overlay,
            open_plugin_indicator,
            move_plugin_indicator,
            close_plugin_indicator,
            open_url_window,
            open_in_explorer,
            guard::guard_event,
            copy_file,
            read_clipboard_text,
            read_clipboard_files,
            run_cli_print,
            save_skills_i18n,
            load_skills_i18n,
            close_me,
            get_skills_dir,
            sync_plugin_skill_links,
            install_skill,
            install_package,
            install_plugin_package,
            uninstall_plugin,
            delete_skill,
            // Notes
            note_create,
            note_update,
            note_delete,
            note_get,
            note_list,
            note_search,
            count_gui_instances,
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
                // T3: 插件后台进程随 GUI 退出 kill(防孤儿/占端口)。
                crate::plugin_process::kill_all_plugin_processes();
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
    // 相对路径以工作区为基准解析（与 open_in_explorer 同一套 resolve_explorer_path）：
    // AI 给的 @ref chip 常是相对路径（如 `.scratch/x/SPEC.md`），直接交给
    // read_to_string 会按**进程 cwd** 解析 → 必然失败 → 调用方回退到资源管理器，
    // 表现为"点了 chip 却在资源管理器打开"。
    let work_dir = crate::settings::load_settings().work_dir;
    let abs = resolve_explorer_path(&path, &work_dir);
    log::info!("read_file: {} (resolved: {})", path, abs);
    std::fs::read_to_string(&abs).map_err(|e| format!("Cannot read file: {}", e))
}

#[tauri::command]
fn read_bytes(path: String) -> Result<String, String> {
    use std::io::Read;
    use base64::Engine;
    // 相对路径同样以工作区为基准解析（同 read_file）——图片预览/ImageItem 的路径
    // 可能来自 @ref chip，直接按进程 cwd 解析会 File not found。
    let work_dir = crate::settings::load_settings().work_dir;
    let abs = resolve_explorer_path(&path, &work_dir);
    log::info!("read_bytes: {} (resolved: {})", path, abs);
    let p = std::path::PathBuf::from(&abs);
    if !p.exists() {
        return Err("File not found".to_string());
    }
    let mut file = std::fs::File::open(&p).map_err(|e| format!("Cannot open: {}", e))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| format!("Cannot read: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

/// 读取插件目录中各 plugin.json → 前端 scanPlugins(纯逻辑) 处理。
/// 路径 = app_data_dir()/plugins/<name>/plugin.json。返回 `[{name, manifestJson}]`。
/// webview 无 fs (capabilities 只放行 read/write text file, 无 readDir+scope),
/// 目录枚举由 Rust 完成, 前端只管解析。
#[tauri::command]
fn list_plugin_manifests(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"));
    let plugins_dir = base.join("plugins");
    let mut entries: Vec<serde_json::Value> = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(&plugins_dir) else {
        return Ok(serde_json::json!(entries)); // 目录不存在 → 无插件
    };
    for entry in read_dir.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 隐藏目录跳过
        }
        let manifest_path = dir.join("plugin.json");
        let Ok(contents) = std::fs::read_to_string(&manifest_path) else {
            continue; // 缺 plugin.json → 跳过(前端容错同名逻辑)
        };
        // 可选 README.md —— 插件详情页正文（市场详情/本地详情共用约定）
        let readme = std::fs::read_to_string(dir.join("README.md")).ok();
        // 可选 AI_NOTES.md —— 作者写给 AI 的排查文档（MCP plugin_docs 本地优先源）
        let ai_notes = std::fs::read_to_string(dir.join("AI_NOTES.md")).ok();
        entries.push(serde_json::json!({ "name": name, "manifestJson": contents, "readme": readme, "aiNotes": ai_notes }));
    }
    Ok(serde_json::to_value(entries).map_err(|e| e.to_string())?)
}

/// 枚举所有启用插件的 runtime 目录（**含 `bin/` 子目录**），供直接 spawn 的子进程
/// 前置进 PATH。
///
/// 与前端 `aggregateRuntimePaths` / `pluginRuntimePaths.ts` 那条契约同源——三处都要
/// 注入 `bin/`，mac/Linux 的 node 在 `runtime/bin` 下（Windows 在根）。
///
/// 用途：mac「打开终端」/ MCP spawn 等**不经 bash provider** 的路径。那两处此前只
/// 在 shell 命令串里 `export PATH`，不改本进程 env，导致引擎/新终端拿不到插件 runtime
/// （2026-09-15 实测：`{"command":"npx"}` 的 MCP server spawn 失败）。
///
/// 失败一律返回空（无插件目录 / 读不了 → 不注入即现状），不拖垮调用方。
fn collect_plugin_runtime_dirs(app: &tauri::AppHandle) -> Vec<String> {
    let Ok(base) = plugins_base_dir(app) else { return Vec::new() };
    let plugins_dir = std::path::PathBuf::from(base);
    let Ok(read_dir) = std::fs::read_dir(&plugins_dir) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for entry in read_dir.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let Some(rels) = read_runtime_rel_paths(&dir) else { continue };
        for rel in rels {
            let abs = dir.join(rel);
            if !abs.exists() { continue; }
            let abs_s = abs.to_string_lossy().to_string();
            if !out.contains(&abs_s) { out.push(abs_s.clone()); }
            // 声明已以 /bin 结尾 → 不追加，防 bin/bin
            if !abs_s.ends_with("/bin") && !abs_s.ends_with(r"\bin") {
                let bin = abs.join("bin");
                if bin.exists() {
                    let bin_s = bin.to_string_lossy().to_string();
                    if !out.contains(&bin_s) { out.push(bin_s); }
                }
            }
        }
    }
    out
}

/// 插件根目录（app_data_dir()/plugins）——前端 runtime 聚合的相对路径基准
/// （plugin-nodejs-runtime T2）。与 list_plugin_manifests 的目录约定同源。
pub(crate) fn plugins_base_dir(app: &tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"));
    Ok(base.join("plugins").to_string_lossy().to_string())
}

#[tauri::command]
fn get_plugins_base_dir(app: tauri::AppHandle) -> Result<String, String> {
    plugins_base_dir(&app)
}

// ── GV-T1: 插件面板 iframe 静态资源协议 ──

/// plugins://<pluginName>/<src> → app_data_dir()/plugins/<pluginName>/<src>。
/// 只服务插件目录内文件; URL 段校验（禁 `..`/反斜杠）+ 规范后前缀检查双重防线。
fn serve_plugin_asset(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::Response;

    let app = ctx.app_handle();
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"))
        .join("plugins");
    let Ok(base_canon) = base.canonicalize() else {
        return not_found();
    };

    // URI 形如 /<pluginName>/<src>?port=xxxx —— 取 path 段（不含 query）
    let rest = request.uri().path().trim_start_matches('/');
    let mut parts = rest.splitn(2, '/');
    let plugin = match parts.next() {
        Some(p) if !p.is_empty() && !p.contains("..") => p,
        _ => return not_found(),
    };
    let src = match parts.next() {
        Some(s) if !s.is_empty() && !s.contains("..") && !s.contains('\\') => s,
        _ => return not_found(),
    };

    let candidate = base.join(plugin).join(src);
    let bytes = match std::fs::read(&candidate) {
        Ok(b) => b,
        Err(_) => return not_found(),
    };
    // 规范后路径仍须在 plugins 根下（symlink/`..` 残余防线）
    if let Ok(canon) = candidate.canonicalize() {
        if !canon.starts_with(&base_canon) {
            return not_found();
        }
    }

    Response::builder()
        .status(200)
        .header("Content-Type", mime_for(src))
        .header("Cache-Control", "no-cache")
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .body(Vec::new())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// 极简 MIME 映射 —— 插件面板常见文件类型; 未知类型回退 octet-stream。
fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

/// 当前运行平台（GUI 按编译结果判断, 与 cfg! 同源）——插件 platforms 支持列表
/// 的匹配基准。返回生态三值枚举: "windows" | "macos" | "linux"。
#[tauri::command]
fn get_platform() -> String {
    match std::env::consts::OS {
        "windows" => "windows".to_string(),
        "macos" => "macos".to_string(),
        _ => "linux".to_string(),
    }
}

// ── 插件设置持久化（独立于 claude.exe 的 settings.json/gui 键）──
// 全局: %APPDATA%/com.claudecode.gui/plugins-settings/<plugin>.json
// 工作区: <workdir>/.claude/plugins-settings/<plugin>.json（覆盖全局, 读时合并）

fn plugin_settings_path(app: &tauri::AppHandle, plugin: &str, scope: &str) -> std::path::PathBuf {
    if scope == "workspace" {
        let wd = crate::settings::bound_work_dir();
        if !wd.is_empty() {
            return std::path::PathBuf::from(wd)
                .join(".claude").join("plugins-settings").join(format!("{}.json", plugin));
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"))
        .join("plugins-settings")
        .join(format!("{}.json", plugin))
}

fn read_plugin_settings_file(path: &std::path::Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .filter(|v: &serde_json::Value| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 读插件设置: 工作区覆盖全局（逐键合并, 非整体替换）。无记录返回 {}。
#[tauri::command]
fn get_plugin_settings(app: tauri::AppHandle, plugin: String) -> Result<serde_json::Value, String> {
    if plugin.is_empty() || plugin.contains(['/', '\\', '.', ':']) {
        return Err(format!("invalid plugin name: {plugin}"));
    }
    let global = read_plugin_settings_file(&plugin_settings_path(&app, &plugin, "global"));
    let wd = crate::settings::bound_work_dir();
    if wd.is_empty() {
        return Ok(global);
    }
    let workspace = read_plugin_settings_file(&plugin_settings_path(&app, &plugin, "workspace"));
    let mut out = global;
    if let (Some(o), Some(w)) = (out.as_object_mut(), workspace.as_object()) {
        for (k, v) in w { o.insert(k.clone(), v.clone()); }
    }
    Ok(out)
}

/// 写插件设置: scope "workspace"(缺省, 绑定后有效) → 工作区文件; "global" → 全局文件。
/// 整文件 replace（插件设置文件就是 {key: value} 简单对象）。
#[tauri::command]
fn save_plugin_settings(
    app: tauri::AppHandle,
    plugin: String,
    patch: serde_json::Value,
    scope: Option<String>,
) -> Result<(), String> {
    if plugin.is_empty() || plugin.contains(['/', '\\', '.', ':']) {
        return Err(format!("invalid plugin name: {plugin}"));
    }
    let scope_str = scope.as_deref().unwrap_or("workspace");
    if scope_str == "workspace" && crate::settings::bound_work_dir().is_empty() {
        return Err("workspace scope requires a bound workspace".to_string());
    }
    let path = plugin_settings_path(&app, &plugin, scope_str);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {}", e))?;
    }
    // merge patch into existing (preserve untouched keys)
    let mut current = read_plugin_settings_file(&path);
    if let (Some(c), Some(p)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in p { c.insert(k.clone(), v.clone()); }
    }
    std::fs::write(&path, serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Cannot write {}: {}", path.display(), e))?;
    Ok(())
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

/// 重启 GUI 应用（AI 经 MCP app_relaunch 调用, AI-guided 插件安装完成后生效用）。
/// 自我拉起: spawn 当前 exe（分离进程）→ 短暂等待 → exit(0) 退出自身。
/// 借鉴 update.rs 的退出模式但不带 UAC/Update.exe——纯重启。
/// ⚠️ 调用即终止本进程（含其托管的 claude.exe 会话）——MCP 侧有 confirm 门,
/// AI 必须先获得用户同意。
#[tauri::command]
fn app_relaunch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("Cannot resolve exe path: {}", e))?;
    log::info!("app_relaunch: spawning {:?} then exiting", exe);
    // exit(0) 绕过 RunEvent::Exit 的 kill_all_plugin_processes → 会遗留孤儿插件进程
    // （cwd 钉在插件目录 → 卸载报 os error 32）。显式补一次清理。
    crate::plugin_process::kill_all_plugin_processes();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: 独立于本进程生命周期
        std::process::Command::new(&exe)
            .creation_flags(0x00000008 | 0x00000200)
            .spawn()
            .map_err(|e| format!("Cannot spawn new instance: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(&exe)
            .spawn()
            .map_err(|e| format!("Cannot spawn new instance: {}", e))?;
    }
    // 给新实例启动留窗口, 然后释放本进程（文件锁/端口/MCP server 一并释放）
    std::thread::sleep(std::time::Duration::from_millis(800));
    std::process::exit(0);
}

/// 查询插件后台进程状态(WorkerPanel / 插件面板)。
#[tauri::command]
fn list_plugin_processes() -> Vec<crate::plugin_process::PluginProcessInfo> {
    crate::plugin_process::list_all()
}

/// 杀插件后台进程(WorkerPanel kill 按钮)。
#[tauri::command]
fn kill_plugin_process_cmd(app: tauri::AppHandle, process_id: String) -> bool {
    crate::plugin_process::kill_plugin_process(&app, &process_id)
}

/// 遗忘插件后台进程条目(卸载/禁用插件时用): 杀 + 从 registry 彻底移除 + 通知前端删行。
/// 与 kill 的区别: kill 保留条目(killed 状态, WorkerPanel 显示"已停止"且可重启);
/// forget 用于插件本身已不存在的情况——条目留着没意义, 且 commands 表还存着启动声明,
/// 点 ↻ 会从已删除的目录重新拉起 node。
#[tauri::command]
fn forget_plugin_processes_cmd(app: tauri::AppHandle, process_ids: Vec<String>) {
    crate::plugin_process::forget_plugin_processes(&app, &process_ids);
}

/// 重启插件后台进程(kill 旧 → spawn 新; 面板/WorkerPanel 重启按钮)。
/// cwd: 插件目录（args 相对路径在此解析; None = 用 GUI 进程 cwd —— 旧插件零回归）。
#[tauri::command]
fn restart_plugin_process_cmd(
    app: tauri::AppHandle,
    process_id: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
    cwd: Option<String>,
) -> Result<(), String> {
    crate::plugin_process::restart_plugin_process(&app, &process_id, &command, args, env, cwd)
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
    // 相对路径同样以工作区为基准（同 read_file/read_bytes）：粘贴判断"这段文本是不是
    // 文件路径"时，用户复制的可能是工作区内的相对路径，按 cwd 解析会误判为不存在。
    let work_dir = crate::settings::load_settings().work_dir;
    std::path::PathBuf::from(resolve_explorer_path(&path, &work_dir)).exists()
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

/// Bound workspace from settings (the data layer's per-workspace key).
fn bound_workdir(settings: &Mutex<settings::AppSettings>) -> Result<String, String> {
    let s = settings.lock().map_err(|e| format!("Lock error: {e}"))?;
    Ok(s.work_dir.clone())
}

/// Degradation ladder (ticket 06): attach → spawn → re-attach → None (local).
/// None → callers fall back to the local SQLite connection. On success caches
/// the client and starts the background event forwarder.
async fn server_client_or(
    server_state: &Mutex<Option<server_client::ServerClient>>,
    workspace: &str,
) -> Option<server_client::ServerClient> {
    server_client::ensure_server(server_state, workspace).await
}

/// Drop a cached server client after an RPC failure, so the NEXT call re-runs
/// ensure_server (attach→spawn→re-attach) instead of being stuck on a dead
/// connection. The current call already fell through to the local path.
fn reset_server(server_state: &Mutex<Option<server_client::ServerClient>>) {
    if let Ok(mut g) = server_state.lock() {
        *g = None;
    }
}

// ── DB commands ──

#[tauri::command]
async fn db_save_plan(
    state: tauri::State<'_, Mutex<DbState>>,
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
    plan: db::PlanInput,
) -> Result<bool, String> {
    let ws = bound_workdir(&settings)?;
    if let Some(client) = server_client_or(&server_state, &ws).await {
        let payload = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
        match client.mutate(&ws, "plan", "", payload).await {
            Ok(res) => return Ok(res.get("superseded").and_then(|v| v.as_bool()).unwrap_or(false)),
            Err(_) => reset_server(&server_state), // dead connection → self-heal + local fallback
        }
    }
    let db = ensure_db(&state, &settings)?;
    db::save_plan(&db.conn, &plan)?;
    Ok(false)
}

/// Tell the server this GUI's chat session list changed, so other GUIs on the
/// same user re-request theirs. No-op when no server — sessions still work locally.
#[tauri::command]
async fn notify_sessions_changed(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
) -> Result<(), String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        return client.notify_sessions_changed().await.map_err(|e| e);
    }
    Ok(())
}

/// Report this GUI's currently-open session + binary agent state (the server
/// injects our client_id). No-op without a server — cross-GUI status isn't the
/// local fallback's concern.
#[tauri::command]
async fn session_status_report(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
    session_id: String,
    state: String,
) -> Result<(), String> {
    let ws = bound_workdir(&settings)?;
    if let Some(client) = server_client_or(&server_state, &ws).await {
        let status = claude_gui_shared::presence::SessionStatus {
            workspace: ws.clone(),
            session_id,
            state: if state == "working" {
                claude_gui_shared::presence::SessionState::Working
            } else {
                claude_gui_shared::presence::SessionState::Idle
            },
            client_id: client.client_id().to_string(),
        };
        return client.session_status_report(status).await;
    }
    Ok(())
}

/// Workspace-scoped snapshot of currently-open sessions + agent state (initial
/// live state for a joining GUI). Empty when no server.
#[tauri::command]
async fn get_session_statuses(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
) -> Result<Vec<claude_gui_shared::presence::SessionStatus>, String> {
    let ws = bound_workdir(&settings)?;
    if let Some(client) = server_client_or(&server_state, &ws).await {
        // Snapshot is used as the "open elsewhere" index — drop our own entry
        // (the incremental stream already skips self) so our current session is
        // never marked as open in another window.
        let self_id = client.client_id().to_string();
        return client
            .get_session_statuses(&ws)
            .await
            .map(|v| v.into_iter().filter(|s| s.client_id != self_id).collect());
    }
    Ok(Vec::new())
}

/// Tell the server this GUI saved a workspace-scoped setting (e.g.
/// favoriteSessionIds), so other GUIs reload their merged settings. No-op without
/// a server — settings still work locally.
#[tauri::command]
async fn notify_settings_changed(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
) -> Result<(), String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        return client.notify_settings_changed().await.map_err(|e| e);
    }
    Ok(())
}

// ── Startup intent (--intent <id>) ──
// The frontend can't construct a client_id for the server's atomic claim, so
// these bridge commands send `client_id()` automatically.

/// Claim this instance's startup intent on the server. Returns the pending
/// intent record (payload incl. workspace/kind) or an error if the server is
/// unreachable (local degraded) or the intent was already claimed/expired.
#[tauri::command]
async fn claim_startup_intent(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    intent_id: String,
) -> Result<serde_json::Value, String> {
    let Some(client) = server_client_or(&server_state, "").await else {
        return Err("Server unavailable (local degraded)".to_string());
    };
    client.claim_intent(&intent_id).await
}

/// Ack the claimed intent after execution (done/failed). Only the claimer may
/// ack, once. No-op without a server.
#[tauri::command]
async fn ack_startup_intent(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    intent_id: String,
    result: Option<serde_json::Value>,
) -> Result<(), String> {
    let Some(client) = server_client_or(&server_state, "").await else {
        return Ok(());
    };
    client.ack_intent(&intent_id, result).await
}

// ── Launcher half of the startup-intent flow ──
// Right-click "open in new window": publish the intent on the server, spawn a
// new GUI with `--intent <id>`, then the launcher polls query_intent_status.

/// Publish a startup intent so a freshly-spawned GUI can claim it. The payload
/// (workspace, kind, session_id/panel_id) travels on the server.
#[tauri::command]
async fn publish_startup_intent(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    intent_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let Some(client) = server_client_or(&server_state, "").await else {
        return Err("Server unavailable (local degraded)".to_string());
    };
    client.publish_intent(&intent_id, payload, 60_000).await
}

/// Poll an intent's status after the new GUI claims/acks it. Returns the record
/// (status/payload/result/claimed_by) or an error if the intent was dropped.
#[tauri::command]
async fn query_intent_status(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    intent_id: String,
) -> Result<serde_json::Value, String> {
    let Some(client) = server_client_or(&server_state, "").await else {
        return Err("Server unavailable (local degraded)".to_string());
    };
    client.query_intent_status(&intent_id).await
}

/// Spawn a NEW GUI instance with `--intent <id>`. Detaches from this process —
/// the new instance opens its own window and runs the intent flow.
#[tauri::command]
fn spawn_intent_gui(intent_id: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--intent").arg(&intent_id);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — spin up detached, no console
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ── GUI server 面板管理（Workers 面板）──

/// 查询 GUI server 存活状态（只读，不主动拉起）。已连接且 ping 通 → connected=true；
/// 已连接但 ping 失败（daemon 挂了）→ 清缓存并报 disconnected；未连接 → disconnected。
/// 端口固定 8766（bind-to-claim 单例）。
#[tauri::command]
async fn get_gui_server_status(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
) -> Result<serde_json::Value, String> {
    let connected = match server_state.lock().map(|g| g.clone()).unwrap_or(None) {
        Some(client) => {
            let alive = client.ping().await.map(|_| true).unwrap_or(false);
            if !alive {
                reset_server(&server_state); // 死连接 → 清缓存(Ping 失败)，自愈留给下次 ensure
            }
            alive
        }
        None => false,
    };
    Ok(serde_json::json!({ "connected": connected, "port": 8766_u16 }))
}

/// 手动重启 GUI server：断开当前 client 缓存 → 重新 ensure_server(attach→spawn→local)。
/// server daemon 若已挂会自动重新拉起；已连则重新 attach。
#[tauri::command]
async fn restart_gui_server(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
) -> Result<(), String> {
    reset_server(&server_state);
    server_client::ensure_server(&server_state, "").await;
    Ok(())
}

#[tauri::command]
async fn db_get_plans(
    state: tauri::State<'_, Mutex<DbState>>,
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
    offset: u32,
    limit: u32,
) -> Result<Vec<db::PlanRecord>, String> {
    let ws = bound_workdir(&settings)?;
    if let Some(client) = server_client_or(&server_state, &ws).await {
        match client.list_plans(&ws, offset, limit).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    let db = ensure_db(&state, &settings)?;
    db::get_plans(&db.conn, offset, limit)
}

#[tauri::command]
async fn db_get_plan_sessions(
    state: tauri::State<'_, Mutex<DbState>>,
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
) -> Result<Vec<db::PlanSession>, String> {
    let ws = bound_workdir(&settings)?;
    // 计划历史时间线也走 server 同源读（与 db_get_plans 一致），否则跨 GUI 实例读本地
    // data.db 与 server 写入不一致 → 部分实例历史时间线消失。
    if let Some(client) = server_client_or(&server_state, &ws).await {
        match client.list_plan_sessions(&ws).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    let db = ensure_db(&state, &settings)?;
    db::get_plan_sessions(&db.conn)
}

#[tauri::command]
async fn db_save_desktop(
    state: tauri::State<'_, Mutex<DbState>>,
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
    desktop: db::DesktopRecord,
) -> Result<bool, String> {
    let ws = bound_workdir(&settings)?;
    if let Some(client) = server_client_or(&server_state, &ws).await {
        let payload = serde_json::to_value(&desktop).map_err(|e| e.to_string())?;
        match client.mutate(&ws, "desktop", "", payload).await {
            Ok(res) => return Ok(res.get("superseded").and_then(|v| v.as_bool()).unwrap_or(false)),
            Err(_) => reset_server(&server_state), // dead connection → self-heal + local fallback
        }
    }
    let db = ensure_db(&state, &settings)?;
    db::save_desktop(&db.conn, &desktop)?;
    Ok(false)
}

#[tauri::command]
async fn db_get_desktops(
    state: tauri::State<'_, Mutex<DbState>>,
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
) -> Result<Vec<db::DesktopRecord>, String> {
    let ws = bound_workdir(&settings)?;
    if let Some(client) = server_client_or(&server_state, &ws).await {
        match client.list_desktops(&ws).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    let db = ensure_db(&state, &settings)?;
    db::get_desktops(&db.conn)
}

#[tauri::command]
async fn db_delete_desktop(
    state: tauri::State<'_, Mutex<DbState>>,
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    settings: tauri::State<'_, Mutex<settings::AppSettings>>,
    id: String,
) -> Result<(), String> {
    let ws = bound_workdir(&settings)?;
    if let Some(client) = server_client_or(&server_state, &ws).await {
        match client
            .mutate(&ws, "delete_desktop", "", serde_json::json!({ "id": id }))
            .await
        {
            Ok(_) => return Ok(()),
            Err(_) => reset_server(&server_state),
        }
    }
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
fn get_app_settings(_state: tauri::State<Mutex<settings::AppSettings>>) -> Result<settings::AppSettings, String> {
    // Before a workspace is bound, return the pure global baseline — the cached
    // state would leak one workspace's overrides (favoriteSessionIds, layoutTree,
    // …) into every instance at startup.
    if settings::bound_work_dir().is_empty() {
        return Ok(settings::load_global_settings());
    }
    // Once bound, re-read the shared workspace file fresh instead of returning the
    // bind-time cached state. Another GUI may have written it (e.g. favoriteSessionIds
    // via cross-GUI sync); without this, reloadSettings sees a stale snapshot and the
    // other instance's change never shows until a restart re-binds.
    Ok(settings::reload_effective_settings(&settings::bound_work_dir()))
}

/// Returns the `--workspace <path>` CLI arg (if any). The frontend uses this to
/// skip the workspace selector for shortcut/CLI-launched instances.
#[tauri::command]
fn get_cli_workspace() -> Option<String> {
    CLI_WORKSPACE.get().cloned()
}

/// True when this instance was launched with `--intent <id>` (intent mode).
/// The frontend reads this to run the intent flow instead of landing.
#[tauri::command]
fn get_startup_intent_mode() -> bool {
    is_intent_mode()
}

/// The `--intent <intentId>` id (if any), so the frontend can claim it on the
/// server, fetch the real payload, and execute.
#[tauri::command]
fn get_startup_intent_id() -> Option<String> {
    CLI_INTENT_ID.get().cloned()
}

/// 本实例是否是「当前绑定工作区」的第一个实例（第二个实例绑定同一工作区应跳过
/// "自动加载最近会话"）。
#[tauri::command]
fn is_first_instance() -> bool {
    // Intent-launched instances always honor their explicit intent (open a given
    // session), even if they're a second instance on the same workspace — the
    // "skip auto-load latest session" suppression only applies to the normal
    // path. See PRD §6.3.
    if is_intent_mode() {
        return true;
    }
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

/// Guard: the main window must actually be on a screen. WebView2/tao can place
/// an unpositioned window at Windows' off-screen sentinel (-32000,-32000) before
/// the OS assigns a slot — a race that leaves the whole GUI invisible. A restored
/// position can likewise point at a monitor that's since been removed. If the
/// window's rect overlaps no monitor, re-center it on the primary screen.
fn ensure_window_on_screen(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Ok(pos) = window.outer_position() else { return; };
    let Ok(size) = window.outer_size() else { return; };
    let wx = pos.x;
    let wy = pos.y;
    let wxr = (wx, wy, wx + size.width as i32, wy + size.height as i32);
    let monitors = app.available_monitors().unwrap_or_default();
    let on_screen = monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        let mxr = (p.x, p.y, p.x + s.width as i32, p.y + s.height as i32);
        wxr.0 < mxr.2 && wxr.2 > mxr.0 && wxr.1 < mxr.3 && wxr.3 > mxr.1
    });
    if !on_screen {
        let _ = window.center();
    }
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
                // 旧 profile 自动补能力 env（幂等；deepseek/qwen 推断，其余不动）
                let _ = ensure_profile_capability_env(&path);
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

    // 切换前确保能力 env 已补（旧 profile 自动迁移，幂等）
    let _ = ensure_profile_capability_env(&profile_path);
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
pub(crate) fn apply_profile_env_to_settings(
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

/// 为旧 profile 自动补能力 env（ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES）。
/// 幂等：已含 `*_SUPPORTED_CAPABILITIES` 或未知 provider 时不动。
/// 依据 ANTHROPIC_BASE_URL 推断：deepseek → thinking+reasoning（用 reasoning 字段控思考）；
/// dashscope/aliyun（Qwen）→ thinking（Claude 原生 thinking 块）。其他 provider 不迁移
/// （无法推断用什么字段，留给用户在 GUI 配置）。切换到旧 profile 时自动落盘，无需重建。
fn ensure_profile_capability_env(path: &std::path::Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    if content.contains("_SUPPORTED_CAPABILITIES") {
        return false;
    }
    let vars = parse_env_file(&content);
    let base_url = vars
        .iter()
        .find(|(k, _)| k == "ANTHROPIC_BASE_URL")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    let caps = if base_url.contains("deepseek") {
        "effort,max_effort,thinking,reasoning"
    } else if base_url.contains("aliyuncs") || base_url.contains("dashscope") {
        "effort,max_effort,thinking"
    } else {
        return false; // 未知 provider，不迁移
    };

    // 只为已设定 tier model 的层补能力 env（否则 get3PModelCapabilityOverride 匹配不到）
    let mut additions = String::new();
    for model_key in [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        if vars.iter().any(|(k, _)| k == model_key) {
            additions.push_str(&format!("{}_SUPPORTED_CAPABILITIES={}\n", model_key, caps));
        }
    }
    if additions.is_empty() {
        return false; // 未设任何 DEFAULT_*_MODEL，能力 env 无效
    }

    let mut new_content = content;
    if !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(&additions);
    std::fs::write(path, new_content).is_ok()
}

// migrate_legacy_profiles 已移至 src/migrations.rs（全清单见其 MIGRATION_REGISTRY）

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

/// 读指定 profile 的 env 变量，供 GUI 编辑预填（新建模板只返回 id/label/model）。
#[tauri::command]
fn get_profile_env(profile_name: String) -> Result<std::collections::HashMap<String, String>, String> {
    let dir = find_profiles_dir()
        .ok_or_else(|| "Cannot find .env.profiles directory".to_string())?;
    let path = dir.join(format!("{}.env", profile_name));
    if !path.exists() {
        return Err(format!("Profile '{}' not found", profile_name));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read profile: {}", e))?;
    let mut map = std::collections::HashMap::new();
    for (k, v) in parse_env_file(&content) {
        map.insert(k, v);
    }
    Ok(map)
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

    // 断掉迁移复活源：migrate_legacy_profiles 会从工作区/项目级的 .env.profiles 把
    // 同名 .env 拷回用户级(dst.exists()==false 即拷)。若不删这里的源, 用户删除的
    // profile 下次启动又会被迁移拷回——"删除后重启又出现"。同名的源文件一并清掉。
    // work_dir 为空时退化为相对路径会误删 CWD 下文件, 必须先守住非空。
    let work_dir = settings::load_settings().work_dir;
    if !work_dir.is_empty() {
        let legacy_src = std::path::PathBuf::from(&work_dir)
            .join(".env.profiles").join(format!("{}.env", profile_name));
        if legacy_src.exists() {
            let _ = std::fs::remove_file(&legacy_src);
            log::info!("[profile] 清理迁移源残留 {} (防复活)", legacy_src.display());
        }
    }
    // find_project_root 的迁移源(安装版 script 所在项目根)也一并清理, 双源都断。
    if let Ok(script) = find_ide_script() {
        let root_src = find_project_root(&script).join(".env.profiles").join(format!("{}.env", profile_name));
        if root_src.exists() {
            let _ = std::fs::remove_file(&root_src);
        }
    }

    // 若删的是当前激活 profile, 清掉指向它的标记, 避免重启后仍被当作激活。
    if let Some((active_id, _)) = resolve_active_profile() {
        if active_id == profile_name && !work_dir.is_empty() {
            let _ = std::fs::remove_file(user_claude_dir().join(".env.active"));
            let ws_marker = std::path::PathBuf::from(&work_dir).join(".claude").join("active-profile");
            let _ = std::fs::remove_file(&ws_marker);
            log::info!("[profile] 已删激活 profile, 清除 active 标记");
        }
    }

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
/// CDP 调试参数（`CCGUI_CDP_PORT=<port>`）—— **必须应用到每一个窗口**。
///
/// ⚠️ 这不是"给某个窗口多加一个参数"那么局部的事：`additional_browser_args` 是
/// **WebView2 environment 级**的选项（wry 在 `create_environment` 里调
/// `set_additional_browser_arguments`，见 wry webview2/mod.rs），而**同一个 user data
/// folder 只允许存在一个 environment**。若只给主窗加、其它窗口不加，第二个窗口建
/// webview 时 environment 参数不一致 → `HRESULT 0x8007139F`（ERROR_INVALID_STATE）
/// → **所有次级窗口全部建不出来**（浮窗 / overlay / 外链窗）。
///
/// 这个坑真的踩过：2026-09-16 排查 overlay 窗口建不出来时，最初误判为 overlay 实现
/// 有问题，实际是当时只给主窗加了 CDP 参数 —— 对照实验里连**已发布的**
/// `create_floating_window` 都以同一 HRESULT 失败，才定位到根因。
///
/// 另外两条约束（同一处代码）：
/// ① wry 是 `additional_browser_args.unwrap_or_else(默认)` 之后**无条件**
///    `set_additional_browser_arguments()`，会覆盖 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
///    环境变量 —— 所以那个 env 传不进去（实测端口不监听）。
/// ② wry 一旦拿到自定义 args 就**不再使用它的默认值**，故必须把默认参数一并带上，
///    否则会丢「去迷你菜单 / 去 SmartScreen」。
///
/// 未设该 env 时返回原 builder，行为与加此功能前完全一致。
fn with_debug_args<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    match std::env::var("CCGUI_CDP_PORT") {
        Ok(port) if !port.trim().is_empty() => builder.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --remote-debugging-port={}",
            port.trim()
        )),
        _ => builder,
    }
}

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
        match with_debug_args(tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App(path.into()),
        ))
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

/// overlay 窗口的**显示兜底**超时（毫秒）。
///
/// 窗口建好后是**隐藏**的（避免 WebView2 白底闪屏，见 `show_plugin_overlay`），
/// 由前端在内容就绪后请求显示。但插件是任意第三方 HTML，不保证上报就绪信号 ——
/// 故到点仍没显示就强制显示：宁可闪一下，也不能让窗口永远不出来。
const OVERLAY_SHOW_FALLBACK_MS: u64 = 1200;

/// 指示窗（小浮标）建好后延迟多久显示。
/// 同样是为了避开 WebView2 的白底首帧，但小窗的构造与绘制开销远小于全屏 overlay，
/// 固定短延迟即可，不必像 overlay 那样要前端回报就绪。
const INDICATOR_SHOW_DELAY_MS: u64 = 250;

/// 给 overlay 窗口开"鼠标穿透"（指示器不挡用户点击下面真正要点的东西）。
///
/// 🔴 **绝对不能用 `WebviewWindow::set_ignore_cursor_events`** —— tao 的实现是
/// （`window_state.rs` 的 `WindowFlags::IGNORE_CURSOR_EVENT` 分支）：
/// ```text
/// if flags.contains(IGNORE_CURSOR_EVENT) { style_ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED; }
/// ```
/// 它**顺带加了 `WS_EX_LAYERED`，却从不调用 `SetLayeredWindowAttributes`** ——
/// 窗口的 layered 属性处于未定义状态 → **整个窗口（含 WebView 内容）什么都不画**。
/// 实测（2026-09-18）：屏幕全黑、连开始菜单都看不见，用户只能强制重启电脑。
/// 而 tao 的**透明**走的是另一条路（`DwmEnableBlurBehindWindow` + 空区域），
/// 与此无关 —— 所以"透明"对、"穿透"把它搞黑了。
///
/// 这里只设 `WS_EX_TRANSPARENT`（**绝不碰 LAYERED**），那才是穿透的语义。
#[cfg(windows)]
fn set_overlay_click_through(win: &tauri::WebviewWindow) -> tauri::Result<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT,
    };
    let hwnd = win.hwnd()?.0 as *mut core::ffi::c_void;
    unsafe {
        let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = cur | WS_EX_TRANSPARENT as isize;
        if next != cur {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
    Ok(())
}

/// overlay 窗口 label 前缀 —— open / close 共用同一份，保证两边对得上。
/// Tauri 的 label 只允许 `[A-Za-z0-9-/:_.]`，而插件名是自由字符串，故净化一次。
fn overlay_label_prefix(plugin: &str) -> String {
    let slug: String = plugin
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("overlay-{slug}-")
}

/// 插件请求开「全屏 overlay」窗口 —— **通用能力**，非某个插件专属。
///
/// 用途：需要铺满显示器、置顶、无边框的全屏交互 UI（区域框选、浮层标注、取色器…）。
/// 插件侧 HTML 由 `src` 指定（插件目录内相对路径，经 `plugins://` 协议加载），
/// 窗口内的 postMessage 上行复用插件面板那套协议（同一 origin 校验，见 pluginPanelBridge）。
///
/// `monitor`: `Some(i)` 只开第 i 块显示器；`None` = 每块显示器各开一个。
/// 返回实际打开的显示器索引。
///
/// ⚠️ **敏感能力**：插件借此可覆盖用户整个屏幕。本轮不做权限门控（见实现计划）。
/// 边界仅两条：① `src` 受 `plugins://` 协议的既有路径校验（只能读插件自己目录）；
/// ② 窗口 label 前缀 `overlay-*` 加进 capability —— 只是为了允许 postMessage，
///    并不额外放权（overlay 窗口拿不到比主窗更多的 IPC 能力）。
#[tauri::command]
fn open_plugin_overlay(
    app: tauri::AppHandle,
    plugin: String,
    src: String,
    monitor: Option<usize>,
    // 不透明透传参数（宿主不解释，只拼进 iframe URL 的 query）—— 插件常用它把
    // 后台进程端口带进 overlay。形如 `key=value&key2=value2`。
    params: Option<String>,
    // 🆕 「标注/教鞭」类 overlay 的两个开关（默认 false = 保持原有行为，
    // 如截图插件的区域框选：不透明 + 要接收点击）：
    //   transparent   —— 窗口背景透明（页面用 CSS 自己画半透明遮罩/图形）
    //   click_through —— 鼠标事件**穿透**到底下窗口。这是教鞭的关键：
    //                    指示器不该挡住用户真正想点的东西。
    //                    启用后 overlay 自身收不到点击（正常 —— 它只是画给人看的）。
    transparent: Option<bool>,
    click_through: Option<bool>,
    // 🛡 硬超时（秒）：到点无条件关窗 —— 防"覆盖层关不掉把屏幕锁死"。
    // 正常关闭依赖覆盖层自己的 JS 跑起来（到期上报 close）；页面没渲染出来时
    // 没有任何 JS 可依赖，这条是唯一的兜底。None/0 = 不设（如框选类 overlay
    // 要等用户操作，靠用户自己按 Esc）。
    hard_ttl_sec: Option<u64>,
) -> Result<Vec<usize>, String> {
    let want_transparent = transparent.unwrap_or(false);
    let want_click_through = click_through.unwrap_or(false);
    let monitors = app.available_monitors().map_err(|e| format!("枚举显示器失败: {e}"))?;
    if monitors.is_empty() {
        return Err("没有可用显示器".into());
    }
    let indices: Vec<usize> = match monitor {
        Some(i) if i < monitors.len() => vec![i],
        Some(i) => return Err(format!("显示器索引 {i} 越界（共 {} 块）", monitors.len())),
        None => (0..monitors.len()).collect(),
    };

    let prefix = overlay_label_prefix(&plugin);
    // 分隔符用 `|`（`/` 会与 src 内的目录分隔冲突）。两侧都要转义 `|` 本身，
    // 否则插件名或路径里含 `|` 会把 hash 解析切错段（TS 侧 parseOverlayHash 对齐）。
    let mut path = format!("index.html#overlay/{}|{}", hash_enc(&plugin), hash_enc(&src));
    if let Some(p) = params.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        path.push('|');
        path.push_str(&hash_enc(p));
    }
    log::info!("[Rust] open_plugin_overlay: plugin={plugin} src={src} monitors={indices:?}");

    let mut opened = Vec::new();
    for &idx in &indices {
        let m = &monitors[idx];
        let pos = m.position(); // PhysicalPosition<i32>
        let size = m.size(); // PhysicalSize<u32>
        let (px, py, sw, sh) = (pos.x, pos.y, size.width, size.height);
        let label = format!("{prefix}{idx}");

        // 幂等：
        //   ① 已存在且**几何一致** → 直接复用（show + 返回），不重建。
        //      重建会让覆盖层重新加载 → 屏幕上闪一下；连续标注（如"先点这、再点那"）
        //      尤其明显。复用时插件侧的数据更新由覆盖层自己的轮询拿（无需宿主参与）。
        //   ② 几何不一致（换显示器/分辨率变了）→ 关掉重建。
        //
        // 🔴 ② 必须**等窗口真的销毁**再 build：`close()` 是异步的（发关闭请求，
        //    实际销毁在事件循环里），紧接着 build 同 label 会报
        //    `a webview with label ... already exists`（实测踩过：第二次调用静默失败，
        //    用户看到的是"什么都没画"）。
        if let Some(w) = app.get_webview_window(&label) {
            let geom_matches = w
                .outer_position()
                .map(|p| p.x == px && p.y == py)
                .unwrap_or(false)
                && w
                    .outer_size()
                    .map(|s| s.width == sw && s.height == sh)
                    .unwrap_or(false);
            if geom_matches {
                let _ = w.show();
                log::info!("[Rust] overlay reused: {label}");
                opened.push(idx);
                continue;
            }
            let _ = w.close();
            // 等它从窗口表里消失（最多 ~1.5s；正常几毫秒）
            for _ in 0..75 {
                if app.get_webview_window(&label).is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }

        let label2 = label.clone();
        let path2 = path.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            // ⚠️ 混合 DPI 的关键：builder 的 `position`/`inner_size` 只吃**逻辑**像素，
            // 而每块显示器缩放可能不同 → 直接喂物理值会错位。
            // 故先以隐藏状态建窗，再用**物理**坐标 set_position/set_size 精确贴合，
            // 最后才 show()（避免默认位置闪一下）。
            let built = with_debug_args(tauri::WebviewWindowBuilder::new(
                &app2,
                &label2,
                tauri::WebviewUrl::App(path2.into()),
            ))
            .title("Overlay")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            // 透明与穿透见 open_plugin_overlay 的参数说明。默认 false → 截图插件行为不变。
            .transparent(want_transparent)
            .data_directory(webview_data_dir(&app2))
            .build();

            match built {
                Ok(win) => {
                    // 点击穿透：鼠标事件落到 overlay **下面**的窗口。
                    // ⚠️ 用自写的 Win32 版本，**不能用 tao 的 set_ignore_cursor_events**
                    //    （它会加 WS_EX_LAYERED 导致窗口整体不绘制 —— 见函数注释）。
                    // 建窗后立刻设（show 之前也行 —— 这是窗口样式位，与可见性无关）。
                    #[cfg(windows)]
                    if want_click_through {
                        if let Err(e) = set_overlay_click_through(&win) {
                            log::error!("[Rust] overlay click-through failed: {e}");
                        }
                    }
                    #[cfg(not(windows))]
                    let _ = want_click_through;

                    // 🛡 硬超时兜底（防"关不掉的覆盖层把用户屏幕锁死"）。
                    // 为什么必须有：覆盖层的正常关闭依赖**它自己页面里的 JS 能跑起来**
                    // （到期 → 上报 close）。若页面根本没渲染（加载失败 / WebView 异常），
                    // 就没有任何 JS 去关它 —— 用户面对一个盖满屏幕、又不响应任何操作的窗口。
                    // 实测（2026-09-18）：用户被迫强制重启电脑。
                    if let Some(ttl) = hard_ttl_sec {
                        if ttl > 0 {
                            let win_t = win.clone();
                            let label_t = label.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_secs(ttl));
                                if win_t.is_visible().unwrap_or(false) {
                                    log::warn!("[Rust] overlay hard TTL ({ttl}s) fired, closing {label_t}");
                                    let _ = win_t.close();
                                }
                            });
                        }
                    }
                    if let Err(e) = win.set_position(tauri::PhysicalPosition::new(px, py)) {
                        log::error!("[Rust] overlay set_position failed: {e}");
                    }
                    if let Err(e) = win.set_size(tauri::PhysicalSize::new(sw, sh)) {
                        log::error!("[Rust] overlay set_size failed: {e}");
                    }
                    // ⚠️ **这里刻意不 show()** —— 见 `show_plugin_overlay` 的注释：
                    // 窗口一显示，WebView2 就用**默认白底**渲染尚未加载完的内容，
                    // 而 overlay 铺满整块屏幕 → 用户看到"整个屏幕白闪一下"。
                    // 改由前端在内容就绪（iframe + 冻结图加载完）后调
                    // `show_plugin_overlay`；下面还有一个超时兜底，保证任何情况下
                    // 窗口都不会永远不显示。
                    let emit_label = win.label().to_string();
                    let app_ev = app2.clone();
                    // 窗口被外部销毁（Alt+F4 / 杀进程）时通知前端，便于清理会话
                    win.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            let _ = app_ev.emit("plugin-overlay-closed", emit_label.as_str());
                        }
                    });

                    // 兜底：前端若因任何原因没来调 show（插件走的是插件自己的 HTML，
                    // 未必上报就绪），到点强制显示 —— 退回"会白闪但能用"的旧行为，
                    // 而不是"窗口永远不出来"。
                    let win_t = win.clone();
                    let label_t = label2.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(
                            OVERLAY_SHOW_FALLBACK_MS,
                        ));
                        if !win_t.is_visible().unwrap_or(true) {
                            log::info!("[Rust] overlay show fallback fired: {label_t}");
                            let _ = win_t.show();
                            let _ = win_t.set_focus();
                        }
                    });

                    log::info!("[Rust] overlay built (hidden): {label2} @({px},{py}) {sw}x{sh}");
                }
                Err(e) => log::error!("[Rust] overlay build FAILED: {e}"),
            }
        });
        opened.push(idx);
    }
    Ok(opened)
}

/// 指示窗 label —— 每插件**一个**（不像 overlay 是每显示器一个）。
fn indicator_label(plugin: &str) -> String {
    let slug: String = plugin
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("indicator-{slug}")
}

/// 打开插件的小指示窗（如鼠标键盘插件的"AI 操作中"浮标）。
///
/// 与 `open_plugin_overlay`（铺满整块显示器、给区域框选用）的区别：这是**小窗**，
/// 位置尺寸由调用方给，且**不抢焦点**。
///
/// ## 两个必须做对的地方
///
/// 1. **`set_focusable(false)`（WS_EX_NOACTIVATE）** —— 指示窗属于宿主进程，若点击它
///    会让它成为前台窗口，而鼠标键盘插件的"前台是宿主就拒绝操作"防护会立刻生效 →
///    用户点一次停止按钮之后，AI 的后续操作**全被拒**，且原因看不出来。
///    设成不可激活：点得到按钮、但前台窗口不变。
/// 2. **`always_on_top` + `skip_taskbar`** —— 它是"随时能看见"的浮标，不进任务栏。
///
/// 位置缺省：主显示器右下角（不挡常见操作区）。
#[tauri::command]
fn open_plugin_indicator(
    app: tauri::AppHandle,
    plugin: String,
    src: String,
    params: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    let label = indicator_label(&plugin);
    // 已存在则先关掉重建（可能换了 src / 尺寸）。要**移动**请用 move_plugin_indicator
    // —— 那条路不重建窗口（重建会闪、也会丢页面状态）。
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }

    // 与 overlay 同一套 hash 协议 —— 复用前端 PluginOverlayApp 的渲染与上行通道
    let mut path = format!("index.html#overlay/{}|{}", hash_enc(&plugin), hash_enc(&src));
    if let Some(p) = params.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        path.push('|');
        path.push_str(&hash_enc(p));
    }

    let w = width.unwrap_or(300).clamp(120, 2000);
    let h = height.unwrap_or(150).clamp(60, 2000);

    let (px, py) = match (x, y) {
        (Some(x), Some(y)) => (x, y),
        _ => {
            let m = app
                .primary_monitor()
                .map_err(|e| format!("取主显示器失败: {e}"))?
                .ok_or("没有主显示器")?;
            let pos = m.position();
            let size = m.size();
            (
                pos.x + size.width as i32 - w as i32 - 16,
                pos.y + size.height as i32 - h as i32 - 64,   // 多留一点，避开任务栏
            )
        }
    };

    log::info!("[Rust] open_plugin_indicator: plugin={plugin} {w}x{h} @({px},{py})");

    let app2 = app.clone();
    std::thread::spawn(move || {
        let built = with_debug_args(tauri::WebviewWindowBuilder::new(
            &app2,
            &label,
            tauri::WebviewUrl::App(path.into()),
        ))
        // 标题是插件**找回这个窗口**的锚点：插件进程按标题 FindWindow 找到它、
        // GetWindowRect 拿屏幕矩形（用于"别操作指示窗所在区域"的判断）。
        //
        // ⚠️ 必须带**宿主 PID**：多开时每个实例都有自己的指示窗，标题若只含插件名，
        // FindWindow 会返回**另一个实例**的窗口 —— 既会读错矩形，也会挪错窗口。
        // 插件侧用同一个规则拼（`indicator::<插件名>::<CLAUDE_PLUGIN_HOST_PID>`）。
        // 窗口无装饰 + 不进任务栏，这个标题用户看不到。
        .title(&format!("indicator::{}::{}", plugin, std::process::id()))
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)      // 先隐藏，稍后再显示（避免 WebView2 白底闪一下）
        .data_directory(webview_data_dir(&app2))
        .build();

        match built {
            Ok(win) => {
                // ⚠️ 不可激活：见函数注释（否则点一次停止按钮就触发"前台是宿主"防护）
                if let Err(e) = win.set_focusable(false) {
                    log::error!("[Rust] indicator set_focusable(false) failed: {e}");
                }
                if let Err(e) = win.set_position(tauri::PhysicalPosition::new(px, py)) {
                    log::error!("[Rust] indicator set_position failed: {e}");
                }
                if let Err(e) = win.set_size(tauri::PhysicalSize::new(w, h)) {
                    log::error!("[Rust] indicator set_size failed: {e}");
                }
                let win_t = win.clone();
                std::thread::spawn(move || {
                    // 小窗构造开销远小于全屏 overlay，固定短延迟即可
                    std::thread::sleep(std::time::Duration::from_millis(INDICATOR_SHOW_DELAY_MS));
                    let _ = win_t.show();
                });
                log::info!("[Rust] indicator built: {label}");
            }
            Err(e) => log::error!("[Rust] indicator build FAILED: {e}"),
        }
    });

    Ok(())
}

/// 移动指示窗（AI 发现它挡住操作时可请求挪开；也可用于恢复到缺省位置）。
#[tauri::command]
fn move_plugin_indicator(
    app: tauri::AppHandle,
    plugin: String,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let label = indicator_label(&plugin);
    let Some(w) = app.get_webview_window(&label) else {
        return Err(format!("指示窗不存在（{label}）"));
    };
    w.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| format!("移动指示窗失败: {e}"))?;
    log::info!("[Rust] move_plugin_indicator: {plugin} -> ({x},{y})");
    Ok(())
}

/// 关闭指示窗（插件请求 / 面板关 / 禁用插件时清理）。
#[tauri::command]
fn close_plugin_indicator(app: tauri::AppHandle, plugin: String) -> Result<(), String> {
    let label = indicator_label(&plugin);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
        log::info!("[Rust] close_plugin_indicator: {plugin}");
    }
    Ok(())
}

/// 关闭某插件的全部 overlay 窗口（插件主动收起 / 禁用 / 退出时清理）。
#[tauri::command]
fn close_plugin_overlay(app: tauri::AppHandle, plugin: String) -> Result<usize, String> {
    let prefix = overlay_label_prefix(&plugin);
    let mut closed = 0usize;
    for w in app.webview_windows().values() {
        if w.label().starts_with(&prefix) {
            let _ = w.close();
            closed += 1;
        }
    }
    log::info!("[Rust] close_plugin_overlay: {plugin} -> closed {closed}");
    Ok(closed)
}

/// 本机有几个同款 GUI 实例（含自己，最小 1）。
///
/// 前端用它把「全局热键注册失败」的两种来源分开：另一个 GUI 实例（多开的正常现象）
/// vs 其它软件（需要用户换键）。OS 的错误信息不区分这两者，而用户要采取的动作
/// 完全不同 —— 见 `prockill::count_sibling_instances`。
#[tauri::command]
fn count_gui_instances() -> usize {
    #[cfg(windows)]
    {
        crate::prockill::count_sibling_instances()
    }
    #[cfg(not(windows))]
    {
        1
    }
}

/// 删除插件根下所有 `.trash-*` 目录（卸载时删不掉、改名留下的残留）。
///
/// 只要名字前缀匹配就删 —— 这些目录是**我们自己**改名产生的，且不在插件扫描范围内
/// （`.trash-` 前缀不是合法插件名），删错的可能不存在。
fn cleanup_trash_plugin_dirs(plugins_root: &str) {
    let Ok(entries) = std::fs::read_dir(plugins_root) else { return };
    let mut n = 0usize;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(".trash-") {
            continue;
        }
        if std::fs::remove_dir_all(e.path()).is_ok() {
            n += 1;
        }
    }
    if n > 0 {
        log::info!("startup: cleaned up {n} trashed plugin dir(s)");
    }
}

/// 显示某插件的 overlay 窗口（内容已就绪，可以亮出来了）。
///
/// **为什么要有这条命令**：`open_plugin_overlay` 建窗时刻意**不 show**。窗口一显示，
/// WebView2 就用它自己的**默认白底**绘制尚未加载完的内容，而 overlay 是铺满整块
/// 屏幕的窗口 —— 于是用户看到"整个屏幕白闪一下"，观感上很廉价（原生截图工具没有
/// 这一下，因为它们不经过 WebView 启动）。改成：窗口先隐藏建好、摆好位置，
/// 由前端在 iframe 与冻结图都加载完之后调本命令亮出来 —— 用户直接看到成品画面。
///
/// 幂等：重复调用只是再 show 一次（无害）。
#[tauri::command]
fn show_plugin_overlay(app: tauri::AppHandle, plugin: String) -> Result<(), String> {
    let prefix = overlay_label_prefix(&plugin);
    let mut shown = 0usize;
    for w in app.webview_windows().values() {
        if w.label().starts_with(&prefix) {
            let _ = w.show();
            let _ = w.set_focus();
            shown += 1;
        }
    }
    if shown > 0 {
        log::info!("[Rust] show_plugin_overlay: {plugin} -> shown {shown}");
    }
    Ok(())
}

fn urlencoding(s: &str) -> String {
    s.replace('%', "%25")
        .replace('#', "%23")
        .replace('&', "%26")
        .replace('+', "%2B")
}

/// overlay hash 段编码：在 `urlencoding` 基础上额外转义 `|`（分段符本身）
/// 与 `/`（避免与片段语义混淆）。TS 侧 `decodeURIComponent` 能还原。
fn hash_enc(s: &str) -> String {
    urlencoding(s).replace('|', "%7C").replace('/', "%2F")
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
        match with_debug_args(tauri::WebviewWindowBuilder::new(
            &app_for_spawn,
            &label,
            tauri::WebviewUrl::External(parsed),
        ))
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
    // the initial fetch, not the streaming body). Kept long (300s) as a pure
    // backstop: the GUI frontend already runs a stall "decision period" — after
    // ~60s of silence it prompts the user to keep waiting or interrupt, and
    // auto-interrupts at ~120s if unhandled. This hard watchdog only fires in the
    // extreme case a user chose "keep waiting" then left, or the frontend's
    // interrupt command never reached the backend. Long enough for huge-context
    // cold-start (prefill can be silent before the first chunk) and for the
    // "keep waiting" window; tool execution happens after the stream closes so
    // long background tasks are unaffected.
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
    // marker 指向的 profile 文件被删/改名(如归档)时回退到目录里第一个可用 .env——
    // 静默 return 会让后端用默认配置启动(连错端点/模型, 且难排查)。
    let profile_path = if profile_path.exists() {
        profile_path
    } else {
        log::warn!(
            "[profile] Profile file not found: {} — falling back to first available",
            profile_path.display()
        );
        match std::fs::read_dir(&profiles_dir).ok().and_then(|rd| {
            rd.flatten()
                .find(|e| e.path().extension().map_or(false, |ext| ext == "env"))
                .map(|e| e.path())
        }) {
            Some(p) => p,
            None => {
                log::warn!("[profile] No .env profile available — backend runs with defaults");
                return;
            }
        }
    };

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
pub(crate) fn write_user_marker(profile_id: &str) {
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

/// 读系统剪贴板的**文件列表**（Windows CF_HDROP / macOS NSPasteboard filenames）。
///
/// 为什么需要：浏览器剪贴板事件里的 File **不带真实路径**——`File.path` 是
/// Electron 的非标准扩展，Tauri 只对**拖放**注入 .path（见 SuperDesktopCanvas
/// handleDrop 的注释）。于是粘贴文件时前端拿不到源路径，只能把内容复制到
/// `.claude/pasted/`；而拖放同一个文件却走引用，同一操作两种行为。
///
/// 剪贴板里不是文件（截图 / 纯文本）或平台不支持该能力 → 空数组，
/// 调用方据此回退到"复制内容"的旧行为。
#[tauri::command]
fn read_clipboard_files() -> Result<Vec<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("{}", e))?;
    Ok(clipboard
        .get()
        .file_list()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
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
fn open_system_terminal(app: tauri::AppHandle, _terminal_type: String, work_dir: String, claude_launch: Option<bool>) -> Result<(), String> {
    use std::process::Command;
    let launch = claude_launch.unwrap_or(false);
    // work_dir 为空时 `cd ""` 会报 bash 错（`: string is empty`），回退到主目录。
    let target_dir = if work_dir.trim().is_empty() {
        std::env::var("HOME").unwrap_or_else(|_| "~".into())
    } else {
        work_dir.clone()
    };
    // 转义策略：路径用 **bash 单引号**包裹，而不是双引号。
    //
    // 为什么不能用双引号：整段 bash 命令最终要嵌进 AppleScript 字符串字面量
    //（`do script "..."`）。路径外层若也用 `"`，这对引号会**提前闭合** AppleScript
    // 的字面量 → osascript 报 `-2741 syntax error: 预期是行的结尾，却找到"`。
    // 早先的写法正是如此（先转义 `"`→`\"`，再拼上**未转义**的 `"` 包裹），
    // 所以 mac 上「打开终端」必现失败。
    //
    // 单引号不参与 AppleScript 字面量，天然规避；bash 侧单引号内除 `'` 外无特殊
    // 字符，只需把路径里的 `'` 按 `'\''` 转义（与 update.rs 的 osascript 提权同思路）。
    let work = target_dir.replace('\'', "'\\''");
    let cd = format!("cd '{}'", work);

    // ⚠️ macOS 新开的 Terminal 是**登录 shell**，只读 ~/.zprofile / ~/.zshrc ——
    // **读不到本进程的 env**。所以插件 runtime（node/npm/npx）与安装目录都不在
    // 它的 PATH 里（Windows 分支靠 `.env("PATH", child_path)` 显式传入，mac 无此机制）。
    // 代价：新终端里 `node`/`npx` 不可用，`claude` 也可能找不到。
    // 修法：把目录拼进 bash 命令串（登录 shell 启动**之后**才 export，才能覆盖）。
    let mut prepend: Vec<String> = Vec::new();
    // 安装目录（claude 二进制所在）= Contents/MacOS
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            prepend.push(dir.to_string_lossy().to_string());
        }
    }
    // 插件 runtime（含 bin/）—— 与 aggregateRuntimePaths / pluginRuntimePaths.ts 同源
    prepend.extend(collect_plugin_runtime_dirs(&app));

    let path_export = if prepend.is_empty() {
        String::new()
    } else {
        let dirs = prepend
            .iter()
            .map(|d| format!("'{}'", d.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(":");
        // ⚠️ bash 侧需要 "$PATH" 的双引号（目录含空格时必须靠它整体展开），但它会被
        // **外层 AppleScript 字面量的 `"` 提前闭合** —— 与「打开终端」那个 -2741 老坑
        // 同源。故这里必须写成 `\"$PATH\"`：AppleScript 先把 `\"` 还原成 `"`，bash
        // 再收到 `"$PATH"`。
        // （已用词法模拟验证：`"` 不转义时 AppleScript 提前闭合；转义后正确，
        //   含空格路径与含单引号路径都通过。）
        format!("export PATH={}:\\\"$PATH\\\"; ", dirs)
    };

    let body = if launch {
        format!("{}{} && CLAUDE_CODE_SKIP_PROMPT_HISTORY=true claude", path_export, cd)
    } else {
        format!("{}{}", path_export, cd)
    };
    let script = format!(
        "tell application \"Terminal\" to activate\ntell application \"Terminal\" to do script \"{}\"",
        body
    );
    // 用 .output() 而非 .spawn()：osascript 会因权限被拒(TCC)返回非零退出码，
    // 而 spawn 不检查 → Rust 谎报 Ok、前端也以为成功，实际终端没开。
    let out = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // 按错误码区分原因 —— 早先不管什么错都提示"权限未授权"，而 AppleScript
        // 语法错(-2741)与权限拒绝(-1743)是完全不同的问题，误导排查方向。
        // 错误码见 AppleScript 错误约定：-2741 = 语法错，-1743 = 用户未授权。
        let hint = if stderr.contains("-1743") || stderr.contains("-600") {
            "（macOS「自动化」权限未授权 — 请到 系统设置→隐私与安全性→自动化，允许本 App 控制「终端」）"
        } else if stderr.contains("-2741") || stderr.contains("syntax error") {
            // 走到这里说明转义逻辑有 bug，而非用户环境问题
            "（AppleScript 语法错误 — 这是应用内部 bug，请连同本条报错反馈）"
        } else {
            "（请查看上方 osascript 原始报错）"
        };
        log::warn!("open_system_terminal: osascript failed, script={script:?}");
        return Err(format!(
            "osascript failed (exit {:?}): {} {hint}",
            out.status.code(),
            stderr.trim()
        ));
    }
    Ok(())
}

/// 拉起一个新的 GUI 实例。macOS 双击 .app 走 LaunchServices 会复用已运行实例（多实例
/// 起不来），这里用 `open -n` 强制开新进程；Windows 直接拉起当前 exe（普通多实例）。
#[tauri::command]
fn spawn_gui_instance() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    #[cfg(target_os = "macos")]
    {
        // .app 根 = Contents/MacOS/ 上溯两级（MacOS → Contents → *.app）
        let app = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent())
            .ok_or_else(|| "无法定位 .app 根".to_string())?;
        std::process::Command::new("open")
            .arg("-n")
            .arg(app)
            .spawn()
            .map_err(|e| format!("open -n 失败: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::process::Command::new(&exe).spawn()
            .map_err(|e| format!("spawn 失败: {}", e))?;
    }
    Ok(())
}

// get_git_branch 已移除（2026-09-11）—— 由 git-viewer 插件面板提供分支信息
// （真 git 命令 + 自动刷新 + worktree 支持）。旧实现读 .git/HEAD 且只在
// workDir 变化时拉一次：切分支不更新、worktree 下失效（.git 是文件读不到）。

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
    // 翻译技能直调 claude 二进制（Windows=claude.exe、mac=claude），不走 claude-haha.cmd 壳。
    // Windows 的 claude-haha.cmd 只是 "%~dp0claude.exe" %* 的转发壳，直调可省一层 shell。
    // claude.exe 与 GUI 同目录（{app} 根），find_cli_script 的 exe 同目录直查能命中。
    let script_name = if cfg!(target_os = "windows") { "claude.exe" } else { "claude" };
    let script = find_cli_script(script_name)?;
    let script = strip_extended_prefix(&script);

    // mac 的 claude 在 .app/Contents/MacOS/ 下，find_project_root 上溯两级得到 Contents/（无意义），
    // 用 work_dir 作为运行目录（翻译目标工作区）。Windows 的 claude.exe 在 {app} 根，同样上溯无意义，
    // 故两平台都直接用 work_dir 运行，CLAUDE_CODE_CWD 也会覆盖实际 cwd。
    let project_root = std::path::PathBuf::from(work_dir);

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new(&script);
        c.arg("-p");
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        c
    } else {
        // mac: claude 是二进制（非 shell 脚本），直接 exec，不由 bash 包裹。
        let mut c = Command::new(&script);
        c.arg("-p");
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
            // exe 同目录直链：mac 的 .app/Contents/MacOS/claude、Windows 安装目录 {app}/claude.exe
            // 都与 GUI 同目录平级放（不在 bin/ 子目录），先直查，避免多一层 shell/壳转发。
            let direct = dir.join(script_name);
            if direct.exists() {
                return Ok(direct);
            }
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


// ── 插件贡献的 skill：把插件内的 skill 目录"链接"进 ~/.claude/skills/ ──
//
// ## 为什么是链接而不是复制
//
// 链接让**插件目录**成为唯一来源：改插件里的 skill 文件立刻生效，不会出现
// "插件更新了、技能目录里还是旧副本"。也省掉一份磁盘副本。
// 卸载插件 → 目录没了 → 链接变悬空 → 下次扫描自动清掉（见下）。
//
// ## 为什么放在"每次扫描"而不是安装时的一次性动作
//
// 这是**幂等同步**：插件在 → 链接在（缺了补、指向错了重建）；插件不在 → 链接清掉。
// 用户手删了链接、或插件被手工挪走，下次重扫都会自愈。
// 做成"安装时建一次"的话，之后状态漂了没人管。
//
// ## 平台差异（都实测过）
//
// - **Windows**：用 **junction**（`mklink /J`）—— 目录联接**不需要管理员权限、
//   也不需要开发者模式**（真 symlink 两者都要）。虽叫 junction，Node 的
//   `Dirent.isSymbolicLink()` 对它返回 true（reparse point），而 skill 加载器
//   显式接受 `isSymbolicLink()`（见 `src/skills/loadSkillsDir.ts`）→ 能被识别。
// - **macOS/Linux**：用 symlink。

/// 一个要链接进来的 skill。
#[derive(serde::Deserialize)]
pub struct SkillLinkSpec {
    /// 目标目录名：`~/.claude/skills/<name>`。必须是安全的单层目录名。
    pub name: String,
    /// **绝对路径**：插件目录内那个 skill 目录（须含 SKILL.md）。
    /// 由前端拼好（`<pluginsRoot>/<pluginName>/<path>`）——
    /// 与其它 contributes 一致：宿主不解析插件 manifest。
    pub source: String,
}

/// 校验 skill 名：只允许字母/数字/`-`/`_`/`.`。
/// name 会被直接 join 进 skills 目录，故必须杜绝路径穿越。
fn sanitize_skill_name(name: &str) -> Option<&str> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." || n.len() > 64 {
        return None;
    }
    if !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return None;
    }
    Some(n)
}

/// 建目录链接（Windows=junction，其它=symlink）。链接位已占时先清，保证幂等。
fn create_dir_link(link: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    if link.symlink_metadata().is_ok() {
        remove_dir_link(link)?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // 🔴 **必须先把正斜杠换成反斜杠** —— `mklink` 是 cmd 的**内置命令**，
        // 而 cmd 把 `/` 当作**参数开关前缀**。传 `C:/Users/...` 时 cmd 会看到
        // `/Users` 这个"开关" → 报 `无效参数 - "Users"`（实测复现）。
        //
        // 这个坑的来源：前端拼路径用 `/` 是**合理**的（跨平台心智，Windows 上也
        // 能正常工作 —— Rust 的 std::fs 两种都吃），所以转换放在这"最后一公里"
        // 是对的位置：**只有外部命令 mklink 有这个限制**。
        // （`std::fs` 的 read_link/remove_dir 等不受影响，不必转换。）
        let link_w = link.to_string_lossy().replace('/', "\\");
        let target_w = target.to_string_lossy().replace('/', "\\");
        let out = Command::new("cmd")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(&link_w)
            .arg(&target_w)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("mklink 启动失败: {e}"))?;
        if !out.status.success() {
            // stderr 是**控制台代码页（中文 Windows = GBK）**，不是 UTF-8 ——
            // 直接 from_utf8_lossy 会得到乱码。尽力解码，解不出就给出退出码，
            // 至少让排查者知道"失败了"而不是看到一串 `�`。
            let raw = out.stderr;
            let msg = String::from_utf8(raw.clone())
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| format!("exit {} (stderr 非 UTF-8，原始 {} 字节)", out.status, raw.len()));
            return Err(format!("mklink /J 失败: {msg}"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(target, link).map_err(|e| format!("symlink 失败: {e}"))
    }
}

/// 删目录链接。**只摘链接本身，绝不递归删目标**。
/// 发现它不是链接（而是真目录）时报错返回 —— 那是用户的东西，不擅自删。
fn remove_dir_link(link: &std::path::Path) -> Result<(), String> {
    let is_link = link
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_link {
        return Err(format!("{} 不是链接（为安全起见不递归删除）", link.display()));
    }
    std::fs::remove_dir(link).map_err(|e| format!("移除链接失败: {e}"))
}

/// 收尾：清掉 skills 目录里**指向插件目录、但本次没在清单里**的链接。
///
/// 两个"只动自己的"判据，避免误删用户手建的链接（如指向 `~/.agents/skills` 的）：
///   ① 必须是链接（真目录一律不碰）
///   ② 目标路径含 `/plugins/`（我们建的链接都指向插件目录）
fn prune_stale_plugin_skill_links(
    skills_dir: &std::path::Path,
    keep: &std::collections::HashSet<String>,
    plugins_root_norm: &str,
) {
    let Ok(entries) = std::fs::read_dir(skills_dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if keep.contains(&name) {
            continue;
        }
        let p = e.path();
        let is_link = p.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
        if !is_link {
            continue;   // 用户自己装的技能目录 → 不动
        }
        // 目标是插件目录下 → 是我们建的（含已悬空的）。read_link 对 junction 也有效。
        let owned = std::fs::read_link(&p)
            .map(|t| {
                let ts = t.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                ts.starts_with(plugins_root_norm)
            })
            .unwrap_or(false);
        if owned {
            match remove_dir_link(&p) {
                Ok(()) => log::info!("skill link pruned: {name}"),
                Err(err) => log::warn!("skill link prune 失败 {name}: {err}"),
            }
        }
    }
}

/// 同步插件贡献的 skill 链接。**幂等**，可反复调用。
#[tauri::command]
fn sync_plugin_skill_links(
    app: tauri::AppHandle,
    specs: Vec<SkillLinkSpec>,
) -> Result<serde_json::Value, String> {
    let skills_dir = user_home().join(".claude").join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|e| format!("Cannot create skills dir: {e}"))?;

    let plugins_base = plugins_base_dir(&app)?;
    let plugins_root = std::path::PathBuf::from(&plugins_base);
    // 归一化用于前缀比对（大小写 + 分隔符），只用于 prune 的归属判断
    let plugins_root_norm = plugins_root
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();

    let mut linked: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();

    for spec in &specs {
        let Some(name) = sanitize_skill_name(&spec.name) else {
            errors.push(format!("非法 skill 名（已跳过）: {}", spec.name));
            continue;
        };
        let src = std::path::PathBuf::from(&spec.source);
        // **只允许链接插件目录内的东西**（source 由前端拼，仍校验一道 ——
        // 万一前端被改了，这里挡住"把任意目录挂进技能目录"）
        let src_norm = src.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
        if !src_norm.starts_with(&plugins_root_norm) {
            errors.push(format!("source 不在插件目录内（已跳过）: {name} → {}", src.display()));
            continue;
        }
        if !src.is_dir() {
            errors.push(format!("skill 目录不存在（已跳过）: {name} → {}", src.display()));
            continue;
        }
        if !src.join("SKILL.md").exists() {
            errors.push(format!("缺 SKILL.md（已跳过）: {name} → {}", src.display()));
            continue;
        }
        keep.insert(name.to_string());

        let link = skills_dir.join(name);
        // 已存在且已指向同一目标 → 不动（省一次 mklink，也避免无谓的目录抖动）
        if link.symlink_metadata().is_ok() {
            if let Ok(cur) = std::fs::read_link(&link) {
                if cur == src {
                    linked.push(name.to_string());
                    continue;
                }
            }
        }
        match create_dir_link(&link, &src) {
            Ok(()) => {
                log::info!("skill link: {name} → {}", src.display());
                linked.push(name.to_string());
            }
            Err(e) => errors.push(format!("建链失败 {name}: {e}")),
        }
    }

    prune_stale_plugin_skill_links(&skills_dir, &keep, &plugins_root_norm);

    Ok(serde_json::json!({ "linked": linked, "errors": errors }))
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

            // 技能下载不产生 UI 进度事件（update-download-progress 只给更新组件用），
            // 传输层靠 callback 上报进度，这里传 None 即无 UI 副作用。
            download_and_extract(&zip_url, &temp_dir, None)?;

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

            download_and_extract(&zip_url, &temp_dir, None)?;

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

/// 读插件目录 plugin.json 的 `runtimes[].path`——更新安装时用于保护这些目录
/// （它们是**安装产物**而非包内容，如 nodejs 插件的 Node 运行时）。
///
/// 校验同前端 `parseRuntimes`：拒绝绝对路径 / 盘符 / UNC / `..` 穿越。
/// 该值来自磁盘上的旧 manifest，不能无条件信任——`target_dir.join(rel)` 在
/// rel 含 `..` 时会逃出插件目录（进而被 rename 到别处）。
/// 读不到 / JSON 非法 / 无有效条目 → None（调用方按"无可保护目录"处理）。
fn read_runtime_rel_paths(plugin_dir: &std::path::Path) -> Option<Vec<String>> {
    let raw = std::fs::read_to_string(plugin_dir.join("plugin.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let arr = v.get("runtimes")?.as_array()?;
    let out: Vec<String> = arr
        .iter()
        .filter_map(|r| r.get("path").and_then(|p| p.as_str()))
        .filter(|p| {
            !p.is_empty()
                && !p.starts_with('/')
                && !p.starts_with('\\')
                && !(p.len() >= 2 && p.as_bytes()[1] == b':')
                && !p.split(['/', '\\']).any(|seg| seg == "..")
        })
        .map(|p| p.to_string())
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 把 `plugin_dir` 下 runtimes 声明的目录（**安装产物**：Node 运行时等，非包内容）
/// rename 到 `stash_prefix` 下暂存，供覆盖安装时跨删除保护。
/// 返回 (暂存绝对路径, 原相对路径) 列表，交给 [`restore_runtimes`] 移回。
///
/// 用 rename 而非复制：同盘瞬时（运行时可达 90MB）；且实测 Windows 上
/// **rename 含正在运行 exe 的目录可行、删除会被拒**（ACCESS_DENIED）——
/// 这正是"移出可靠、删除失败"的差异来源。
fn stash_runtimes(
    plugin_dir: &std::path::Path,
    stash_prefix: &std::path::Path,
    tag: &str,
) -> Vec<(std::path::PathBuf, String)> {
    let Some(rels) = read_runtime_rel_paths(plugin_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, rel) in rels.iter().enumerate() {
        let src = plugin_dir.join(rel);
        if !src.exists() {
            continue;
        }
        let stash = stash_prefix.join(format!(".tmp_rt_{}_{}", tag, i));
        let _ = std::fs::remove_dir_all(&stash); // 清上次异常残留
        match std::fs::rename(&src, &stash) {
            Ok(_) => out.push((stash, rel.clone())),
            Err(e) => log::warn!("preserve runtime '{}' failed: {}", rel, e),
        }
    }
    out
}

/// 把 [`stash_runtimes`] 暂存的目录移回 `plugin_dir/<rel>`。
/// 新包自带同名目录 → 以新包为准（丢弃暂存）；单个失败不拖垮其余。
fn restore_runtimes(plugin_dir: &std::path::Path, preserved: Vec<(std::path::PathBuf, String)>) {
    for (stash, rel) in preserved {
        let dst = plugin_dir.join(&rel);
        if dst.exists() {
            let _ = std::fs::remove_dir_all(&stash);
            continue;
        }
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::rename(&stash, &dst) {
            log::warn!("restore runtime '{}' failed: {}", rel, e);
            let _ = std::fs::remove_dir_all(&stash);
        }
    }
}

/// 安装插件包(T5): 下载 zip → 解压 temp → 找 plugin.json 根 → 校验 → 落到
/// app_data_dir()/plugins/<pluginName>/（旧同名先删）。返回 pluginName 供前端重扫。
/// 插件包顶层结构: 根含 plugin.json(或单一子目录含 plugin.json)。
#[tauri::command]
async fn install_plugin_package(
    app: tauri::AppHandle,
    zip_url: String,
    package_name: String,
) -> Result<String, String> {
    // package_name 仅日志/校验用; 落盘目录以 plugin.json 的 pluginName 为准
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let base = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"));
            let plugins_dir = base.join("plugins");
            std::fs::create_dir_all(&plugins_dir)
                .map_err(|e| format!("Cannot create plugins dir: {}", e))?;

            let temp_dir = plugins_dir.join(format!(".tmp_plugin_{}", package_name));
            download_and_extract(&zip_url, &temp_dir, None)?;

            // 找 plugin.json 根: temp 自身(无插件包根目录)或唯一含 plugin.json 的子目录
            let plugin_root = find_plugin_root(&temp_dir)?;

            // 校验 plugin.json 可解析且含 pluginName
            let manifest_str = std::fs::read_to_string(plugin_root.join("plugin.json"))
                .map_err(|e| format!("Cannot read plugin.json: {}", e))?;
            let parsed: serde_json::Value = serde_json::from_str(&manifest_str)
                .map_err(|e| format!("plugin.json not valid JSON: {}", e))?;
            let plugin_name = parsed.get("pluginName")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "plugin.json missing pluginName".to_string())?
                .to_string();
            if plugin_name.trim().is_empty() {
                return Err("plugin.json pluginName is empty".to_string());
            }

            // 落到 plugins/<pluginName>/
            let target_dir = plugins_dir.join(&plugin_name);
            let mut preserved: Vec<(std::path::PathBuf, String)> = Vec::new();
            if target_dir.exists() {
                // 更新场景：先移出 runtimes 声明的**安装产物**（Node 运行时等），
                // 否则下面的 remove_dir_all 会一并删除它们 —— 用户每更新一次插件
                // 就得重新下载安装（nodejs 的运行时可达 90MB）。详见 stash_runtimes。
                preserved = stash_runtimes(&target_dir, &plugins_dir, &package_name);
                // 覆盖安装同一目录: 先杀掉 cwd 钉在该目录的进程(孤儿 node 持目录句柄
                // → remove_dir_all 失败 → 旧文件残留混入新版本), 同 uninstall_plugin。
                #[cfg(windows)]
                {
                    let n = crate::prockill::kill_processes_with_cwd_under(&target_dir.to_string_lossy());
                    if n > 0 {
                        log::info!("install_plugin_package: killed {} cwd holders of {}", n, plugin_name);
                        std::thread::sleep(std::time::Duration::from_millis(150));
                    }
                }
                std::fs::remove_dir_all(&target_dir).ok();
            }
            let copy_result = copy_dir_recursive(&plugin_root, &target_dir);
            // 无论复制成败都还原（失败时运行时也留在正确位置，便于用户重试）
            restore_runtimes(&target_dir, preserved);
            copy_result.map_err(|e| format!("Cannot install plugin: {}", e))?;

            std::fs::remove_dir_all(&temp_dir).ok();
            log::info!("Plugin installed: {} (from {})", plugin_name, package_name);
            Ok(plugin_name)
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("Install panicked: {}", e))?
}

/// 卸载插件: 杀该插件声明的后台进程 → 删除 plugins/<name>/ 目录。

// ── 插件生命周期 hook（beforeUninstall）──────────────────────────────
//
// 卸载流程是「**先杀进程 → 再删目录**」，所以 hook 不能是"让插件进程自己跑"
// —— 那一刻它已经死了。必须是**声明式脚本、由宿主执行**。
//
// 与更新组件的 `post_install`（update.rs）同一模式，但有两个关键差别：
//
// ① **用 bun / python 跑，不用 node**
//    宿主安装包自带 bun（安装目录 `bun.exe`）与 python（`python/python.exe`），
//    两者都已由 `prepend_tool_dirs` 前置进 PATH → **零前置条件**。
//    而 node 要靠 `nodejs` **插件**提供 —— hook 是基础能力，不该依赖另一个插件。
//
// ② **失败绝不阻断卸载**
//    刚修完"卸载不了"的坑（见 uninstall_plugin 的注释），不能因为 hook 写错、
//    超时、或依赖缺失又让用户卸不掉。所有异常只 warn。
//
// 参数经**环境变量**传给脚本（不用命令行，避免引号/转义地狱，也给更多上下文）：
//   CLAUDE_PLUGIN_NAME      被卸载的插件名
//   CLAUDE_PLUGIN_DIR       插件目录（**即将被删除**，脚本应只读它）
//   CLAUDE_PLUGIN_DATA_DIR  插件数据目录（宿主管理，卸载时自动清；脚本可提前处理）
//   CLAUDE_PLUGIN_WORKSPACE 当前工作区（可能为空）
const HOOK_TIMEOUT_SECS: u64 = 15;

/// 选解释器：bun 优先（安装目录自带），其次 python（自带），最后 PATH 里的。
/// 返回 (exe, 额外参数)。缺失时返回 None（调用方 warn 后跳过 hook）。
fn pick_hook_interpreter(install_dir: &std::path::Path, script: &str) -> Option<(std::path::PathBuf, Vec<String>)> {
    let ext = std::path::Path::new(script)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let is_py = ext == "py";
    let is_js = ext == "js" || ext == "mjs" || ext == "cjs";

    let bun = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
    let py = if cfg!(target_os = "windows") { "python.exe" } else { "python3" };

    if is_js {
        // .js/.cjs/.mjs → bun run（bun 直接跑脚本，无需额外子命令）
        let cand = install_dir.join(bun);
        if cand.is_file() { return Some((cand, vec![])); }
        return Some((std::path::PathBuf::from("bun"), vec![]));   // 交给 PATH
    }
    if is_py {
        // .py → python（Windows 在 install_dir/python/，mac 在 python/bin/）
        let cand = if cfg!(target_os = "windows") {
            install_dir.join("python").join(py)
        } else {
            install_dir.join("python").join("bin").join(py)
        };
        if cand.is_file() { return Some((cand, vec![])); }
        return Some((std::path::PathBuf::from(py), vec![]));
    }
    None   // 未知扩展名 → 不猜
}

/// 执行插件的 beforeUninstall hook。**任何失败只 warn，返回 Err 供调用方记日志。**
fn run_uninstall_hook(
    install_dir: &std::path::Path,
    plugin_dir: &std::path::Path,
    plugin_name: &str,
    script_rel: &str,
) -> Result<(), String> {
    let script = plugin_dir.join(script_rel);
    if !script.is_file() {
        return Err(format!("hook 脚本不存在: {}", script.display()));
    }
    let (exe, extra) = pick_hook_interpreter(install_dir, script_rel)
        .ok_or_else(|| format!("hook 脚本扩展名不支持（只认 .js/.cjs/.mjs/.py）: {script_rel}"))?;

    log::info!("uninstall_plugin: running hook {script_rel} via {}", exe.display());
    let mut cmd = Command::new(&exe);
    cmd.arg(&script);
    for a in &extra { cmd.arg(a); }
    cmd.current_dir(plugin_dir);
    cmd.env("CLAUDE_PLUGIN_NAME", plugin_name);
    cmd.env("CLAUDE_PLUGIN_DIR", plugin_dir.to_string_lossy().to_string());
    cmd.env("CLAUDE_PLUGIN_DATA_DIR", plugin_data_dir(install_dir, plugin_name).to_string_lossy().to_string());
    let wd = crate::settings::bound_work_dir();
    if !wd.is_empty() { cmd.env("CLAUDE_PLUGIN_WORKSPACE", wd); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("启动 hook 失败: {e}"))?;

    // 超时：到点就杀（不能让它挂住卸载流程）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(HOOK_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    log::info!("uninstall_plugin: hook {script_rel} ok");
                    return Ok(());
                }
                return Err(format!("hook 退出码 {status}"));
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err(format!("hook 超时（>{HOOK_TIMEOUT_SECS}s），已终止"));
                }
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            Err(e) => return Err(format!("等待 hook 失败: {e}")),
        }
    }
}

/// 插件数据目录（宿主管理；卸载时自动清空）。
/// 与 plugins-settings 同级放在 app_data_dir 下，便于统一清理。
fn plugin_data_dir(install_dir: &std::path::Path, plugin: &str) -> std::path::PathBuf {
    install_dir.join("plugins-data").join(plugin)
}

/// 前端卸载后调 reloadPlugins 重扫, 面板/命令即消失。
/// process_ids: 前端从 manifest.processes[].id 取（**裸名**, 如 "git-viewer-server"——
/// 与 registry 实际注册 id 一致; 曾按 `plugin:<name>:` 前缀过滤, 与裸名不匹配 → 进程
/// 没被杀 → Windows 文件占用删目录失败「另一个程序正在使用此文件」, 用户实测）。
/// 卸载结果（前端据此决定是否提示"需要重启"）。
#[derive(serde::Serialize)]
struct UninstallOutcome {
    /// 是否真的卸载了（false = 本来就没装，幂等）
    removed: bool,
    /// 插件声明了"卸载后需重启才生效" → 前端提示用户
    needs_restart: bool,
    /// beforeUninstall hook 的问题（有值时前端可提示"清理未完全"，但不阻断）
    hook_warning: Option<String>,
}

/// 插件可在 manifest 声明 `beforeUninstall`（脚本路径）与 `needsRestart: true`。
/// 两者都由**前端**从 manifest 读出后传进来 —— Rust 侧不解析 manifest
/// （插件目录即将被删，不必也不该在这里读它）。
#[tauri::command]
async fn uninstall_plugin(
    app: tauri::AppHandle,
    plugin_name: String,
    process_ids: Vec<String>,
    before_uninstall_hook: Option<String>,
    needs_restart: Option<bool>,
) -> Result<UninstallOutcome, String> {
    if plugin_name.trim().is_empty() || plugin_name.contains(['/', '\\', '.', ':']) {
        return Err(format!("invalid plugin name: {plugin_name}"));
    }
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("claude-code-gui"));
    let target = base.join("plugins").join(&plugin_name);
    if !target.exists() {
        return Ok(UninstallOutcome { removed: false, needs_restart: false, hook_warning: None }); // 未安装, 幂等
    }
    // ── beforeUninstall hook（**在杀进程之前**）──
    // 放到杀进程前，插件还有机会做"需要活着"的事（发通知、断连接、刷盘）；
    // 只清文件的 hook 在杀前跑也没问题。
    // ⚠️ 失败只 warn，**绝不阻断卸载**（刚修完"卸载不了"的坑，不能因 hook 又卸不掉）。
    let mut hook_warning: Option<String> = None;
    if let Some(script) = before_uninstall_hook.as_deref().filter(|s| !s.trim().is_empty()) {
        let install_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| std::env::temp_dir());
        if let Err(e) = run_uninstall_hook(&install_dir, &target, &plugin_name, script) {
            log::warn!("uninstall_plugin: beforeUninstall hook 未成功（不阻断卸载）: {e}");
            hook_warning = Some(e);
        }
    }

    // 杀该插件的后台进程: 裸名 id（前端传） + 前缀约定兜底（兼容未来带命名空间的注册）。
    let prefix = format!("plugin:{plugin_name}:");
    let mut ids: Vec<String> = process_ids;
    for id in plugin_process::registry().pids.lock().unwrap().keys() {
        if id.starts_with(&prefix) && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    for id in &ids {
        plugin_process::kill_plugin_process(&app, id);
    }
    // 决定性的一步：把**占着这个目录的进程**全杀掉。registry 只覆盖当前 GUI 自己
    // spawn 的进程 —— 更新/强杀/重启 GUI 留下的进程不在表里，上面杀不到，
    // 不杀干净这里就会报「另一个程序正在使用此文件」/「拒绝访问」。
    //
    // **两种占用来源都要杀，缺一个就会漏**（2026-09-17 实测踩到）：
    //   ① cwd 钉住**目录** ② 加载了 .node/.dll → 锁住**文件**
    // 当时只做了 ①，日志显示一个都没命中，而 ② 精确找到了持有 vendor/*.node 的进程。
    #[cfg(windows)]
    {
        let t = target.to_string_lossy().to_string();
        let n1 = crate::prockill::kill_processes_with_cwd_under(&t);
        let n2 = crate::prockill::kill_processes_loading_from(&t);
        if n1 + n2 > 0 {
            log::info!(
                "uninstall_plugin: killed {n1} cwd-holder(s) + {n2} module-loader(s) of {plugin_name}"
            );
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }
    // Windows: 进程退出后文件句柄释放有延迟——重试删除（最多 ~2s）。
    let mut last_err = String::new();
    for attempt in 0..10 {
        match std::fs::remove_dir_all(&target) {
            Ok(()) => { last_err.clear(); break; }
            Err(e) => {
                last_err = e.to_string();
                if attempt < 9 {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
    }
    if !last_err.is_empty() {
        // **兜底：改名而不是放弃。** 目录里可能还有我们杀不掉的占用者（别的用户
        // 起的进程、杀不动的权限等）。改名在"文件被占用"时通常仍能成功（锁的是
        // 具体文件/目录内容，不是父目录项），于是：
        //   · 对用户 = 卸载成功（插件从列表消失、目录不再被扫描）
        //   · 残留的真删除交给下次启动的清理（见 sweep_trash_plugin_dirs）
        // 比"卸载失败 + 让用户自己找占用进程"好得多。
        let trash = base.join("plugins").join(format!(
            ".trash-{}-{}",
            plugin_name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        match std::fs::rename(&target, &trash) {
            Ok(()) => {
                log::warn!(
                    "uninstall_plugin: {plugin_name} could not be deleted ({last_err}); \
                     moved to {} for cleanup on next start",
                    trash.display()
                );
            }
            Err(re) => {
                return Err(format!(
                    "Cannot remove plugin dir: {last_err}（改名兜底也失败: {re}）"
                ));
            }
        }
    }
    // ── 清宿主侧的插件残留（目录之外的东西）──
    // 这两样**卸载时必须清**，否则重装后旧设置/旧数据会"借尸还魂"：
    //   · plugins-settings/<name>.json（全局 + 工作区）—— 之前一直没清，是既有 bug
    //   · plugins-data/<name>/（宿主管理的插件数据目录）
    cleanup_plugin_residue(&app, &plugin_name);

    log::info!("Plugin uninstalled: {}", plugin_name);
    Ok(UninstallOutcome {
        removed: true,
        needs_restart: needs_restart.unwrap_or(false),
        hook_warning,
    })
}

/// 清宿主侧的插件残留（插件目录之外）。
/// 失败只 warn —— 残留比"卸载不了"轻得多。
fn cleanup_plugin_residue(app: &tauri::AppHandle, plugin: &str) {
    let fname = format!("{plugin}.json");
    // 全局设置
    if let Ok(dir) = app.path().app_data_dir() {
        let p = dir.join("plugins-settings").join(&fname);
        if p.exists() {
            match std::fs::remove_file(&p) {
                Ok(()) => log::info!("uninstall_plugin: removed {}", p.display()),
                Err(e) => log::warn!("uninstall_plugin: 清全局设置失败 {}: {e}", p.display()),
            }
        }
        // 插件数据目录
        let data = plugin_data_dir(&dir, plugin);
        if data.exists() {
            match std::fs::remove_dir_all(&data) {
                Ok(()) => log::info!("uninstall_plugin: removed {}", data.display()),
                Err(e) => log::warn!("uninstall_plugin: 清数据目录失败 {}: {e}", data.display()),
            }
        }
    }
    // 工作区设置（<workdir>/.claude/plugins-settings/<name>.json）
    let wd = crate::settings::bound_work_dir();
    if !wd.is_empty() {
        let p = std::path::PathBuf::from(&wd).join(".claude").join("plugins-settings").join(&fname);
        if p.exists() {
            match std::fs::remove_file(&p) {
                Ok(()) => log::info!("uninstall_plugin: removed {}", p.display()),
                Err(e) => log::warn!("uninstall_plugin: 清工作区设置失败 {}: {e}", p.display()),
            }
        }
    }
}

/// 验证市场插件包签名(Ed25519)。下载 zip 原始字节 + 拉 `<slug>/signature` 端点,
/// 用嵌入式官方公钥验证 (zip, sig)。
/// 返回 { trusted: bool, status: "verified" | "unsigned" | "invalid" | "fetch_failed", detail? }
/// 前端: trusted(true)=可「安装」; 否则只「AI 安装」+ AI 安全审查。
#[tauri::command]
async fn verify_plugin_signature(zip_url: String) -> Result<serde_json::Value, String> {
    // 从 zip_url 推 signature_url: /packages/<slug>/download → /packages/<slug>/signature
    let sig_url = if zip_url.ends_with("/download") {
        let base = zip_url.trim_end_matches("/download");
        format!("{}/signature", base)
    } else {
        format!("{}/signature", zip_url.trim_end_matches("/"))
    };

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|e| format!("HTTP client: {}", e))?;
            let zip_bytes = download_zip_retry(&client, &zip_url, None)?;
            // 拉签名
            let sig_resp = client.get(&sig_url).send();
            match sig_resp {
                Ok(resp) if resp.status().is_success() => {
                    let sig = resp.text().unwrap_or_default();
                    match crate::plugin_signature::verify_zip_signature(&zip_bytes, &sig) {
                        Ok(true) => Ok(serde_json::json!({ "trusted": true, "status": "verified" })),
                        Ok(false) => Ok(serde_json::json!({ "trusted": false, "status": "invalid" })),
                        Err(e) => Ok(serde_json::json!({ "trusted": false, "status": "invalid", "detail": e })),
                    }
                }
                _ => Ok(serde_json::json!({ "trusted": false, "status": "unsigned" })),
            }
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("verify channel: {}", e))?
}

// ── Helpers ──

/// 下载 zip 字节，传输中断（decode/超时/连接）时自动重试一次。
/// 公网大文件易被代理掐断 chunked 流 → 带重试显著降低偶发失败。
fn download_zip_retry(client: &reqwest::blocking::Client, url: &str, on_progress: Option<&ProgressCb>) -> Result<Vec<u8>, String> {
    let mut last_err: Option<String> = None;
    for attempt in 0..2 {
        match download_zip_once(client, url, on_progress) {
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

fn download_zip_once(client: &reqwest::blocking::Client, url: &str, on_progress: Option<&ProgressCb>) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use std::time::Instant;
    let mut response = client.get(url).send()
        .map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download returned HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
    let mut chunk = [0u8; 256 * 1024];
    let start = Instant::now();
    let mut last_emit = start;
    loop {
        let n = response.read(&mut chunk)
            .map_err(|e| format!("Download read failed: {}", e))?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        // 每 ~300ms 上报一次进度（避免 IPC 刷爆）。传输层只调 callback，不 emit、不管理状态。
        let now = Instant::now();
        if now.duration_since(last_emit).as_millis() >= 300 {
            if let Some(cb) = on_progress { cb(buf.len() as u64, total); }
            last_emit = now;
        }
    }
    // 结束前恒上报一次（缩放到 100% 或已下载量）
    if let Some(cb) = on_progress { cb(buf.len() as u64, total); }
    Ok(buf)
}

/// 下载进度回调：接收 (transferred_bytes, total_bytes)。由调用方决定是否/如何使用
/// （update.rs 用它 emit 到前端；技能下载传 None 即不产生 UI 副作用）。
/// 传输层保持纯净——不依赖 Tauri、不引用"组件"概念、不管理任何进度状态。
pub type ProgressCb = Box<dyn Fn(u64, u64) + Send>;

/// 构造"更新组件下载进度"回调：EMA 平滑速度状态封装在闭包里（不再用全局 map），
/// 每次进度上报 emit `update-download-progress` 到前端。component 由调用方捕获。
pub(crate) fn make_update_progress_cb(component: String) -> ProgressCb {
    // EMA 状态在闭包外捕获（RefCell 内部可变），闭包多次调用共享同一速度状态。
    use std::cell::RefCell;
    use std::time::Instant;
    let state = RefCell::new((0u64, Instant::now(), 0.0f64));
    Box::new(move |transferred: u64, total: u64| {
        let mut st = state.borrow_mut();
        let (last_bytes, last_t, ema) = *st;
        let now = Instant::now();
        let dt = now.duration_since(last_t).as_secs_f64();
        let delta = transferred.saturating_sub(last_bytes);
        let instant = if dt > 0.001 { delta as f64 / dt } else { ema };
        let new_ema = if ema == 0.0 { instant } else { ema * 0.7 + instant * 0.3 };
        *st = (transferred, now, new_ema);

        let percent = if total > 0 { (transferred as f64 * 100.0 / total as f64).min(100.0) } else { 0.0 };
        if let Some(app) = server_client::app_handle() {
            let _ = app.emit("update-download-progress", serde_json::json!({
                "component": component,
                "transferred": transferred,
                "total": total,
                "speedBytesPerSec": new_ema,
                "percent": percent,
            }));
        }
    })
}

pub(crate) fn download_and_extract(url: &str, temp_dir: &std::path::Path, on_progress: Option<ProgressCb>) -> Result<(), String> {
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
    let bytes = download_zip_retry(&client, url, on_progress.as_ref())?;

    let zip_path = temp_dir.join("download.zip");
    std::fs::write(&zip_path, &bytes)
        .map_err(|e| format!("Cannot write temp zip: {}", e))?;

    let file = std::fs::File::open(&zip_path)
        .map_err(|e| format!("Cannot open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Cannot read zip: {}", e))?;

    extract_zip_entries(&mut archive, temp_dir)?;

    std::fs::remove_file(&zip_path).ok();
    Ok(())
}

/// 把 zip 的所有条目解到 `dest`（跳过目录条目 → 由文件的父目录按需创建）。
///
/// 从 `download_and_extract` 抽出来**以便单测**（原实现内联且依赖网络下载，
/// 导致权限回归无法被测试覆盖 —— 而该 bug 正是"编译能过、运行必挂"那类）。
fn extract_zip_entries<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    dest: &std::path::Path,
) -> Result<(), String> {
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
        let out_path = dest.join(&name);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create dir: {}", e))?;
        }
        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|e| format!("Cannot create file: {}", e))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("Cannot write extracted file: {}", e))?;
        drop(out_file);

        // ⚠️ **必须恢复 zip 条目记录的可执行位** —— `File::create` 用默认 0o644
        // 建文件，不还原 unix mode。丢了 +x 的后果（mac GUI 自动更新实测）：
        //   `claude` 解出后不可执行 → 后续 osascript 提权 `ditto` 进 .app
        //   → `claude-ide: ... claude: Permission denied` → 引擎起不来、
        //     "IDE backend did not announce port within timeout"。
        // ZIP 把 unix 权限存在 `external_attributes >> 16` 的高 16 位。
        // 只处理 unix 平台（Windows 用 ACL，无 mode 概念，设了也无意义）。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = entry.unix_mode().unwrap_or(0o644);
            // 源 zip 若来自 Windows（无 mode 位，unix_mode 返回 0 或 None），
            // 不要把它设成 0o000（不可读）—— 只在与 0 不同才应用。
            if mode != 0 {
                let _ = std::fs::set_permissions(
                    &out_path,
                    std::fs::Permissions::from_mode(mode),
                );
            }
        }
    }
    Ok(())
}

/// Find the directory containing a marker file (SKILL.md / plugin.json) within
/// an extracted temp dir. Checks temp dir itself first, then immediate subdirs.
/// 三个 find_*_root 中收编的同形部分（skill/plugin/package 的 marker 匹配共用）。
fn find_marker_root(
    temp_dir: &std::path::Path,
    marker: &str,
    label: &str,
) -> Result<std::path::PathBuf, String> {
    if temp_dir.join(marker).exists() {
        return Ok(temp_dir.to_path_buf());
    }
    let entries = std::fs::read_dir(temp_dir)
        .map_err(|e| format!("Cannot read temp dir: {}", e))?;
    let mut found: Option<std::path::PathBuf> = None;
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if entry.path().join(marker).exists() {
                if found.is_some() {
                    return Err(format!("Multiple {} roots found in zip", label));
                }
                found = Some(entry.path());
            }
        }
    }
    found.ok_or_else(|| format!("No {} found in extracted zip", label))
}

/// Find the directory containing SKILL.md within an extracted temp dir.
/// Checks temp dir itself first, then immediate subdirectories.
fn find_skill_root(temp_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    find_marker_root(temp_dir, "SKILL.md", "skill")
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

/// 找插件包根目录: temp 自身含 plugin.json → 直接返回; 否则在子目录中找唯一含 plugin.json 的目录。
fn find_plugin_root(temp_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    find_marker_root(temp_dir, "plugin.json", "plugin")
}

// ─── Notes commands (user-level; route through server when reachable) ───

#[tauri::command]
async fn note_create(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    input: notes::NoteInput,
) -> Result<notes::NoteCreateResult, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_create(input.clone()).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_create(input)
}

#[tauri::command]
async fn note_update(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    id: String,
    input: notes::NoteUpdate,
) -> Result<notes::Note, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_update(&id, input.clone()).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_update(&id, input)
}

#[tauri::command]
async fn note_delete(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    id: String,
) -> Result<bool, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_delete(&id).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_delete(&id)
}

#[tauri::command]
async fn note_get(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    id: String,
) -> Result<notes::Note, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_get(&id).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_get(&id)
}

#[tauri::command]
async fn note_list(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    scope: Option<String>,
    tag: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<notes::NoteSummary>, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_list(scope.clone(), tag.clone(), limit).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_list(scope, tag, limit)
}

#[tauri::command]
async fn note_search(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    query: String,
    scope: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<notes::NoteSummary>, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_search(query.clone(), scope.clone(), limit).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_search(query, scope, limit)
}

#[tauri::command]
async fn note_associate(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    input: notes::NoteAssocInput,
) -> Result<bool, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_associate(input.clone()).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_associate(input)
}

#[tauri::command]
async fn note_disassociate(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    source_id: String,
    target_id: String,
) -> Result<bool, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_disassociate(&source_id, &target_id).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_disassociate(&source_id, &target_id)
}

#[tauri::command]
async fn note_tags(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    scope: Option<String>,
) -> Result<Vec<notes::TagCount>, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_tags(scope.clone()).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_tags(scope)
}

#[tauri::command]
async fn note_get_all_tag_names(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
) -> Result<Vec<String>, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_get_all_tag_names().await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_get_all_tag_names()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── prepend_tool_dirs: 安装目录子目录必须用相对后缀（Windows join 语义）──

    /// 回归：suffix 带前导反斜杠时 Path::join 会解析成盘根（C:\bin）而非
    /// 回归：解压必须**保留 zip 条目的可执行位**。
    ///
    /// 早期用 `File::create` 解压 → 一律 0o644，丢掉 `claude` 的 +x。
    /// mac GUI 自动更新实测后果：解压出的 `claude` 不可执行 → osascript 提权
    /// `ditto` 进 .app 后仍不可执行 → `claude-ide: ... claude: Permission denied`
    /// → 引擎起不来（"IDE backend did not announce port within timeout"）。
    ///
    /// 服务端 zip 里 `claude`/`claude-gui-server`/`claude-code-gui` 均为 0o755
    /// （已实测确认），所以丢失 100% 发生在解压这一步。
    #[cfg(unix)]
    #[test]
    fn extract_zip_preserves_unix_exec_bit() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        // 造一个含 0o755 条目的 zip（模拟 build.ts 用 ditto 打的包）
        let zip_path = std::env::temp_dir()
            .join(format!("extract_perm_{}.zip", std::process::id()));
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            // zip 0.6 的 API 是 `FileOptions`（不是 1.x/2.x 的 SimpleFileOptions）
            let opts = zip::write::FileOptions::default().unix_permissions(0o755);
            zw.start_file("Claude Code.app/Contents/MacOS/claude", opts).unwrap();
            zw.write_all(b"#!/bin/sh\necho hi\n").unwrap();
            zw.finish().unwrap();
        }

        let dest = std::env::temp_dir()
            .join(format!("extract_perm_out_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();

        let f = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        extract_zip_entries(&mut archive, &dest).unwrap();

        let out = dest.join("Claude Code.app/Contents/MacOS/claude");
        assert!(out.is_file(), "解压后文件应存在（含空格路径的嵌套目录）");
        let mode = std::fs::metadata(&out).unwrap().permissions().mode();
        assert!(
            mode & 0o111 != 0,
            "可执行位必须保留，实际 mode=0o{:o}（丢了就是 mac 更新后引擎起不来的根因）",
            mode & 0o7777
        );

        let _ = std::fs::remove_file(&zip_path);
        let _ = std::fs::remove_dir_all(&dest);
    }

    /// install_dir\bin → bin/python 永远进不了 PATH（fd/jq/yq 找不到）。
    /// 本测试用真实临时目录验证子目录被正确前置。
    #[test]
    fn prepend_tool_dirs_includes_subdirs_with_relative_suffix() {
        let base = std::env::temp_dir().join(format!("prepend_dirs_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for sub in ["bin", "python"] {
            std::fs::create_dir_all(base.join(sub)).unwrap();
        }
        // 把 base 当成 install_dir 传入（内部只看这些子目录是否存在）
        let out = prepend_tool_dirs(&base, "ORIG");
        let parts: Vec<&str> = out.split(if cfg!(target_os = "windows") { ';' } else { ':' }).collect();

        let base_s = base.to_string_lossy().to_string();
        let expect_bin = format!("{}{}bin", base_s, std::path::MAIN_SEPARATOR);
        let expect_py = format!("{}{}python", base_s, std::path::MAIN_SEPARATOR);
        assert!(parts.iter().any(|p| *p == expect_bin), "bin subdir missing: {:?}", parts);
        assert!(parts.iter().any(|p| *p == expect_py), "python subdir missing: {:?}", parts);
        // 原始条目保留在尾部
        assert_eq!(parts.last(), Some(&"ORIG"));
        let _ = std::fs::remove_dir_all(&base);
    }

    // ── 更新安装时保护 runtimes 目录（安装产物跨覆盖保留）──

    fn rt_fixture(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rt_protect_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_manifest(dir: &std::path::Path, runtimes_json: &str) {
        std::fs::write(
            dir.join("plugin.json"),
            format!(r#"{{"pluginName":"p","runtimes":{}}}"#, runtimes_json),
        )
        .unwrap();
    }

    /// 正常声明：读出相对路径。
    #[test]
    fn runtime_paths_reads_valid() {
        let d = rt_fixture("valid");
        write_manifest(&d, r#"[{"id":"node","path":"runtime"}]"#);
        assert_eq!(read_runtime_rel_paths(&d), Some(vec!["runtime".to_string()]));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// `..` 穿越必须被拒 —— 否则 target_dir.join(rel) 会逃出插件目录（可被 rename 到别处）。
    #[test]
    fn runtime_paths_rejects_traversal() {
        let d = rt_fixture("traversal");
        write_manifest(&d, r#"[{"id":"n","path":"../evil"},{"id":"m","path":"a/../../b"}]"#);
        assert_eq!(read_runtime_rel_paths(&d), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 绝对路径 / 盘符 / UNC 一律拒绝。
    #[test]
    fn runtime_paths_rejects_absolute() {
        let d = rt_fixture("abs");
        for bad in [
            r#"[{"id":"n","path":"/etc"}]"#,
            r#"[{"id":"n","path":"C:/Windows"}]"#,
            r#"[{"id":"n","path":"\\\\server\\share"}]"#,
        ] {
            write_manifest(&d, bad);
            assert_eq!(read_runtime_rel_paths(&d), None, "should reject: {}", bad);
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// manifest 缺失 / JSON 非法 / 无有效条目 → None（调用方按"无可保护"处理）。
    #[test]
    fn runtime_paths_none_when_unusable() {
        let d = rt_fixture("none");
        assert_eq!(read_runtime_rel_paths(&d), None); // 无 plugin.json
        std::fs::write(d.join("plugin.json"), "{ not json").unwrap();
        assert_eq!(read_runtime_rel_paths(&d), None); // JSON 非法
        write_manifest(&d, "[]");
        assert_eq!(read_runtime_rel_paths(&d), None); // 空数组
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 核心：stash → 删除原目录 → 复制新包 → restore，runtime 内容完好保留。
    #[test]
    fn runtimes_survive_overwrite_install() {
        let base = rt_fixture("roundtrip");
        let plugin_dir = base.join("p");
        std::fs::create_dir_all(plugin_dir.join("runtime/sub")).unwrap();
        std::fs::write(plugin_dir.join("runtime/node.exe"), b"BINARY").unwrap();
        std::fs::write(plugin_dir.join("runtime/sub/x"), b"data").unwrap();
        write_manifest(&plugin_dir, r#"[{"id":"node","path":"runtime"}]"#);
        std::fs::write(plugin_dir.join("old.txt"), b"old").unwrap();

        // 更新流程：移出 → 删除 → 复制"新包" → 移回
        let saved = stash_runtimes(&plugin_dir, &base, "p");
        assert_eq!(saved.len(), 1, "runtime 应被移出");
        std::fs::remove_dir_all(&plugin_dir).ok();
        assert!(!plugin_dir.join("runtime").exists(), "删除后 runtime 不在原位");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("plugin.json"), br#"{"pluginName":"p"}"#).unwrap();
        restore_runtimes(&plugin_dir, saved);

        // 运行时内容完好
        assert_eq!(std::fs::read(plugin_dir.join("runtime/node.exe")).unwrap(), b"BINARY");
        assert_eq!(std::fs::read(plugin_dir.join("runtime/sub/x")).unwrap(), b"data");
        // 旧包内容被正确清除（remove_dir_all 生效了，不是整体跳过）
        assert!(!plugin_dir.join("old.txt").exists());
        // 暂存区已清空
        let leftovers: Vec<_> = std::fs::read_dir(&base)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp_rt_"))
            .collect();
        assert!(leftovers.is_empty(), "暂存目录不应残留");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 新包自带同名目录 → 以新包为准（丢弃暂存，不覆盖回去）。
    #[test]
    fn runtimes_restore_prefers_new_package() {
        let base = rt_fixture("prefer");
        let plugin_dir = base.join("p");
        std::fs::create_dir_all(plugin_dir.join("runtime")).unwrap();
        std::fs::write(plugin_dir.join("runtime/node.exe"), b"OLD").unwrap();
        write_manifest(&plugin_dir, r#"[{"id":"node","path":"runtime"}]"#);

        let saved = stash_runtimes(&plugin_dir, &base, "p");
        std::fs::remove_dir_all(&plugin_dir).ok();
        // 新包自带 runtime/（内容不同）
        std::fs::create_dir_all(plugin_dir.join("runtime")).unwrap();
        std::fs::write(plugin_dir.join("runtime/node.exe"), b"NEW").unwrap();
        restore_runtimes(&plugin_dir, saved);

        assert_eq!(std::fs::read(plugin_dir.join("runtime/node.exe")).unwrap(), b"NEW");
        let _ = std::fs::remove_dir_all(&base);
    }

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

    /// AI 的 @ref chip 常给工作区相对路径（无盘符、无前导分隔符）。read_file /
    /// read_bytes / path_exists 都复用本函数解析——若不解析就直接读，会按进程 cwd
    /// 找文件而失败，表现为"点 chip 却在资源管理器打开"。此处锁定该场景的解析结果。
    #[test]
    fn explorer_path_handles_ai_ref_chip_paths() {
        // 用户实际遇到的形态
        assert_eq!(
            resolve_explorer_path(".scratch/memory-upgrade/SPEC.md", r"C:\Storage\claude-code-haha-dev"),
            r"C:\Storage\claude-code-haha-dev\.scratch\memory-upgrade\SPEC.md"
        );
        // 正斜杠 / 无前导 ./ 的形态
        assert_eq!(
            resolve_explorer_path("docs/adr/0001.md", r"C:\Storage\proj"),
            r"C:\Storage\proj\docs\adr\0001.md"
        );
        // Windows 绝对路径（盘符 / UNC）→ 原样返回，不被工作区前缀污染。
        // 注意 `/unix/abs/x.md` **不在**此列：`Path::is_absolute()` 在 Windows 上
        // 不认前导 `/`，会被当相对路径拼到工作区（与既有 explorer 行为一致）。
        for abs in [r"C:\abs\x.md", r"\\server\share\x.md"] {
            assert_eq!(resolve_explorer_path(abs, r"C:\ws"), abs, "应原样返回: {}", abs);
        }
        // 未绑定工作区（空 work_dir）→ 仍是相对路径（保持相对语义，读不到而已）。
        // 分隔符会被 PathBuf 归一成 `\`——Windows 上两者等价，不影响可用性。
        assert_eq!(resolve_explorer_path("a/b.md", ""), r"a\b.md");
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
        migrations::migrate_legacy_profiles();
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
async fn note_apply_tag_mapping(
    server_state: tauri::State<'_, Mutex<Option<server_client::ServerClient>>>,
    mappings: HashMap<String, String>,
) -> Result<Vec<notes::TagCount>, String> {
    if let Some(client) = server_client_or(&server_state, "").await {
        match client.note_apply_tag_mapping(mappings.clone()).await {
            Ok(v) => return Ok(v),
            Err(_) => reset_server(&server_state),
        }
    }
    notes::note_apply_tag_mapping(mappings)
}


#[cfg(test)]
mod uninstall_hook_tests {
    use super::pick_hook_interpreter;

    /// 解释器选择：`.js/.cjs/.mjs` → bun，`.py` → python，其它 → None（不猜）。
    ///
    /// 为什么用 bun/python 而不是 node：宿主安装包**自带**这两个
    /// （`bun.exe` + `python/python.exe`，且已由 prepend_tool_dirs 前置进 PATH），
    /// 而 node 要靠 **nodejs 插件**提供 —— hook 是基础能力，不该依赖另一个插件。
    #[test]
    fn picks_bun_for_js_and_python_for_py() {
        let dir = std::path::Path::new("C:/nonexistent-install-dir");
        for s in ["cleanup.cjs", "cleanup.js", "cleanup.mjs"] {
            let (exe, _) = pick_hook_interpreter(dir, s).unwrap_or_else(|| panic!("{s} 应可解析"));
            let name = exe.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
            assert!(name.starts_with("bun"), "{s} 应选 bun，实际 {name}");
        }
        for s in ["cleanup.py", "clean.py"] {
            let (exe, _) = pick_hook_interpreter(dir, s).unwrap_or_else(|| panic!("{s} 应可解析"));
            let name = exe.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
            assert!(name.starts_with("python"), "{s} 应选 python，实际 {name}");
        }
    }

    /// 大小写不敏感（用户可能写 `Cleanup.CJS`）
    #[test]
    fn extension_match_is_case_insensitive() {
        let dir = std::path::Path::new("C:/nonexistent");
        assert!(pick_hook_interpreter(dir, "Cleanup.CJS").is_some());
        assert!(pick_hook_interpreter(dir, "CLEANUP.PY").is_some());
    }

    /// 🔴 **未知扩展名必须返回 None**，绝不能猜着用某个解释器跑 ——
    /// 那等于让 manifest 决定"用什么程序执行什么文件"，是个提权面。
    #[test]
    fn unknown_extension_is_refused() {
        let dir = std::path::Path::new("C:/nonexistent");
        for s in ["cleanup.sh", "cleanup.bat", "cleanup.exe", "cleanup", "cleanup.txt", "cleanup.cmd"] {
            assert!(pick_hook_interpreter(dir, s).is_none(), "{s} 不该被接受");
        }
    }
}


#[cfg(test)]
mod skill_link_tests {
    use super::{create_dir_link, remove_dir_link};

    /// 🔴 **建链走的到底是哪条路** —— 手工验证时我用的是 PowerShell 的
    /// `New-Item -ItemType Junction`，**而代码里用的是 `cmd /c mklink /J`**
    /// —— 两条完全不同的实现。这个测试直接测**代码里那条**。
    #[test]
    fn skill_link_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("skilllink_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let target = tmp.join("plugin").join("skill");
        let link = tmp.join("skills").join("computer-use");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::fs::write(target.join("SKILL.md"), b"---
name: t
---
").unwrap();

        // ① 建链（代码里那条路：cmd /c mklink /J）
        create_dir_link(&link, &target).expect("create_dir_link 应成功");

        // ② 链接存在，且**通过它能读到文件**（这是 Node 侧 loader 的行为）
        let meta = link.symlink_metadata().expect("链接应存在");
        assert!(meta.file_type().is_symlink(), "必须是 reparse point（Node isSymbolicLink 依赖它）");
        assert!(link.join("SKILL.md").exists(), "通过链接应能读到 SKILL.md");

        // ③ 幂等：再建一次（先删后建）不应报错
        create_dir_link(&link, &target).expect("重复建链应成功（幂等）");
        assert!(link.join("SKILL.md").exists());

        // ④ 删链**不能误删目标**
        remove_dir_link(&link).expect("remove_dir_link 应成功");
        assert!(link.symlink_metadata().is_err(), "链接应已移除");
        assert!(target.join("SKILL.md").exists(), "🔴 目标被误删了！");

        // ⑤ 防御：对**真目录**调 remove_dir_link 应拒绝（不递归删用户数据）
        let real_dir = tmp.join("real-dir");
        std::fs::create_dir_all(&real_dir).unwrap();
        assert!(remove_dir_link(&real_dir).is_err(), "对真目录应拒绝删除");

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// 🔴 **回归测试（2026-09-18）**：source 用**正斜杠**时也必须能建链。
    ///
    /// 实测事故：前端拼路径用 `/`（`C:/Users/.../plugins/computer-use/skill`），
    /// 而 `mklink` 是 cmd 内置命令、**把 `/` 当参数开关** → 报
    /// `无效参数 - "Users"`（cmd 把 `/Users` 当成了开关）。
    ///
    /// 这个测试用**正斜杠 target** 建链 —— 若有人把 Rust 侧的斜杠转换去掉，
    /// 它会立刻变红。
    #[test]
    fn skill_link_accepts_forward_slash_source() {
        let tmp = std::env::temp_dir().join(format!("skilllink_fwd_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let target = tmp.join("com.claudecode.gui").join("plugins").join("computer-use").join("skill");
        let link = tmp.join(".claude").join("skills").join("computer-use");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::fs::write(target.join("SKILL.md"), b"x").unwrap();

        // 模拟前端传来的形态：**正斜杠**
        let target_fwd = std::path::PathBuf::from(target.to_string_lossy().replace('\\', "/"));
        assert!(target_fwd.to_string_lossy().contains('/'), "前提：路径确实是正斜杠");

        create_dir_link(&link, &target_fwd)
            .expect("🔴 正斜杠路径建链失败 —— mklink 需要反斜杠（见 create_dir_link 注释）");
        assert!(link.join("SKILL.md").exists(), "通过链接应能读到文件");

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// 路径含空格时仍能建链 —— `cmd /c` 的引号处理是著名坑点。
    /// 本机 `%APPDATA%` 无空格所以现网没暴露，但别的机器可能踩。
    #[test]
    fn skill_link_works_with_spaces_in_path() {
        let tmp = std::env::temp_dir().join(format!("skill link test {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let target = tmp.join("my plugin").join("skill dir");
        let link = tmp.join("skills").join("some skill");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::fs::write(target.join("SKILL.md"), b"x").unwrap();

        let r = create_dir_link(&link, &target);
        if let Err(e) = &r {
            panic!("含空格路径建链失败（cmd /c 引号问题？）: {e}");
        }
        assert!(link.join("SKILL.md").exists(), "含空格路径下应能通过链接读到文件");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
