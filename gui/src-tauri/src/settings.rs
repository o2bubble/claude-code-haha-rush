// ── Settings — one module owns the settings schema + persistence ──
// The `gui` section of the Claude settings JSON is the canonical schema;
// AppSettings (here) and the TS mirror (settingsStore.ts) serialize/deserialize
// it. Every write goes through read-modify-write that PRESERVES unknown keys,
// so a field the frontend knows but this struct doesn't is never stripped on
// round-trip (the quickPrompts-stripping bug class is structurally impossible).

use serde::{Deserialize, Serialize};

use crate::{dirs_next, user_home};

// ── Schema ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QuickPrompt {
    pub id: String,
    pub title: String,
    pub prompt: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionFolder {
    pub id: String,
    pub name: String,
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<String>,
}

/// 会话文件夹数据(工作区作用域): 嵌套树 folders(parent_id 实现) + sessionId->folderId 归属
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SessionFolderTree {
    pub folders: Vec<SessionFolder>,
    pub assignments: std::collections::HashMap<String, String>,
}

/// 自定义压缩提示词（前端 SettingsPanel「压缩」区 ↔ settings.json gui 键，
/// claude.exe 后端 compactConfig 读取）。字段缺失时 GUI 读回丢弃 → 设置面板
/// 勾选丢失（claude.exe 却仍生效）——AppSettings 必须声明它。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CompactPrompt {
    #[serde(default = "default_compact_mode")]
    pub mode: String,
    #[serde(default)]
    pub text: String,
}
fn default_compact_mode() -> String { "append".into() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    #[serde(rename = "workDir", default = "default_work_dir")]
    pub work_dir: String,
    #[serde(rename = "isFirstLaunch", default)]
    pub is_first_launch: bool,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(rename = "terminalMaxEntries", default = "default_terminal_max")]
    pub terminal_max_entries: u32,
    #[serde(rename = "permissionMode", default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(rename = "layoutTree", default)]
    pub layout_tree: Option<serde_json::Value>,
    #[serde(rename = "showHiddenFiles", default)]
    pub show_hidden_files: bool,
    #[serde(rename = "workspaces", default)]
    pub workspaces: Vec<String>,
    #[serde(rename = "recentWorkspaces", default)]
    pub recent_workspaces: Vec<String>,
    #[serde(rename = "autoEnterRecentWorkspace", default)]
    pub auto_enter_recent_workspace: Option<bool>,
    #[serde(rename = "saveLayoutToGlobal", default)]
    pub save_layout_to_global: Option<bool>,
    #[serde(rename = "editorFontSize", default)]
    pub editor_font_size: Option<u32>,
    #[serde(rename = "editorTabSize", default)]
    pub editor_tab_size: Option<u32>,
    #[serde(rename = "editorWordWrap", default)]
    pub editor_word_wrap: Option<bool>,
    #[serde(rename = "chatEnterBehavior", default)]
    pub chat_enter_behavior: Option<String>,
    #[serde(rename = "fileSortOrder", default)]
    pub file_sort_order: Option<String>,
    #[serde(rename = "terminalFontSize", default)]
    pub terminal_font_size: Option<u32>,
    #[serde(rename = "autoLoadLatestSession", default)]
    pub auto_load_latest_session: Option<bool>,
    #[serde(rename = "forceChineseThinking", default)]
    pub force_chinese_thinking: Option<bool>,
    #[serde(rename = "skillRegistryUrl", default = "default_skill_registry_url")]
    pub skill_registry_url: String,
    #[serde(rename = "_version", default = "default_version")]
    pub _version: String,
    #[serde(rename = "uiFontSize", default = "default_ui_font_size")]
    pub ui_font_size: f64,
    #[serde(rename = "windowWidth", default)]
    pub window_width: Option<f64>,
    #[serde(rename = "windowHeight", default)]
    pub window_height: Option<f64>,
    #[serde(rename = "windowX", default)]
    pub window_x: Option<f64>,
    #[serde(rename = "windowY", default)]
    pub window_y: Option<f64>,
    #[serde(rename = "windowMaximized", default)]
    pub window_maximized: bool,
    #[serde(rename = "updateServerUrl", default = "default_update_server_url")]
    pub update_server_url: String,
    #[serde(rename = "theme", default)]
    pub theme: Option<String>,
    #[serde(rename = "quickPrompts", default)]
    pub quick_prompts: Vec<QuickPrompt>,
    #[serde(rename = "favoriteSkills", default)]
    pub favorite_skills: Vec<String>,
    #[serde(rename = "favoriteSessionIds", default)]
    pub favorite_session_ids: Vec<String>,
    #[serde(rename = "msgQueuePosition", default)]
    pub msg_queue_position: Option<String>,
    #[serde(rename = "msgQueueMaxItems", default)]
    pub msg_queue_max_items: Option<u32>,
    #[serde(rename = "msgSelectionToolbar", default)]
    pub msg_selection_toolbar: Option<bool>,
    #[serde(rename = "sessionFolders", default)]
    pub session_folders: Option<bool>,
    #[serde(rename = "sessionFolderTree", default)]
    pub session_folder_tree: Option<SessionFolderTree>,
    #[serde(rename = "messageTimeline", default)]
    pub message_timeline: Option<bool>,
    #[serde(rename = "customCompactPrompt", default)]
    pub custom_compact_prompt: Option<CompactPrompt>,
    #[serde(rename = "compactExtractScript", default)]
    pub compact_extract_script: Option<String>,
}

pub fn default_work_dir() -> String {
    user_home().join("claude-code-workspace").to_string_lossy().to_string()
}
const DEFAULT_96_SERVER: &str = "http://192.168.186.96:8765";
fn default_language() -> String { "zh".into() }
fn default_terminal_max() -> u32 { 50 }
fn default_permission_mode() -> String { "default".into() }
fn default_skill_registry_url() -> String { DEFAULT_96_SERVER.into() }
fn default_update_server_url() -> String { DEFAULT_96_SERVER.into() }
fn default_version() -> String { "1.0.0-preview".into() }
fn default_ui_font_size() -> f64 { 100.0 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            work_dir: default_work_dir(),
            is_first_launch: true,
            language: "zh".into(),
            terminal_max_entries: 50,
            permission_mode: "default".into(),
            layout_tree: None,
            show_hidden_files: false,
            workspaces: vec![],
            recent_workspaces: vec![],
            auto_enter_recent_workspace: None,
            save_layout_to_global: None,
            editor_font_size: None,
            editor_tab_size: None,
            editor_word_wrap: None,
            chat_enter_behavior: None,
            file_sort_order: None,
            terminal_font_size: None,
            auto_load_latest_session: None,
            force_chinese_thinking: None,
            skill_registry_url: default_skill_registry_url(),
            _version: default_version(),
            ui_font_size: default_ui_font_size(),
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
            window_maximized: false,
            update_server_url: default_update_server_url(),
            theme: None,
            quick_prompts: vec![],
            favorite_skills: vec![],
            favorite_session_ids: vec![],
            msg_queue_position: None,
            msg_queue_max_items: None,
            msg_selection_toolbar: None,
            session_folders: None,
            session_folder_tree: None,
            message_timeline: None,
            custom_compact_prompt: None,
            compact_extract_script: None,
        }
    }
}

// ── Bound workspace (process-global) ──
// The workspace this GUI instance is currently bound to. A process-global so
// helper functions (profile lookup, MCP registration, …) that have no Tauri
// State access still resolve the correct per-workspace context.

static BOUND_WORK_DIR: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();

pub fn bound_work_dir() -> String {
    match BOUND_WORK_DIR.get() {
        Some(m) => m.lock().map(|g| g.clone()).unwrap_or_default(),
        None => String::new(),
    }
}

pub fn set_bound_work_dir(path: &str) {
    BOUND_WORK_DIR
        .get_or_init(|| std::sync::Mutex::new(String::new()))
        .lock()
        .map(|mut g| *g = path.to_string())
        .ok();
}

// ── Paths ──
// Global settings live in ~/.claude/settings.json under a `gui` top-level key,
// matching Claude Code's own user-level config file. Workspace overrides live in
// <workdir>/.claude/settings.local.json under the same `gui` key. The engine
// tolerates the unknown `gui` key (SettingsSchema outer `.passthrough()`), and
// we read-modify-write so engine keys (env/hooks/mcpServers/…) are preserved.

pub fn legacy_settings_path() -> std::path::PathBuf {
    let dir = dirs_next().unwrap_or_else(|| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

pub fn global_settings_path() -> std::path::PathBuf {
    user_home().join(".claude").join("settings.json")
}

pub fn workspace_settings_path(work_dir: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(work_dir).join(".claude").join("settings.local.json")
}

// ── 单文件→双文件回退迁移 ──

/// 把 user-scope MCP（`~/.claude/settings.json` 根 `mcpServers`，单文件模式时代引擎把全局
/// 配置写进了 settings.json）迁移到 `~/.claude.json` 根 `mcpServers`。
/// 回退 `getGlobalClaudeFile` 到双文件后，引擎只从 `~/.claude.json` 读 user-scope MCP；
/// 不迁移则 codebase-memory/playwright 等全部失效。幂等：迁移完成后 settings.json 不再有
/// 根 mcpServers，下次启动直接 no-op。同名服务器不覆盖（已有的优先）。
pub fn migrate_single_file_mcp_to_claude_json() {
    let settings_path = global_settings_path();
    let claude_json_path = user_home().join(".claude.json");
    migrate_single_file_mcp_between(&settings_path, &claude_json_path);
}

/// 路径可注入的迁移核心（单测用临时文件，绝不碰真实 ~/.claude）。
fn migrate_single_file_mcp_between(
    settings_path: &std::path::Path,
    claude_json_path: &std::path::Path,
) {
    let mut settings: serde_json::Value = match std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(v) => v,
        None => return, // 没有 settings.json → 双文件已就绪
    };

    let mcp = settings
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .cloned();
    let Some(mcp) = mcp else {
        return; // settings.json 没有根 mcpServers → 无需迁移
    };

    if !mcp.is_empty() {
        // 合并进 ~/.claude.json 根 mcpServers（同名不覆盖，已有优先）。
        // mcpServers 缺失 → 创建对象；非对象残留（如数组）→ 重建对象，防迁移丢失。
        let mut global: serde_json::Value = std::fs::read_to_string(claude_json_path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let Some(global_obj) = global.as_object_mut() else {
            return;
        };
        let gm = match global_obj.get_mut("mcpServers") {
            Some(v) if v.is_object() => v.as_object_mut().unwrap(),
            _ => {
                global_obj.insert("mcpServers".into(), serde_json::json!({}));
                global_obj.get_mut("mcpServers").unwrap().as_object_mut().unwrap()
            }
        };
        let mut moved = 0usize;
        for (name, cfg) in &mcp {
            if !gm.contains_key(name) {
                gm.insert(name.clone(), cfg.clone());
                moved += 1;
            }
        }
        if moved > 0 {
            if std::fs::write(claude_json_path, serde_json::to_string_pretty(&global).unwrap_or_default()).is_ok() {
                log::info!("Migrated {} user-scope MCP server(s): settings.json → ~/.claude.json", moved);
            }
        }
    }

    // 从 settings.json 移除根 mcpServers（保留 gui 键与其余引擎键）
    if let Some(obj) = settings.as_object_mut() {
        obj.remove("mcpServers");
    }
    let _ = std::fs::write(settings_path, serde_json::to_string_pretty(&settings).unwrap_or_default());
}

// ── office MCP 自动注册 ──

/// GUI 启动时把 office MCP server 注册到 `~/.claude.json` 根 `mcpServers`（user scope，
/// 所有工作区可用），让 claude.exe 以 stdio MCP 方式加载 office 工具。后端逻辑平台
/// 自适应（Windows→win32com，macOS→osascript）。自包含 python 与 server 路径每次启动
/// 重写（同名覆盖，路径随安装目录变化），幂等。缺文件时跳过，不误写。
pub fn register_office_mcp() {
    let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    // 自包含 python：Windows 在安装目录 python/；macOS 预留 bundle 布局（Phase 3 校准）。
    let python_exe = if cfg!(target_os = "windows") {
        exe_dir.join("python").join("python.exe")
    } else {
        exe_dir.join("python").join("bin").join("python3")
    };
    let server = exe_dir
        .join("extensions")
        .join("office")
        .join("com")
        .join("office_mcp_server.py");
    register_office_mcp_at(&user_home().join(".claude.json"), &python_exe, &server);
}

/// 可注入核心（单测用临时路径，绝不碰真实 ~/.claude）。
fn register_office_mcp_at(
    claude_json_path: &std::path::Path,
    python_exe: &std::path::Path,
    server: &std::path::Path,
) {
    if !python_exe.exists() || !server.exists() {
        log::debug!(
            "office MCP: skip registration (python={} exists={}, server={} exists={})",
            python_exe.display(),
            python_exe.exists(),
            server.display(),
            server.exists()
        );
        return;
    }

    let mut global: serde_json::Value = std::fs::read_to_string(claude_json_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(global_obj) = global.as_object_mut() else {
        return;
    };
    let servers = match global_obj.get_mut("mcpServers") {
        Some(v) if v.is_object() => v.as_object_mut().unwrap(),
        _ => {
            global_obj.insert("mcpServers".into(), serde_json::json!({}));
            global_obj
                .get_mut("mcpServers")
                .unwrap()
                .as_object_mut()
                .unwrap()
        }
    };
    servers.insert(
        "office".to_string(),
        serde_json::json!({
            "command": python_exe.to_string_lossy(),
            "args": [server.to_string_lossy()],
        }),
    );
    if std::fs::write(
        claude_json_path,
        serde_json::to_string_pretty(&global).unwrap_or_default(),
    )
    .is_ok()
    {
        log::info!("Registered office MCP server in {}", claude_json_path.display());
    }
}

// ── office-bridge 指南同步 ──

/// GUI 启动时把 office 操作指南（office-bridge.md）同步到 ~/.claude/ 并确保
/// `@office-bridge.md` 注入 CLAUDE.md。与 office MCP 注册同一时机——安装器只管
/// 装文件，用户配置（AI 操作指南）由运行时维护：更新版本免重装、mac/win 统一、
/// 每次启动幂等（内容相同不写盘、@ 已存在不重复注入）。
pub fn sync_office_guide() {
    let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    let src = exe_dir
        .join("extensions")
        .join("office")
        .join("office-bridge.md");
    let claude_dir = user_home().join(".claude");
    sync_office_guide_at(&claude_dir, &src);
}

/// 可注入核心（单测用临时目录，绝不碰真实 ~/.claude）。
fn sync_office_guide_at(claude_dir: &std::path::Path, src: &std::path::Path) {
    if !src.exists() {
        log::debug!("office guide: skip sync (source missing: {})", src.display());
        return;
    }
    let _ = std::fs::create_dir_all(claude_dir);

    // 内容不同才写，避免每次启动磁盘写。
    let dst = claude_dir.join("office-bridge.md");
    let needs_write = match std::fs::read(&dst) {
        Ok(existing) => std::fs::read(src).map(|cur| existing != cur).unwrap_or(true),
        Err(_) => true,
    };
    if needs_write {
        if let Ok(content) = std::fs::read(src) {
            if std::fs::write(&dst, content).is_ok() {
                log::info!("Synced office guide → {}", dst.display());
            }
        }
    }

    // 注入 @office-bridge.md 到 CLAUDE.md（幂等：已存在则跳过）。
    let claude_md = claude_dir.join("CLAUDE.md");
    let mut content = std::fs::read_to_string(&claude_md).unwrap_or_default();
    if content.contains("@office-bridge.md") {
        return;
    }
    if content.is_empty() {
        content = "# Claude Code Global Instructions\n\n@office-bridge.md\n".to_string();
    } else {
        content = content.trim_end().to_string() + "\n\n@office-bridge.md\n";
    }
    if std::fs::write(&claude_md, content).is_ok() {
        log::info!("Injected @office-bridge.md into {}", claude_md.display());
    }
}

// ── Low-level gui-section IO ──

/// Read the `gui` section (object) from a Claude settings file, if present.
pub fn read_gui_section(path: &std::path::Path) -> Option<serde_json::Value> {
    let content = std::fs::read_to_string(path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&content).ok()?;
    root.get("gui").cloned()
}

/// Read-modify-write the `gui` section into a Claude settings file, preserving
/// every other top-level key (env / hooks / mcpServers / permissions / …).
pub fn write_gui_section(path: &std::path::Path, gui: &serde_json::Value) -> Result<(), String> {
    let mut root: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    if let Some(obj) = root.as_object_mut() {
        obj.insert("gui".to_string(), gui.clone());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(path, &json).map_err(|e| e.to_string())
}

pub fn app_settings_to_gui(s: &AppSettings) -> serde_json::Value {
    serde_json::to_value(s).unwrap_or_else(|_| serde_json::json!({}))
}

pub fn gui_to_app_settings(gui: &serde_json::Value) -> AppSettings {
    serde_json::from_value(gui.clone()).unwrap_or_default()
}

// ── Load ──

/// Load global settings from ~/.claude/settings.json → `gui` key.
/// Migrates the legacy %APPDATA%/claude-code-gui/settings.json on first run.
pub fn load_global_settings() -> AppSettings {
    let mut s = match read_gui_section(&global_settings_path()) {
        Some(gui) => gui_to_app_settings(&gui),
        None => AppSettings::default(),
    };

    // Legacy migration: %APPDATA%/claude-code-gui/settings.json → ~/.claude gui.
    let legacy = legacy_settings_path();
    if legacy.exists() {
        if let Ok(content) = std::fs::read_to_string(&legacy) {
            if let Ok(legacy_s) = serde_json::from_str::<AppSettings>(&content) {
                if read_gui_section(&global_settings_path()).is_none() {
                    // First migration — adopt legacy wholesale.
                    s = legacy_s;
                    let _ = save_global_settings(&s);
                    log::info!("Migrated legacy settings to ~/.claude/settings.json gui");
                }
                let _ = std::fs::remove_file(&legacy);
            }
        }
    }

    // Migrate old default workspace from AppData\Roaming to user home
    let old_root = std::env::var("APPDATA").ok().map(std::path::PathBuf::from).unwrap_or_default();
    let old_ws = old_root.join("claude-code-workspace");
    let new_ws = user_home().join("claude-code-workspace");

    if s.work_dir == old_ws.to_string_lossy() && old_ws.exists() && !new_ws.exists() {
        log::info!("Migrating workspace from {} to {}", old_ws.display(), new_ws.display());
        if std::fs::rename(&old_ws, &new_ws).is_ok() {
            s.work_dir = new_ws.to_string_lossy().to_string();
            if let Some(pos) = s.workspaces.iter().position(|w| w == &old_ws.to_string_lossy()) {
                s.workspaces[pos] = s.work_dir.clone();
            }
            save_global_settings(&s).ok();
            log::info!("Workspace migrated successfully");
        } else {
            log::warn!("Failed to migrate workspace, keeping old path");
        }
    }

    // Migrate the legacy default server URL → the current 96 default. This only
    // fires on `localhost` (the true pre-1.0 default) — the cloud address
    // (123.56.66.84) is a valid user choice in the settings panel / wizard and
    // must NOT be rewritten back to the intranet server on every load.
    if should_migrate_server_url(&s.skill_registry_url) {
        log::info!("Migrating skillRegistryUrl from {} to 96 server", s.skill_registry_url);
        s.skill_registry_url = default_skill_registry_url();
        s.update_server_url = default_update_server_url();
        save_global_settings(&s).ok();
    }

    // Migrate per-workspace quickPrompts into the global baseline. quickPrompts
    // are meant to be shared across workspaces, but older versions saved them
    // workspace-scoped — so each workspace's copy must be folded into global
    // once (dedup by id), then removed from the workspace file. Without this,
    // users switching workspaces after upgrading would see their prompts vanish.
    migrate_quick_prompts_to_global(&mut s);

    s
}

/// Fold each known workspace's `quickPrompts` into the global baseline (dedup by
/// id), then strip `quickPrompts` from the workspace settings file. Pure helper
/// extracted for testability — only touches `s` and the filesystem, no logic
/// gate on version (idempotent: already-merged ids are skipped).
pub fn migrate_quick_prompts_to_global(s: &mut AppSettings) {
    let workspaces = s.workspaces.clone();
    if workspaces.is_empty() {
        return;
    }
    let mut merged: Vec<QuickPrompt> = s.quick_prompts.clone();
    let mut changed = false;

    for ws in &workspaces {
        let ws_path = workspace_settings_path(ws);
        let Some(gui) = read_gui_section(&ws_path) else { continue };
        let Some(mut gui_obj) = gui.as_object().cloned() else { continue };
        let Some(qp) = gui_obj.remove("quickPrompts") else { continue };
        let Some(arr) = qp.as_array() else { continue };

        let extras: Vec<QuickPrompt> = arr
            .iter()
            .filter_map(|item| serde_json::from_value::<QuickPrompt>(item.clone()).ok())
            .collect();
        let before = merged.len();
        merged = merge_quick_prompts(merged, extras);
        if merged.len() != before {
            changed = true;
        }
        // Persist the workspace file with quickPrompts removed (keep other gui keys).
        let _ = write_gui_section(&ws_path, &serde_json::Value::Object(gui_obj));
    }

    if changed {
        s.quick_prompts = merged;
        let _ = save_global_settings(s);
        log::info!("Migrated workspace quickPrompts into global baseline");
    }
}

/// Merge `extra` prompts into `base`, dedup by id (first occurrence wins).
/// Pure — extracted for testability; the idempotency guarantee of the migration
/// (already-merged ids are skipped on later runs) comes from this dedup.
pub fn merge_quick_prompts(base: Vec<QuickPrompt>, extra: Vec<QuickPrompt>) -> Vec<QuickPrompt> {
    let mut seen: std::collections::HashSet<String> = base.iter().map(|p| p.id.clone()).collect();
    let mut merged = base;
    for p in extra {
        if seen.insert(p.id.clone()) {
            merged.push(p);
        }
    }
    merged
}

/// Decide whether a legacy default server URL needs migrating. Pure — only
/// `localhost` counts (the pre-1.0 default); the cloud/intranet addresses are
/// valid user choices and are never rewritten.
pub fn should_migrate_server_url(skill_registry_url: &str) -> bool {
    skill_registry_url.contains("localhost")
}

pub fn load_workspace_settings(work_dir: &str) -> AppSettings {
    match read_gui_section(&workspace_settings_path(work_dir)) {
        Some(gui) => gui_to_app_settings(&gui),
        None => AppSettings::default(),
    }
}

/// Merge workspace-scoped fields into a global-loaded AppSettings.
fn merge_workspace_overrides(base: &mut AppSettings, o: &AppSettings) {
    if !o.workspaces.is_empty() { base.workspaces = o.workspaces.clone(); }
    if !o.recent_workspaces.is_empty() { base.recent_workspaces = o.recent_workspaces.clone(); }
    if o.layout_tree.is_some() { base.layout_tree = o.layout_tree.clone(); }
    if o.theme.is_some() { base.theme = o.theme.clone(); }
    if o.editor_font_size.is_some() { base.editor_font_size = o.editor_font_size; }
    if o.editor_tab_size.is_some() { base.editor_tab_size = o.editor_tab_size; }
    if o.editor_word_wrap.is_some() { base.editor_word_wrap = o.editor_word_wrap; }
    if o.chat_enter_behavior.is_some() { base.chat_enter_behavior = o.chat_enter_behavior.clone(); }
    if o.file_sort_order.is_some() { base.file_sort_order = o.file_sort_order.clone(); }
    if o.terminal_font_size.is_some() { base.terminal_font_size = o.terminal_font_size; }
    if o.auto_load_latest_session.is_some() { base.auto_load_latest_session = o.auto_load_latest_session; }
    if o.force_chinese_thinking.is_some() { base.force_chinese_thinking = o.force_chinese_thinking; }
    if o.save_layout_to_global.is_some() { base.save_layout_to_global = o.save_layout_to_global; }
    if o.show_hidden_files { base.show_hidden_files = true; }
    if !o.favorite_session_ids.is_empty() { base.favorite_session_ids = o.favorite_session_ids.clone(); }
    if !o.quick_prompts.is_empty() { base.quick_prompts = o.quick_prompts.clone(); }
    if !o.favorite_skills.is_empty() { base.favorite_skills = o.favorite_skills.clone(); }
    if o.msg_queue_position.is_some() { base.msg_queue_position = o.msg_queue_position.clone(); }
    if o.msg_queue_max_items.is_some() { base.msg_queue_max_items = o.msg_queue_max_items; }
    if o.msg_selection_toolbar.is_some() { base.msg_selection_toolbar = o.msg_selection_toolbar; }
    if o.session_folders.is_some() { base.session_folders = o.session_folders; }
    if o.session_folder_tree.is_some() { base.session_folder_tree = o.session_folder_tree.clone(); }
    if o.message_timeline.is_some() { base.message_timeline = o.message_timeline; }
    if o.window_width.is_some() { base.window_width = o.window_width; }
    if o.window_height.is_some() { base.window_height = o.window_height; }
    if o.window_x.is_some() { base.window_x = o.window_x; }
    if o.window_y.is_some() { base.window_y = o.window_y; }
    if o.window_maximized { base.window_maximized = true; }
}

/// Effective settings for an instance bound to `work_dir`: global gui merged
/// with that workspace's gui (workspace overrides).
pub fn reload_effective_settings(work_dir: &str) -> AppSettings {
    let mut eff = load_global_settings();
    if !work_dir.is_empty() {
        // Every bound workspace — including the default one (user_home/
        // claude-code-workspace) — merges its own overrides: it persists and
        // restores its own layout like any other. Old code skipped the merge
        // for the default workspace, so a layout saved there was dropped and
        // "adjust layout, restart, it reverts". work_dir must ALWAYS report
        // the bound workspace: when the default workspace is bound, eff.work_dir
        // must be the bound path (toolbar chip, file-tree root, CLI cwd).
        let ws = load_workspace_settings(work_dir);
        merge_workspace_overrides(&mut eff, &ws);
        eff.work_dir = work_dir.to_string();
    }
    eff
}

/// Effective settings for the CURRENT instance (bound work dir aware). Kept as
/// the single entry point for background/spawn code that has no State access.
/// Before a workspace is bound this returns the PURE global baseline — the old
/// behavior fell back to the global workDir's workspace merge, which leaked one
/// workspace's overrides into every unbound instance at startup.
pub fn load_settings() -> AppSettings {
    let global = load_global_settings();
    let bound = bound_work_dir();
    if bound.is_empty() {
        return global;
    }
    reload_effective_settings(&bound)
}

// ── Save ──

/// Merge an AppSettings onto a `gui` object, preserving unknown keys.
/// This is the structural fix for the quickPrompts-stripping bug class: a key
/// the frontend wrote but this struct doesn't model survives every save.
pub fn merge_settings_into_gui(gui: &mut serde_json::Value, s: &AppSettings) {
    if !gui.is_object() {
        *gui = serde_json::json!({});
    }
    if let (Some(obj), Some(new_obj)) = (gui.as_object_mut(), app_settings_to_gui(s).as_object()) {
        for (k, v) in new_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
}

/// Save struct fields ONTO the existing `gui` section, preserving unknown keys.
pub fn save_global_settings(s: &AppSettings) -> Result<(), String> {
    let path = global_settings_path();
    let mut gui = read_gui_section(&path).unwrap_or_else(|| serde_json::json!({}));
    merge_settings_into_gui(&mut gui, s);
    write_gui_section(&path, &gui)
}

/// Merge a partial settings patch into the `gui` section of a settings file
/// (read-modify-write, preserving other gui fields and other top-level keys).
pub fn merge_gui_patch(path: &std::path::Path, patch: &serde_json::Value) -> Result<(), String> {
    let mut gui = read_gui_section(path).unwrap_or_else(|| serde_json::json!({}));
    if !gui.is_object() { gui = serde_json::json!({}); }
    if let (Some(g), Some(p)) = (gui.as_object_mut(), patch.as_object()) {
        for (k, v) in p { g.insert(k.clone(), v.clone()); }
    }
    write_gui_section(path, &gui)
}

/// Decide where a settings patch should land. `None` = drop the write.
/// - scope "workspace": the bound workspace's own settings.local.json. An
///   UNBOUND write is dropped (must never pollute the global `gui` section
///   with a startup default layout). The default workspace (user_home/
///   claude-code-workspace) is a normal workspace — it persists its own layout
///   like any other. Old code skipped it, so a layout adjusted there was
///   silently dropped and reverted on restart.
/// - otherwise (global): the global baseline ~/.claude/settings.json.
pub fn save_target_path(bound_wd: &str, scope: Option<&str>) -> Option<std::path::PathBuf> {
    match scope {
        Some("workspace") if !bound_wd.is_empty() => Some(workspace_settings_path(bound_wd)),
        Some("workspace") => None,
        _ => Some(global_settings_path()),
    }
}

/// Typed entry for `save_app_settings`: writes the patch to global or the
/// bound workspace's local settings (scope-aware), preserving unknown keys.
/// A workspace-scoped write while NO workspace is bound must NOT fall through
/// to the global file — the startup default layout would pollute the global
/// `gui` section and be restored by every instance. Silently skip instead.
pub fn save_effective_patch(bound_wd: &str, patch: &serde_json::Value, scope: Option<&str>) -> Result<(), String> {
    let Some(path) = save_target_path(bound_wd, scope) else {
        log::warn!("save_effective_patch: workspace scope but not bound; skipping");
        return Ok(());
    };
    merge_gui_patch(&path, patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pure test — never touches the real ~/.claude/settings.json.
    #[test]
    fn merge_settings_preserves_unknown_keys() {
        let mut gui = serde_json::json!({
            "workDir": "C:/ws",
            "someFrontendOnlyKey": { "nested": true }
        });
        let mut s = AppSettings::default();
        s.work_dir = "C:/ws".into();
        s.language = "en".into();
        merge_settings_into_gui(&mut gui, &s);

        assert_eq!(gui["workDir"], "C:/ws");
        assert_eq!(gui["language"], "en");
        assert!(gui["someFrontendOnlyKey"]["nested"].as_bool().unwrap_or(false));
    }

    /// Pure test — workspace override merging.
    #[test]
    fn merge_workspace_overrides_wins_over_global() {
        let mut base = AppSettings::default();
        base.language = "en".into();
        base.theme = None;
        let mut ws = AppSettings::default();
        ws.theme = Some("dark".into());
        merge_workspace_overrides(&mut base, &ws);

        assert_eq!(base.language, "en");
        assert_eq!(base.theme.as_deref(), Some("dark"));
    }

    /// Round-trip: a struct value serializes to gui and back without loss.
    #[test]
    fn app_settings_round_trips() {
        let mut s = AppSettings::default();
        s.quick_prompts = vec![QuickPrompt { id: "q1".into(), title: "T".into(), prompt: "P".into() }];
        s.favorite_skills = vec!["skill-a".into()];
        s.favorite_session_ids = vec!["agent-s1".into()];
        s.save_layout_to_global = Some(true);
        let gui = app_settings_to_gui(&s);
        let back = gui_to_app_settings(&gui);
        assert_eq!(back.quick_prompts.len(), 1);
        assert_eq!(back.favorite_skills, vec!["skill-a".to_string()]);
        assert_eq!(back.favorite_session_ids, vec!["agent-s1".to_string()]);
        assert_eq!(back.save_layout_to_global, Some(true));
    }

    /// autoEnterRecentWorkspace round-trips and survives an absent recentWorkspaces.
    #[test]
    fn auto_enter_recent_workspace_round_trips() {
        let mut s = AppSettings::default();
        s.auto_enter_recent_workspace = Some(true);
        s.recent_workspaces = vec!["C:/ws-a".into(), "C:/ws-b".into()];
        let gui = app_settings_to_gui(&s);
        assert_eq!(gui["autoEnterRecentWorkspace"], true);
        let back = gui_to_app_settings(&gui);
        assert_eq!(back.auto_enter_recent_workspace, Some(true));
        assert_eq!(back.recent_workspaces, vec!["C:/ws-a".to_string(), "C:/ws-b".to_string()]);
    }

    /// Regression: the cloud/intranet server URLs are valid user choices and must
    /// never be migrated back to the intranet 96 default (saving them used to get
    /// reverted on every load). Only `localhost` is the legacy default.
    #[test]
    fn server_url_migration_only_for_localhost() {
        assert!(should_migrate_server_url("http://localhost:8765"));
        assert!(!should_migrate_server_url("http://123.56.66.84:8765"));
        assert!(!should_migrate_server_url("http://192.168.186.96:8765"));
        assert!(!should_migrate_server_url("http://example.com:8765"));
    }

    /// Regression: binding the DEFAULT workspace (user_home/claude-code-workspace)
    /// must still report it as work_dir — the old guard skipped setting it, so the
    /// toolbar/file-tree showed the global workDir for the default workspace.
    #[test]
    fn reload_effective_settings_reports_bound_work_dir_always() {
        let default = default_work_dir();
        let s = reload_effective_settings(&default);
        assert_eq!(s.work_dir, default, "binding the default workspace must report it");
        let s2 = reload_effective_settings("C:/Some/NonDefault");
        assert_eq!(s2.work_dir, "C:/Some/NonDefault");
    }

    /// Workspace settings files are partial (only workspace-scoped fields) and do
    /// NOT contain `isFirstLaunch` — the parse must not fail or layoutTree is lost.
    #[test]
    fn workspace_partial_gui_parses_without_is_first_launch() {
        let gui = serde_json::json!({
            "layoutTree": { "tree": {}, "floatingPanels": [], "tauriWindows": [] },
            "windowWidth": 1920.0,
            "windowHeight": 1009.0,
            "windowX": null,
            "windowY": null,
        });
        let a = gui_to_app_settings(&gui);
        assert!(a.layout_tree.is_some(), "workspace partial gui must keep layoutTree");
        assert!(!a.is_first_launch);
    }

    /// Regression: the DEFAULT workspace (user_home/claude-code-workspace) must
    /// persist its own layout like any other workspace. Old code skipped it on
    /// BOTH sides — save_effective_patch dropped the workspace-scoped write and
    /// reload_effective_settings never merged its overrides — so "adjust the
    /// layout in the default workspace, restart, and it reverts".
    #[test]
    fn default_workspace_persists_its_own_layout() {
        let default = default_work_dir();
        assert_eq!(
            save_target_path(&default, Some("workspace")),
            Some(workspace_settings_path(&default)),
            "workspace-scoped save while bound to the default workspace must land in its own settings.local.json"
        );
        // Unbound workspace-scoped writes are still dropped (must not pollute global).
        assert_eq!(save_target_path("", Some("workspace")), None);
        // Global scope still targets the global baseline.
        assert_eq!(save_target_path(&default, Some("global")), Some(global_settings_path()));
        // Default (None) scope → global baseline.
        assert_eq!(save_target_path(&default, None), Some(global_settings_path()));
    }

    /// Regression: startup layout-clobber. `save_app_settings` used `state.work_dir`
    /// as the "bound workspace", but at startup the state holds the GLOBAL workDir
    /// (load_settings() returns pure global before a real bind). A workspace-scoped
    /// save then landed in the GLOBAL workDir's workspace file, overwriting its
    /// saved layout with the startup default on every launch. The caller must derive
    /// the target from the TRUE process binding (`bound_work_dir()`), which is empty
    /// until bind_workspace — an unbound startup write is dropped.
    #[test]
    fn unbound_startup_must_not_save_into_global_workdir_workspace() {
        // State.work_dir at startup = the global workDir (non-empty, looks bound).
        let startup_state_workdir = load_global_settings().work_dir;
        assert!(!startup_state_workdir.is_empty());
        // A naive caller passing state.work_dir would clobber THIS file:
        assert_eq!(
            save_target_path(&startup_state_workdir, Some("workspace")),
            Some(workspace_settings_path(&startup_state_workdir)),
            "state.work_dir is a valid-looking path — the old caller wrote the startup default layout here"
        );
        // The correct caller passes the true binding, empty until a real bind → dropped.
        assert_eq!(save_target_path("", Some("workspace")), None);
    }

    /// Regression: QuickPromptPanel/SkillsPanel persist quickPrompts/favoriteSkills
    /// with the default WORKSPACE scope (saveSettings → <bound>/.claude/settings.local.json),
    /// but merge_workspace_overrides never copied them back over the global baseline —
    /// a newly-created quick prompt was written to disk yet invisible after restart.
    #[test]
    fn workspace_quick_prompts_and_favorite_skills_override_global() {
        let mut base = AppSettings::default();
        base.quick_prompts = vec![QuickPrompt { id: "global-1".into(), title: "G".into(), prompt: "Gp".into() }];
        base.favorite_skills = vec!["global-skill".into()];
        let mut ws = AppSettings::default();
        ws.quick_prompts = vec![QuickPrompt { id: "ws-1".into(), title: "W".into(), prompt: "Wp".into() }];
        ws.favorite_skills = vec!["ws-skill".into()];
        merge_workspace_overrides(&mut base, &ws);
        assert_eq!(base.quick_prompts.len(), 1, "workspace quickPrompts must replace global");
        assert_eq!(base.quick_prompts[0].id, "ws-1");
        assert_eq!(base.favorite_skills, vec!["ws-skill".to_string()], "workspace favoriteSkills must replace global");
    }

    /// SettingsPanel persists msgQueuePosition/msgQueueMaxItems with the default
    /// WORKSPACE scope; without merging them back, the queue layout/cap choices
    /// would silently revert on restart.
    #[test]
    fn workspace_msg_queue_settings_override_global() {
        let mut base = AppSettings::default();
        base.msg_queue_position = Some("top".into());
        base.msg_queue_max_items = Some(20);
        let mut ws = AppSettings::default();
        ws.msg_queue_position = Some("right".into());
        ws.msg_queue_max_items = Some(5);
        merge_workspace_overrides(&mut base, &ws);
        assert_eq!(base.msg_queue_position.as_deref(), Some("right"), "workspace msgQueuePosition must replace global");
        assert_eq!(base.msg_queue_max_items, Some(5), "workspace msgQueueMaxItems must replace global");
    }

    /// The selection-toolbar toggle is persisted as a regular AppSettings field;
    /// a workspace override must win over the global baseline on merge.
    #[test]
    fn workspace_msg_selection_toolbar_override_global() {
        let mut base = AppSettings::default();
        base.msg_selection_toolbar = Some(true);
        let mut ws = AppSettings::default();
        ws.msg_selection_toolbar = Some(false);
        merge_workspace_overrides(&mut base, &ws);
        assert_eq!(base.msg_selection_toolbar, Some(false), "workspace msgSelectionToolbar must replace global");
    }

    /// 会话文件夹开关与数据是工作区作用域字段; 工作区覆盖必须赢过全局基线。
    #[test]
    fn workspace_session_folders_override_global() {
        let mut base = AppSettings::default();
        base.session_folders = Some(false);
        let mut ws = AppSettings::default();
        ws.session_folders = Some(true);
        ws.session_folder_tree = Some(SessionFolderTree {
            folders: vec![SessionFolder { id: "f1".into(), name: "项目A".into(), parent_id: None }],
            assignments: [("s1".to_string(), "f1".to_string())].into_iter().collect(),
        });
        merge_workspace_overrides(&mut base, &ws);
        assert_eq!(base.session_folders, Some(true), "workspace sessionFolders must replace global");
        let tree = base.session_folder_tree.expect("workspace sessionFolderTree must merge");
        assert_eq!(tree.folders.len(), 1);
        assert_eq!(tree.assignments.get("s1").map(String::as_str), Some("f1"));
    }

    /// quickPrompts 从工作区迁移到全局：按 id 去重合并，先到先得（幂等）。
    #[test]
    fn merge_quick_prompts_dedups_by_id_and_keeps_first() {
        let base = vec![
            QuickPrompt { id: "q1".into(), title: "A".into(), prompt: "a".into() },
            QuickPrompt { id: "q2".into(), title: "B".into(), prompt: "b".into() },
        ];
        let extra = vec![
            QuickPrompt { id: "q1".into(), title: "A2".into(), prompt: "a2".into() }, // dup → skip
            QuickPrompt { id: "q3".into(), title: "C".into(), prompt: "c".into() },  // new → add
        ];
        let merged = merge_quick_prompts(base, extra);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].id, "q1");
        assert_eq!(merged[0].prompt, "a", "first occurrence wins");
        assert_eq!(merged[2].id, "q3");
    }

    /// 空 extra / 全重复 extra：保持 base 不变（迁移幂等）。
    #[test]
    fn merge_quick_prompts_idempotent() {
        let base = vec![QuickPrompt { id: "q1".into(), title: "A".into(), prompt: "a".into() }];
        assert_eq!(merge_quick_prompts(base.clone(), vec![]).len(), 1);
        let again = vec![QuickPrompt { id: "q1".into(), title: "A".into(), prompt: "a".into() }];
        assert_eq!(merge_quick_prompts(base, again).len(), 1, "rerun with same ids stays stable");
    }

    // ── 单文件→双文件 MCP 迁移（临时文件，绝不碰真实 ~/.claude）──

    fn mcp_mig_fixture(tag: &str, settings_json: &str, global_json: Option<&str>) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("mcp_mig_{}_{}", std::process::id(), tag));
        let _ = std::fs::create_dir_all(&dir);
        let settings = dir.join("settings.json");
        let claude_json = dir.join(".claude.json");
        let _ = std::fs::write(&settings, settings_json);
        if let Some(g) = global_json {
            let _ = std::fs::write(&claude_json, g);
        }
        (settings, claude_json)
    }

    fn read_json(p: &std::path::Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    // ── office MCP 自动注册（临时文件，绝不碰真实 ~/.claude）──

    fn office_fixture(tag: &str, global_json: Option<&str>) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("office_mcp_{}_{}", std::process::id(), tag));
        let _ = std::fs::create_dir_all(&dir);
        let py = dir.join("python.exe");
        let server = dir.join("office_mcp_server.py");
        let _ = std::fs::write(&py, "");
        let _ = std::fs::write(&server, "");
        let claude_json = dir.join(".claude.json");
        if let Some(g) = global_json {
            let _ = std::fs::write(&claude_json, g);
        }
        (claude_json, py, server)
    }

    /// 注册写入 mcpServers.office（user scope），保留其余键/服务器。
    #[test]
    fn office_mcp_registers_user_scope() {
        let (g, py, server) =
            office_fixture("reg", Some(r#"{"numStartups":3,"mcpServers":{"memory":{"command":"mem"}}}"#));
        register_office_mcp_at(&g, &py, &server);

        let global = read_json(&g);
        assert_eq!(global["mcpServers"]["office"]["command"].as_str().unwrap(), py.to_str().unwrap());
        assert_eq!(global["mcpServers"]["office"]["args"][0].as_str().unwrap(), server.to_str().unwrap());
        assert_eq!(global["mcpServers"]["memory"]["command"], "mem", "其他服务器保留");
        assert_eq!(global["numStartups"], 3, "其他键保留");
    }

    /// 二次注册同名覆盖（安装目录变化时路径要更新），不重复。
    #[test]
    fn office_mcp_reregister_overwrites() {
        let (g, py, server) =
            office_fixture("re", Some(r#"{"mcpServers":{"office":{"command":"old","args":["old.py"]}}}"#));
        register_office_mcp_at(&g, &py, &server);

        let global = read_json(&g);
        assert_eq!(global["mcpServers"]["office"]["command"].as_str().unwrap(), py.to_str().unwrap());
        assert_eq!(global["mcpServers"].as_object().unwrap().len(), 1, "同名覆盖，不重复");
    }

    /// 缺 python/server 文件 → 跳过，不写配置。
    #[test]
    fn office_mcp_skips_when_files_missing() {
        let dir = std::env::temp_dir().join(format!("office_mcp_miss_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let g = dir.join(".claude.json");
        let _ = std::fs::write(&g, r#"{"mcpServers":{"memory":{"command":"mem"}}}"#);

        register_office_mcp_at(&g, &dir.join("none_python.exe"), &dir.join("none_server.py"));

        let global = read_json(&g);
        assert!(global.get("mcpServers").and_then(|m| m.get("office")).is_none(), "缺文件不注册");
    }

    // ── 压缩配置读回（struct 字段回归）──

    /// gui 键里的 customCompactPrompt/compactExtractScript 读回 AppSettings 必须保留。
    /// 此前 struct 缺字段 serde 丢弃 → GUI 重启后设置面板勾选丢失（claude.exe 却仍生效）。
    #[test]
    fn gui_compact_fields_roundtrip() {
        let gui = serde_json::json!({
            "customCompactPrompt": {"mode": "replace", "text": "summary"},
            "compactExtractScript": "extensions/handoff-compact/scripts/handoff_extract.py",
        });
        let s = gui_to_app_settings(&gui);
        assert_eq!(s.custom_compact_prompt.as_ref().unwrap().mode, "replace");
        assert_eq!(s.custom_compact_prompt.as_ref().unwrap().text, "summary");
        assert_eq!(s.compact_extract_script.as_deref(),
            Some("extensions/handoff-compact/scripts/handoff_extract.py"));
    }

    // ── office-bridge 指南同步（临时目录，绝不碰真实 ~/.claude）──

    fn guide_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("office_guide_{}_{}", std::process::id(), tag));
        let _ = std::fs::create_dir_all(&dir);
        let claude_dir = dir.join(".claude");
        let src = dir.join("office-bridge.md");
        (claude_dir, src)
    }

    /// 源存在 → 复制到 ~/.claude/ + 注入 @office-bridge.md 到 CLAUDE.md。
    #[test]
    fn office_guide_copies_and_injects() {
        let (c, src) = guide_fixture("basic");
        std::fs::write(&src, "# Office MCP guide\n").unwrap();
        sync_office_guide_at(&c, &src);

        assert_eq!(std::fs::read_to_string(c.join("office-bridge.md")).unwrap(), "# Office MCP guide\n");
        let claude_md = std::fs::read_to_string(c.join("CLAUDE.md")).unwrap();
        assert!(claude_md.contains("@office-bridge.md"), "应注入 @ 引用");
    }

    /// 幂等：内容变化才更新 md，@ 引用不重复注入。
    #[test]
    fn office_guide_idempotent() {
        let (c, src) = guide_fixture("idem");
        std::fs::write(&src, "v1\n").unwrap();
        sync_office_guide_at(&c, &src);
        std::fs::write(&src, "v2\n").unwrap();
        sync_office_guide_at(&c, &src);

        assert_eq!(std::fs::read_to_string(c.join("office-bridge.md")).unwrap(), "v2\n", "内容变化应更新");
        let md = std::fs::read_to_string(c.join("CLAUDE.md")).unwrap();
        assert_eq!(md.matches("@office-bridge.md").count(), 1, "@ 引用不重复注入");
    }

    /// 源缺失 → 跳过，不写任何文件。
    #[test]
    fn office_guide_skips_when_source_missing() {
        let (c, src) = guide_fixture("miss");
        sync_office_guide_at(&c, &src);
        assert!(!c.join("office-bridge.md").exists());
        assert!(!c.join("CLAUDE.md").exists());
    }

    /// CLAUDE.md 已有 @ 引用 → 不重复注入；md 内容不同仍同步。
    #[test]
    fn office_guide_keeps_existing_injection() {
        let (c, src) = guide_fixture("keep");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("CLAUDE.md"), "# header\n\n@office-bridge.md\n@other.md\n").unwrap();
        std::fs::write(&src, "new\n").unwrap();
        sync_office_guide_at(&c, &src);

        let md = std::fs::read_to_string(c.join("CLAUDE.md")).unwrap();
        assert_eq!(md.matches("@office-bridge.md").count(), 1, "已有引用不重复");
        assert!(md.contains("@other.md"), "其余行保留");
        assert_eq!(std::fs::read_to_string(c.join("office-bridge.md")).unwrap(), "new\n");
    }

    /// 迁移把 settings.json 根 mcpServers 搬进 ~/.claude.json；
    /// 同名服务器不覆盖（已有的优先），其余键（gui 等）保留。
    #[test]
    fn mcp_migrate_moves_and_merges_preserving_existing() {
        let (s, g) = mcp_mig_fixture(
            "merge",
            r#"{"gui":{"language":"zh"},"mcpServers":{"codebase-memory-mcp":{"command":"x"},"playwright":{"command":"pw"}}}"#,
            Some(r#"{"numStartups":5,"mcpServers":{"playwright":{"command":"pw_old"},"memory":{"command":"mem"}}}"#),
        );
        migrate_single_file_mcp_between(&s, &g);

        let settings = read_json(&s);
        assert!(settings.get("mcpServers").is_none(), "settings.json 根 mcpServers 应被移除");
        assert_eq!(settings["gui"]["language"], "zh", "gui 键必须保留");

        let global = read_json(&g);
        assert_eq!(global["numStartups"], 5, "~/.claude.json 其余字段保留");
        let servers = global["mcpServers"].as_object().unwrap();
        assert!(servers.contains_key("codebase-memory-mcp"), "新服务器应搬入");
        assert_eq!(servers["playwright"]["command"], "pw_old", "同名不覆盖——已有的优先");
        assert!(servers.contains_key("memory"), "已有服务器保留");
    }

    /// 幂等：第二次运行 settings.json 已无 mcpServers → no-op。
    #[test]
    fn mcp_migrate_is_idempotent() {
        let (s, g) = mcp_mig_fixture(
            "idem",
            r#"{"gui":{},"mcpServers":{"a":{"command":"1"}}}"#,
            Some(r#"{}"#),
        );
        migrate_single_file_mcp_between(&s, &g);
        let after_first = std::fs::read_to_string(&g).unwrap();
        migrate_single_file_mcp_between(&s, &g);
        assert_eq!(std::fs::read_to_string(&g).unwrap(), after_first, "第二次运行不应改动 ~/.claude.json");
        assert!(read_json(&s).get("mcpServers").is_none());
    }

    /// settings.json 没有根 mcpServers → 直接返回，不动任何文件。
    #[test]
    fn mcp_migrate_noop_without_settings_mcp() {
        let (s, g) = mcp_mig_fixture("noop", r#"{"gui":{}}"#, Some(r#"{"mcpServers":{"z":{}}}"#));
        let before = std::fs::read_to_string(&g).unwrap();
        migrate_single_file_mcp_between(&s, &g);
        assert_eq!(std::fs::read_to_string(&g).unwrap(), before, "不应改动");
        assert!(read_json(&s).get("mcpServers").is_none());
    }

    /// ~/.claude.json 不存在 → 迁移创建它并写入 mcpServers。
    #[test]
    fn mcp_migrate_creates_claude_json_when_missing() {
        let (s, g) = mcp_mig_fixture("create", r#"{"mcpServers":{"a":{"command":"1"}}}"#, None);
        assert!(!g.exists());
        migrate_single_file_mcp_between(&s, &g);
        assert!(g.exists(), "迁移应创建 ~/.claude.json");
        assert!(read_json(&g)["mcpServers"].as_object().unwrap().contains_key("a"));
        assert!(read_json(&s).get("mcpServers").is_none());
    }

    /// 回归：~/.claude.json 的 mcpServers 是数组残留（非对象）→ 重建为对象再合并，防迁移丢失。
    #[test]
    fn mcp_migrate_rebuilds_array_residue() {
        let (s, g) = mcp_mig_fixture(
            "array",
            r#"{"mcpServers":{"a":{"command":"1"}}}"#,
            Some(r#"{"mcpServers":[]}"#),
        );
        migrate_single_file_mcp_between(&s, &g);
        let global = read_json(&g);
        assert!(global["mcpServers"].is_object(), "数组残留应被重建为对象");
        assert!(global["mcpServers"].as_object().unwrap().contains_key("a"), "服务器应合并进去");
        assert!(read_json(&s).get("mcpServers").is_none());
    }
}
