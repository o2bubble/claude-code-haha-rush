//! 进程树终止 —— **GUI 与 server 共用**。
//!
//! 2026-10-27 从 `gui/src-tauri/src/prockill.rs` 下沉：server 的托盘菜单
//! 要能「结束某个 GUI 进程」，而 server 是独立 crate 拿不到 GUI 的模块。
//!
//! 只搬了最核心的 `kill_process_tree`；`prockill.rs` 里那些 GUI 专属的
//! （按命令行/CWD/加载模块筛选）仍留在原处，它对本模块做 `pub use`。

use std::collections::HashMap;

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

/// 收集 `root` 的全部后代 pid（不含 root 自己）。
#[cfg(target_os = "windows")]
fn collect_descendants(root: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    unsafe {
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                children
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                out.push(k);
                stack.push(k);
            }
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn collect_descendants(_root: u32) -> Vec<u32> {
    Vec::new()
}

/// 尽力强杀单个 pid。已退出 / 无权限 → 静默忽略。
#[cfg(target_os = "windows")]
fn terminate(pid: u32) {
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return;
        }
        let _ = TerminateProcess(h, 1);
        let _ = CloseHandle(h);
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate(_pid: u32) {}

/// 终止 `pid` 及其全部后代（先孩子后根）—— 等价于 `taskkill /F /T /PID`。
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let mut targets = collect_descendants(pid);
    targets.push(pid);
    for p in targets {
        terminate(p);
    }
}

// ── 向上找「用户拉起器」────────────────────────────────────────────
//
// ## 为什么需要（2026-10-28 用户反馈）
//
// 有用户把 GUI **套了一层壳**（换名字/图标应付公司审查）：外面是自己写的一个
// 拉起程序，里面才是 `claude-code-gui.exe`。从托盘「结束进程」时，我们只杀了
// 自己这一棵 —— 外层拉起器还活着，并在它的窗口里留下一个**无法交互的空白窗口**，
// 用户只能用任务管理器强杀。
//
// ## 为什么不能无脑往上杀
//
// 正常的父子关系长这样：
//
//   explorer.exe → claude-code-gui.exe     （双击启动，杀 explorer 是灾难）
//   powershell.exe → claude-code-gui.exe   （命令行启动，杀 shell 会带走用户的终端）
//   claude-gui-server.exe → claude-code-gui.exe  （「新建窗口」，杀 server 等于自杀）
//
// 所以「往上杀」必须同时满足下面**全部**条件，缺一条就停：
//
//   1. 名字不在 `PROTECTED_NAMES` 里（系统进程 / shell / 脚本宿主 / 我们自己的程序）
//   2. 不在调用方给的 `extra_protected` 里（调用方传自己的 pid）
//   3. **父进程比子进程先启动**，且间隔 ≤ `MAX_LAUNCH_GAP_MS`
//      —— 拉起器是"启动后立刻拉起子进程"，间隔极小；explorer/终端往往已经开了
//      几个小时。这条同时挡掉 pid 复用（父比子还新 = 不是真父子）。
//   4. 它的**所有**活着的子进程都在本次杀掉的集合里
//      —— 它存在的意义就只有"承载我们"，多开的其他孩子说明它是公共的启动器，
//      杀了会波及别人。
//
// 四条都过才继续往上走，最多 `MAX_HOPS` 层。任何一条不满足 → 停在上一层，
// 只杀我们自己的树（行为与改动前一致）。

/// 父进程比子进程早启动多久以内，才算「拉起器」而不是常驻宿主。
///
/// 15 秒足够覆盖"拉起器做点初始化再 spawn"；再长就接近"用户先开了个程序、
/// 后来又启动 GUI"的情形，那不该被牵连。
const MAX_LAUNCH_GAP_MS: u64 = 15_000;

/// 最多往上找几层（launcher → wrapper → app 三层已经够）。
const MAX_HOPS: usize = 4;

/// 绝不能因为"向上找拉起器"而被杀掉的名字（小写、无 `.exe` 后缀）。
const PROTECTED_NAMES: &[&str] = &[
    // ── 系统 / 外壳 ──
    "explorer", "winlogon", "wininit", "services", "lsass", "csrss", "smss", "dwm",
    "svchost", "taskmgr", "conhost", "sihost", "fontdrvhost", "ctfmon", "runtimebroker",
    "searchhost", "searchapp", "startmenuexperiencehost", "shellexperiencehost",
    "textinputhost", "applicationframehost", "systemsettings", "lockapp", "logonui",
    "securityhealthservice", "securityhealthsystray", "msmpeng", "nissrv", "spoolsv",
    "dllhost", "rundll32", "taskhostw", "wmiprvse", "audiodg", "wudfhost",
    // 第三方文件管理器（同样不该因为"是父进程"就被杀）
    "totalcmd", "totalcmd64", "directoryopus",
    // ── 终端 / shell / IDE ──
    "cmd", "powershell", "pwsh", "bash", "sh", "wsl", "wt", "windowsterminal",
    "conemu", "conemu64", "mintty", "alacritty", "wezterm", "wezterm-gui", "hyper",
    "tabby", "code", "code-insiders", "devenv", "idea64", "pycharm64", "goland64",
    "webstorm64", "clion64",
    // ── 脚本宿主 ──
    // 刻意保护：无法区分"用户的开发环境常驻"和"脚本写的拉起器"，
    // 宁可留一个空白窗口让用户手动处理，也不误杀别人的运行环境。
    "python", "python3", "pythonw", "py", "node", "java", "javaw", "dotnet",
    "wscript", "cscript", "mshta", "ruby", "perl", "php",
    // ── 构建 / 任务调度 ──
    // 实测（2026-10-28 诊断）：从构建脚本里子进程链是
    // `test ← cargo ← cargo ← timeout`，每层都只隔几毫秒、且只有一个孩子 ——
    // 完全符合"拉起器"的形状。开发场景下把它当成拉起器会把整个构建杀掉。
    "cargo", "rustc", "rust-analyzer", "msbuild", "vbcscompiler", "ninja", "make",
    "gradle", "mvn", "javac", "tsc", "bun", "deno", "timeout",
    "taskeng", "schtasks", "taskhostw", "msiexec",
    // ── 我们自己 ──
    "claude-code-gui", "claude-gui-server", "claude", "claude-code",
];

fn normalize_name(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

fn is_protected(name: &str) -> bool {
    PROTECTED_NAMES.contains(&name)
}

/// 进程快照里的一条。`name` 已规范化（小写、无 `.exe`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}

/// 取一份进程快照（pid / 父 pid / 映像名）。
#[cfg(target_os = "windows")]
pub fn snapshot_processes() -> Vec<ProcEntry> {
    let mut out = Vec::new();
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return out;
    }
    unsafe {
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let raw = String::from_utf16_lossy(&entry.szExeFile[..end]);
                out.push(ProcEntry {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: normalize_name(&raw),
                });
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

#[cfg(not(target_os = "windows"))]
pub fn snapshot_processes() -> Vec<ProcEntry> {
    Vec::new()
}

/// **纯函数**：给定进程快照，算出除 `roots` 之外还要杀的「拉起器」pid（最上层）。
///
/// `start_ms` 注入进程启动时刻（测试用假数据，运行时传
/// [`crate::instances::process_start_time_ms`]）。
/// 判定规则见本段开头注释；任何一条不满足就停在该层。
pub fn plan_launchers<F>(
    roots: &[u32],
    procs: &[ProcEntry],
    start_ms: F,
    extra_protected: &[u32],
) -> Vec<u32>
where
    F: Fn(u32) -> Option<u64>,
{
    if roots.is_empty() {
        return Vec::new();
    }
    let by_pid: HashMap<u32, &ProcEntry> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        children.entry(p.parent).or_default().push(p.pid);
    }

    // 本次会被杀掉的集合 —— 判断"父进程的孩子是不是都要被杀掉"时的基准。
    // 认可一个祖先就把它也加进来，这样多级链（launcher → wrapper → app）能继续往上走。
    let mut killset: std::collections::HashSet<u32> = roots.iter().copied().collect();
    let mut out: Vec<u32> = Vec::new();

    for &root in roots {
        let mut cur = root;
        let Some(mut cur_start) = start_ms(root) else { continue };
        let mut topmost: Option<u32> = None;

        for _ in 0..MAX_HOPS {
            let Some(entry) = by_pid.get(&cur) else { break };
            let parent = entry.parent;
            if parent == 0 || parent == cur {
                break;
            }
            let Some(pe) = by_pid.get(&parent) else { break };

            // ① 名字保护（系统 / shell / 脚本宿主 / 我们自己）
            if is_protected(&pe.name) {
                break;
            }
            // ② 调用方额外保护（server 自己的 pid）
            if extra_protected.contains(&parent) {
                break;
            }
            // ③ 必须比子进程早启动，且间隔够小
            let Some(pstart) = start_ms(parent) else { break };
            if pstart > cur_start || cur_start - pstart > MAX_LAUNCH_GAP_MS {
                break;
            }
            // ④ 它的所有活着的孩子都必须在本轮待杀集合里
            let kids = children.get(&parent).cloned().unwrap_or_default();
            if kids.is_empty() || !kids.iter().all(|k| killset.contains(k)) {
                break;
            }

            killset.insert(parent);
            topmost = Some(parent);
            cur = parent;
            cur_start = pstart;
        }

        if let Some(t) = topmost {
            if !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out
}

/// 结束 GUI 实例 —— **连同外层的用户拉起器**（若判定安全）。
///
/// 返回实际额外杀掉的拉起器 pid（便于日志/测试）。
///
/// 只给托盘用。GUI 内部杀后端/插件进程仍走 [`kill_process_tree`] ——
/// 那些场景的父进程就是 GUI 自己，往上找毫无意义且危险。
pub fn kill_instances(roots: &[u32], extra_protected: &[u32]) -> Vec<u32> {
    let roots: Vec<u32> = roots.iter().copied().filter(|p| *p != 0).collect();
    if roots.is_empty() {
        return Vec::new();
    }
    // ⚠️ 先判定再动手：杀完实例后父子关系就变了（拉起器的孩子数归零），
    // 那时再判定会得出完全不同（且错误）的结论。
    let procs = snapshot_processes();
    let launchers = plan_launchers(
        &roots,
        &procs,
        crate::instances::process_start_time_ms,
        extra_protected,
    );

    for &r in &roots {
        kill_process_tree(r);
    }
    for &l in &launchers {
        // 拉起器用整树杀：它下面此刻只剩我们（条件④已保证）
        kill_process_tree(l);
    }
    launchers
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一条快照记录：`p(pid, parent, name)`。
    fn p(pid: u32, parent: u32, name: &str) -> ProcEntry {
        ProcEntry { pid, parent, name: name.into() }
    }

    /// 用一张"pid → 启动时刻"表当 `start_ms`。
    fn starts(pairs: &[(u32, u64)]) -> impl Fn(u32) -> Option<u64> + '_ {
        move |pid| pairs.iter().find(|(p, _)| *p == pid).map(|(_, t)| *t)
    }

    #[test]
    fn explorer_parent_is_never_a_launcher() {
        // 双击启动：explorer 是父进程，绝不能杀
        let procs = vec![p(10, 4, "explorer"), p(100, 10, "claude-code-gui")];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 5_000), (10, 1_000)]), &[]);
        assert!(out.is_empty(), "explorer 必须被保护: {out:?}");
    }

    #[test]
    fn shell_and_script_hosts_are_protected() {
        for shell in ["powershell", "cmd", "pwsh", "bash", "python", "node", "code"] {
            let procs = vec![p(10, 4, shell), p(100, 10, "claude-code-gui")];
            let out = plan_launchers(&[100], &procs, starts(&[(100, 5_000), (10, 4_900)]), &[]);
            assert!(out.is_empty(), "{shell} 必须被保护: {out:?}");
        }
    }

    #[test]
    fn our_own_server_is_protected_both_by_name_and_by_pid() {
        // 「新建窗口」是 server spawn 的 GUI —— 杀 server 等于自杀
        let procs = vec![p(10, 4, "claude-gui-server"), p(100, 10, "claude-code-gui")];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 5_000), (10, 4_900)]), &[]);
        assert!(out.is_empty(), "server 必须被保护（名字）: {out:?}");

        // 名字被改过的 server（旧版本/自定义构建）→ 靠调用方传 pid 兜住
        let procs = vec![p(10, 4, "whatever"), p(100, 10, "claude-code-gui")];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 5_000), (10, 4_900)]), &[10]);
        assert!(out.is_empty(), "server pid 必须被保护: {out:?}");
    }

    #[test]
    fn a_launcher_started_right_before_us_is_found() {
        // 用户场景：外层拉起器 3 秒前启动，只有我们一个孩子
        let procs = vec![p(10, 4, "corp-launcher"), p(100, 10, "claude-code-gui")];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 5_000), (10, 2_000)]), &[]);
        assert_eq!(out, vec![10], "应识别出拉起器");
    }

    #[test]
    fn multi_level_chain_yields_the_topmost() {
        // launcher(1) → wrapper(10) → gui(100)
        let procs = vec![
            p(1, 4, "corp-launcher"),
            p(10, 1, "some-wrapper"),
            p(100, 10, "claude-code-gui"),
        ];
        let out = plan_launchers(
            &[100],
            &procs,
            starts(&[(100, 6_000), (10, 3_000), (1, 1_000)]),
            &[],
        );
        assert_eq!(out, vec![1], "应返回最上层那个: {out:?}");
    }

    #[test]
    fn parent_that_started_long_ago_is_not_a_launcher() {
        // 间隔 > 15 秒 → 不是"拉起器"，是常驻宿主
        let procs = vec![p(10, 4, "corp-launcher"), p(100, 10, "claude-code-gui")];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 60_000), (10, 1_000)]), &[]);
        assert!(out.is_empty(), "间隔太久不该牵连: {out:?}");
    }

    #[test]
    fn parent_with_other_children_is_shared_and_left_alone() {
        // 拉起器还带着别的孩子（比如另一个不归我们管的进程）→ 不能杀
        let procs = vec![
            p(10, 4, "corp-launcher"),
            p(100, 10, "claude-code-gui"),
            p(101, 10, "other-app"),
        ];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 5_000), (101, 5_100), (10, 2_000)]), &[]);
        assert!(out.is_empty(), "有别的孩子时不该杀: {out:?}");
    }

    #[test]
    fn kill_all_may_take_the_launcher_when_every_child_dies() {
        // 「关闭所有实例」：拉起器的孩子全是我们的实例 → 可以一起关
        let procs = vec![
            p(10, 4, "corp-launcher"),
            p(100, 10, "claude-code-gui"),
            p(101, 10, "claude-code-gui"),
        ];
        let out = plan_launchers(
            &[100, 101],
            &procs,
            starts(&[(100, 5_000), (101, 5_200), (10, 2_000)]),
            &[],
        );
        assert_eq!(out, vec![10], "所有孩子都被关时可以带走拉起器: {out:?}");
    }

    #[test]
    fn killing_one_of_two_siblings_leaves_the_launcher() {
        // 只关一个实例 → 拉起器还要伺候另一个，不能杀
        let procs = vec![
            p(10, 4, "corp-launcher"),
            p(100, 10, "claude-code-gui"),
            p(101, 10, "claude-code-gui"),
        ];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 5_000), (101, 5_200), (10, 2_000)]), &[]);
        assert!(out.is_empty(), "另一个实例还开着，不能杀拉起器: {out:?}");
    }

    #[test]
    fn parent_newer_than_child_is_rejected() {
        // pid 复用 / 脏数据：父比子晚启动 → 不是真父子
        let procs = vec![p(10, 4, "corp-launcher"), p(100, 10, "claude-code-gui")];
        let out = plan_launchers(&[100], &procs, starts(&[(100, 1_000), (10, 9_000)]), &[]);
        assert!(out.is_empty(), "父比子新必须拒绝: {out:?}");
    }

    #[test]
    fn missing_or_zero_parents_are_safe() {
        let procs = vec![p(100, 0, "claude-code-gui")];
        assert!(plan_launchers(&[100], &procs, starts(&[(100, 1_000)]), &[]).is_empty());

        // 父进程不在快照里（已退出）
        let procs = vec![p(100, 999, "claude-code-gui")];
        assert!(plan_launchers(&[100], &procs, starts(&[(100, 1_000)]), &[]).is_empty());

        // 取不到启动时刻
        let procs = vec![p(10, 4, "corp-launcher"), p(100, 10, "claude-code-gui")];
        assert!(plan_launchers(&[100], &procs, starts(&[]), &[]).is_empty());
    }

    #[test]
    fn empty_roots_is_a_noop() {
        assert!(plan_launchers(&[], &[], starts(&[]), &[]).is_empty());
    }

    #[test]
    fn name_normalization_handles_exe_suffix_and_case() {
        assert_eq!(normalize_name("EXPLORER.EXE"), "explorer");
        assert_eq!(normalize_name("Claude-Code-Gui.exe"), "claude-code-gui");
        assert_eq!(normalize_name("  python  "), "python");
        // 不是 .exe 结尾的不动
        assert_eq!(normalize_name("wezterm-gui"), "wezterm-gui");
    }

    #[test]
    fn snapshot_contains_this_process() {
        // 冒烟：真快照至少要能看见自己，且自己的父进程是有效 pid
        let procs = snapshot_processes();
        if procs.is_empty() {
            return; // 非 Windows / 快照失败 → 跳过
        }
        let me = std::process::id();
        let mine = procs.iter().find(|p| p.pid == me).expect("快照里必须有自己的进程");
        assert!(mine.parent != me, "父进程不能是自己");
        assert!(!mine.name.is_empty());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod e2e {
    //! 真进程端到端验证 —— **默认 #[ignore]**，手动跑：
    //!
    //! ```bash
    //! cargo test -p claude-gui-shared e2e -- --ignored --nocapture --test-threads=1
    //! ```
    //!
    //! 为什么不做成常规回归：它要**真的创建并杀掉进程**，并行跑会互相干扰；
    //! 而且在 CI 上会杀测试框架自己的子进程。决策逻辑的回归已由上面的纯函数
    //! 用例覆盖，这里只验证"真实进程表里的父子关系/启动时刻"喂进去确实能命中。
    //!
    //! 手法：把自己的测试二进制复制成 `corp-launcher.exe`（非保护名），
    //! 让它 spawn 一个同名孩子并等待 —— 复刻用户"套壳"的进程形状。

    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    const LAUNCHER_ENV: &str = "KILL_E2E_LAUNCHER";
    const CHILD_ENV: &str = "KILL_E2E_CHILD";

    fn is_alive(pid: u32) -> bool {
        crate::instances::process_start_time_ms(pid).is_some()
    }

    fn wait_dead(pid: u32, limit: Duration) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < limit {
            if !is_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// 孩子角色：什么都不做，等着被杀。
    #[test]
    fn helper_child() {
        if std::env::var(CHILD_ENV).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_secs(120));
    }

    /// 拉起器角色：spawn 一个孩子然后等它。
    #[test]
    fn helper_launcher() {
        if std::env::var(LAUNCHER_ENV).is_err() {
            return;
        }
        let exe = std::env::current_exe().unwrap();
        let child = Command::new(&exe)
            .args(["--exact", "proc::e2e::helper_child", "--nocapture", "--test-threads=1"])
            .env(CHILD_ENV, "1")
            .spawn()
            .expect("拉起器应能 spawn 孩子");
        println!("E2E_CHILD_PID={}", child.id());
        std::thread::sleep(Duration::from_secs(120));
    }

    #[test]
    #[ignore = "真进程端到端：手动跑 cargo test e2e -- --ignored"]
    fn launcher_chain_is_really_killed() {
        let exe = std::env::current_exe().unwrap();
        let dir = std::env::temp_dir().join(format!("kb-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let launcher_exe = dir.join("corp-launcher.exe");
        std::fs::copy(&exe, &launcher_exe).unwrap();

        let mut launcher = Command::new(&launcher_exe)
            .args(["--exact", "proc::e2e::helper_launcher", "--nocapture", "--test-threads=1"])
            .env(LAUNCHER_ENV, "1")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("拉起器应能启动");

        // 等它把孩子 pid 打出来。
        // ⚠️ 必须用后台线程读：`read()` 会**一直阻塞**到有数据或 EOF，而拉起器
        // 拿到孩子后就只是 sleep —— 主线程直接 read 会卡满整个 sleep 时长，
        // 超时判断根本没机会执行（实测：测试挂了 120 秒）。
        let mut child_pid = 0u32;
        {
            let stdout = launcher.stdout.take().unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<String>();
            std::thread::spawn(move || {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut seen: Vec<String> = Vec::new();
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(left.min(Duration::from_millis(300))) {
                    Ok(line) => {
                        // ⚠️ 不能用 strip_prefix：libtest 会先输出
                        // `test proc::e2e::helper_launcher ... ` 且**不换行**，
                        // 我们的 println 被接在同一行后面。
                        if let Some(idx) = line.find("E2E_CHILD_PID=") {
                            let rest = &line[idx + "E2E_CHILD_PID=".len()..];
                            let digits: String =
                                rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                            child_pid = digits.parse().unwrap_or(0);
                            break;
                        }
                        seen.push(line);
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            assert!(
                child_pid != 0,
                "没拿到孩子的 pid；拉起器输出：{seen:?}；退出状态：{:?}",
                launcher.try_wait()
            );
        }
        let launcher_pid = launcher.id();
        assert!(is_alive(launcher_pid) && is_alive(child_pid), "两者都应活着");

        // 只杀孩子 —— 但拉起器的唯一孩子就是它，所以拉起器也该被带走
        let extra = kill_instances(&[child_pid], &[std::process::id()]);
        println!("额外杀掉: {extra:?}（拉起器 pid={launcher_pid}）");

        assert!(wait_dead(child_pid, Duration::from_secs(10)), "孩子应已退出");
        assert!(wait_dead(launcher_pid, Duration::from_secs(10)),
            "拉起器 {} 没被带走 —— 用户那边就是那个关不掉的空白窗口", launcher_pid);

        let _ = launcher.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 打印本进程的真实祖先链 —— 诊断用（核对保护名单是否够）。
    #[test]
    #[ignore = "诊断输出：手动跑 --ignored --nocapture"]
    fn print_real_ancestor_chain() {
        let snap = snapshot_processes();
        let mut cur = std::process::id();
        println!("--- 本测试进程的祖先链 ---");
        for _ in 0..6 {
            let Some(e) = snap.iter().find(|p| p.pid == cur) else { break };
            let start = crate::instances::process_start_time_ms(e.pid).unwrap_or(0);
            println!(
                "pid={:<7} name={:<22} parent={:<7} start={} protected={}",
                e.pid, e.name, e.parent, start, is_protected(&e.name)
            );
            if e.parent == 0 || e.parent == cur {
                break;
            }
            cur = e.parent;
        }
        let out = plan_launchers(
            &[std::process::id()],
            &snap,
            crate::instances::process_start_time_ms,
            &[],
        );
        println!("plan_launchers 选中: {out:?}");
    }
}
