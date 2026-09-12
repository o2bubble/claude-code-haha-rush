//! ── GUI 后端（Tauri）迁移统一入口与权威登记表 ──
//!
//! 本模块是 Rust 侧所有「旧配置文件 / 旧持久化数据格式迁移」的唯一索引。
//! 新增迁移时：先实现迁移函数，再在下方 `MIGRATION_REGISTRY` 登记一条。
//!
//! ## 登记表
//!
//! 见 [`MIGRATION_REGISTRY`]（模块底部）—— 罗列全部迁移、触发时机、幂等性说明。
//! 其中 `run_startup_migrations()` 会跑启动期的那批（被 `lib.rs` 的启动序列调用）。
//!
//! ## 未搬入本模块、但属于迁移的逻辑（登记在此，避免"找不到"）
//!
//! 这些内嵌在 `settings.rs::load_global_settings()` 的加载流程里，抽出来会改变
//! 执行顺序与上下文（它们依赖刚读出的 `s`），故保留原地：
//!
//! 1. **legacy settings 采纳** —— `%APPDATA%/claude-code-gui/settings.json` →
//!    `~/.claude/settings.json` 的 `gui` 键（首次迁移整体采纳，随后删源文件）。
//! 2. **旧默认工作区改名** —— `%APPDATA%/claude-code-workspace` → 用户主目录同名，
//!    同步改写 `work_dir` 与 `workspaces`。
//! 3. **旧默认服务地址迁移** —— 仅 `localhost` 旧默认改写成当前 96 默认；
//!    判定逻辑在 [`should_migrate_server_url`]，调用点保留在 `load_global_settings`。
//! 4. **quickPrompts 提升为全局** —— 调 [`migrate_quick_prompts_to_global`]。
//!
//! 另有两处非磁盘配置迁移，也保留原地：
//! - `settings.rs::sync_cli_tools()` / `strip_cli_tools_section()` —— CLAUDE.md 旧
//!   `## Preferred CLI Tools` 段 → `@cli-tools.md` 引用（同步职责，非一次性迁移）。
//! - `shared/src/db.rs` 的 `ALTER TABLE desktops ADD COLUMN snap_to_grid` ——
//!   SQLite 无版本表，用 ALTER 失败当迁移守卫。

use crate::settings::{
    global_settings_path, merge_quick_prompts, read_gui_section, save_global_settings,
    workspace_settings_path, write_gui_section, AppSettings, QuickPrompt,
};

// ── 单文件→双文件回退迁移 ──

/// 把 user-scope MCP（`~/.claude/settings.json` 根 `mcpServers`，单文件模式时代引擎把全局
/// 配置写进了 settings.json）迁移到 `~/.claude.json` 根 `mcpServers`。
/// 回退 `getGlobalClaudeFile` 到双文件后，引擎只从 `~/.claude.json` 读 user-scope MCP；
/// 不迁移则 codebase-memory/playwright 等全部失效。幂等：迁移完成后 settings.json 不再有
/// 根 mcpServers，下次启动直接 no-op。同名服务器不覆盖（已有的优先）。
pub fn migrate_single_file_mcp_to_claude_json() {
    let settings_path = global_settings_path();
    let claude_json_path = crate::user_home().join(".claude.json");
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

// ── 全局配置字段迁移 ──

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

/// Decide whether a legacy default server URL needs migrating. Pure — only
/// `localhost` counts (the pre-1.0 default); the cloud/intranet addresses are
/// valid user choices and are never rewritten.
///
/// 调用点保留在 `settings.rs::load_global_settings()`（迁移动作与加载流程内联）。
pub fn should_migrate_server_url(skill_registry_url: &str) -> bool {
    skill_registry_url.contains("localhost")
}

// ── DeepSeek 模型下线：已有 profile 合并 ──

/// DeepSeek 官方已下线 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`
/// （请求由 DeepSeek-V4.1-Flash 承接），`deepseek-v4-pro` 也已宣布路由到同一模型。
/// 现有效模型名只有 `deepseek-flash` 与 `deepseek-v4-pro`。
///
/// 本迁移把「同一 api（api.deepseek.com）+ 同一 key」的旧 profile 合并为一个
/// `deepseek-flash`；原文件移到 `<profiles>/archive/` 归档（不删除）。若被合并的
/// profile 正是当前激活的那个，激活态一并指向新 profile。
///
/// 幂等：合并后旧文件已移出扫描范围 → 再次运行 no-op。
pub(crate) fn migrate_deepseek_profiles() {
    let Some(dir) = crate::find_profiles_dir() else { return };
    migrate_deepseek_profiles_in(
        &dir,
        &std::path::PathBuf::from(&crate::settings::load_settings().work_dir),
        crate::resolve_active_profile().map(|(id, _)| id).as_deref(),
    );
}

/// 路径可注入的迁移核心（单测用临时目录，绝不碰真实 ~/.claude）。
///
/// `work_dir` 用于定位工作区 active-profile 标记与 settings.local.json。
pub(crate) fn migrate_deepseek_profiles_in(
    profiles_dir: &std::path::Path,
    work_dir: &std::path::Path,
    active_id: Option<&str>,
) {
    let Ok(entries) = std::fs::read_dir(profiles_dir) else { return };

    // 1. 收集候选：顶层 *.env 且 ANTHROPIC_BASE_URL 指向 api.deepseek.com
    struct Candidate {
        path: std::path::PathBuf,
        id: String,
        token: String,
        vars: Vec<(String, String)>,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().map_or(true, |x| x != "env") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let vars = crate::parse_env_file(&content);
        let get = |k: &str| vars.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone());
        let Some(base_url) = get("ANTHROPIC_BASE_URL") else { continue };
        if !base_url.contains("api.deepseek.com") {
            continue;
        }
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
        // 已经是新名的 profile 不参与（它就是合并目标，或用户已手工建好）
        if id == "deepseek-flash" || id.starts_with("deepseek-flash-") {
            continue;
        }
        candidates.push(Candidate {
            path,
            id,
            token: get("ANTHROPIC_AUTH_TOKEN").unwrap_or_default(),
            vars,
        });
    }
    if candidates.is_empty() {
        return;
    }

    // 2. 按 token 分组（同 api 已由第 1 步保证，同 token 即同组），组内按 id 排序保证确定性。
    //    token 为空的（异常配置）各自成组，不互相合并。
    let mut groups: Vec<Vec<Candidate>> = Vec::new();
    for c in candidates {
        if c.token.is_empty() {
            groups.push(vec![c]);
            continue;
        }
        match groups.iter_mut().find(|g| g[0].token == c.token) {
            Some(g) => g.push(c),
            None => groups.push(vec![c]),
        }
    }
    for g in groups.iter_mut() {
        g.sort_by(|a, b| a.id.cmp(&b.id));
    }
    // 组间按 token 排序 → 目标名分配确定性
    groups.sort_by(|a, b| a[0].token.cmp(&b[0].token));

    // 3. 逐组写入合并结果并归档原文件
    let archive_dir = profiles_dir.join("archive");
    for (i, group) in groups.iter().enumerate() {
        let target_id = if i == 0 { "deepseek-flash".to_string() } else { format!("deepseek-flash-{}", i + 1) };
        let target_path = profiles_dir.join(format!("{}.env", target_id));
        // 目标已存在 → 整组跳过（不覆盖用户数据，也不归档）
        if target_path.exists() {
            log::info!("[deepseek-migrate] {} already exists — skip merging {} profile(s)", target_id, group.len());
            continue;
        }

        // 合并：组内 vars 取并集（先到先得），随后覆盖模型键为 deepseek-flash
        let mut merged: Vec<(String, String)> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for c in group {
            for (k, v) in &c.vars {
                if seen.insert(k.clone()) {
                    merged.push((k.clone(), v.clone()));
                }
            }
        }
        const MODEL_KEYS: [&str; 4] = [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
        ];
        for key in MODEL_KEYS {
            match merged.iter_mut().find(|(k, _)| k == key) {
                Some((_, v)) => *v = target_id.clone(),
                None => merged.push((key.to_string(), target_id.clone())),
            }
        }
        // DeepSeek 能力 env（与 GUI 预设一致：用 reasoning 字段控思考）
        for mk in ["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"] {
            let key = format!("{}_SUPPORTED_CAPABILITIES", mk);
            match merged.iter_mut().find(|(k, _)| *k == key) {
                Some((_, v)) => *v = "effort,max_effort,thinking,reasoning".to_string(),
                None => merged.push((key, "effort,max_effort,thinking,reasoning".to_string())),
            }
        }

        let content = crate::env_file_string(&merged, true);
        if let Err(e) = std::fs::write(&target_path, content) {
            log::warn!("[deepseek-migrate] write {} failed: {}", target_path.display(), e);
            continue;
        }
        log::info!(
            "[deepseek-migrate] merged {} profile(s) [{}] → {}",
            group.len(),
            group.iter().map(|c| c.id.as_str()).collect::<Vec<_>>().join(", "),
            target_id
        );

        // 4. 激活态跟随：被合并的正是当前激活 profile → 标记与 settings.local.json 一并改写
        let was_active = active_id.map_or(false, |a| group.iter().any(|c| c.id == a));
        if was_active {
            switch_active_profile_in(work_dir, &target_id, &merged);
            log::info!("[deepseek-migrate] active profile switched to {}", target_id);
        }

        // 5. 归档原文件（不删除）
        if std::fs::create_dir_all(&archive_dir).is_ok() {
            for c in group {
                let dest = unique_archive_path(&archive_dir, &c.path);
                match std::fs::rename(&c.path, &dest) {
                    Ok(_) => log::info!("[deepseek-migrate] archived {} → {}", c.id, dest.display()),
                    Err(e) => log::warn!("[deepseek-migrate] archive {} failed: {}", c.id, e),
                }
            }
        }
    }
}

/// 归档目标路径；同名已存在则加时间戳后缀，避免覆盖上一次的归档。
fn unique_archive_path(archive_dir: &std::path::Path, src: &std::path::Path) -> std::path::PathBuf {
    let name = src.file_name().map(|s| s.to_owned()).unwrap_or_default();
    let candidate = archive_dir.join(&name);
    if !candidate.exists() {
        return candidate;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    archive_dir.join(format!("{}.{}.env", stem, ts))
}

/// 把激活态指向 `profile_id`：写工作区 active-profile 标记 + 用户级标记，
/// 并把该 profile 的 env 落进工作区 settings.local.json（后端紧接着 spawn 会读到）。
fn switch_active_profile_in(
    work_dir: &std::path::Path,
    profile_id: &str,
    env_vars: &[(String, String)],
) {
    if !work_dir.as_os_str().is_empty() {
        let claude_dir = work_dir.join(".claude");
        if std::fs::create_dir_all(&claude_dir).is_ok() {
            let _ = std::fs::write(claude_dir.join("active-profile"), profile_id);

            let local_settings_path = claude_dir.join("settings.local.json");
            let mut local_settings: serde_json::Value = std::fs::read_to_string(&local_settings_path)
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            crate::apply_profile_env_to_settings(&mut local_settings, env_vars);
            let _ = std::fs::write(
                &local_settings_path,
                serde_json::to_string_pretty(&local_settings).unwrap_or_default(),
            );
        }
    }
    crate::write_user_marker(profile_id);
}

// ── Profile 目录迁移 ──

/// 旧版把 `.env.profiles` 放在项目根 / 工作区下，导致 profile 散落各项目、
/// 跨项目找不到 —— 统一迁到用户级 `~/.claude/.env.profiles`（幂等：目标已存在则跳过）。
pub(crate) fn migrate_legacy_profiles() {
    let user_dir = crate::user_claude_dir().join(".env.profiles");
    std::fs::create_dir_all(&user_dir).ok();

    let mut legacy_dirs = Vec::new();
    if let Ok(script) = crate::find_ide_script() {
        legacy_dirs.push(crate::find_project_root(&script).join(".env.profiles"));
    }
    let ws = crate::settings::load_settings().work_dir;
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

// ── 权威登记表 ──

/// 迁移的触发时机。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Trigger {
    /// 启动时跑一次（见 `run_startup_migrations`）
    Startup,
    /// 挂在配置加载路径上，每次加载都跑（纯转换 / 幂等）
    LoadPath,
}

/// 单条迁移的登记项。
///
/// `name` / `target` / `source` / `idempotent` 是给人看的检索信息（本表的存在意义
/// 就是「所有迁移在哪一处可查」），不参与运行时代码路径，故允许 dead_code。
#[allow(dead_code)]
pub(crate) struct MigrationEntry {
    /// 迁移函数名（未搬入本模块的填可检索的名字）
    pub name: &'static str,
    pub trigger: Trigger,
    /// 迁移什么（旧格式 → 新格式）
    pub target: &'static str,
    /// 函数本体所在位置（相对 gui/src-tauri/src）
    pub source: &'static str,
    /// 幂等性说明
    pub idempotent: &'static str,
    /// 迁移函数本体；`Startup` 项由 `run_startup_migrations` 遍历调用。
    /// 未搬入本模块的项留 `None`（只登记 —— 它们内嵌在各自的加载流程里）。
    pub run: Option<fn()>,
}

/// 权威登记表 —— Rust 侧所有迁移的唯一索引。
///
/// `run_startup_migrations()` 按声明顺序遍历 `trigger == Startup` 且 `run.is_some()`
/// 的项。`LoadPath` 项只登记（它们的调用点在各加载流程内，抽出来会改变时序）。
pub(crate) const MIGRATION_REGISTRY: &[MigrationEntry] = &[
    MigrationEntry {
        name: "migrate_legacy_profiles",
        trigger: Trigger::Startup,
        target: "项目根 / 工作区 .env.profiles → ~/.claude/.env.profiles",
        source: "migrations.rs",
        idempotent: "目标文件已存在即跳过",
        run: Some(migrate_legacy_profiles),
    },
    MigrationEntry {
        name: "migrate_deepseek_profiles",
        trigger: Trigger::Startup,
        target: "同 api+key 的旧 deepseek profile（v4-pro/v4-flash/vision-exp）→ 单个 deepseek-flash；原文件归档到 profiles/archive/；激活态跟随",
        source: "migrations.rs",
        idempotent: "合并后旧文件已移出扫描范围 → 再次运行 no-op；目标 profile 已存在则整组跳过",
        run: Some(migrate_deepseek_profiles),
    },
    MigrationEntry {
        name: "migrate_single_file_mcp_to_claude_json",
        trigger: Trigger::Startup,
        target: "~/.claude/settings.json 根 mcpServers → ~/.claude.json 根 mcpServers",
        source: "migrations.rs",
        idempotent: "迁移后 settings.json 无根 mcpServers → no-op；同名服务器不覆盖",
        run: Some(migrate_single_file_mcp_to_claude_json),
    },
    MigrationEntry {
        name: "migrate_quick_prompts_to_global",
        trigger: Trigger::LoadPath,
        target: "各 workspace settings.local.json 的 quickPrompts → 全局 baseline",
        source: "migrations.rs（函数）/ settings.rs::load_global_settings（调用点）",
        idempotent: "按 id 去重合并（先到先得），已合并的再次运行长度不变",
        run: None,
    },
    MigrationEntry {
        name: "should_migrate_server_url + 调用点",
        trigger: Trigger::LoadPath,
        target: "skillRegistryUrl 旧 localhost 默认 → 当前 96 默认",
        source: "migrations.rs（判定）/ settings.rs load_global_settings（动作）",
        idempotent: "仅 localhost 命中；云端/内网地址为用户选择，永不改写",
        run: None,
    },
    MigrationEntry {
        name: "legacy settings 采纳",
        trigger: Trigger::LoadPath,
        target: "%APPDATA%/claude-code-gui/settings.json → ~/.claude/settings.json 的 gui 键",
        source: "settings.rs load_global_settings",
        idempotent: "仅当 gui 键不存在时整体采纳，随后删除源文件",
        run: None,
    },
    MigrationEntry {
        name: "旧默认工作区改名",
        trigger: Trigger::LoadPath,
        target: "%APPDATA%/claude-code-workspace → 用户主目录同名目录",
        source: "settings.rs load_global_settings",
        idempotent: "源存在且目标不存在才 rename",
        run: None,
    },
    MigrationEntry {
        name: "sync_cli_tools / strip_cli_tools_section",
        trigger: Trigger::LoadPath,
        target: "CLAUDE.md 旧 `## Preferred CLI Tools` 文本段 → `@cli-tools.md` 引用",
        source: "settings.rs",
        idempotent: "已有引用即 no-op（职责是同步，非一次性迁移）",
        run: None,
    },
    MigrationEntry {
        name: "ALTER TABLE desktops ADD COLUMN snap_to_grid",
        trigger: Trigger::LoadPath,
        target: "桌面 DB 旧表结构 → 新增 snap_to_grid 列",
        source: "../shared/src/db.rs",
        idempotent: "ALTER 失败即视为列已存在（SQLite 无版本表，用失败当守卫）",
        run: None,
    },
    MigrationEntry {
        name: "note_fts + note_meta（FTS5 索引）",
        trigger: Trigger::LoadPath,
        target: "笔记 DB 旧表结构 → 新增 FTS5 虚拟表与状态表，并回填已有笔记",
        source: "../shared/src/note.rs::ensure_fts",
        idempotent: "IF NOT EXISTS 建表；回填仅在「索引为空且笔记非空」或「分词引擎变更」时触发，\
                     且 note_meta.fts_enabled='0' 的手动禁用不会被覆盖",
        run: None,
    },
];

// ── 启动期汇总 ──

/// 跑启动期的那批迁移（由 `lib.rs` 的启动序列调用，必须在 spawn 后端之前 ——
/// 后端启动时读全局配置）。
///
/// 遍历顺序即 `MIGRATION_REGISTRY` 中 `Startup` 项的声明顺序。
pub(crate) fn run_startup_migrations() {
    for m in MIGRATION_REGISTRY {
        if m.trigger == Trigger::Startup {
            if let Some(f) = m.run {
                f();
            }
        }
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

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

    // ── quickPrompts 迁移 ──

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

    // ── server URL 迁移判定 ──

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

    // ── DeepSeek 模型下线：profile 合并迁移（临时目录，绝不碰真实 ~/.claude）──

    fn ds_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("ds_mig_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        let profiles = dir.join(".env.profiles");
        let work = dir.join("ws");
        std::fs::create_dir_all(&profiles).unwrap();
        std::fs::create_dir_all(work.join(".claude")).unwrap();
        (profiles, work)
    }

    fn write_profile(dir: &std::path::Path, id: &str, base_url: &str, token: &str, model: &str) {
        let content = format!(
            "ANTHROPIC_AUTH_TOKEN={}\nANTHROPIC_BASE_URL={}\nANTHROPIC_MODEL={}\n\
             ANTHROPIC_DEFAULT_SONNET_MODEL={}\nANTHROPIC_DEFAULT_HAIKU_MODEL={}\n\
             ANTHROPIC_DEFAULT_OPUS_MODEL={}\nCLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000\n",
            token, base_url, model, model, model, model
        );
        std::fs::write(dir.join(format!("{}.env", id)), content).unwrap();
    }

    fn read_env(p: &std::path::Path) -> Vec<(String, String)> {
        crate::parse_env_file(&std::fs::read_to_string(p).unwrap())
    }

    fn env_get(vars: &[(String, String)], k: &str) -> Option<String> {
        vars.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone())
    }

    /// 同 api + 同 key 的三个旧 profile → 合并为单个 deepseek-flash；原文件归档。
    #[test]
    fn ds_migrate_merges_same_key_group_and_archives() {
        let (profiles, work) = ds_fixture("merge");
        let ds = "https://api.deepseek.com/anthropic";
        write_profile(&profiles, "deepseek-v4-pro", ds, "sk-same", "deepseek-v4-pro");
        write_profile(&profiles, "deepseek-v4-flash", ds, "sk-same", "deepseek-v4-flash");
        write_profile(&profiles, "deepseek-v4-flash-vision-exp", ds, "sk-same", "deepseek-v4-flash-vision-exp");

        migrate_deepseek_profiles_in(&profiles, &work, None);

        let target = profiles.join("deepseek-flash.env");
        assert!(target.exists(), "应产出 deepseek-flash");
        let vars = read_env(&target);
        assert_eq!(env_get(&vars, "ANTHROPIC_MODEL").as_deref(), Some("deepseek-flash"));
        assert_eq!(env_get(&vars, "ANTHROPIC_DEFAULT_OPUS_MODEL").as_deref(), Some("deepseek-flash"));
        assert_eq!(env_get(&vars, "ANTHROPIC_AUTH_TOKEN").as_deref(), Some("sk-same"), "key 保留");
        assert_eq!(
            env_get(&vars, "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES").as_deref(),
            Some("effort,max_effort,thinking,reasoning"),
            "能力 env 补齐"
        );

        // 原文件已移出顶层目录（归档）
        for id in ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"] {
            assert!(!profiles.join(format!("{}.env", id)).exists(), "{} 应已移走", id);
            assert!(profiles.join("archive").join(format!("{}.env", id)).exists(), "{} 应已归档", id);
        }
    }

    /// 不同 key 的 deepseek profile 不互相合并（各自成组）。
    #[test]
    fn ds_migrate_keeps_different_keys_apart() {
        let (profiles, work) = ds_fixture("diffkey");
        let ds = "https://api.deepseek.com/anthropic";
        write_profile(&profiles, "deepseek-v4-flash", ds, "sk-a", "deepseek-v4-flash");
        write_profile(&profiles, "deepseek-v4-pro", ds, "sk-b", "deepseek-v4-pro");

        migrate_deepseek_profiles_in(&profiles, &work, None);

        assert!(profiles.join("deepseek-flash.env").exists(), "第一组 → deepseek-flash");
        assert!(profiles.join("deepseek-flash-2.env").exists(), "第二组 → deepseek-flash-2");
        let a = read_env(&profiles.join("deepseek-flash.env"));
        let b = read_env(&profiles.join("deepseek-flash-2.env"));
        assert_ne!(
            env_get(&a, "ANTHROPIC_AUTH_TOKEN"),
            env_get(&b, "ANTHROPIC_AUTH_TOKEN"),
            "两个目标 profile 的 key 应不同"
        );
    }

    /// 非 deepseek 的 profile 不受影响（不同 api）。
    #[test]
    fn ds_migrate_ignores_other_providers() {
        let (profiles, work) = ds_fixture("other");
        write_profile(&profiles, "deepseek-v4-flash", "https://api.deepseek.com/anthropic", "sk-a", "deepseek-v4-flash");
        write_profile(&profiles, "glm-5.3-flash", "https://open.bigmodel.cn/api/anthropic", "k", "glm-5.3-flash");
        write_profile(&profiles, "plan-ds", "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", "sk-plan", "deepseek-v4-flash-0731");

        migrate_deepseek_profiles_in(&profiles, &work, None);

        assert!(profiles.join("glm-5.3-flash.env").exists(), "其他 provider 不动");
        assert!(profiles.join("plan-ds.env").exists(), "同模型名但不同 api 不动");
        assert!(!profiles.join("archive").join("glm-5.3-flash.env").exists());
    }

    /// 目标 profile 已存在 → 整组跳过（不覆盖用户数据，也不归档）。
    #[test]
    fn ds_migrate_skips_when_target_exists() {
        let (profiles, work) = ds_fixture("exists");
        let ds = "https://api.deepseek.com/anthropic";
        write_profile(&profiles, "deepseek-flash", ds, "sk-same", "deepseek-flash");
        std::fs::write(profiles.join("deepseek-flash.env"), "ANTHROPIC_MODEL=user-edited\n").unwrap();
        write_profile(&profiles, "deepseek-v4-flash", ds, "sk-same", "deepseek-v4-flash");

        migrate_deepseek_profiles_in(&profiles, &work, None);

        assert_eq!(
            std::fs::read_to_string(profiles.join("deepseek-flash.env")).unwrap(),
            "ANTHROPIC_MODEL=user-edited\n",
            "已有目标 profile 不被覆盖"
        );
        assert!(profiles.join("deepseek-v4-flash.env").exists(), "跳过时不归档源文件");
    }

    /// 二次运行幂等：旧文件已归档 → 扫描不到 → no-op。
    #[test]
    fn ds_migrate_is_idempotent() {
        let (profiles, work) = ds_fixture("idem");
        let ds = "https://api.deepseek.com/anthropic";
        write_profile(&profiles, "deepseek-v4-flash", ds, "sk-same", "deepseek-v4-flash");
        write_profile(&profiles, "deepseek-v4-pro", ds, "sk-same", "deepseek-v4-pro");

        migrate_deepseek_profiles_in(&profiles, &work, None);
        let after_first = std::fs::read_to_string(profiles.join("deepseek-flash.env")).unwrap();

        migrate_deepseek_profiles_in(&profiles, &work, None);
        assert_eq!(
            std::fs::read_to_string(profiles.join("deepseek-flash.env")).unwrap(),
            after_first,
            "第二次运行不应改动目标 profile"
        );
    }

    /// 激活态跟随：被合并的正是当前激活 profile → 标记与 settings.local.json 一并改写。
    #[test]
    fn ds_migrate_switches_active_profile() {
        let (profiles, work) = ds_fixture("active");
        let ds = "https://api.deepseek.com/anthropic";
        write_profile(&profiles, "deepseek-v4-flash", ds, "sk-same", "deepseek-v4-flash");
        write_profile(&profiles, "deepseek-v4-flash-vision-exp", ds, "sk-same", "deepseek-v4-flash-vision-exp");

        migrate_deepseek_profiles_in(&profiles, &work, Some("deepseek-v4-flash-vision-exp"));

        // 工作区标记改写
        let marker = std::fs::read_to_string(work.join(".claude").join("active-profile")).unwrap();
        assert_eq!(marker.trim(), "deepseek-flash", "工作区 active-profile 应指向新 profile");

        // settings.local.json 的 env 落到新模型
        let local: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(work.join(".claude").join("settings.local.json")).unwrap()).unwrap();
        assert_eq!(local["env"]["ANTHROPIC_MODEL"], "deepseek-flash", "settings.local.json env 应指向新模型");
    }

    /// 激活的是别的 profile → 不碰激活态。
    #[test]
    fn ds_migrate_leaves_active_when_unrelated() {
        let (profiles, work) = ds_fixture("active-other");
        let ds = "https://api.deepseek.com/anthropic";
        write_profile(&profiles, "deepseek-v4-flash", ds, "sk-same", "deepseek-v4-flash");

        migrate_deepseek_profiles_in(&profiles, &work, Some("glm-5.3-flash"));

        assert!(
            !work.join(".claude").join("active-profile").exists(),
            "激活的是无关 profile → 不应写激活标记"
        );
    }
}
