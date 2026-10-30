//! 存储清理 —— 扫描与删除「程序自己产生的、删了不影响已有数据」的中间产物。
//!
//! 设计规格：`.scratch/cleanup-tool/PRD.md`
//!
//! ## 为什么单独一个模块
//!
//! 既要能扫 `~/.claude`、程序数据目录，又要能扫**每个工作区**的 `.claude`；
//! 还要按类别决定默认勾选、保护活跃工作区、判定孤儿会话。这些规则混进 `lib.rs`
//! 会把那个文件推得更大，而且没法用临时目录做单测。
//!
//! 本模块**只做纯文件系统操作**，不读 Tauri 的 AppHandle：
//! 调用方（命令层）负责把根目录、活跃工作区列表传进来。这样测试可以直接把
//! 根目录指向临时目录，不碰真实的用户数据。
//!
//! ## 一条铁律
//!
//! **删除前的路径校验在这里做，不依赖前端。** 前端把用户勾选项的路径原样传回来，
//! 一旦传错（或有人手工构造请求），后果不可逆。`validate_deletable` 要求路径
//! 落在允许的根目录之内，且不是根目录本身。

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ── 类别 id（与前端 cleanupLogic 共用，改动即跨端契约） ──
pub const CAT_TEMP: &str = "temp";
pub const CAT_APP_CACHE: &str = "app-cache";
pub const CAT_FILE_HISTORY: &str = "file-history";
pub const CAT_ARCHIVE: &str = "archive";
pub const CAT_ORPHAN: &str = "orphan";

/// 一条清理候选。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    /// 稳定标识（kind + 路径的一次性散列），供前端做 React key。
    pub id: String,
    /// 类别：`temp` / `app-cache` / `file-history` / `archive` / `orphan`。
    pub category: String,
    /// 具体种类（`tool-results`、`shell-snapshots`…）—— 前端据此本地化名称。
    pub kind: String,
    /// 绝对路径。
    pub path: String,
    pub size_bytes: u64,
    pub file_count: u64,
    /// 最后修改时间（epoch 毫秒）；取不到则为 None。
    pub last_modified_ms: Option<u64>,
    /// 是否可清理。false 时前端灰掉并显示 `blocked_reason`。
    pub deletable: bool,
    /// 不可清理的原因码：`protected` / `active-workspace` / `in-use`。
    pub blocked_reason: Option<String>,
    /// 扫描超时 → 大小未知（仍可清理）。
    pub timed_out: bool,
}

/// 扫描输入。全部由调用方传入，本模块不自己去猜路径。
#[derive(Debug, Clone, Default)]
pub struct ScanRoots {
    /// `~/.claude`
    pub claude_dir: Option<PathBuf>,
    /// `%APPDATA%\com.claudecode.gui`
    pub app_data_dir: Option<PathBuf>,
    /// 启动页工作区列表（未归一化，本模块统一归一化并去重）
    pub workspaces: Vec<String>,
    /// **其他**活动实例绑定的工作区（本进程自己不算）。
    ///
    /// 命名保留 `active_workspaces`，语义收窄为"别人正在用" —— 由调用方保证
    /// 已排除自身 pid。这一层不做 pid 判断：本模块不读进程表，只做文件系统。
    pub active_workspaces: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub items: Vec<CleanupItem>,
    pub workspaces_total: usize,
    pub workspaces_timed_out: usize,
}

/// 一条删除结果。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub id: String,
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
    pub freed_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub outcomes: Vec<DeleteOutcome>,
    pub freed_bytes: u64,
}

// ─────────────────────────── 路径归一化 ───────────────────────────

/// 归一化用于**比较**的路径：统一分隔符、去尾斜杠、Windows 语义下转小写。
///
/// 与 `instances.rs` 的 `normalize_workspace` 同义（那边服务于实例判重，
/// 这边服务于清理清单，刻意各自独立以免一方的口径变更波及另一方）。
pub fn normalize_path(p: &str) -> String {
    let mut s = p.trim().replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    #[cfg(target_os = "windows")]
    {
        s = s.to_lowercase();
    }
    s
}

/// 去重后的工作区列表（保留首次出现的原始写法，便于界面上显示原生风格路径）。
pub fn dedupe_workspaces(list: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for w in list {
        if w.trim().is_empty() {
            continue;
        }
        let key = normalize_path(w);
        if seen.insert(key) {
            out.push(w.clone());
        }
    }
    out
}

/// 词法规范化：消掉 `.` 与 `..`，不做符号链接解析。
fn lexical_clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// ─────────────────────────── 统计 ───────────────────────────

#[derive(Default)]
struct Stats {
    bytes: u64,
    files: u64,
    newest_ms: Option<u64>,
    timed_out: bool,
}

fn mtime_ms(md: &std::fs::Metadata) -> Option<u64> {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// 递归统计；超过 `deadline` 就放弃并标记超时。
///
/// 每 512 个条目检查一次时间 —— 逐条检查 `Instant::now()` 在几十万小文件的
/// 目录上本身就是可观的开销。
fn stat_tree(root: &Path, deadline: Instant) -> Stats {
    let mut st = Stats::default();
    let Ok(md) = std::fs::metadata(root) else {
        return st;
    };
    st.newest_ms = mtime_ms(&md);
    // 单文件目标（如 `edit-history.jsonl`）直接返回 —— 否则会落到下面的
    // `read_dir`，对文件失败后返回全 0，清单里显示「0 B / 0 个文件」。
    if md.is_file() {
        st.files = 1;
        st.bytes = md.len();
        return st;
    }
    let mut stack = vec![root.to_path_buf()];
    let mut ticks: u32 = 0;
    while let Some(dir) = stack.pop() {
        // 进目录前先看一次：小目录（条目数凑不满一个检查周期）也要能超时，
        // 否则 `Duration::ZERO` 这种"不给时间"的输入会扫完整棵树。
        if ticks % 512 == 0 && Instant::now() > deadline {
            st.timed_out = true;
            return st;
        }
        ticks = ticks.wrapping_add(1);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(ft) if ft.is_dir() => stack.push(p),
                Ok(_) => {
                    st.files += 1;
                    if let Ok(md) = e.metadata() {
                        st.bytes += md.len();
                        if let Some(t) = mtime_ms(&md) {
                            st.newest_ms = Some(st.newest_ms.map_or(t, |n| n.max(t)));
                        }
                    }
                }
                Err(_) => {}
            }
        }
    }
    st
}

// ─────────────────────── 孤儿会话：从 jsonl 反解工作区 ───────────────────────

/// 从会话 jsonl 里读出真实 `cwd`。
///
/// **为什么不用目录名反解**：项目目录名把非字母数字一律换成 `-`
/// （`C:\Storage\work\牵引供电\simulationWeb` → `C--Storage-work------simulationWeb`），
/// 中文与特殊字符全部丢失，**不可逆**。拿它反解会得出错误路径，进而把活跃会话
/// 误判成孤儿。
///
/// 每条日志都带 `cwd` 字段，直接读它才是可靠来源。
///
/// 返回 None 表示读不出（文件缺失、格式异常）——调用方据此**不把该目录列为孤儿**。
fn workspace_of_project_dir(dir: &Path) -> Option<String> {
    const MAX_FILES: usize = 3;
    const MAX_LINE_BYTES: usize = 64 * 1024;

    let mut jsonls: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .collect();
    // 大文件更可能是本项目的真实会话；小文件常是空的占位
    jsonls.sort_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
    jsonls.reverse();

    for f in jsonls.into_iter().take(MAX_FILES) {
        let Ok(text) = std::fs::read_to_string(&f) else {
            continue;
        };
        for line in text.lines().take(20) {
            if line.len() > MAX_LINE_BYTES {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(cwd) = v.get("cwd").and_then(|x| x.as_str()) {
                if !cwd.trim().is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

// ─────────────────────────── 扫描 ───────────────────────────

/// 扫描全部清理候选。
///
/// `item_timeout` 作用于**每一个**统计目标（一个工作区、一个目录），
/// 超时的项标 `timed_out` 但仍列出 —— 清理本身不需要精确大小。
pub fn scan(roots: &ScanRoots, item_timeout: Duration) -> ScanResult {
    let mut items: Vec<CleanupItem> = Vec::new();
    let active: HashSet<String> = roots
        .active_workspaces
        .iter()
        .map(|w| normalize_path(w))
        .collect();
    let workspaces = dedupe_workspaces(&roots.workspaces);

    // ── 用户级：~/.claude ──
    if let Some(claude) = &roots.claude_dir {
        // 临时产物（默认勾选）
        for (kind, rel, cat) in [
            ("shell-snapshots", "shell-snapshots", CAT_TEMP),
            ("paste-cache", "paste-cache", CAT_TEMP),
            ("telemetry", "telemetry", CAT_TEMP),
        ] {
            push_if_exists(&mut items, claude, kind, rel, cat, item_timeout);
        }

        // ── projects/<项目>/ 下的三类东西 ──
        //
        // 目录结构是 **三层**：
        //   projects/<项目 slug>/
        //     <会话 id>.jsonl          会话记录（不清理）
        //     edit-history.jsonl       编辑历史日志（清理，归「编辑快照」）
        //     <会话 id>/               会话子目录
        //       tool-results/          工具输出（清理）
        //       subagents/             子代理执行记录（清理）
        //
        // ⚠️ 首版把 tool-results 当成 `projects/<项目>/tool-results` —— 少了
        // `<会话 id>` 这一层，**从来没扫到过任何东西**（2026-10-30 用户实测发现）。
        if let Ok(projs) = std::fs::read_dir(claude.join("projects")) {
            let mut project_dirs: Vec<PathBuf> = projs
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            project_dirs.sort();
            for proj in project_dirs {
                // ① 编辑历史日志：单个文件，属于「编辑快照」（删了同样丢失历史）
                let edit_history = proj.join("edit-history.jsonl");
                if edit_history.is_file() {
                    let st = stat_tree(&edit_history, Instant::now() + item_timeout);
                    items.push(make_item(
                        &format!("edit-history:{}", edit_history.display()),
                        CAT_FILE_HISTORY,
                        "edit-history",
                        &edit_history,
                        st,
                    ));
                }

                // ② 每个会话子目录下的 tool-results / subagents
                let Ok(sessions) = std::fs::read_dir(&proj) else {
                    continue;
                };
                let mut session_dirs: Vec<PathBuf> = sessions
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect();
                session_dirs.sort();
                for session in session_dirs {
                    for (kind, dirname) in [
                        ("tool-results", "tool-results"),
                        ("subagents", "subagents"),
                    ] {
                        let target = session.join(dirname);
                        if !target.is_dir() {
                            continue;
                        }
                        let st = stat_tree(&target, Instant::now() + item_timeout);
                        items.push(make_item(
                            &format!("{kind}:{}", target.display()),
                            CAT_TEMP,
                            kind,
                            &target,
                            st,
                        ));
                    }
                }
            }
        }

        // 编辑快照 / 归档 / 备份（默认不勾）
        for (kind, rel, cat) in [
            ("file-history", "file-history", CAT_FILE_HISTORY),
            ("branch-archive", "branch-archive", CAT_ARCHIVE),
            ("backups", "backups", CAT_ARCHIVE),
        ] {
            push_if_exists(&mut items, claude, kind, rel, cat, item_timeout);
        }

        // 配置版本保护仓库 —— 永不删除，但要显示出来（用户会好奇那 78 MB 是什么）
        let git = claude.join(".git");
        if git.exists() {
            let st = stat_tree(&git, Instant::now() + item_timeout);
            let mut it = make_item("protected:git", CAT_ARCHIVE, "git-repo", &git, st);
            it.deletable = false;
            it.blocked_reason = Some("protected".into());
            items.push(it);
        }

        // 孤儿会话：项目目录对应的 cwd 已不存在
        if let Ok(dirs) = std::fs::read_dir(claude.join("projects")) {
            for e in dirs.flatten() {
                let proj = e.path();
                if !proj.is_dir() {
                    continue;
                }
                // 双向确认：读得出 cwd，且该目录确实不存在
                let Some(cwd) = workspace_of_project_dir(&proj) else {
                    continue; // 读不出 → 不列为孤儿（宁可漏清，不可错删）
                };
                if Path::new(&cwd).exists() {
                    continue; // 工作区还在 → 活会话，永不列出
                }
                let st = stat_tree(&proj, Instant::now() + item_timeout);
                items.push(make_item(
                    &format!("orphan:{}", proj.display()),
                    CAT_ORPHAN,
                    "orphan-sessions",
                    &proj,
                    st,
                ));
            }
        }
    }

    // ── 程序级：%APPDATA%\com.claudecode.gui ──
    if let Some(app_data) = &roots.app_data_dir {
        for (kind, rel) in [("plugin-cache", "plugins"), ("gui-logs", "logs")] {
            push_if_exists(&mut items, app_data, kind, rel, CAT_APP_CACHE, item_timeout);
        }
    }

    // ── 工作区级 ──
    let mut ws_timed_out = 0usize;
    for ws in &workspaces {
        let ws_path = Path::new(ws);
        let active_ws = active.contains(&normalize_path(ws));
        for (kind, rel) in [
            ("workspace-pasted", "pasted"),
            ("workspace-screenshots", "screenshots"),
        ] {
            let p = ws_path.join(".claude").join(rel);
            if !p.is_dir() {
                continue;
            }
            let st = stat_tree(&p, Instant::now() + item_timeout);
            if st.timed_out {
                ws_timed_out += 1;
            }
            let mut it = make_item(
                &format!("{kind}:{}", p.display()),
                CAT_TEMP,
                kind,
                &p,
                st,
            );
            if active_ws {
                it.deletable = false;
                it.blocked_reason = Some("active-workspace".into());
            }
            items.push(it);
        }
    }

    ScanResult {
        items,
        workspaces_total: workspaces.len(),
        workspaces_timed_out: ws_timed_out,
    }
}

fn push_if_exists(
    items: &mut Vec<CleanupItem>,
    base: &Path,
    kind: &str,
    rel: &str,
    category: &str,
    item_timeout: Duration,
) {
    let p = base.join(rel);
    if !p.exists() {
        return;
    }
    let st = stat_tree(&p, Instant::now() + item_timeout);
    items.push(make_item(
        &format!("{kind}:{}", p.display()),
        category,
        kind,
        &p,
        st,
    ));
}

fn make_item(id_seed: &str, category: &str, kind: &str, path: &Path, st: Stats) -> CleanupItem {
    CleanupItem {
        id: hash_id(id_seed),
        category: category.to_string(),
        kind: kind.to_string(),
        path: path.to_string_lossy().to_string(),
        size_bytes: st.bytes,
        file_count: st.files,
        last_modified_ms: st.newest_ms,
        deletable: true,
        blocked_reason: None,
        timed_out: st.timed_out,
    }
}

/// 稳定短 id（FNV-1a 64）。不引第三方散列库，只求同路径同 id。
fn hash_id(seed: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{h:016x}")
}

// ─────────────────────────── 删除 ───────────────────────────

/// 校验路径**可以**被删除。
///
/// 前端回传的路径一律当作不可信输入：
///  - 必须落在某个允许的根目录**之内**（不含根本身 —— 删根等于删库）
///  - 不允许 `.git`（配置版本保护仓库）
///  - 路径里不允许出现 `..`（防止拼出根目录之外的路径）
pub fn validate_deletable(path: &Path, roots: &[&Path]) -> Result<(), String> {
    let cleaned = lexical_clean(path);
    if cleaned.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    // 含 .. 的路径一律拒绝：lexical_clean 已经消掉，能到这里说明原文里就没有
    // 允许的根必须**严格包含**目标
    let mut inside = false;
    for root in roots {
        let root = lexical_clean(root);
        if cleaned == root {
            return Err("refusing to delete a root directory".into());
        }
        if cleaned.starts_with(&root) {
            inside = true;
            break;
        }
    }
    if !inside {
        return Err("path is outside the allowed roots".into());
    }
    if cleaned
        .components()
        .any(|c| c.as_os_str() == ".git")
    {
        return Err("refusing to delete a git repository".into());
    }
    Ok(())
}

/// 执行删除。逐项进行，**某项失败不影响其余**（规格 Q13）。
pub fn run_deletes<F>(items: &[CleanupItem], roots: &[&Path], mut on_done: F) -> RunReport
where
    F: FnMut(&DeleteOutcome),
{
    let mut outcomes = Vec::with_capacity(items.len());
    let mut freed = 0u64;
    for it in items {
        let p = PathBuf::from(&it.path);
        let outcome = match validate_deletable(&p, roots) {
            Err(e) => DeleteOutcome {
                id: it.id.clone(),
                path: it.path.clone(),
                ok: false,
                error: Some(e),
                freed_bytes: 0,
            },
            Ok(()) => match remove_tree(&p) {
                Ok(()) => {
                    freed += it.size_bytes;
                    DeleteOutcome {
                        id: it.id.clone(),
                        path: it.path.clone(),
                        ok: true,
                        error: None,
                        freed_bytes: it.size_bytes,
                    }
                }
                Err(e) => DeleteOutcome {
                    id: it.id.clone(),
                    path: it.path.clone(),
                    ok: false,
                    error: Some(e),
                    freed_bytes: 0,
                },
            },
        };
        on_done(&outcome);
        outcomes.push(outcome);
    }
    RunReport {
        outcomes,
        freed_bytes: freed,
    }
}

fn remove_tree(p: &Path) -> Result<(), String> {
    let md = std::fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    if md.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

// ─────────────────────────── 清理日志 ───────────────────────────

/// 清理日志的一条记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupLogEntry {
    pub at_ms: u64,
    pub freed_bytes: u64,
    pub ok_count: usize,
    pub fail_count: usize,
    pub categories: Vec<String>,
}

/// 追加一条清理记录，只保留最近 `keep` 条。
///
/// 落在**程序数据目录**而不是 `~/.claude` —— 后者有配置版本仓库，新增未跟踪
/// 文件会让 `git status` 变脏（规格 Q28）。
pub fn append_log(path: &Path, entry: &CleanupLogEntry, keep: usize) -> Result<(), String> {
    let mut lines: Vec<String> = Vec::new();
    if let Ok(text) = std::fs::read_to_string(path) {
        lines = text.lines().filter(|l| !l.trim().is_empty()).map(|s| s.to_string()).collect();
    }
    if let Ok(s) = serde_json::to_string(entry) {
        lines.push(s);
    }
    if lines.len() > keep {
        let cut = lines.len() - keep;
        lines.drain(0..cut);
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(path, lines.join("\n") + "\n").map_err(|e| e.to_string())
}

/// 读取最近 `limit` 条（新的在前）。
pub fn read_log(path: &Path, limit: usize) -> Vec<CleanupLogEntry> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out: Vec<CleanupLogEntry> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    out.reverse();
    out.truncate(limit);
    out
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─────────────────────────── 测试 ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let d = std::env::temp_dir().join(format!(
            "claude-cleanup-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(p: &Path, bytes: usize) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn normalize_handles_slashes_and_case() {
        assert_eq!(normalize_path("C:\\Work\\Proj\\"), normalize_path("c:/work/proj"));
        assert_eq!(normalize_path("/a/b//"), "/a/b");
    }

    #[test]
    fn dedupe_workspaces_collapses_equivalent_forms() {
        let ws = vec![
            "C:\\Storage\\work\\docs".to_string(),
            "C:/Storage/work/docs".to_string(),
            "C:\\Storage\\work\\other".to_string(),
            "   ".to_string(),
        ];
        let out = dedupe_workspaces(&ws);
        assert_eq!(out.len(), 2);
        // 保留首次出现的原始写法
        assert_eq!(out[0], "C:\\Storage\\work\\docs");
    }

    #[test]
    fn scan_lists_temp_artifacts_and_leaves_missing_ones_out() {
        let claude = tmp("temp");
        write(&claude.join("shell-snapshots/a.sh"), 10);
        write(&claude.join("shell-snapshots/b.sh"), 20);
        // paste-cache 不存在 → 不应出现
        let roots = ScanRoots {
            claude_dir: Some(claude.clone()),
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));
        let ss = r
            .items
            .iter()
            .find(|i| i.kind == "shell-snapshots")
            .expect("shell-snapshots 应被列出");
        assert_eq!(ss.file_count, 2);
        assert_eq!(ss.size_bytes, 30);
        assert_eq!(ss.category, CAT_TEMP);
        assert!(ss.deletable);
        assert!(r.items.iter().all(|i| i.kind != "paste-cache"));
        std::fs::remove_dir_all(&claude).ok();
    }

    #[test]
    fn scan_categorizes_file_history_separately() {
        let claude = tmp("fh");
        write(&claude.join("file-history/x/1.txt"), 5);
        let roots = ScanRoots {
            claude_dir: Some(claude.clone()),
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));
        let it = r.items.iter().find(|i| i.kind == "file-history").unwrap();
        assert_eq!(it.category, CAT_FILE_HISTORY);
        std::fs::remove_dir_all(&claude).ok();
    }

    #[test]
    fn git_repo_is_listed_but_never_deletable() {
        let claude = tmp("git");
        write(&claude.join(".git/config"), 3);
        let roots = ScanRoots {
            claude_dir: Some(claude.clone()),
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));
        let it = r.items.iter().find(|i| i.kind == "git-repo").unwrap();
        assert!(!it.deletable);
        assert_eq!(it.blocked_reason.as_deref(), Some("protected"));
        // 且删除校验会拒绝它
        let p = PathBuf::from(&it.path);
        assert!(validate_deletable(&p, &[claude.as_path()]).is_err());
        std::fs::remove_dir_all(&claude).ok();
    }

    /// 三层结构：`projects/<项目>/<会话 id>/{tool-results,subagents}`。
    ///
    /// 首版把它当成 `projects/<项目>/tool-results`（少一层），导致这部分
    /// **从来没扫到过任何东西** —— 而且旧的测试只覆盖了 shell-snapshots，
    /// 所以这个 bug 一路溜到了用户手里。这条测试就是为了钉死层级。
    #[test]
    fn scan_finds_tool_results_and_subagents_under_session_dir() {
        let claude = tmp("nested");
        let proj = claude.join("projects/C--Storage-work-demo");
        let session = proj.join("1a2b3c4d-0000-0000-0000-000000000000");
        write(&session.join("tool-results/out.txt"), 100);
        write(&session.join("subagents/agent.jsonl"), 250);

        let roots = ScanRoots {
            claude_dir: Some(claude.clone()),
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));

        let tr = r
            .items
            .iter()
            .find(|i| i.kind == "tool-results")
            .expect("tool-results 必须被扫到（三层路径）");
        assert_eq!(tr.size_bytes, 100);
        assert_eq!(tr.category, CAT_TEMP);

        let sa = r
            .items
            .iter()
            .find(|i| i.kind == "subagents")
            .expect("subagents 必须被扫到");
        assert_eq!(sa.size_bytes, 250);
        assert_eq!(sa.category, CAT_TEMP);

        std::fs::remove_dir_all(&claude).ok();
    }

    /// `edit-history.jsonl` 是单文件目标，必须能统计出真实大小
    /// （`stat_tree` 早年只处理目录，对文件会返回 0 B）。
    #[test]
    fn scan_finds_edit_history_file_with_real_size() {
        let claude = tmp("edithist");
        let proj = claude.join("projects/C--Storage-work-demo");
        write(&proj.join("edit-history.jsonl"), 4096);
        write(&proj.join("some-session.jsonl"), 999);

        let roots = ScanRoots {
            claude_dir: Some(claude.clone()),
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));

        let eh = r
            .items
            .iter()
            .find(|i| i.kind == "edit-history")
            .expect("edit-history.jsonl 必须被扫到");
        assert_eq!(eh.size_bytes, 4096, "单文件也要算出真实大小");
        assert_eq!(eh.file_count, 1);
        assert_eq!(eh.category, CAT_FILE_HISTORY, "归入「编辑快照」，默认不勾");
        assert!(eh.deletable);

        // 会话 jsonl 本身不该出现在任何清理项里（那是唯一不可再生的数据）
        assert!(!r.items.iter().any(|i| i.path.ends_with("some-session.jsonl")));

        std::fs::remove_dir_all(&claude).ok();
    }

    #[test]
    fn orphan_needs_both_decodable_and_missing() {
        let claude = tmp("orphan");

        // ① 会话里 cwd 指向一个不存在的目录 → 孤儿
        let p1 = claude.join("projects/proj-gone");
        let session = serde_json::json!({
            "type": "user",
            "cwd": "C:\\__definitely_not_existing__\\gone",
        });
        write(&p1.join("s.jsonl"), 0);
        std::fs::write(p1.join("s.jsonl"), session.to_string()).unwrap();

        // ② 会话里 cwd 指向**存在**的目录 → 活会话，不能列出
        let p2 = claude.join("projects/proj-live");
        std::fs::create_dir_all(&p2).unwrap();
        let live = serde_json::json!({ "type": "user", "cwd": claude.to_string_lossy() });
        std::fs::write(p2.join("s.jsonl"), live.to_string()).unwrap();

        // ③ 读不出 cwd → 不列为孤儿
        let p3 = claude.join("projects/proj-unknown");
        write(&p3.join("s.jsonl"), 1);

        let roots = ScanRoots {
            claude_dir: Some(claude.clone()),
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));
        let orphans: Vec<_> = r.items.iter().filter(|i| i.kind == "orphan-sessions").collect();
        assert_eq!(orphans.len(), 1, "只有 ① 该被列为孤儿");
        assert!(orphans[0].path.contains("proj-gone"));
        std::fs::remove_dir_all(&claude).ok();
    }

    #[test]
    fn active_workspace_items_are_blocked() {
        let ws = tmp("active-ws");
        write(&ws.join(".claude/pasted/a.md"), 7);
        let roots = ScanRoots {
            workspaces: vec![ws.to_string_lossy().to_string()],
            active_workspaces: vec![ws.to_string_lossy().to_string()],
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));
        let it = r.items.iter().find(|i| i.kind == "workspace-pasted").unwrap();
        assert!(!it.deletable);
        assert_eq!(it.blocked_reason.as_deref(), Some("active-workspace"));
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn workspace_dedupe_prevents_double_counting() {
        let ws = tmp("dup-ws");
        write(&ws.join(".claude/pasted/a.md"), 4);
        let s = ws.to_string_lossy().to_string();
        let roots = ScanRoots {
            workspaces: vec![s.clone(), s.replace('\\', "/")],
            ..Default::default()
        };
        let r = scan(&roots, Duration::from_secs(5));
        assert_eq!(
            r.items.iter().filter(|i| i.kind == "workspace-pasted").count(),
            1,
            "同一工作区的两种写法只该出现一次"
        );
        assert_eq!(r.workspaces_total, 1);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn validate_rejects_roots_parents_and_outside_paths() {
        let root = tmp("validate");
        let inside = root.join("sub");
        std::fs::create_dir_all(&inside).unwrap();

        assert!(validate_deletable(&inside, &[root.as_path()]).is_ok());
        // 根目录本身
        assert!(validate_deletable(&root, &[root.as_path()]).is_err());
        // 根目录之外
        assert!(validate_deletable(Path::new("C:\\Windows\\System32"), &[root.as_path()]).is_err());
        // .git
        let git = root.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        assert!(validate_deletable(&git, &[root.as_path()]).is_err());
        // .. 逃逸
        let escape = root.join("sub").join("..").join("..").join("Windows");
        assert!(validate_deletable(&escape, &[root.as_path()]).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn run_deletes_continues_after_failure_and_reports() {
        let root = tmp("run");
        let ok1 = root.join("a");
        let ok2 = root.join("b");
        write(&ok1.join("x.txt"), 3);
        write(&ok2.join("y.txt"), 4);

        let items = vec![
            CleanupItem {
                id: "1".into(),
                category: CAT_TEMP.into(),
                kind: "k".into(),
                path: ok1.to_string_lossy().to_string(),
                size_bytes: 3,
                file_count: 1,
                last_modified_ms: None,
                deletable: true,
                blocked_reason: None,
                timed_out: false,
            },
            // 这一项路径在允许根之外 → 必须失败，但**不能**中断后续
            CleanupItem {
                id: "2".into(),
                category: CAT_TEMP.into(),
                kind: "k".into(),
                path: "C:\\__outside__\\nope".into(),
                size_bytes: 0,
                file_count: 0,
                last_modified_ms: None,
                deletable: true,
                blocked_reason: None,
                timed_out: false,
            },
            CleanupItem {
                id: "3".into(),
                category: CAT_TEMP.into(),
                kind: "k".into(),
                path: ok2.to_string_lossy().to_string(),
                size_bytes: 4,
                file_count: 1,
                last_modified_ms: None,
                deletable: true,
                blocked_reason: None,
                timed_out: false,
            },
        ];

        let report = run_deletes(&items, &[root.as_path()], |_| {});
        assert_eq!(report.outcomes.len(), 3);
        assert!(report.outcomes[0].ok);
        assert!(!report.outcomes[1].ok, "越界路径必须失败");
        assert!(report.outcomes[2].ok, "失败项之后仍要继续");
        assert_eq!(report.freed_bytes, 7);
        assert!(!ok1.exists() && !ok2.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn log_keeps_only_recent_entries() {
        let root = tmp("log");
        let path = root.join("cleanup-log.jsonl");
        for i in 0..5u64 {
            let e = CleanupLogEntry {
                at_ms: i,
                freed_bytes: i * 10,
                ok_count: 1,
                fail_count: 0,
                categories: vec![CAT_TEMP.into()],
            };
            append_log(&path, &e, 3).unwrap();
        }
        let recent = read_log(&path, 10);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].at_ms, 4, "新的在前");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_times_out_but_still_lists_item() {
        let claude = tmp("timeout");
        write(&claude.join("shell-snapshots/a.sh"), 10);
        let roots = ScanRoots {
            claude_dir: Some(claude.clone()),
            ..Default::default()
        };
        // 0 超时：必然超时（deadline 已过）
        let r = scan(&roots, Duration::ZERO);
        let it = r.items.iter().find(|i| i.kind == "shell-snapshots").unwrap();
        assert!(it.timed_out, "超时项仍要列出，只是标记 timed_out");
        assert!(it.deletable);
        std::fs::remove_dir_all(&claude).ok();
    }
}

