// ── 运行环境诊断 — 纯函数检查层 + 采集编排 ──
//
// 唯一测试接缝：每个检查项实现为纯函数 (inputs…) -> DiagnosticCheck，输入由
// 编排层从真实环境采集后传入。网络探测的「结果分类」同样拆成纯函数。前端只
// 渲染报告，不做判断逻辑。

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
    Na,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub id: String,
    pub status: CheckStatus,
    pub title: String,
    pub detail: String,
    /// 分类内的小节（如「安装环境变量」），None = 直接挂在分类下。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

impl DiagnosticCheck {
    fn new(id: &str, status: CheckStatus, title: &str, detail: String) -> Self {
        Self { id: id.into(), status, title: title.into(), detail, group: None }
    }

    fn with_group(mut self, group: &str) -> Self {
        self.group = Some(group.into());
        self
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCategory {
    pub id: String,
    pub title: String,
    pub checks: Vec<DiagnosticCheck>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub timestamp: u64,
    pub categories: Vec<DiagnosticCategory>,
}

// ── 纯函数检查层（测试接缝）──

pub fn check_install_dir(path: &str, exists: bool) -> DiagnosticCheck {
    if exists {
        DiagnosticCheck::new("install_dir", CheckStatus::Pass, "安装目录",
            format!("{} — 存在", path))
    } else {
        DiagnosticCheck::new("install_dir", CheckStatus::Fail, "安装目录",
            format!("{} — 不存在", path))
    }
}

pub fn check_gui_version(version: &str) -> DiagnosticCheck {
    DiagnosticCheck::new("gui_version", CheckStatus::Pass, "GUI 版本",
        format!("当前版本 {}", version))
}

/// 环境变量的持久化作用域描述：系统 + 用户 / 系统级 / 用户级 / 未持久化。
fn registry_scope_desc(user_registry: Option<&str>, system_registry: Option<&str>) -> String {
    if system_registry.is_some() && user_registry.is_some() {
        "系统 + 用户（存在用户级残留）".into()
    } else if system_registry.is_some() {
        "系统级 (HKLM)".into()
    } else if user_registry.is_some() {
        "用户级 (HKCU)".into()
    } else {
        "未持久化".into()
    }
}

/// 用户级(HKCU)残留判定（纯函数，可单测）：注入 HKCU 三值。
fn user_leftover_check(
    user_home: Option<&str>,
    user_git: Option<&str>,
    user_path: Option<&str>,
    install_dir: &str,
) -> DiagnosticCheck {
    let mut leftovers: Vec<String> = Vec::new();
    if user_home.is_some() {
        leftovers.push("CLAUDE_CODE_HAHA_HOME".to_string());
    }
    if user_git.is_some() {
        leftovers.push("CLAUDE_CODE_GIT_BASH_PATH".to_string());
    }
    if let Some(up) = user_path {
        // 安装目录相关条目（根 或 %CLAUDE_CODE_HAHA_HOME% 或子后缀）出现在 HKCU PATH
        let has_install = PATH_SUFFIXES.iter().any(|s| {
            let full = format!("{}{}", install_dir, s);
            let var_token = format!("%CLAUDE_CODE_HAHA_HOME%{}", s);
            path_has(up, &full) || path_has(up, &var_token)
        }) || path_has(up, install_dir);
        if has_install {
            leftovers.push("PATH(含安装目录条目)".to_string());
        }
    }
    if leftovers.is_empty() {
        DiagnosticCheck::new(
            "user_leftover", CheckStatus::Pass, "用户级环境变量残留",
            "未检测到用户级残留（HKCU 干净）".to_string(),
        )
    } else {
        DiagnosticCheck::new(
            "user_leftover", CheckStatus::Warn, "用户级环境变量残留",
            format!(
                "HKCU 存在: {} — 用户级残留按 Windows 读取顺序覆盖系统级正确值。点击修复将清理。",
                leftovers.join("、")
            ),
        )
    }
}

/// 读真实 HKCU 三值做残留检测（生产入口）。
pub fn check_user_leftover(install_dir: &str) -> DiagnosticCheck {
    let (uh, _) = read_registry_env("CLAUDE_CODE_HAHA_HOME");
    let (ug, _) = read_registry_env("CLAUDE_CODE_GIT_BASH_PATH");
    let (up, _) = read_registry_env("PATH");
    user_leftover_check(uh.as_deref(), ug.as_deref(), up.as_deref(), install_dir)
}

/// CLAUDE_CODE_HAHA_HOME：进程环境 + 用户/系统注册表 + 一致性 + 目录存在。
/// 进程值 ≠ 注册表值 → 警告「可能安装后未重启」；指向目录不存在 → 失败。
pub fn check_home_env(
    process: Option<&str>,
    user_registry: Option<&str>,
    system_registry: Option<&str>,
    dir_exists: bool,
) -> DiagnosticCheck {
    let scope = registry_scope_desc(user_registry, system_registry);
    // 系统级(HKLM)为持久化唯一权威 — Windows 读取顺序为 系统→用户(用户覆盖系统)。
    // 修复后只有 HKLM 有值; 若 HKCU 也有(残留)由 check_user_leftover 单独提示。
    let effective_registry = system_registry.or(user_registry);

    let (status, detail) = match (process, effective_registry) {
        (None, None) => (
            CheckStatus::Fail,
            "未检测到 CLAUDE_CODE_HAHA_HOME（进程与注册表均未设置）。请重新运行安装程序。".to_string(),
        ),
        (None, Some(r)) if !dir_exists => (
            CheckStatus::Fail,
            format!("{} — 已持久化（{scope}）但指向的目录不存在。", r),
        ),
        (None, Some(r)) => (
            CheckStatus::Warn,
            format!("已持久化到注册表（{scope}），但当前进程未读到。需重启/重新登录后生效。当前值: {}", r),
        ),
        (Some(p), Some(r)) if p != r => (
            CheckStatus::Warn,
            format!("进程值 ({}) 与注册表值 ({}) 不一致（{scope}）。可能安装后未重启/重新登录。", p, r),
        ),
        (Some(p), _) if !dir_exists => (
            CheckStatus::Fail,
            format!("{} — 指向的目录不存在。", p),
        ),
        (Some(p), Some(_)) => (
            CheckStatus::Pass,
            format!("{} — 已设置（进程与注册表一致，{scope}）", p),
        ),
        (Some(p), None) => (
            CheckStatus::Pass,
            format!("{} — 进程环境已设置（未持久化到注册表）", p),
        ),
    };
    DiagnosticCheck::new("claude_home", status, "CLAUDE_CODE_HAHA_HOME", detail)
}

/// CLAUDE_CODE_HAHA_HOME 作用域：进程读取值与注册表持久化（用户/系统）是否一致。
/// 独立成行，满足「作用域一致性」检查项；与 check_home_env 互补（后者看值与目录）。
pub fn check_env_scope(
    process: Option<&str>,
    user_registry: Option<&str>,
    system_registry: Option<&str>,
) -> DiagnosticCheck {
    let scope = registry_scope_desc(user_registry, system_registry);
    let effective_registry = system_registry.or(user_registry);
    let (status, detail) = match (process, effective_registry) {
        (None, None) => (
            CheckStatus::Na,
            format!("未设置（无注册表持久化，见上方 {} 检查）", "CLAUDE_CODE_HAHA_HOME"),
        ),
        (None, Some(r)) => (
            CheckStatus::Warn,
            format!("已持久化到注册表（{scope}），但当前进程未读到。需重启/重新登录后生效。当前值: {}", r),
        ),
        (Some(p), None) => (
            CheckStatus::Pass,
            format!("{} — 进程环境已设置（未持久化到注册表）", p),
        ),
        (Some(p), Some(r)) if p != r => (
            CheckStatus::Warn,
            format!("进程值 ({}) 与注册表值 ({}) 不一致（{scope}）。可能安装后未重启/重新登录。", p, r),
        ),
        (Some(p), Some(_)) => (
            CheckStatus::Pass,
            format!("进程读取与注册表一致（{scope}）：{}", p),
        ),
    };
    DiagnosticCheck::new("env_scope", status, "CLAUDE_CODE_HAHA_HOME 作用域", detail)
}

/// CLAUDE_CODE_GIT_BASH_PATH：设置 + %VAR% 展开后 bash.exe 存在。
/// 缺失/指向不存在 → 失败（claude 后端会直接 process::exit(1)）。
/// 仅注册表有值（进程未读到）→ 警告需重启——否则存活的后端进程仍会 exit。
pub fn check_git_bash_path(
    process: Option<&str>,
    registry: Option<&str>,
    expanded_exists: bool,
) -> DiagnosticCheck {
    let (status, detail) = match (process, registry) {
        (None, None) => (
            CheckStatus::Fail,
            "未设置 CLAUDE_CODE_GIT_BASH_PATH。claude 后端找不到 bash 会直接退出。请重新安装或设置该变量指向 git-bash 的 bash.exe。".to_string(),
        ),
        (None, Some(r)) => (
            CheckStatus::Warn,
            format!("已持久化到注册表但当前进程未读到（{}）。需重启/重新登录，否则 claude 后端会直接退出。", r),
        ),
        (Some(p), _) if !expanded_exists => (
            CheckStatus::Fail,
            format!("{} — 展开 %VAR% 后 bash.exe 不存在。claude 后端会直接退出。", p),
        ),
        (Some(p), _) => (
            CheckStatus::Pass,
            format!("{} — bash.exe 存在", p),
        ),
    };
    DiagnosticCheck::new("git_bash_path", status, "CLAUDE_CODE_GIT_BASH_PATH", detail)
}

/// PATH 是否包含安装根目录 / bin / git\usr\bin（进程 PATH 或注册表 PATH，
/// %VAR% 形式或展开后形式均可）。
pub fn check_path_entries(
    process_path: &str,
    registry_path: Option<&str>,
    var_token: &str,
    expanded_home: &str,
    expected_suffixes: &[&str],
) -> DiagnosticCheck {
    let mut missing: Vec<String> = Vec::new();
    for suffix in expected_suffixes {
        let token_var = format!("{}{}", var_token, suffix);
        let token_exp = format!("{}{}", expanded_home, suffix);
        let in_proc = path_has(process_path, &token_var) || path_has(process_path, &token_exp);
        let in_reg = registry_path.map_or(false, |r| path_has(r, &token_var) || path_has(r, &token_exp));
        if !in_proc && !in_reg {
            let label = if suffix.is_empty() { "安装根目录".to_string() } else { suffix.to_string() };
            missing.push(label);
        }
    }
    let (status, detail) = if missing.is_empty() {
        (CheckStatus::Pass, "PATH 已包含安装根目录 / bin / git\\usr\\bin（进程级，GUI 启动已前置）".to_string())
    } else {
        (
            CheckStatus::Warn,
            format!("进程 PATH 缺少: {}。重启 GUI 会自动前置安装目录。", missing.join(", ")),
        )
    };
    DiagnosticCheck::new("path_entries", status, "PATH 环境变量", detail)
}

/// 安装目录组件完整性：根 exe 缺失 → 失败；bin/python/git 缺失 → 警告。
pub fn check_install_dir_components(
    install_dir: &str,
    has_root_exe: bool,
    has_bin: bool,
    has_python: bool,
    has_git: bool,
) -> DiagnosticCheck {
    let mut missing: Vec<&str> = Vec::new();
    if !has_root_exe { missing.push("根 exe"); }
    if !has_bin { missing.push("bin (CLI 工具)"); }
    if !has_python { missing.push("python"); }
    if !has_git { missing.push("git"); }
    let (status, detail) = if !has_root_exe {
        (CheckStatus::Fail, format!("{} — 缺少核心组件: {}。安装可能不完整，建议重新安装。", install_dir, missing.join(", ")))
    } else if !missing.is_empty() {
        (CheckStatus::Warn, format!("{} — 缺少可选组件: {}", install_dir, missing.join(", ")))
    } else {
        (CheckStatus::Pass, format!("{} — 根 exe / bin / python / git 均就位", install_dir))
    };
    DiagnosticCheck::new("install_dir_components", status, "安装目录组件", detail)
}

/// 进程 PATH 里第一个存在的 bash.exe 所在目录（模拟裸 `bash` 命令的解析）。
/// 进程 PATH 是系统+用户合并且展开后的，System32(WSL) 在前则返回 System32。
fn first_bash_in_path(process_path: &str) -> Option<String> {
    for dir in process_path.split(';') {
        let d = dir.trim().trim_end_matches('\\');
        if d.is_empty() { continue; }
        if std::path::Path::new(d).join("bash.exe").is_file() {
            return Some(d.to_string());
        }
    }
    None
}

/// bash 解析检查：裸 `bash` 是否被 WSL(System32) 或独立 Git 截胡。
/// 仅 PATH 存在性检查看不出来——必须看实际解析到的第一个 bash 是谁。
pub fn check_bash_resolution(first_bash: Option<&str>, our_bash_dirs: &[String]) -> DiagnosticCheck {
    let ours = first_bash.map_or(false, |p| {
        our_bash_dirs.iter().any(|d| p.eq_ignore_ascii_case(d))
    });
    let (status, detail) = match first_bash {
        None => (
            CheckStatus::Fail,
            "PATH 中找不到 bash.exe（git bash 未就位）。".to_string(),
        ),
        Some(p) if ours => (
            CheckStatus::Pass,
            format!("bash → {}（git bash）", p),
        ),
        Some(p) => (
            CheckStatus::Warn,
            format!("bash 被 {} 截胡（非 git bash，可能是 WSL 或独立 Git）。Claude Code 已用 SHELL 变量绕开；裸 bash 命令建议由管理员将 git\\bin 前置到系统 PATH。", p),
        ),
    };
    DiagnosticCheck::new("bash_resolution", status, "bash 解析", detail)
}

/// 展开 %VAR% 引用（与 CLI 侧 windowsPaths.ts 的 expandEnvVars 语义一致）。
/// lookup 抽象出环境读取，使本函数可纯单测。
fn expand_env_vars(p: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut result = String::new();
    let mut rest = p;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                result.push_str(&lookup(name).unwrap_or_default());
                rest = &after[end + 1..];
            }
            None => {
                result.push('%');
                rest = after;
            }
        }
    }
    result.push_str(rest);
    result
}

/// PATH 中的某个条目是否存在（大小写不敏感、忽略尾部反斜杠、按 ';' 分隔）。
fn path_has(path: &str, entry: &str) -> bool {
    let entry = entry.trim_end_matches('\\').to_lowercase();
    if entry.is_empty() { return false; }
    path.split(';').any(|p| p.trim_end_matches('\\').to_lowercase() == entry)
}

// ── 采集编排 ──

const GROUP_INSTALL_ENV: &str = "install_env";
const GROUP_PROFILE: &str = "profile";

/// 环境分类：基础（安装目录 + GUI 版本）+ 安装环境变量（小节）+ Profile 环境文件（小节）。
fn env_category() -> Vec<DiagnosticCheck> {
    let install_dir = crate::update::get_install_dir();
    let install_dir_str = install_dir.to_string_lossy().to_string();
    let version = crate::settings::load_global_settings()._version;

    let mut checks = vec![
        check_install_dir(&install_dir_str, install_dir.is_dir()),
        check_gui_version(&version),
    ];
    checks.extend(install_env_checks(&install_dir));
    checks.extend(profile_checks());
    checks
}

/// macOS git 可用性检测。git 官方无便携发行版（Windows 有 PortableGit，mac 没有）→
/// 走系统安装 + 引导（xcode-select --install 或 brew install git）。
/// 注：跨平台编译（install_env_checks 的 mac 分支用 cfg! 运行时判断，Windows 上不调用）；
/// 函数体只用跨平台 std API。
fn mac_git_check() -> DiagnosticCheck {
    use std::process::Command;
    match Command::new("git").arg("--version").output() {
        Ok(out) if out.status.success() => {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            DiagnosticCheck::new(
                "mac_git", CheckStatus::Pass, "Git (macOS)",
                format!("系统 Git 可用: {}", ver),
            )
        }
        _ => DiagnosticCheck::new(
            "mac_git", CheckStatus::Warn, "Git (macOS)",
            "未检测到系统 Git（可选，仅作提示）。macOS 自带终端可完成日常操作；\
             仅当需要 git 命令（clone/commit/分支）时才需安装：\
             xcode-select --install 或 brew install git，装完重启 GUI。".to_string(),
        ),
    }
}

/// 「安装环境变量」小节：HOME / GIT_BASH_PATH / PATH / 安装目录组件。
/// macOS 无注册表/GIT_BASH_PATH 假设（系统环境管理）→ 注册表相关返回「不适用」，
/// 不触发 read_registry_env（reg.exe 是 Windows 专属）。git 官方无便携发行版，
/// 走系统安装 → 补一条 mac 专属 git 检测 + 缺失引导。
fn install_env_checks(install_dir: &std::path::Path) -> Vec<DiagnosticCheck> {
    if !cfg!(target_os = "windows") {
        let _ = install_dir;
        return vec![
            DiagnosticCheck::new(
                "install_env", CheckStatus::Na, "安装环境变量",
                "macOS 使用系统环境管理，无注册表/GIT_BASH_PATH 假设，此项不适用".to_string(),
            ).with_group(GROUP_INSTALL_ENV),
            mac_git_check().with_group(GROUP_INSTALL_ENV),
        ];
    }
    let install_dir_str = install_dir.to_string_lossy().to_string();

    // CLAUDE_CODE_HAHA_HOME
    let proc_home = std::env::var("CLAUDE_CODE_HAHA_HOME").ok();
    let (user_home, sys_home) = read_registry_env("CLAUDE_CODE_HAHA_HOME");
    let effective_home = proc_home.clone().or(sys_home.clone()).or(user_home.clone());
    let home_dir_exists = effective_home.as_deref().map(|p| std::path::Path::new(p).is_dir()).unwrap_or(false);
    let home_check = check_home_env(
        proc_home.as_deref(), user_home.as_deref(), sys_home.as_deref(), home_dir_exists,
    ).with_group(GROUP_INSTALL_ENV);
    let scope_check = check_env_scope(
        proc_home.as_deref(), user_home.as_deref(), sys_home.as_deref(),
    ).with_group(GROUP_INSTALL_ENV);

    // CLAUDE_CODE_GIT_BASH_PATH（存在性按进程值判定——后端读的是进程 env）
    let proc_git = std::env::var("CLAUDE_CODE_GIT_BASH_PATH").ok();
    let (user_git, sys_git) = read_registry_env("CLAUDE_CODE_GIT_BASH_PATH");
    let reg_git = sys_git.clone().or(user_git.clone());
    let expanded_git = proc_git.as_deref().map(|p| expand_env_vars(p, |n| std::env::var(n).ok()));
    let git_exists = expanded_git.as_deref().map(|p| std::path::Path::new(p).is_file()).unwrap_or(false);
    let git_check = check_git_bash_path(proc_git.as_deref(), reg_git.as_deref(), git_exists).with_group(GROUP_INSTALL_ENV);

    // PATH — 进程级策略：GUI 启动已 setvar PATH（前置安装目录），注册表 PATH 不再读取/要求。
    let proc_path = std::env::var("PATH").unwrap_or_default();
    let path_suffixes: Vec<&str> = PATH_SUFFIXES.iter()
        .filter(|s| s.is_empty() || install_dir.join(s.trim_start_matches('\\')).is_dir())
        .copied()
        .collect();
    // 进程级策略：GUI 启动已 setvar PATH（前置安装目录），子进程自足；系统注册表
    // 只保留 CLAUDE_CODE_HAHA_HOME，PATH 不再要求写入系统 → 检测只认进程 PATH。
    let path_check = check_path_entries(
        &proc_path, None, "%CLAUDE_CODE_HAHA_HOME%", &install_dir_str,
        &path_suffixes,
    ).with_group(GROUP_INSTALL_ENV);

    // 系统注册表 PATH 精简检查（新策略只需根 + git\usr\bin，冗余子条目为历史遗留）
    let (_, sys_reg_path) = read_registry_env("PATH");
    let slim_check = check_system_path_slim(sys_reg_path.as_deref(), &install_dir_str).with_group(GROUP_INSTALL_ENV);

    // bash 解析：裸 `bash` 是否被 WSL(System32)/独立 Git 截胡（仅 PATH 存在性检查看不出顺序）
    let mut our_bash_dirs = Vec::new();
    for suffix in ["\\git\\usr\\bin", "\\git\\bin"] {
        if install_dir.join(suffix.trim_start_matches('\\')).is_dir() {
            our_bash_dirs.push(install_dir_str.clone() + suffix);
        }
    }
    let bash_check = check_bash_resolution(first_bash_in_path(&proc_path).as_deref(), &our_bash_dirs)
        .with_group(GROUP_INSTALL_ENV);

    // 安装目录组件
    let has_root = install_dir.join("claude-code-gui.exe").is_file() || install_dir.join("claude.exe").is_file();
    let has_bin = install_dir.join("bin").is_dir();
    let has_python = install_dir.join("python").is_dir();
    let has_git = install_dir.join("git").is_dir();
    let comp_check = check_install_dir_components(
        &install_dir_str, has_root, has_bin, has_python, has_git,
    ).with_group(GROUP_INSTALL_ENV);

    let leftover_check = check_user_leftover(&install_dir_str).with_group(GROUP_INSTALL_ENV);

    // GIT_BASH_PATH 遗留 + SHELL 残留（新策略进程级提供，注册表值为历史遗留）
    let git_legacy_check = check_git_bash_legacy(sys_git.as_deref(), user_git.as_deref()).with_group(GROUP_INSTALL_ENV);
    let (user_shell, sys_shell) = read_registry_env("SHELL");
    let shell_check = check_shell_leftover(user_shell.as_deref(), sys_shell.as_deref(), &install_dir_str).with_group(GROUP_INSTALL_ENV);

    vec![
        home_check, scope_check, git_check, path_check, slim_check,
        leftover_check, git_legacy_check, shell_check, bash_check, comp_check,
    ]
}

/// Profile 目录：是否找到 .env.profiles、在哪个优先级位置、有哪些 profile。
pub fn check_profiles_found(found: bool, location: &str, profiles: &[String]) -> DiagnosticCheck {
    let (status, detail) = if !found {
        (CheckStatus::Fail,
         "未找到 .env.profiles 目录（用户主目录 ~/.claude/.env.profiles 缺失）。请用 Profile 管理创建。".to_string())
    } else if profiles.is_empty() {
        (CheckStatus::Warn, format!("在 {} 找到 .env.profiles，但没有任何 *.env profile。", location))
    } else {
        (CheckStatus::Pass,
         format!("在 {} 找到 .env.profiles（{} 个 profile: {}）", location, profiles.len(), profiles.join(", ")))
    };
    DiagnosticCheck::new("profiles_found", status, "Profile 目录", detail)
}

/// 激活 Profile：解析标记（工作区 active-profile → ~/.claude/.env.active → 兜底第一个）。
pub fn check_active_profile(active_id: Option<&str>, marker_source: &str, exists: bool) -> DiagnosticCheck {
    let (status, detail) = match (active_id, exists) {
        (None, _) => (
            CheckStatus::Warn,
            "未检测到激活标记，且无可用 profile 兜底。请用 Profile 管理创建 profile 或设置激活。".to_string(),
        ),
        (Some(id), false) => (
            CheckStatus::Fail,
            format!("激活标记指向的 profile '{}' 不存在（标记来源: {}）。", id, marker_source),
        ),
        (Some(id), true) => (
            CheckStatus::Pass,
            format!("激活 profile: {}（标记来源: {}）", id, marker_source),
        ),
    };
    DiagnosticCheck::new("active_profile", status, "激活 Profile", detail)
}

/// 激活 Profile 内容：无激活 profile → 不适用；API 凭据必须非空（缺 → 失败）；
/// BaseURL / 模型缺 → 警告。
pub fn check_profile_content(
    active: Option<&str>,
    has_credential: bool,
    has_model: bool,
    base_url: Option<&str>,
) -> DiagnosticCheck {
    let has_base_url = base_url.is_some();
    let (status, detail) = match active {
        None => (CheckStatus::Na, "无激活 profile，跳过内容校验。".to_string()),
        Some(_) if !has_credential => (
            CheckStatus::Fail,
            "缺少 API 凭据（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 均为空）。请检查激活 profile 或重新创建。".to_string(),
        ),
        Some(_) if !has_base_url && !has_model => (
            CheckStatus::Warn,
            "已配置 API 凭据；未设置 ANTHROPIC_BASE_URL 与默认模型（BaseURL 将使用官方默认端点）。".to_string(),
        ),
        Some(_) if !has_base_url => (
            CheckStatus::Warn,
            "已配置 API 凭据；未设置 ANTHROPIC_BASE_URL（将使用官方默认端点）。".to_string(),
        ),
        Some(_) if !has_model => (
            CheckStatus::Warn,
            "已配置 API 凭据与 BaseURL；未设置默认模型（ANTHROPIC_MODEL）。".to_string(),
        ),
        Some(_) => (
            CheckStatus::Pass,
            format!("API 凭据 / BaseURL / 模型均已配置（BaseURL: {}）", base_url.unwrap_or("")),
        ),
    };
    DiagnosticCheck::new("profile_content", status, "激活 Profile 内容", detail)
}

/// 后端注入：profile 已解析且将在后端启动时注入环境变量。
pub fn check_profile_injected(inject_var_count: usize, active: Option<&str>) -> DiagnosticCheck {
    let (status, detail) = match (active, inject_var_count) {
        (None, _) => (CheckStatus::Na, "无激活 profile，未注入任何环境变量。".to_string()),
        (Some(_), 0) => (CheckStatus::Warn, "激活 profile 已解析但无任何环境变量（文件可能为空）。".to_string()),
        (Some(id), n) => (
            CheckStatus::Pass,
            format!("解析成功（{}），将在后端启动时注入 {} 个环境变量。", id, n),
        ),
    };
    DiagnosticCheck::new("profile_injected", status, "后端注入", detail)
}

const CLOUD_SERVER_URL: &str = "http://123.56.66.84:8765";
/// 内网更新/注册服务器（skillRegistryUrl）：可达 → 通过，否则失败。
pub fn check_update_server(reachable: bool, url: &str) -> DiagnosticCheck {
    let (status, detail) = if reachable {
        (CheckStatus::Pass, format!("{} — 可达", url))
    } else {
        (CheckStatus::Fail, format!("{} — 不可达（更新/技能市场功能将不可用）", url))
    };
    DiagnosticCheck::new("update_server", status, "更新/注册服务器", detail)
}

/// 云服务器（123.56.66.84:8765）：可达 → 通过，否则失败。
pub fn check_cloud_server(reachable: bool, url: &str) -> DiagnosticCheck {
    let (status, detail) = if reachable {
        (CheckStatus::Pass, format!("{} — 可达", url))
    } else {
        (CheckStatus::Fail, format!("{} — 不可达", url))
    };
    DiagnosticCheck::new("cloud_server", status, "云服务器", detail)
}

/// MCP super-desktop：内嵌在 GUI 进程内的 MCP 服务器，端口为动态分配
/// （13920-14000 首个空闲，多实例各自不同）。直接读本实例 mcp::mcp_port()，
/// 不探测固定端口——那在多实例场景会误报「未运行」。
pub fn check_mcp_service(port: u16) -> DiagnosticCheck {
    let (status, detail) = if port > 0 {
        (CheckStatus::Pass, format!("运行中（本实例端口 {}）", port))
    } else {
        (CheckStatus::Na, "未启动（内嵌 MCP 服务器未绑定端口）。".to_string())
    };
    DiagnosticCheck::new("mcp_service", status, "MCP super-desktop", detail)
}

/// API BaseURL（激活 profile）：未配置 → 不适用；主机解析失败 → 警告；TCP 探测。
pub fn check_api_endpoint(
    configured: bool,
    host_port: Option<&str>,
    reachable: bool,
) -> DiagnosticCheck {
    let (status, detail) = match (configured, host_port, reachable) {
        (false, _, _) => (CheckStatus::Na, "未配置 ANTHROPIC_BASE_URL（见 Profile 检查），跳过端点探测。".to_string()),
        (true, None, _) => (CheckStatus::Warn, "无法解析 BaseURL 的主机地址。".to_string()),
        (true, Some(hp), true) => (CheckStatus::Pass, format!("{} — TCP 可达", hp)),
        (true, Some(hp), false) => (CheckStatus::Fail, format!("{} — TCP 不可达（AI 服务地址连不上）", hp)),
    };
    DiagnosticCheck::new("api_endpoint", status, "API BaseURL", detail)
}

/// 从 URL 提取主机 + 端口（缺省按协议：https→443，http→80）。
fn url_host_port(url: &str) -> Option<(String, u16)> {
    let is_https = url.starts_with("https://");
    let default_port = if is_https { 443 } else { 80 };
    let rest = url.split("://").nth(1)?;
    let authority = rest.split(['/', '?']).next()?;
    match authority.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => Some((h.to_string(), port)),
            Err(_) => Some((authority.to_string(), default_port)),
        },
        None => Some((authority.to_string(), default_port)),
    }
}

/// 「网络连通」分类：内网更新服务器 / 云服务器 / MCP 本地 / API BaseURL。
/// 四项探测并行执行（各自 ≤3s 超时），总量约等于最慢项而非四倍。
fn network_category() -> Vec<DiagnosticCheck> {
    let settings = crate::settings::load_global_settings();
    let update_url = settings.skill_registry_url.clone();
    let cloud_url = CLOUD_SERVER_URL.to_string();
    let api_host_port = active_profile_base_url().and_then(|b| url_host_port(&b));

    let update_thread = update_url.clone();
    let cloud_thread = cloud_url.clone();
    let t_update = std::thread::spawn(move || http_reachable(&update_thread));
    let t_cloud = std::thread::spawn(move || http_reachable(&cloud_thread));
    let t_api = api_host_port.as_ref().map(|(h, p)| {
        let h = h.clone();
        let p = *p;
        std::thread::spawn(move || tcp_probe(&h, p) == ProbeOutcome::Ok)
    });

    let update_ok = t_update.join().unwrap_or(false);
    let cloud_ok = t_cloud.join().unwrap_or(false);
    let api_ok = t_api.and_then(|h| h.join().ok()).unwrap_or(false);

    let api_host_port_str = api_host_port.as_ref().map(|(h, p)| format!("{}:{}", h, p));

    vec![
        check_update_server(update_ok, &update_url),
        check_cloud_server(cloud_ok, &cloud_url),
        // MCP 是内嵌本进程的服务器，直接读本实例动态端口（非固定端口探测）
        check_mcp_service(crate::mcp::mcp_port()),
        check_api_endpoint(api_host_port.is_some(), api_host_port_str.as_deref(), api_ok),
    ]
}

fn active_profile_base_url() -> Option<String> {
    let (id, _) = crate::resolve_active_profile()?;
    let dir = crate::find_profiles_dir()?;
    let content = std::fs::read_to_string(dir.join(format!("{}.env", id))).ok()?;
    crate::parse_env_file(&content).into_iter()
        .find(|(k, v)| k == "ANTHROPIC_BASE_URL" && !v.is_empty())
        .map(|(_, v)| v)
}

// ── 工作区 ──

/// 工作区绑定：已绑定 → 通过；未绑定 → 不适用（其余工作区检查跳过）。
pub fn check_workspace_bound(bound: bool, path: &str) -> DiagnosticCheck {
    let (status, detail) = if bound {
        (CheckStatus::Pass, format!("当前工作区: {}", path))
    } else {
        (CheckStatus::Na, "未绑定工作区。相关工作区检查跳过。".to_string())
    };
    DiagnosticCheck::new("workspace_bound", status, "工作区绑定", detail)
}

/// 工作区局部设置文件：不存在是首次进入的正常状态，不是故障。
pub fn check_workspace_local_settings(exists: bool, path: &str) -> DiagnosticCheck {
    let detail = if exists {
        format!("{} — 存在", path)
    } else {
        format!("{} — 不存在（首次进入工作区，将回退全局默认）", path)
    };
    DiagnosticCheck::new("workspace_local_settings", CheckStatus::Pass, "工作区局部设置", detail)
}

/// 会话数据库：可打开 → 通过；损坏/打不开 → 失败。
pub fn check_workspace_db(ok: bool, path: &str, detail: &str) -> DiagnosticCheck {
    let status = if ok { CheckStatus::Pass } else { CheckStatus::Fail };
    DiagnosticCheck::new("workspace_db", status, "会话数据库", format!("{} — {}", path, detail))
}

fn na_check(id: &str, title: &str, detail: &str) -> DiagnosticCheck {
    DiagnosticCheck::new(id, CheckStatus::Na, title, detail.to_string())
}

/// 「工作区」分类：绑定状态 / 局部设置文件 / 会话数据库。
fn workspace_checks() -> Vec<DiagnosticCheck> {
    let bound = crate::settings::bound_work_dir();
    let bound_path = std::path::Path::new(&bound);
    let bound_check = check_workspace_bound(!bound.is_empty(), &bound);

    if bound.is_empty() {
        return vec![
            bound_check,
            na_check("workspace_local_settings", "工作区局部设置", "未绑定工作区，跳过"),
            na_check("workspace_db", "会话数据库", "未绑定工作区，跳过"),
        ];
    }

    let local_path = bound_path.join(".claude").join("settings.local.json");
    let local_check = check_workspace_local_settings(local_path.is_file(), &local_path.to_string_lossy());

    let db_path = bound_path.join(".claude").join("data.db");
    let (db_ok, db_detail) = open_db_check(&db_path);
    let db_check = check_workspace_db(db_ok, &db_path.to_string_lossy(), &db_detail);

    vec![bound_check, local_check, db_check]
}

fn open_db_check(path: &std::path::Path) -> (bool, String) {
    if !path.exists() {
        return (true, "尚未创建（首次进入工作区时自动创建）".to_string());
    }
    // 只读打开 —— 这是检查不是写操作；读写打开活跃会话库会因并发锁误报失败
    match rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => match conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)) {
            Ok(_) => (true, "可正常打开".to_string()),
            Err(e) => (false, format!("打开失败: {}", e)),
        },
        Err(e) => (false, format!("打开失败: {}", e)),
    }
}

fn http_reachable(url: &str) -> bool {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()
        .and_then(|c| c.get(url).send().ok())
        .is_some()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ProbeOutcome {
    Ok,
    Refused,
    Timeout,
    Error,
}

fn tcp_probe(host: &str, port: u16) -> ProbeOutcome {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    let Some(addr) = (host, port).to_socket_addrs().ok().and_then(|mut it| it.next()) else {
        return ProbeOutcome::Error;
    };
    match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
        Ok(_) => ProbeOutcome::Ok,
        Err(e) => match e.kind() {
            std::io::ErrorKind::ConnectionRefused => ProbeOutcome::Refused,
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => ProbeOutcome::Timeout,
            _ => ProbeOutcome::Error,
        },
    }
}

/// 「Profile 环境文件」小节：目录 / 激活标记 / 内容校验 / 注入链路。
fn profile_checks() -> Vec<DiagnosticCheck> {
    let dir = crate::find_profiles_dir();
    let (found, location) = match &dir {
        Some(d) => (true, profile_location_label(d)),
        None => (false, ""),
    };
    let profiles = dir.as_deref().map(list_env_profiles).unwrap_or_default();
    let found_check = check_profiles_found(found, location, &profiles).with_group(GROUP_PROFILE);

    // 激活解析 — 与后端启动共用 lib.rs 的 resolve_active_profile（杜绝兜底漂移）
    let active = crate::resolve_active_profile();
    let active_id = active.as_ref().map(|(id, _)| id.clone());
    let marker_source = active.as_ref().map(|(_, s)| *s).unwrap_or("");
    let active_exists = active_id.as_ref().map(|id| {
        dir.as_deref().map_or(false, |d| d.join(format!("{}.env", id)).is_file())
    }).unwrap_or(false);
    let active_check = check_active_profile(active_id.as_deref(), marker_source, active_exists).with_group(GROUP_PROFILE);

    // 激活 profile 内容
    let vars = active_id.as_ref().and_then(|id| {
        dir.as_deref().map(|d| d.join(format!("{}.env", id)))
            .and_then(|p| std::fs::read_to_string(p).ok())
    }).map(|c| crate::parse_env_file(&c)).unwrap_or_default();
    let has_credential = vars.iter().any(|(k, v)| {
        (k == "ANTHROPIC_API_KEY" || k == "ANTHROPIC_AUTH_TOKEN") && !v.is_empty()
    });
    let base_url = vars.iter()
        .find(|(k, _)| k == "ANTHROPIC_BASE_URL")
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty());
    let has_model = vars.iter().any(|(k, v)| k == "ANTHROPIC_MODEL" && !v.is_empty());
    let content_check = check_profile_content(
        active_id.as_deref(), has_credential, has_model, base_url.as_deref(),
    ).with_group(GROUP_PROFILE);

    let inject_check = check_profile_injected(vars.len(), active_id.as_deref()).with_group(GROUP_PROFILE);

    vec![found_check, active_check, content_check, inject_check]
}

/// profile 目录统一为用户级 ~/.claude/.env.profiles（跨项目共享）
fn profile_location_label(_d: &std::path::Path) -> &'static str {
    "用户主目录"
}

fn list_env_profiles(d: &std::path::Path) -> Vec<String> {
    let mut ids = std::fs::read_dir(d).ok().map(|e| {
        e.flatten()
            .filter(|e| e.path().extension().map_or(false, |x| x == "env"))
            .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().to_string()))
            .collect::<Vec<_>>()
    }).unwrap_or_default();
    ids.sort();
    ids
}

/// 读取一个环境变量在用户(HKCU)与系统(HKLM)注册表中的持久化值。
fn read_registry_env(name: &str) -> (Option<String>, Option<String>) {
    let user = reg_query("HKCU", "Environment", name);
    let system = reg_query("HKLM", "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", name);
    (user, system)
}

fn reg_query(hive: &str, subkey: &str, name: &str) -> Option<String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = std::process::Command::new("reg");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .args(["query", &format!("{}\\{}", hive, subkey), "/v", name])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    parse_reg_query_output(&String::from_utf8_lossy(&out.stdout), name)
}

/// 解析 `reg query <key> /v <name>` 输出为值。输出形如 `<name> <类型> <值>`，
/// 值可能含空格；值超长被 reg.exe 折行时续行需拼接（续行不含 name 前缀）。
/// 不再依赖「最后一行」——折行时最后一行只是片段，取不到完整值。
fn parse_reg_query_output(text: &str, name: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    // 值行 = 以 name 开头且 name 后是空白（避免误配 HKEY_... 头或别的同名前缀）
    let is_value_line = |s: &str| {
        s.len() > name.len() && s.starts_with(name) && s.as_bytes()[name.len()].is_ascii_whitespace()
    };
    let (idx, line) = lines.iter().enumerate().find(|(_, l)| is_value_line(l))?;
    let toks: Vec<&str> = line.split_whitespace().collect();
    if toks.len() < 3 { return None; }
    let mut value = toks[2..].join(" ");
    // 值超长被 reg.exe 折行：后续非值行拼接（续行不含 name 前缀）
    for cont in lines.iter().skip(idx + 1) {
        if is_value_line(cont) {
            break;
        }
        value.push_str(cont);
    }
    Some(value)
}

#[tauri::command]
pub async fn run_env_diagnostics() -> Result<DiagnosticsReport, String> {
    let categories = vec![DiagnosticCategory {
        id: "env".into(),
        title: "环境".into(),
        checks: env_category(),
    }];
    Ok(DiagnosticsReport {
        timestamp: now_ms(),
        categories,
    })
}

/// 网络连通诊断 — 独立命令：探测较慢（HTTP/TCP ≤3s 超时），放到工作线程执行，
/// 避免阻塞 Tauri 异步运行时；前端对网络分类单独显示加载态。
#[tauri::command]
pub async fn run_network_diagnostics() -> Result<DiagnosticsReport, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let report = DiagnosticsReport {
            timestamp: now_ms(),
            categories: vec![DiagnosticCategory {
                id: "network".into(),
                title: "网络连通".into(),
                checks: network_category(),
            }],
        };
        let _ = tx.send(report);
    });
    rx.recv().map_err(|e| format!("Network diagnostics panicked: {}", e))
}

/// 工作区诊断 — 绑定状态 / 局部设置 / 会话数据库（本地毫秒级）。
#[tauri::command]
pub async fn run_workspace_diagnostics() -> Result<DiagnosticsReport, String> {
    let categories = vec![DiagnosticCategory {
        id: "workspace".into(),
        title: "工作区".into(),
        checks: workspace_checks(),
    }];
    Ok(DiagnosticsReport { timestamp: now_ms(), categories })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_dir_exists_is_pass() {
        let c = check_install_dir("C:/app", true);
        assert_eq!(c.id, "install_dir");
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("C:/app"));
    }

    #[test]
    fn install_dir_missing_is_fail() {
        let c = check_install_dir("C:/nonexistent", false);
        assert_eq!(c.status, CheckStatus::Fail);
    }

    #[test]
    fn gui_version_reports_current_version() {
        let c = check_gui_version("1.0.0-preview");
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("1.0.0-preview"));
    }

    // ── CLAUDE_CODE_HAHA_HOME ──

    #[test]
    fn home_env_missing_everywhere_fails() {
        let c = check_home_env(None, None, None, false);
        assert_eq!(c.status, CheckStatus::Fail);
        assert!(c.detail.contains("重新运行安装"));
    }

    #[test]
    fn home_env_process_matches_registry_passes() {
        let c = check_home_env(Some("C:/app"), Some("C:/app"), None, true);
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("一致"));
    }

    #[test]
    fn home_env_process_mismatch_registry_warns_not_restarted() {
        let c = check_home_env(Some("C:/new"), Some("C:/old"), None, true);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("未重启"));
    }

    #[test]
    fn home_env_only_in_registry_warns_restart() {
        let c = check_home_env(None, Some("C:/app"), None, true);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("重启"));
    }

    #[test]
    fn home_env_dir_missing_fails() {
        let c = check_home_env(Some("C:/gone"), Some("C:/gone"), None, false);
        assert_eq!(c.status, CheckStatus::Fail);
        assert!(c.detail.contains("不存在"));
    }

    #[test]
    fn home_env_process_only_no_registry_passes() {
        let c = check_home_env(Some("C:/app"), None, None, true);
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn home_env_system_matches_ignores_user_leftover() {
        // 系统级优先 —— process=NEW, sys=NEW, user=OLD → 判 Pass(系统是权威);
        // 用户级残留由 check_user_leftover 单独提示, 不再让本项误报不匹配。
        let c = check_home_env(Some("C:/new"), Some("C:/old"), Some("C:/new"), true);
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("系统 + 用户"));
    }

    #[test]
    fn home_env_reports_both_scopes() {
        let c = check_home_env(Some("C:/app"), Some("C:/app"), Some("C:/app"), true);
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("系统 + 用户"));
    }

    // ── CLAUDE_CODE_GIT_BASH_PATH ──

    #[test]
    fn git_bash_path_missing_everywhere_fails() {
        let c = check_git_bash_path(None, None, false);
        assert_eq!(c.status, CheckStatus::Fail);
        assert!(c.detail.contains("直接退出"));
    }

    #[test]
    fn git_bash_path_exists_passes() {
        let c = check_git_bash_path(Some("C:/app/git/usr/bin/bash.exe"), Some("C:/app/git/usr/bin/bash.exe"), true);
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn git_bash_path_missing_file_fails() {
        let c = check_git_bash_path(Some("C:/app/git/usr/bin/bash.exe"), Some("C:/app/git/usr/bin/bash.exe"), false);
        assert_eq!(c.status, CheckStatus::Fail);
    }

    #[test]
    fn git_bash_path_registry_only_warns_restart() {
        // 仅注册表有值、进程未读到 —— 存活的后端进程仍会 exit，必须警告
        let c = check_git_bash_path(None, Some("C:/app/git/usr/bin/bash.exe"), false);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("重启"));
    }

    #[test]
    fn git_bash_path_no_process_no_registry_is_fail_even_if_file_known() {
        let c = check_git_bash_path(None, None, true);
        assert_eq!(c.status, CheckStatus::Fail);
    }

    // ── 作用域一致性 ──

    #[test]
    fn env_scope_process_matches_registry_passes() {
        let c = check_env_scope(Some("C:/app"), Some("C:/app"), None);
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("一致"));
    }

    #[test]
    fn env_scope_mismatch_warns_not_restarted() {
        let c = check_env_scope(Some("C:/new"), Some("C:/old"), None);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("未重启"));
    }

    #[test]
    fn env_scope_registry_only_warns_restart() {
        let c = check_env_scope(None, Some("C:/app"), None);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("重启"));
    }

    #[test]
    fn env_scope_process_only_no_registry_passes() {
        let c = check_env_scope(Some("C:/app"), None, None);
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn env_scope_nothing_set_is_na() {
        let c = check_env_scope(None, None, None);
        assert_eq!(c.status, CheckStatus::Na);
    }

    #[test]
    fn env_scope_system_matches_ignores_user_leftover() {
        // 系统级优先 —— process=NEW, sys=NEW, user=OLD → Pass(与 check_home_env 一致);
        // user 残留专门由 check_user_leftover 报告。
        let c = check_env_scope(Some("C:/new"), Some("C:/old"), Some("C:/new"));
        assert_eq!(c.status, CheckStatus::Pass);
    }

    // ── PATH ──

    #[test]
    fn path_entries_all_present_passes() {
        let c = check_path_entries(
            "C:/Windows;C:\\app;C:\\app\\bin;C:\\app\\git\\usr\\bin",
            None, "%CLAUDE_CODE_HAHA_HOME%", "C:\\app", &["", "\\bin", "\\git\\usr\\bin"],
        );
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn path_entries_via_var_token_in_registry_passes() {
        let c = check_path_entries(
            "C:/Windows",
            Some("%CLAUDE_CODE_HAHA_HOME%;%CLAUDE_CODE_HAHA_HOME%\\bin"),
            "%CLAUDE_CODE_HAHA_HOME%", "C:\\app", &["", "\\bin", "\\git\\usr\\bin"],
        );
        assert_eq!(c.status, CheckStatus::Warn, "git\\usr\\bin 缺失应警告");
        assert!(c.detail.contains("git\\usr\\bin"));
    }

    #[test]
    fn path_entries_missing_warns() {
        let c = check_path_entries(
            "C:/Windows", None, "%CLAUDE_CODE_HAHA_HOME%", "C:\\app",
            &["", "\\bin", "\\git\\usr\\bin"],
        );
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("PATH 缺少"));
    }

    #[test]
    fn path_entries_case_insensitive() {
        let c = check_path_entries(
            "c:/windows;C:/APP", None, "%CLAUDE_CODE_HAHA_HOME%", "C:/App", &[""],
        );
        assert_eq!(c.status, CheckStatus::Pass);
    }

    // ── strip_install_entries / user_leftover ──

    #[test]
    fn strip_install_entries_removes_expanded_and_var_forms() {
        let install = r"C:\app";
        let path = "C:\\Windows;C:\\app;C:\\app\\git\\usr\\bin;%CLAUDE_CODE_HAHA_HOME%;D:\\keep;%CLAUDE_CODE_HAHA_HOME%\\bin";
        let out = strip_install_entries(path, install);
        assert!(!out.contains("C:\\app"), "展开形式应被移除: {}", out);
        assert!(!out.contains("%CLAUDE_CODE_HAHA_HOME%"), "%VAR% 形式应被移除: {}", out);
        assert!(out.contains("C:\\Windows"));
        assert!(out.contains("D:\\keep"));
    }

    #[test]
    fn strip_install_entries_keeps_unrelated_when_empty() {
        assert_eq!(strip_install_entries(r"C:\Windows;D:\git\bin", r"C:\App"), r"C:\Windows;D:\git\bin");
    }

    #[test]
    fn strip_install_entries_empty_result_when_all_install() {
        assert_eq!(strip_install_entries(r"%CLAUDE_CODE_HAHA_HOME%;C:\App\bin", r"C:\App"), "");
    }

    #[test]
    fn user_leftover_pass_when_clean() {
        let c = user_leftover_check(None, None, None, r"C:\app");
        assert_eq!(c.status, CheckStatus::Pass, "{}", c.detail);
    }

    #[test]
    fn user_leftover_warns_on_leftovers() {
        let c = user_leftover_check(
            Some(r"C:\app"), None,
            Some(r"C:\Windows;%CLAUDE_CODE_HAHA_HOME%\bin"), r"C:\app",
        );
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("CLAUDE_CODE_HAHA_HOME"));
        assert!(c.detail.contains("PATH"));
    }

    #[test]
    fn user_leftover_warns_on_path_install_entry_only() {
        let c = user_leftover_check(None, None, Some(r"C:\Windows;C:\app\git\usr\bin"), r"C:\app");
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("PATH"));
    }

    // ── 安装目录组件 ──

    #[test]
    fn install_dir_components_all_present_passes() {
        let c = check_install_dir_components("C:/app", true, true, true, true);
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn install_dir_components_optional_missing_warns() {
        let c = check_install_dir_components("C:/app", true, true, false, false);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("可选组件"));
    }

    #[test]
    fn install_dir_root_missing_fails() {
        let c = check_install_dir_components("C:/app", false, false, false, false);
        assert_eq!(c.status, CheckStatus::Fail);
    }

    // ── %VAR% 展开 ──

    #[test]
    fn expand_env_vars_replaces_tokens() {
        let lookup = |n: &str| match n {
            "CLAUDE_CODE_HAHA_HOME" => Some("C:/app".into()),
            _ => None,
        };
        assert_eq!(
            expand_env_vars("%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin\\bash.exe", &lookup),
            "C:/app\\git\\usr\\bin\\bash.exe"
        );
    }

    #[test]
    fn expand_env_vars_leaves_unknown_token_empty() {
        let lookup = |_: &str| None;
        assert_eq!(expand_env_vars("%MISSING%\\bin", &lookup), "\\bin");
    }

    #[test]
    fn expand_env_vars_keeps_plain_text() {
        let lookup = |_: &str| None;
        assert_eq!(expand_env_vars("C:/plain/path", &lookup), "C:/plain/path");
    }

    // ── reg query 输出解析 ──

    #[test]
    fn parse_reg_query_value_with_spaces() {
        assert_eq!(
            parse_reg_query_output(
                "HKEY_CURRENT_USER\\Environment\n    CLAUDE_CODE_HAHA_HOME    REG_SZ    C:\\Program Files (x86)\\Claude Code Haha\n",
                "CLAUDE_CODE_HAHA_HOME"
            ).as_deref(),
            Some("C:\\Program Files (x86)\\Claude Code Haha")
        );
    }

    #[test]
    fn parse_reg_query_expand_sz() {
        assert_eq!(
            parse_reg_query_output(
                "HKEY_LOCAL_MACHINE\\...\\Environment\n    GIT    REG_EXPAND_SZ    %CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin\\bash.exe\n",
                "GIT"
            ).as_deref(),
            Some("%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin\\bash.exe")
        );
    }

    #[test]
    fn parse_reg_query_long_path_wrapped_concatenates() {
        // 长 PATH 被 reg.exe 折行成多行：续行拼接回完整值（旧实现只取最后一行会丢前半段）
        let wrapped = "HKEY_CURRENT_USER\\Environment\n    PATH    REG_EXPAND_SZ    %CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Users\\SZH\\.cargo\\bin;C:\\Users\\SZH\\AppData\n\\Local\\Programs\\Microsoft VS Code\\bin;%CLAUDE_CODE_HAHA_HOME%\\python\n";
        assert_eq!(
            parse_reg_query_output(wrapped, "PATH").as_deref(),
            Some("%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Users\\SZH\\.cargo\\bin;C:\\Users\\SZH\\AppData\\Local\\Programs\\Microsoft VS Code\\bin;%CLAUDE_CODE_HAHA_HOME%\\python")
        );
    }

    #[test]
    fn parse_reg_query_value_not_found_is_none() {
        assert_eq!(parse_reg_query_output("ERROR: The system was unable to find the specified registry key or value.\n", "PATH"), None);
        assert_eq!(parse_reg_query_output("", "PATH"), None);
    }

    // ── Profile 环境文件 ──

    #[test]
    fn profiles_found_with_list_passes() {
        let c = check_profiles_found(true, "工作区根", &["p1".to_string(), "p2".to_string()]);
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("p1"));
    }

    #[test]
    fn profiles_dir_missing_fails() {
        let c = check_profiles_found(false, "", &[]);
        assert_eq!(c.status, CheckStatus::Fail);
        assert!(c.detail.contains("Profile 管理"));
    }

    #[test]
    fn profiles_dir_empty_warns() {
        let c = check_profiles_found(true, "用户主目录", &[]);
        assert_eq!(c.status, CheckStatus::Warn);
    }

    #[test]
    fn active_profile_resolved_passes() {
        let c = check_active_profile(Some("work"), "工作区 active-profile", true);
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("work"));
    }

    #[test]
    fn active_profile_marker_missing_warns() {
        let c = check_active_profile(None, "", true);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("兜底"));
    }

    #[test]
    fn active_profile_points_to_missing_fails() {
        let c = check_active_profile(Some("ghost"), "工作区 active-profile", false);
        assert_eq!(c.status, CheckStatus::Fail);
        assert!(c.detail.contains("ghost"));
    }

    #[test]
    fn profile_content_full_passes() {
        let c = check_profile_content(Some("work"), true, true, Some("http://example.com"));
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("http://example.com"));
    }

    #[test]
    fn profile_content_missing_credential_fails() {
        let c = check_profile_content(Some("work"), false, true, Some("http://example.com"));
        assert_eq!(c.status, CheckStatus::Fail);
    }

    #[test]
    fn profile_content_missing_base_url_warns() {
        let c = check_profile_content(Some("work"), true, true, None);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("BASE_URL"));
    }

    #[test]
    fn profile_content_missing_model_warns() {
        let c = check_profile_content(Some("work"), true, false, Some("http://example.com"));
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("MODEL"));
    }

    #[test]
    fn profile_content_no_active_is_na() {
        let c = check_profile_content(None, false, false, None);
        assert_eq!(c.status, CheckStatus::Na);
    }

    #[test]
    fn profile_injected_with_vars_passes() {
        let c = check_profile_injected(3, Some("work"));
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn profile_injected_no_active_is_na() {
        let c = check_profile_injected(0, None);
        assert_eq!(c.status, CheckStatus::Na);
    }

    #[test]
    fn profile_injected_empty_profile_warns() {
        let c = check_profile_injected(0, Some("work"));
        assert_eq!(c.status, CheckStatus::Warn);
    }

    // ── 网络连通 ──

    #[test]
    fn update_server_reachable_passes() {
        let c = check_update_server(true, "http://192.168.186.96:8765");
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("192.168.186.96"));
    }

    #[test]
    fn update_server_unreachable_fails() {
        let c = check_update_server(false, "http://192.168.186.96:8765");
        assert_eq!(c.status, CheckStatus::Fail);
    }

    #[test]
    fn cloud_server_reachable_passes() {
        let c = check_cloud_server(true, "http://123.56.66.84:8765");
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn cloud_server_unreachable_fails() {
        let c = check_cloud_server(false, "http://123.56.66.84:8765");
        assert_eq!(c.status, CheckStatus::Fail);
    }

    #[test]
    fn mcp_running_with_dynamic_port_passes() {
        // 多实例时端口动态（13920-14000），非固定 13921
        let c = check_mcp_service(13925);
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("13925"));
    }

    #[test]
    fn mcp_not_started_is_na() {
        let c = check_mcp_service(0);
        assert_eq!(c.status, CheckStatus::Na);
        assert!(c.detail.contains("未启动"));
    }

    #[test]
    fn api_endpoint_not_configured_is_na() {
        let c = check_api_endpoint(false, None, false);
        assert_eq!(c.status, CheckStatus::Na);
    }

    #[test]
    fn api_endpoint_reachable_passes() {
        let c = check_api_endpoint(true, Some("api.deepseek.com:443"), true);
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn api_endpoint_unreachable_fails() {
        let c = check_api_endpoint(true, Some("api.deepseek.com:443"), false);
        assert_eq!(c.status, CheckStatus::Fail);
    }

    #[test]
    fn api_endpoint_unparsable_host_warns() {
        let c = check_api_endpoint(true, None, false);
        assert_eq!(c.status, CheckStatus::Warn);
    }

    #[test]
    fn url_host_port_parses_explicit_port() {
        assert_eq!(url_host_port("http://127.0.0.1:13921/mcp"), Some(("127.0.0.1".into(), 13921)));
    }

    #[test]
    fn url_host_port_defaults_https_443() {
        assert_eq!(url_host_port("https://api.deepseek.com"), Some(("api.deepseek.com".into(), 443)));
    }

    #[test]
    fn url_host_port_defaults_http_80() {
        assert_eq!(url_host_port("http://192.168.186.96"), Some(("192.168.186.96".into(), 80)));
    }

    // ── 工作区 ──

    #[test]
    fn workspace_bound_passes() {
        let c = check_workspace_bound(true, "C:/ws");
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("C:/ws"));
    }

    #[test]
    fn workspace_unbound_is_na() {
        let c = check_workspace_bound(false, "");
        assert_eq!(c.status, CheckStatus::Na);
        assert!(c.detail.contains("未绑定"));
    }

    #[test]
    fn workspace_local_settings_exists_passes() {
        let c = check_workspace_local_settings(true, "C:/ws/.claude/settings.local.json");
        assert_eq!(c.status, CheckStatus::Pass);
        assert!(c.detail.contains("存在"));
    }

    #[test]
    fn workspace_local_settings_missing_is_normal() {
        let c = check_workspace_local_settings(false, "C:/ws/.claude/settings.local.json");
        assert_eq!(c.status, CheckStatus::Pass, "首次进入工作区缺文件是正常状态");
        assert!(c.detail.contains("不存在"));
    }

    #[test]
    fn workspace_db_ok_passes() {
        let c = check_workspace_db(true, "C:/ws/.claude/data.db", "可正常打开");
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn workspace_db_broken_fails() {
        let c = check_workspace_db(false, "C:/ws/.claude/data.db", "打开失败: corrupt");
        assert_eq!(c.status, CheckStatus::Fail);
        assert!(c.detail.contains("corrupt"));
    }

    // ── missing_path_entries ──

    fn dir_exists_set<'a>(existing: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p: &str| existing.iter().any(|e| p.eq_ignore_ascii_case(e))
    }

    #[test]
    fn path_missing_python_and_git_bin_are_listed() {
        // 安装根 / bin / git\usr\bin 已在进程 PATH，但 git\bin、python、python\Scripts 缺失
        let install = "C:\\app";
        let proc = "C:\\Windows;C:\\app;C:\\app\\bin;C:\\app\\git\\usr\\bin";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin", "C:\\app\\git\\bin", "C:\\app\\python", "C:\\app\\python\\Scripts"];
        let missing = missing_path_entries(proc, None, install, dir_exists_set(&existing));
        assert_eq!(missing, vec!["C:\\app\\git\\bin", "C:\\app\\python", "C:\\app\\python\\Scripts"]);
    }

    #[test]
    fn path_all_present_returns_empty() {
        let install = "C:\\app";
        let proc = "C:\\app;C:\\app\\bin;C:\\app\\git\\usr\\bin;C:\\app\\git\\bin;C:\\app\\python;C:\\app\\python\\Scripts";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin", "C:\\app\\git\\bin", "C:\\app\\python", "C:\\app\\python\\Scripts"];
        let missing = missing_path_entries(proc, None, install, dir_exists_set(&existing));
        assert_eq!(missing, Vec::<String>::new());
    }

    #[test]
    fn path_dir_not_exist_is_not_added() {
        // python 目录不存在 → 即使 PATH 没有也不补
        let install = "C:\\app";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin"];
        let missing = missing_path_entries("C:\\Windows", None, install, dir_exists_set(&existing));
        assert_eq!(missing, vec!["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin"]);
    }

    #[test]
    fn path_user_registry_has_var_form_not_duplicated() {
        // 注册表存 %CLAUDE_CODE_HAHA_HOME% 形式 → 不再补完整路径
        let install = "C:\\app";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin", "C:\\app\\python"];
        let reg = "%CLAUDE_CODE_HAHA_HOME%;%CLAUDE_CODE_HAHA_HOME%\\python";
        let missing = missing_path_entries("C:\\Windows", Some(reg), install, dir_exists_set(&existing));
        assert_eq!(missing, vec!["C:\\app\\bin", "C:\\app\\git\\usr\\bin"]);
    }

    #[test]
    fn path_case_insensitive_already_present() {
        let install = "C:/App";
        let existing = ["C:/App", "C:/App/python"];
        let proc = "c:/app;c:/app/python";
        let missing = missing_path_entries(proc, None, install, dir_exists_set(&existing));
        assert_eq!(missing, Vec::<String>::new());
    }

    // ── path_entries_var_form ──

    #[test]
    fn var_form_root_is_home_var() {
        assert_eq!(path_entries_var_form("C:\\app", "C:\\app"), "%CLAUDE_CODE_HAHA_HOME%");
    }

    #[test]
    fn var_form_subdir_prefixed() {
        assert_eq!(
            path_entries_var_form("C:\\app", "C:\\app\\python\\Scripts"),
            "%CLAUDE_CODE_HAHA_HOME%\\python\\Scripts"
        );
    }

    #[test]
    fn var_form_unrelated_path_kept_as_is() {
        // 不在安装根下 → 保留原样，避免丢信息
        assert_eq!(path_entries_var_form("C:\\app", "D:\\other"), "D:\\other");
    }

    // ── arrange_install_path ──

    fn var_entry(s: &str) -> String {
        if s.is_empty() { "%CLAUDE_CODE_HAHA_HOME%".to_string() } else { format!("%CLAUDE_CODE_HAHA_HOME%{}", s) }
    }
    fn exp_entry(s: &str) -> String {
        format!("C:\\app{}", s)
    }

    #[test]
    fn git_bash_moved_to_front_behind_wsl() {
        // 当前 PATH: C:\Windows\... 前 + WSL shim + git\usr\bin(展开)后 → 重排后 git\usr\bin 最前
        let current = "C:\\Windows\\System32;C:\\Windows\\System32\\WSL;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin";
        let out = arrange_install_path(current, "C:\\app", &var_entry, Some("\\git\\usr\\bin"), &[]);
        assert_eq!(
            out,
            "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows\\System32;C:\\Windows\\System32\\WSL"
        );
    }

    #[test]
    fn git_bash_dedup_var_and_expanded_forms() {
        // 展开形式已存在 + %VAR% 形式也存在 → 只保留最前一条
        let current = "C:\\app\\git\\usr\\bin;C:\\Windows;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin";
        let out = arrange_install_path(current, "C:\\app", &var_entry, Some("\\git\\usr\\bin"), &[]);
        assert_eq!(out, "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows");
    }

    #[test]
    fn append_missing_after_original() {
        // 无 git bash 前置时：原 PATH 保持，缺失项追加到末尾
        let current = "C:\\Windows";
        let out = arrange_install_path(current, "C:\\app", &var_entry, None, &["\\bin", "\\python"]);
        assert_eq!(out, "C:\\Windows;%CLAUDE_CODE_HAHA_HOME%\\bin;%CLAUDE_CODE_HAHA_HOME%\\python");
    }

    #[test]
    fn prepend_plus_append_order() {
        let current = "C:\\Windows";
        let out = arrange_install_path(current, "C:\\app", &var_entry, Some("\\git\\usr\\bin"), &["\\bin"]);
        assert_eq!(
            out,
            "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows;%CLAUDE_CODE_HAHA_HOME%\\bin"
        );
    }

    #[test]
    fn expanded_form_used_for_process() {
        let current = "C:\\Windows;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin";
        let out = arrange_install_path(current, "C:\\app", &exp_entry, Some("\\git\\usr\\bin"), &["\\bin"]);
        assert_eq!(out, "C:\\app\\git\\usr\\bin;C:\\Windows;C:\\app\\bin");
    }

    #[test]
    fn empty_current_only_prepend_and_append() {
        let out = arrange_install_path("", "C:\\app", &var_entry, Some("\\git\\usr\\bin"), &["\\bin"]);
        assert_eq!(out, "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;%CLAUDE_CODE_HAHA_HOME%\\bin");
    }

    // ── normalize_install_entries ──

    #[test]
    fn normalize_converts_stale_expanded_entries_to_var_form() {
        // 旧格式系统 PATH：安装目录条目是展开全路径(且大小写不同) → 统一成 %VAR% 引用，非安装条目保留
        let p = r"C:\Windows;c:\APP\git\bin;C:\Program Files\Foo;C:\APP\git\usr\bin";
        let out = normalize_install_entries(p, r"C:\app", &|s| path_entries_var_form(r"C:\app", s));
        assert_eq!(
            out,
            r"C:\Windows;%CLAUDE_CODE_HAHA_HOME%\git\bin;C:\Program Files\Foo;%CLAUDE_CODE_HAHA_HOME%\git\usr\bin"
        );
    }

    #[test]
    fn normalize_preserves_var_ref_and_dedupes() {
        // 已 %VAR% 引用原样保留；同一目录展开形式与引用形式并存 → 去重
        let p = r"%CLAUDE_CODE_HAHA_HOME%;C:\app;C:\Windows;C:\app";
        let out = normalize_install_entries(p, r"C:\app", &|s| path_entries_var_form(r"C:\app", s));
        assert_eq!(out, r"%CLAUDE_CODE_HAHA_HOME%;C:\Windows");
    }

    #[test]
    fn normalize_unrelated_path_untouched() {
        let p = r"D:\other;D:\app2\bin;C:\Program Files\Git\cmd";
        let out = normalize_install_entries(p, r"C:\app", &|s| path_entries_var_form(r"C:\app", s));
        assert_eq!(out, p);
    }

    // ── plan_path_fix ──

    #[test]
    fn plan_path_proc_missing_but_sys_present_is_appended_to_proc() {
        // 修复③：条目在系统已有但进程缺 → 补进进程（旧实现只算并集，漏补进程）
        let install = "C:\\app";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin", "C:\\app\\git\\bin", "C:\\app\\python"];
        let sys = "%CLAUDE_CODE_HAHA_HOME%;%CLAUDE_CODE_HAHA_HOME%\\bin;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;%CLAUDE_CODE_HAHA_HOME%\\git\\bin;%CLAUDE_CODE_HAHA_HOME%\\python;C:\\Windows";
        let proc = "C:\\Windows;C:\\app;C:\\app\\bin;C:\\app\\git\\usr\\bin;C:\\app\\git\\bin"; // 缺 python（sys 有）
        let plan = plan_path_fix(Some(sys), None, proc, install, dir_exists_set(&existing)).expect("应有修复");
        assert!(plan.proc_changed, "进程 PATH 应补 python");
        assert!(plan.new_proc_path.contains("C:\\app\\python"), "进程 PATH 应含 python: {}", plan.new_proc_path);
    }

    #[test]
    fn plan_path_converts_stale_sys_expanded_to_var_and_prepends_git_bash() {
        // 新策略：系统 PATH 精简到根 + git\usr\bin（旧 \bin\python 等子目录不再持久化）
        let install = "C:\\app";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin", "C:\\app\\git\\bin", "C:\\app\\python"];
        let sys = "C:\\app\\git\\bin;C:\\Windows;C:\\Program Files\\Zulu\\zulu-21\\bin";
        let proc = "C:\\app\\git\\usr\\bin;C:\\Windows;C:\\Program Files\\Zulu\\zulu-21\\bin;C:\\app;C:\\app\\bin;C:\\app\\git\\bin;C:\\app\\python";
        let plan = plan_path_fix(Some(sys), None, proc, install, dir_exists_set(&existing)).expect("应有修复");
        assert!(plan.sys_changed);
        let parts: Vec<&str> = plan.new_sys_path.split(';').collect();
        assert_eq!(parts[0], "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin", "git\\usr\\bin 应前置");
        assert!(!plan.new_sys_path.contains("git\\bin"), "git\\bin 冗余子目录条目应精简删除");
        assert!(!plan.new_sys_path.contains("python"), "系统不补 python 子目录(进程由 GUI 前置)");
        assert!(plan.new_sys_path.contains("%CLAUDE_CODE_HAHA_HOME%"), "根应补上");
        assert!(plan.new_sys_path.contains("C:\\Program Files\\Zulu\\zulu-21\\bin"), "非安装条目原样保留");
    }

    #[test]
    fn plan_path_all_correct_returns_none() {
        // 新策略就绪态：系统 PATH 只有根 + git\usr\bin，进程 PATH 含全部工具目录 → 无操作
        let install = "C:\\app";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin", "C:\\app\\git\\bin"];
        let sys = "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows;%CLAUDE_CODE_HAHA_HOME%";
        let proc = "C:\\app\\git\\usr\\bin;C:\\Windows;C:\\app;C:\\app\\bin;C:\\app\\git\\bin";
        assert!(plan_path_fix(Some(sys), None, proc, install, dir_exists_set(&existing)).is_none());
    }

    // ── slim_system_path（新策略：系统 PATH 精简到根 + git\usr\bin）──

    #[test]
    fn slim_system_path_removes_redundant_subdirs_keeps_root_and_git_bash() {
        let sys = "%CLAUDE_CODE_HAHA_HOME%;%CLAUDE_CODE_HAHA_HOME%\\bin;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;%CLAUDE_CODE_HAHA_HOME%\\git\\bin;%CLAUDE_CODE_HAHA_HOME%\\python;%CLAUDE_CODE_HAHA_HOME%\\python\\Scripts;C:\\Windows";
        let slim = slim_system_path(sys, r"C:\Program Files (x86)\Claude Code Haha").expect("应有精简");
        let parts: Vec<&str> = slim.split(';').collect();
        assert_eq!(parts, vec!["%CLAUDE_CODE_HAHA_HOME%", "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin", "C:\\Windows"]);
    }

    #[test]
    fn slim_system_path_handles_expanded_absolute_form() {
        let sys = "C:\\app\\git\\bin;C:\\Windows;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin";
        let slim = slim_system_path(sys, "C:\\app").expect("应删 git\\bin");
        assert!(!slim.contains("git\\bin"), "旧展开 git\\bin 冗余应删");
        assert!(slim.contains("%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin"));
        assert!(slim.contains("C:\\Windows"));
    }

    #[test]
    fn slim_system_path_noop_when_already_slim() {
        let sys = "%CLAUDE_CODE_HAHA_HOME%;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows";
        assert!(slim_system_path(sys, "C:\\app").is_none(), "已精简则无操作");
    }

    #[test]
    fn slim_system_path_keeps_unrelated_entries() {
        let sys = "C:\\Windows;C:\\Program Files\\Zulu;%CLAUDE_CODE_HAHA_HOME%\\python";
        let slim = slim_system_path(sys, "C:\\app").expect("应删 python");
        assert!(!slim.contains("python"));
        assert!(slim.contains("C:\\Windows"));
        assert!(slim.contains("Zulu"));
    }

    // ── 遗留检查项（GIT_BASH_PATH / SHELL / 系统 PATH 精简）──

    #[test]
    fn git_bash_legacy_warns_when_registered() {
        assert_eq!(check_git_bash_legacy(Some("C:\\app\\git\\usr\\bin\\bash.exe"), None).status, CheckStatus::Warn);
        assert_eq!(check_git_bash_legacy(None, None).status, CheckStatus::Pass);
    }

    #[test]
    fn shell_leftover_warns_when_points_to_install() {
        assert_eq!(check_shell_leftover(Some("%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin\\bash.exe"), None, "C:\\app").status, CheckStatus::Warn);
        assert_eq!(check_shell_leftover(Some("C:\\msys64\\usr\\bin\\bash.exe"), None, "C:\\app").status, CheckStatus::Pass);
        assert_eq!(check_shell_leftover(None, None, "C:\\app").status, CheckStatus::Pass);
    }

    #[test]
    fn system_path_slim_check_warns_on_redundant() {
        let sys = "%CLAUDE_CODE_HAHA_HOME%;%CLAUDE_CODE_HAHA_HOME%\\python;C:\\Windows";
        assert_eq!(check_system_path_slim(Some(sys), "C:\\app").status, CheckStatus::Warn);
        let slim = "%CLAUDE_CODE_HAHA_HOME%;%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows";
        assert_eq!(check_system_path_slim(Some(slim), "C:\\app").status, CheckStatus::Pass);
        assert_eq!(check_system_path_slim(None, "C:\\app").status, CheckStatus::Pass);
    }

    #[test]
    fn plan_path_user_residue_is_stripped() {
        // HKCU PATH 残留安装条目 → 清掉，非安装条目保留
        let install = "C:\\app";
        let existing = ["C:\\app", "C:\\app\\bin", "C:\\app\\git\\usr\\bin", "C:\\app\\git\\bin"];
        let sys = "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows";
        let user = "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Users\\me\\bin;%CLAUDE_CODE_HAHA_HOME%\\python";
        let proc = "C:\\app\\git\\usr\\bin;C:\\Windows;C:\\Users\\me\\bin";
        let plan = plan_path_fix(Some(sys), Some(user), proc, install, dir_exists_set(&existing)).expect("应有清理");
        assert_eq!(plan.user_action, Some(Some("C:\\Users\\me\\bin".into())));
    }

    #[test]
    fn plan_path_user_residue_empties_means_delete() {
        let install = "C:\\app";
        let existing = ["C:\\app\\git\\usr\\bin"];
        let sys = "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin;C:\\Windows";
        let user = "%CLAUDE_CODE_HAHA_HOME%\\git\\usr\\bin";
        let proc = "C:\\app\\git\\usr\\bin;C:\\Windows";
        let plan = plan_path_fix(Some(sys), Some(user), proc, install, dir_exists_set(&existing)).expect("应有删除");
        assert_eq!(plan.user_action, Some(None));
    }

    // ── first_bash_in_path / check_bash_resolution ──

    #[test]
    fn first_bash_picks_first_dir_with_bash() {
        // 第一个含 bash.exe 的目录 = 裸 bash 实际解析目标
        let p = "C:\\Windows\\System32;D:\\bin;E:\\git\\usr\\bin";
        // 用已知存在的目录做断言——System32 必有 bash.exe(装 WSL)或 Win 兜底
        let r = first_bash_in_path(p);
        assert!(r.is_some());
    }

    #[test]
    fn first_bash_skips_empty_and_slash_only() {
        assert_eq!(first_bash_in_path(";; ;\\;C:\\Windows\\System32;"), Some("C:\\Windows\\System32".into()));
    }

    #[test]
    fn first_bash_none_when_no_bash_dirs() {
        assert_eq!(first_bash_in_path("C:\\no_such_dir_xyz;D:\\also_none"), None);
    }

    #[test]
    fn bash_resolution_ours_is_pass() {
        let c = check_bash_resolution(Some("C:\\app\\git\\usr\\bin"), &["C:\\app\\git\\usr\\bin".into()]);
        assert_eq!(c.status, CheckStatus::Pass);
    }

    #[test]
    fn bash_resolution_wsl_hijack_is_warn() {
        let c = check_bash_resolution(Some("C:\\Windows\\System32"), &["C:\\app\\git\\usr\\bin".into()]);
        assert_eq!(c.status, CheckStatus::Warn);
        assert!(c.detail.contains("截胡"));
    }

    #[test]
    fn bash_resolution_missing_is_fail() {
        let c = check_bash_resolution(None, &["C:\\app\\git\\usr\\bin".into()]);
        assert_eq!(c.status, CheckStatus::Fail);
    }

    // ── profile_has_credentials ──

    #[test]
    fn profile_with_api_key_has_credentials() {
        let c = "ANTHROPIC_API_KEY=sk-123\nANTHROPIC_BASE_URL=http://example.com";
        assert!(profile_has_credentials(c));
    }

    #[test]
    fn profile_with_auth_token_has_credentials() {
        let c = "ANTHROPIC_AUTH_TOKEN=tok-abc\nANTHROPIC_MODEL=deepseek-v4-flash";
        assert!(profile_has_credentials(c));
    }

    #[test]
    fn profile_empty_value_no_credentials() {
        let c = "ANTHROPIC_API_KEY=\nANTHROPIC_MODEL=deepseek";
        assert!(!profile_has_credentials(c));
    }

    #[test]
    fn profile_no_credential_keys_no_credentials() {
        let c = "ANTHROPIC_MODEL=deepseek\nANTHROPIC_BASE_URL=http://example.com";
        assert!(!profile_has_credentials(c));
    }

    #[test]
    fn profile_empty_file_no_credentials() {
        assert!(!profile_has_credentials(""));
        assert!(!profile_has_credentials("  \n# comment only\n"));
    }

    // ── plan_var_fix ──

    #[test]
    fn plan_var_remove_when_bash_missing_and_old_user_reg_value() {
        // 旧版 bug 曾把 GIT_BASH_PATH 写成 git.exe；bash.exe 缺失时该值不可再用，
        // 用户级旧值会优先于系统级被读取 → 必须删除而不是保留。
        assert_eq!(
            plan_var_fix(Some(r"C:\app\git\bin\git.exe"), Some(r"C:\app\git\bin\git.exe"), None, "C:\\app"),
            VarFixPlan::Remove
        );
    }

    #[test]
    fn plan_var_remove_when_only_proc_value_stale() {
        assert_eq!(plan_var_fix(Some("D:\\old\\bash.exe"), None, None, "C:\\app"), VarFixPlan::Remove);
    }

    #[test]
    fn plan_var_keep_when_bash_missing_and_no_value() {
        assert_eq!(plan_var_fix(None, None, None, "C:\\app"), VarFixPlan::Keep);
    }

    #[test]
    fn plan_var_keep_when_all_correct() {
        let c = Some(r"C:\app\git\usr\bin\bash.exe");
        assert_eq!(plan_var_fix(c, c, c, "C:\\app"), VarFixPlan::Keep);
    }

    #[test]
    fn plan_var_write_when_user_reg_has_old_value() {
        // bash 存在 → 覆盖用户级旧值（git.exe 写法经 %VAR% trim 比较判定不符）
        let correct = Some(r"C:\app\git\usr\bin\bash.exe");
        let old = Some(r"%CLAUDE_CODE_HAHA_HOME%\git\bin\git.exe");
        assert_eq!(
            plan_var_fix(old, old, correct, "C:\\app"),
            VarFixPlan::Write(r"C:\app\git\usr\bin\bash.exe".into())
        );
    }

    #[test]
    fn plan_var_write_when_user_reg_missing() {
        let correct = Some(r"C:\app\git\usr\bin\bash.exe");
        assert_eq!(plan_var_fix(None, None, correct, "C:\\app"), VarFixPlan::Write(r"C:\app\git\usr\bin\bash.exe".into()));
    }

    // ── plan_var_fix 规范化（大小写/尾斜杠/%VAR% 引用等价）──

    #[test]
    fn plan_var_keep_when_case_differs() {
        // 进程值 + 系统注册表存小写 → 与正确值大小写不同，但 Windows 路径不敏感 → 不重写（避免反复 UAC）
        let correct = Some(r"C:\app\git\usr\bin\bash.exe");
        let variant = Some(r"c:\APP\git\usr\bin\bash.exe");
        assert_eq!(plan_var_fix(variant, variant, correct, "C:\\app"), VarFixPlan::Keep);
    }

    #[test]
    fn plan_var_keep_when_trailing_backslash_differs() {
        // 进程值 + 系统注册表带尾反斜杠 → 与不带等价 → 不重写
        let correct = Some(r"C:\app");
        let variant = Some(r"C:\app\");
        assert_eq!(plan_var_fix(variant, variant, correct, "C:\\app"), VarFixPlan::Keep);
    }

    #[test]
    fn plan_var_keep_when_var_ref_form() {
        // 系统注册表存 %CLAUDE_CODE_HAHA_HOME% 引用形式 → 展开后与正确值等价 → 不重写
        let correct = Some(r"C:\app\git\usr\bin\bash.exe");
        let variant = Some(r"%CLAUDE_CODE_HAHA_HOME%\git\usr\bin\bash.exe");
        assert_eq!(plan_var_fix(variant, variant, correct, "C:\\app"), VarFixPlan::Keep);
    }

    #[test]
    fn plan_var_write_when_system_reg_missing() {
        // 进程值正确但系统注册表缺失 → 仍要写（系统级是权威）
        let correct = Some(r"C:\app\git\usr\bin\bash.exe");
        assert_eq!(
            plan_var_fix(Some(r"C:\app\git\usr\bin\bash.exe"), None, correct, "C:\\app"),
            VarFixPlan::Write(r"C:\app\git\usr\bin\bash.exe".into())
        );
    }

    #[test]
    fn plan_var_write_when_genuinely_different_path() {
        // 进程值 + 系统注册表真不同路径（换过安装位置）→ 仍要重写
        let correct = Some(r"C:\app\git\usr\bin\bash.exe");
        let old = Some(r"D:\old\git\usr\bin\bash.exe");
        assert_eq!(
            plan_var_fix(old, old, correct, "C:\\app"),
            VarFixPlan::Write(r"C:\app\git\usr\bin\bash.exe".into())
        );
    }

    /// 真机往返验证（手动跑：cargo test -- --ignored）：
    /// 注入临时值 → reg_delete_user 删除 → 确认 HKCU 已无该值。
    /// 不触碰任何在用变量（用 _TEST 后缀名），结束时无条件清理。
    #[test]
    #[ignore]
    fn reg_delete_user_real_roundtrip() {
        const NAME: &str = "CLAUDE_CODE_HAHA_DEV_TMP";
        let out = std::process::Command::new("reg")
            .args(["add", "HKCU\\Environment", "/v", NAME, "/t", "REG_SZ", "/d", "junk", "/f"])
            .output().expect("reg add 失败");
        assert!(out.status.success(), "注入失败: {:?}", out.stderr);

        let del = reg_delete_user(NAME);
        assert!(del.is_ok(), "reg_delete_user 失败: {:?}", del);
        assert_eq!(read_registry_env(NAME).0, None, "删除后 HKCU 仍能读到该值");

        let _ = std::process::Command::new("reg")
            .args(["delete", "HKCU\\Environment", "/v", NAME, "/f"]).output();
    }
}

// ── 诊断修复: 环境变量 ──

#[derive(Debug, Serialize, Clone)]
pub struct EnvVarFix {
    pub name: String,
    pub problem: String,
    pub action: String,
}

/// 仅真机往返测试用：删除 HKCU 残留（生产修复已走 Update.exe env_ops DeleteUser）。
#[cfg(test)]
fn reg_delete_user(name: &str) -> Result<(), String> {
    let out = std::process::Command::new("reg")
        .args(["delete", "HKCU\\Environment", "/v", name, "/f"])
        .output()
        .map_err(|e| format!("reg delete 失败: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// 单变量修复规划（纯函数，可单测）。
#[derive(Debug, Clone, PartialEq)]
enum VarFixPlan {
    /// 变量值应被写成正确值（reg add + 进程 set_var）
    Write(String),
    /// 变量已不需要：残留旧值必须清理（reg delete + 进程 remove_var）。
    /// 正确值为 None 即触发——例如安装目录缺 bash.exe 时，
    /// 用户级旧 CLAUDE_CODE_GIT_BASH_PATH 会优先于系统级被 Windows 读取，
    /// 继续干扰 SHELL/bash 解析。
    Remove,
    /// 已正确，无需操作。
    Keep,
}

/// 环境变量值等价判定（Windows 语义）：trim + 大小写不敏感 + 忽略尾反斜杠；
/// 存储值含 %CLAUDE_CODE_HAHA_HOME% 引用时按 install_dir 展开后再比。
/// 避免「同值异形」（大小写/尾斜杠/%VAR% 引用）被反复判定为不符 → 反复 UAC 提权重写。
fn var_value_ok(stored: &str, correct: &str, install_dir: &str) -> bool {
    norm_env_cmp(&stored.trim().replace("%CLAUDE_CODE_HAHA_HOME%", install_dir)) == norm_env_cmp(correct)
}

fn norm_env_cmp(v: &str) -> String {
    v.trim().trim_end_matches('\\').to_lowercase()
}

fn plan_var_fix(
    proc_val: Option<&str>,
    user_reg: Option<&str>,
    correct: Option<&str>,
    install_dir: &str,
) -> VarFixPlan {
    match correct {
        Some(c) => {
            let proc_ok = proc_val.as_deref().map(|v| var_value_ok(v, c, install_dir)).unwrap_or(false);
            let user_ok = user_reg.as_deref().map(|v| var_value_ok(v, c, install_dir)).unwrap_or(false);
            if proc_ok && user_ok {
                VarFixPlan::Keep
            } else {
                VarFixPlan::Write(c.to_string())
            }
        }
        None => {
            if proc_val.is_some() || user_reg.is_some() {
                VarFixPlan::Remove
            } else {
                VarFixPlan::Keep
            }
        }
    }
}

/// 需要补进 PATH 的安装目录子路径（相对安装根）。目录存在才补；
/// 覆盖 git（usr/bin 供 bash、bin 供 git 可执行）与 python（解释器 + pip 脚本）。
const PATH_SUFFIXES: &[&str] = &["", "\\bin", "\\git\\usr\\bin", "\\git\\bin", "\\python", "\\python\\Scripts"];

/// 系统 PATH 精简（纯函数，可单测）：删除冗余 claude 子目录条目，只保留
/// %CLAUDE_CODE_HAHA_HOME%（根）与 %CLAUDE_CODE_HAHA_HOME%\git\usr\bin。
/// 返回 Some(精简后 PATH)；无冗余返回 None（调用方据此跳过提权写）。
fn slim_system_path(sys_path: &str, install_dir: &str) -> Option<String> {
    let home_var = "%CLAUDE_CODE_HAHA_HOME%";
    let keep = [
        home_var.to_string(),
        install_dir.to_string(),
        format!("{}\\git\\usr\\bin", home_var),
        format!("{}\\git\\usr\\bin", install_dir),
    ];
    let mut out: Vec<String> = Vec::new();
    let mut changed = false;
    for entry in sys_path.split(';') {
        let e = entry.trim();
        if e.is_empty() { continue; }
        let is_claude = e.starts_with(home_var) || e.starts_with(install_dir);
        if is_claude && !keep.contains(&e.to_string()) {
            changed = true;
            continue;
        }
        out.push(entry.to_string());
    }
    if !changed { return None; }
    Some(out.join(";"))
}

/// 系统 PATH 冗余检查：存在多余 claude 子目录条目（新策略只需根 + git\usr\bin）。
fn check_system_path_slim(sys_path: Option<&str>, install_dir: &str) -> DiagnosticCheck {
    let Some(p) = sys_path else {
        return DiagnosticCheck::new("path_slim", CheckStatus::Pass, "系统 PATH 精简",
            "系统注册表 PATH 无冗余安装条目".into());
    };
    match slim_system_path(p, install_dir) {
        None => DiagnosticCheck::new("path_slim", CheckStatus::Pass, "系统 PATH 精简",
            "系统 PATH 已精简（仅根 + git\\usr\\bin）".into()),
        Some(_) => DiagnosticCheck::new("path_slim", CheckStatus::Warn, "系统 PATH 精简",
            "系统 PATH 含冗余安装目录子条目（\\bin、\\python、\\python\\Scripts、\\git\\bin）— 新策略只需根 + git\\usr\\bin，其余由 GUI 启动进程级提供。点击修复将精简。".into()),
    }
}

/// GIT_BASH_PATH 遗留检查：新策略进程级（GUI setvar 提供），系统/用户注册表不再需要。
fn check_git_bash_legacy(sys_git: Option<&str>, user_git: Option<&str>) -> DiagnosticCheck {
    if sys_git.is_none() && user_git.is_none() {
        DiagnosticCheck::new("git_bash_legacy", CheckStatus::Pass, "CLAUDE_CODE_GIT_BASH_PATH 遗留",
            "未持久化到注册表（进程由 GUI 启动提供）".into())
    } else {
        DiagnosticCheck::new("git_bash_legacy", CheckStatus::Warn, "CLAUDE_CODE_GIT_BASH_PATH 遗留",
            "系统/用户注册表仍持久化 CLAUDE_CODE_GIT_BASH_PATH — 新策略进程级提供，注册表值为历史遗留。点击修复将删除。".into())
    }
}

/// HKCU SHELL 残留检查：SHELL 指向安装目录 git bash 属历史遗留（GUI 启动进程级设置）。
fn check_shell_leftover(user_shell: Option<&str>, sys_shell: Option<&str>, install_dir: &str) -> DiagnosticCheck {
    let points_to_install = |v: Option<&str>| v.map_or(false, |p| {
        // %CLAUDE_CODE_HAHA_HOME% 用 install_dir 展开（测试环境无真实变量也能判）。
        let exp = expand_env_vars(p, |n| {
            if n == "CLAUDE_CODE_HAHA_HOME" { Some(install_dir.to_string()) } else { std::env::var(n).ok() }
        });
        exp.starts_with(install_dir)
    });
    if points_to_install(user_shell) || points_to_install(sys_shell) {
        DiagnosticCheck::new("shell_leftover", CheckStatus::Warn, "SHELL 残留",
            "SHELL 指向安装目录 git bash — 历史遗留（GUI 启动进程级设置 SHELL）。点击修复将删除注册表值。".into())
    } else {
        DiagnosticCheck::new("shell_leftover", CheckStatus::Pass, "SHELL 残留",
            "SHELL 无安装目录残留".into())
    }
}

/// 计算 PATH 缺失项（纯函数，可单测）：对每个安装目录组件子路径，
/// 目录存在且既不在进程 PATH 也不在用户注册表 PATH（含 %VAR% 或展开形式）时记为缺失。
fn missing_path_entries(
    proc_path: &str,
    user_reg_path: Option<&str>,
    install_dir: &str,
    dir_exists: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut missing = Vec::new();
    for suffix in PATH_SUFFIXES {
        let full = format!("{}{}", install_dir, suffix);
        if !dir_exists(&full) {
            continue;
        }
        let var_token = format!("%CLAUDE_CODE_HAHA_HOME%{}", suffix);
        let in_proc = path_has(proc_path, &full) || path_has(proc_path, &var_token);
        let in_reg = user_reg_path.map_or(false, |r| path_has(r, &full) || path_has(r, &var_token));
        if !in_proc && !in_reg {
            missing.push(full);
        }
    }
    missing
}

/// 从 PATH（注册表值，可能 %VAR% 或展开形式）移除所有安装目录相关条目。
/// 覆盖三种形态（展开全路径 / %CLAUDE_CODE_HAHA_HOME% 引用 / 大小写差异），
/// 用于清理 HKCU PATH 中残留的安装目录条目。非安装条目原样保留。
fn strip_install_entries(path: &str, install_dir: &str) -> String {
    // 预计算待移除的规范化值集合（展开形式 + %VAR% 引用形式）
    let install_norm: Vec<String> = PATH_SUFFIXES.iter()
        .map(|s| norm_path_entry(&format!("{}{}", install_dir, s)))
        .collect();
    let var_norm: Vec<String> = PATH_SUFFIXES.iter()
        .map(|s| norm_path_entry(&format!("%CLAUDE_CODE_HAHA_HOME%{}", s)))
        .collect();
    let kept: Vec<String> = path.split(';')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let n = norm_path_entry(p);
            !install_norm.contains(&n) && !var_norm.contains(&n)
        })
        .collect();
    kept.join(";")
}

/// case-insensitive 规范化（去尾反斜杠）用于条目比较。
fn norm_path_entry(p: &str) -> String {
    p.trim_end_matches('\\').to_lowercase()
}

/// 把展开的 PATH 条目转成 %CLAUDE_CODE_HAHA_HOME% 引用形式（写注册表用，
/// 可移植且安装目录迁移自动跟随）。安装根目录项即 %CLAUDE_CODE_HAHA_HOME% 本身。
/// 前缀比较大小写不敏感（注册表里旧值可能是任意大小写），且须在目录边界切分
/// （`C:\app` 不匹配 `C:\app2`）。不在安装根下 → 保留原样。
fn path_entries_var_form(install_dir: &str, missing_path: &str) -> String {
    let base = install_dir.trim_end_matches('\\');
    let p = missing_path.trim_end_matches('\\');
    if p.eq_ignore_ascii_case(base) {
        return "%CLAUDE_CODE_HAHA_HOME%".to_string();
    }
    if p.len() > base.len()
        && p.as_bytes()[base.len()] == b'\\'
        && p[..base.len()].eq_ignore_ascii_case(base)
    {
        return format!("%CLAUDE_CODE_HAHA_HOME%{}", &p[base.len()..]);
    }
    missing_path.to_string()
}

/// PATH 重排（注册表/进程通用，纯函数）：把安装目录的 git\usr\bin 无条件移到最前
/// （防 WSL 的 bash 截胡，装了 WSL 时其 shim 常排在前面），其余缺失组件追加到末尾；
/// 重复条目（%VAR% 或展开形式）先移除再重新加入。entry_form 决定输出用 %VAR% 引用
/// （注册表 REG_EXPAND_SZ）还是展开值（进程 env）。
fn arrange_install_path(
    current: &str,
    install_dir: &str,
    entry_form: &dyn Fn(&str) -> String,
    git_bash_prepend: Option<&str>,
    append_suffixes: &[&str],
) -> String {
    let mut parts: Vec<String> = current.split(';')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();

    // 收集将重新加入的条目：覆盖 entry_form 输出 + %VAR% 形式 + 展开形式，
    // 三种都从当前 PATH 移除，防重复（进程 env 可能存 %VAR% 或展开任一）。
    let mut reinserted: Vec<String> = Vec::new();
    for s in git_bash_prepend.iter().copied().chain(append_suffixes.iter().copied()) {
        reinserted.push(entry_form(s));
        reinserted.push(format!("%CLAUDE_CODE_HAHA_HOME%{}", s));
        reinserted.push(install_dir.to_string() + s);
    }
    for e in &reinserted {
        let n = e.trim_end_matches('\\').to_lowercase();
        parts.retain(|p| p.trim_end_matches('\\').to_lowercase() != n);
    }

    let mut out: Vec<String> = Vec::new();
    if let Some(s) = git_bash_prepend {
        out.push(entry_form(s));
    }
    out.extend(parts);
    out.extend(append_suffixes.iter().map(|s| entry_form(s)));
    out.join(";")
}

/// 把 PATH 中「安装目录下」的条目统一转成 entry_form（系统用 %CLAUDE_CODE_HAHA_HOME% 引用、
/// 进程用展开值）。旧格式展开全路径 → %VAR% 引用（注册表可移植、换安装目录自动跟随）；
/// 已引用形式原样保留；非安装条目原样保留；重复条目去重。
fn normalize_install_entries(
    path: &str,
    install_dir: &str,
    entry_form: &dyn Fn(&str) -> String,
) -> String {
    let install_norm = norm_path_entry(install_dir);
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for p in path.split(';').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        let n = norm_path_entry(&p);
        let entry = if n == install_norm || n.starts_with(&format!("{}\\", install_norm)) {
            entry_form(&p) // 展开全路径/大小写差异 → 统一 entry_form
        } else {
            p.clone() // 已 %VAR% 引用 或 非安装条目 → 原样保留
        };
        let key = norm_path_entry(&entry);
        if !seen.contains(&key) {
            seen.push(key);
            out.push(entry);
        }
    }
    out.join(";")
}

/// PATH 修复规划（纯函数，可单测）：系统/进程分别按各自缺失集补全，
/// 系统 PATH 把旧展开条目规范化成 %VAR% 引用，git\usr\bin 前置，用户级残留清理。
/// 返回 None 表示无需任何操作（避免无谓提权）。
struct PathFixPlan {
    new_sys_path: String,
    sys_changed: bool,
    /// 用户级 PATH 清理：None=不动；Some(None)=删除用户 PATH；Some(Some(v))=写回 v
    user_action: Option<Option<String>>,
    new_proc_path: String,
    proc_changed: bool,
}

fn plan_path_fix(
    sys_path: Option<&str>,
    user_path: Option<&str>,
    proc_path: &str,
    install_dir: &str,
    dir_exists: impl Fn(&str) -> bool,
) -> Option<PathFixPlan> {
    let git_bash_suffix = "\\git\\usr\\bin";
    let git_bash_exists = dir_exists(&format!("{}{}", install_dir, git_bash_suffix));

    // 系统与进程各自独立的缺失集：某条目在系统已有但进程缺 → 仍补进进程（反之亦然）。
    let suffix_missing = |source: &str| -> Vec<String> {
        missing_path_entries(source, None, install_dir, &dir_exists)
    };
    let sys_missing = suffix_missing(sys_path.unwrap_or(""));
    let proc_missing = suffix_missing(proc_path);
    // 新策略：系统 PATH 只补根（\bin\python 等子目录由 GUI 启动进程级 setvar 前置提供，
    // 不再持久化）。进程 PATH 仍补全全部工具目录（GUI 前置的）。
    let sys_append: Vec<&str> = [""].iter()
        .filter(|s| sys_missing.iter().any(|p| p == &format!("{}{}", install_dir, s)))
        .copied()
        .collect();
    let proc_append: Vec<&str> = PATH_SUFFIXES.iter()
        .filter(|s| **s != git_bash_suffix)
        .filter(|s| proc_missing.iter().any(|p| p == &format!("{}{}", install_dir, s)))
        .copied()
        .collect();

    let to_var = |s: &str| path_entries_var_form(install_dir, &format!("{}{}", install_dir, s));
    let to_exp = |s: &str| format!("{}{}", install_dir, s);
    let git_prepend = git_bash_exists.then_some(git_bash_suffix);

    // 系统 PATH：旧展开条目先规范化成 %VAR% 引用（按全路径转换），再前置 git\usr\bin + 补根，
    // 最后精简到根 + git\usr\bin（删冗余子目录条目——历史遗留）。
    let sys_normalized = normalize_install_entries(
        sys_path.unwrap_or(""), install_dir,
        &|p: &str| path_entries_var_form(install_dir, p),
    );
    let arranged = arrange_install_path(&sys_normalized, install_dir, &to_var, git_prepend, &sys_append);
    let new_sys_path = slim_system_path(&arranged, install_dir).unwrap_or(arranged);
    let sys_changed = sys_path != Some(new_sys_path.as_str());

    let user_action = user_path.map(|up| {
        let stripped = strip_install_entries(up, install_dir);
        if stripped != up {
            Some(if stripped.is_empty() { None } else { Some(stripped) })
        } else {
            None
        }
    }).flatten();

    let new_proc_path = arrange_install_path(proc_path, install_dir, &to_exp, git_prepend, &proc_append);
    let proc_changed = new_proc_path != proc_path;

    if !sys_changed && !proc_changed && user_action.is_none() {
        return None;
    }
    Some(PathFixPlan { new_sys_path, sys_changed, user_action, new_proc_path, proc_changed })
}

/// 系统级环境变量修复指令 — 由 Update.exe (提权) 执行。serde 与 updater/main.rs env_ops 对齐（tag="op"）。
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "op")]
pub enum EnvOp {
    /// reg add HKLM(expand=true → REG_EXPAND_SZ)
    Set { name: String, value: String, expand: bool },
    /// reg delete HKLM（服务自有值清理，如 bash.exe 缺失时）
    Delete { name: String },
    /// reg delete HKCU（清理用户级残留）
    DeleteUser { name: String },
    /// reg add HKCU PATH = 移除安装条目后的值
    SetUserPath { value: String },
    /// reg delete HKCU PATH
    DeleteUserPath,
}

/// 诊断修复: 探测环境变量(进程 + 注册表)相对安装目录的偏差, 逐项修正。
/// 覆盖项: CLAUDE_CODE_HAHA_HOME / CLAUDE_CODE_GIT_BASH_PATH / PATH(全量补全
/// 安装根·bin·git\usr\bin·git\bin·python·python\Scripts, 目录存在才加)。
/// 修正: 以系统级(HKLM)为权威写注册表, 同时清理用户级(HKCU)残留 —
/// 经 Update.exe 提权执行(HKLM 写入需管理员), 并更新当前进程 env(本会话立即生效)。
#[tauri::command]
pub fn fix_environment_vars() -> Result<Vec<EnvVarFix>, String> {
    #[cfg(target_os = "macos")]
    {
        // macOS 用系统环境管理（进程级 setenv，见 lib.rs apply_process_env），无注册表，
        // 不需要 Windows 式环境变量修复。此前会因"系统注册表缺失"构造 HKLM 写 → 走
        // Update.exe 提权链路（mac 无 Update.exe）→ 报错。直接返回"无需修复"。
        return Ok(vec![EnvVarFix {
            name: "(macOS)".into(),
            problem: "macOS 使用系统环境管理，无注册表 PATH/环境变量需修复".into(),
            action: "无需操作".into(),
        }]);
    }
    let mut fixes = Vec::new();
    let mut ops: Vec<EnvOp> = Vec::new();
    let Some(install_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) else {
        return Err("无法解析安装目录(可执行文件父目录)".into());
    };
    let install_dir_str = install_dir.to_string_lossy().to_string();

    // 新策略：CLAUDE_CODE_GIT_BASH_PATH 由 GUI 启动进程级 setvar 提供（lib.rs
    // apply_process_env 设真实 git\usr\bin\bash.exe，防 WSL bash 截胡），系统注册表
    // 不再持久化。candidates 只保留 CLAUDE_CODE_HAHA_HOME；GIT_BASH_PATH 作为遗留
    // 单独清理（删注册表值，保留进程值）。
    let candidates: Vec<(&str, Option<String>)> = vec![
        ("CLAUDE_CODE_HAHA_HOME", Some(install_dir_str.clone())),
    ];

    for (name, correct) in candidates {
        let proc_val = std::env::var(name).ok();
        let (user_reg, sys_reg) = read_registry_env(name);
        // 以系统级为权威：plan 对 system 判定; 若 system 正确但 user 残留 → 只清 user。
        let plan = plan_var_fix(proc_val.as_deref(), sys_reg.as_deref(), correct.as_deref(), &install_dir_str);

        let mut problem_parts: Vec<String> = Vec::new();
        let action = match &plan {
            VarFixPlan::Keep => {
                // 系统级正确无需写; 但若用户级还有残留值 → 仍要清（读取顺序会被用户级覆盖）
                if user_reg.is_some() {
                    problem_parts.push("用户级残留旧值覆盖系统级正确值".into());
                    ops.push(EnvOp::DeleteUser { name: name.to_string() });
                    "清理用户级残留(reg delete HKCU)".to_string()
                } else {
                    continue;
                }
            }
            VarFixPlan::Write(correct_val) => {
                if proc_val.as_deref().map_or(true, |v| v.trim() != correct_val) {
                    if proc_val.as_deref().map(|v| v != v.trim()).unwrap_or(false) {
                        problem_parts.push("进程值带前导/尾随空格".into());
                    }
                    problem_parts.push(format!("进程值: {}", proc_val.as_deref().unwrap_or("(未设置)")));
                }
                if !sys_reg.as_deref().map_or(false, |v| v.trim() == correct_val) {
                    problem_parts.push("系统注册表缺失或值不符".into());
                    ops.push(EnvOp::Set { name: name.to_string(), value: correct_val.clone(), expand: false });
                }
                if user_reg.is_some() {
                    problem_parts.push("用户级残留旧值".into());
                    ops.push(EnvOp::DeleteUser { name: name.to_string() });
                }
                std::env::set_var(name, correct_val);
                "写入系统注册表(HKLM) + 清理用户级残留 + 更新当前进程环境变量".to_string()
            }
            VarFixPlan::Remove => {
                problem_parts.push("该变量已不需要（如 bash.exe 缺失）— 系统级/用户级残留已清理".into());
                if sys_reg.is_some() {
                    ops.push(EnvOp::Delete { name: name.to_string() });
                }
                if user_reg.is_some() {
                    ops.push(EnvOp::DeleteUser { name: name.to_string() });
                }
                if proc_val.is_some() {
                    std::env::remove_var(name);
                }
                "删除系统+用户级注册表值(reg delete) + 移除进程变量".to_string()
            }
        };

        fixes.push(EnvVarFix {
            name: name.to_string(),
            problem: problem_parts.join("；"),
            action,
        });
    }

    // CLAUDE_CODE_GIT_BASH_PATH 遗留：进程由 GUI 启动 setvar 提供，注册表值（系统/用户）
    // 为历史遗留 → 删除。进程值保留（删了会破坏 GUI 后端的 bash 解析）。
    {
        let (user_git, sys_git) = read_registry_env("CLAUDE_CODE_GIT_BASH_PATH");
        if user_git.is_some() || sys_git.is_some() {
            let mut parts: Vec<String> = vec!["新策略进程级提供，注册表值为历史遗留".into()];
            if sys_git.is_some() {
                ops.push(EnvOp::Delete { name: "CLAUDE_CODE_GIT_BASH_PATH".into() });
            }
            if user_git.is_some() {
                ops.push(EnvOp::DeleteUser { name: "CLAUDE_CODE_GIT_BASH_PATH".into() });
                parts.push("用户级残留".into());
            }
            if sys_git.is_some() {
                parts.push("系统级残留".into());
            }
            let action = "删除系统+用户级遗留(进程由 GUI 启动提供)".into();
            fixes.push(EnvVarFix {
                name: "CLAUDE_CODE_GIT_BASH_PATH".into(),
                problem: parts.join("；"),
                action,
            });
        }
    }

    // SHELL 残留：GUI 启动进程级设置 SHELL（setShellIfWindows），注册表里指向安装
    // 目录 git bash 的 SHELL 为历史遗留 → 删除（保留进程值）。
    {
        let (user_shell, sys_shell) = read_registry_env("SHELL");
        if let Some(v) = user_shell.as_deref().or(sys_shell.as_deref()) {
            let exp = expand_env_vars(v, |n| std::env::var(n).ok());
            if exp.starts_with(&install_dir_str) {
                let parts: Vec<String> = vec!["指向安装目录 git bash — 历史遗留".into()];
                if user_shell.is_some() {
                    ops.push(EnvOp::DeleteUser { name: "SHELL".into() });
                }
                if sys_shell.is_some() {
                    ops.push(EnvOp::Delete { name: "SHELL".into() });
                }
                fixes.push(EnvVarFix {
                    name: "SHELL".into(),
                    problem: parts.join("；"),
                    action: "删除注册表 SHELL(进程由 GUI 启动设置)".into(),
                });
            }
        }
    }

    // PATH：git\usr\bin 提到最前（防 WSL bash 截胡）+ 系统/进程各自缺失集补全。
    // 系统 PATH 写 %CLAUDE_CODE_HAHA_HOME% 引用（REG_EXPAND_SZ，旧展开条目也规范化成引用）；
    // 进程写展开值；用户级残留移除安装条目。
    let proc_path = std::env::var("PATH").unwrap_or_default();
    let (user_path, sys_path) = read_registry_env("PATH");
    let git_bash_exists = install_dir.join("git").join("usr").join("bin").is_dir();
    if let Some(plan) = plan_path_fix(
        sys_path.as_deref(), user_path.as_deref(), &proc_path, &install_dir_str,
        |p| std::path::Path::new(p).is_dir(),
    ) {
        // 系统 PATH：新策略目标 = 根 + git\usr\bin（plan_path_fix 已规范化旧展开条目、
        // 前置 git\usr\bin、补根，并精简冗余子目录条目——历史遗留）。有变化 → 写系统
        // （主动清理遗留需持久化，值用 %CLAUDE_CODE_HAHA_HOME% 引用 REG_EXPAND_SZ）。
        // 进程 PATH 实时更新（子进程继承）；HKCU 残留仍清理。
        if plan.sys_changed {
            ops.push(EnvOp::Set { name: "PATH".into(), value: plan.new_sys_path.clone(), expand: true });
        }
        match plan.user_action {
            Some(None) => ops.push(EnvOp::DeleteUserPath),
            Some(Some(v)) => ops.push(EnvOp::SetUserPath { value: v }),
            None => {}
        }
        if plan.proc_changed {
            std::env::set_var("PATH", &plan.new_proc_path);
        }

        if plan.sys_changed || plan.proc_changed {
            let mut problem_parts: Vec<String> = Vec::new();
            if plan.sys_changed {
                problem_parts.push("系统 PATH 含冗余安装子目录条目/缺根或 git\\usr\\bin".into());
            }
            if plan.proc_changed {
                problem_parts.push("进程 PATH 缺失条目/顺序不符".into());
            }
            fixes.push(EnvVarFix {
                name: "PATH".into(),
                problem: problem_parts.join("；"),
                action: "精简系统 PATH 至根 + git\\usr\\bin(%CLAUDE_CODE_HAHA_HOME% 引用) + 旧展开条目规范化 + 清理用户级 PATH 残留 + 进程展开值".into(),
            });
        }
    }

    // bash 截胡检测：裸 `bash` 若被 WSL/独立 Git 截胡。git\usr\bin 前置已在上面写入
    // bash 截胡检测：git\usr\bin 已在 PATH 段前置到系统 PATH（若缺失），不再是「只能提示」。
    let first_bash = first_bash_in_path(&proc_path);
    let our_bash_dirs: Vec<String> = [
            format!("{}\\git\\usr\\bin", install_dir_str),
            format!("{}\\git\\bin", install_dir_str),
        ].into_iter().filter(|d| std::path::Path::new(d).is_dir()).collect();
    let bash_is_ours = first_bash.as_deref().map_or(false, |p| {
        our_bash_dirs.iter().any(|d| p.eq_ignore_ascii_case(d))
    });
    let bash_path_set = ops.iter().any(|op| matches!(op, EnvOp::Set { name, .. } if name == "PATH"));
    if !bash_is_ours && git_bash_exists && bash_path_set {
        fixes.push(EnvVarFix {
            name: "bash 解析".into(),
            problem: format!("裸 bash 被 {} 截胡(非 git bash，可能 WSL/独立 Git)", first_bash.as_deref().unwrap_or("(PATH 无 bash)")),
            action: "已将 git\\usr\\bin 前置到系统 PATH(HKLM) — 重启后裸 bash 走 git-bash，不再被 WSL 截胡".into(),
        });
    }

    // 执行提权修复（Update.exe + UAC）——仅当有注册表写操作（HKLM / 清 HKCU）
    if !ops.is_empty() {
        crate::update::run_env_ops_elevated(ops)?;
    }

    if fixes.is_empty() {
        fixes.push(EnvVarFix { name: "(无)".into(), problem: "未发现需要修复的环境变量问题".into(), action: "无需操作".into() });
    }
    Ok(fixes)
}

/// profile 是否含有效 API 凭据（ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN 非空）。
fn profile_has_credentials(content: &str) -> bool {
    crate::parse_env_file(content).iter().any(|(k, v)| {
        (k == "ANTHROPIC_API_KEY" || k == "ANTHROPIC_AUTH_TOKEN") && !v.trim().is_empty()
    })
}

/// 诊断修复: 激活的 profile 无效（标记指向不存在 / 缺 API 凭据 / 未激活）时,
/// 自动把激活标记切换到第一个有效凭据的 profile。修复对象:
/// ~/.claude/.env.active（用户标记）+ 项目 .claude/active-profile（若指向坏 profile）。
/// 无任何有效 profile 时不动标记, 提示手动修正。
#[tauri::command]
pub fn fix_profiles() -> Result<Vec<EnvVarFix>, String> {
    let mut fixes = Vec::new();
    let Some(dir) = crate::find_profiles_dir() else {
        return Ok(vec![EnvVarFix {
            name: "Profile".into(),
            problem: "未找到 .env.profiles 目录".into(),
            action: "请用 Profile 管理创建 profile".into(),
        }]);
    };

    let mut ids = list_env_profiles(&dir);
    ids.sort();
    if ids.is_empty() {
        return Ok(vec![EnvVarFix {
            name: "Profile".into(),
            problem: "profile 目录无任何 *.env 文件".into(),
            action: "请用 Profile 管理创建 profile".into(),
        }]);
    }

    // 有效 = 文件可读 + 含非空 API 凭据
    let valid: Vec<String> = ids.iter()
        .filter(|id| {
            std::fs::read_to_string(dir.join(format!("{}.env", id)))
                .map(|c| profile_has_credentials(&c)).unwrap_or(false)
        })
        .cloned()
        .collect();

    let active = crate::resolve_active_profile();
    let active_id = active.as_ref().map(|(id, _)| id.as_str());
    let active_source = active.as_ref().map(|(_, s)| *s).unwrap_or("");

    let (problem, switch_to) = match active_id {
        Some(id) if valid.iter().any(|v| v == id) => (None, None),
        Some(id) => {
            let p = if ids.iter().any(|i| i == id) {
                format!("激活 profile '{}' 缺有效 API 凭据（来源: {}）", id, active_source)
            } else {
                format!("激活标记指向不存在的 profile '{}'（来源: {}）", id, active_source)
            };
            (Some(p), valid.first().cloned())
        }
        None => {
            if valid.is_empty() {
                (Some("未激活 profile，且所有 profile 均无有效 API 凭据".into()), None)
            } else {
                (Some("未激活 profile（无激活标记）".into()), valid.first().cloned())
            }
        }
    };

    match (problem, switch_to) {
        (None, _) => {
            fixes.push(EnvVarFix { name: "Profile".into(), problem: "激活的 profile 有效".into(), action: "无需操作".into() });
        }
        (Some(p), Some(new_id)) => {
            let marker = crate::user_claude_dir().join(".env.active");
            std::fs::write(&marker, &new_id).map_err(|e| format!("写入激活标记失败: {}", e))?;
            // 工作区标记（resolve 读取优先级最高）若也指向坏 profile → 一并改写，保持两处一致
            let ws_marker = std::path::PathBuf::from(crate::settings::load_settings().work_dir)
                .join(".claude").join("active-profile");
            if let Some(ws_id) = crate::read_marker(&ws_marker) {
                if !valid.iter().any(|v| v == &ws_id) {
                    let _ = std::fs::write(&ws_marker, &new_id);
                }
            }
            fixes.push(EnvVarFix {
                name: "Profile".into(),
                problem: p,
                action: format!("激活切换为 '{}'（写入 ~/.claude/.env.active + 工作区 active-profile）", new_id),
            });
        }
        (Some(p), None) => {
            fixes.push(EnvVarFix {
                name: "Profile".into(),
                problem: p,
                action: "请用 Profile 管理创建/修正 API 凭据后重试".into(),
            });
        }
    }
    Ok(fixes)
}
