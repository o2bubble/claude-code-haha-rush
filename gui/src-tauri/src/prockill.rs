#![cfg(windows)]
//! Native Windows process termination — no external `taskkill` spawn.
//!
//! Spawning `taskkill.exe` pops "0xc0000142 / DLL initialization failed" when
//! launched at early logon or during shutdown under a restricted token (the
//! window/DLL subsystem is not ready yet), and flashes a console. These helpers
//! terminate the same process trees in-proc via Toolhelp32 + TerminateProcess,
//! which work in any token/session state. They replace the `taskkill /F /T
//! /PID` and `/IM` calls used by the IDE-backend lifecycle, and read process
//! command lines natively (PEB) to tell GUI backends (`--ide-mode`) apart from
//! the user's terminal TUI.

use std::collections::HashMap;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, INVALID_HANDLE_VALUE, BOOL, HANDLE, HINSTANCE, HWND, LPARAM,
    LRESULT, WPARAM,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Process32FirstW, Process32NextW,
    MODULEENTRY32W, PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    PROCESS_VM_READ,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, RegisterClassW, WNDCLASSW, WS_OVERLAPPED,
};

const ERROR_CLASS_ALREADY_EXISTS: u32 = 1410;

/// Snapshot the process table, return every descendant of `root` (not the root
/// itself). Best-effort: an empty vec on any snapshot failure.
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

/// Best-effort force-terminate one PID. Ignores already-dead / access-denied.
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

/// Terminate `pid` and every descendant (children first, then the root) —
/// mirrors `taskkill /F /T /PID`.
pub fn kill_process_tree(pid: u32) {
    let mut targets = collect_descendants(pid);
    targets.push(pid);
    for p in targets {
        terminate(p);
    }
}

// ── Command-line filter ──
//
// Killing by image name (`taskkill /IM claude.exe`) also kills the user's
// terminal TUI, which runs the same binary without `--ide-mode`. The reliable
// discriminator is the `--ide-mode` flag in the command line. Reading it
// natively (PEB via NtQueryInformationProcess + ReadProcessMemory) avoids
// spawning PowerShell.
//
// Offsets below are the x86-64 layouts of PROCESS_BASIC_INFORMATION (0x08),
// PEB (0x20) and RTL_USER_PROCESS_PARAMETERS.CommandLine (0x70). The GUI and
// its backends are x64; a same-privilege mismatch fails the reads and the
// process is simply skipped.

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process_handle: HANDLE,
        info_class: u32,
        process_information: *mut core::ffi::c_void,
        process_information_length: u32,
        return_length: *mut u32,
    ) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn ReadProcessMemory(
        process: HANDLE,
        base_address: *const core::ffi::c_void,
        buffer: *mut core::ffi::c_void,
        size: usize,
        number_of_bytes_read: *mut usize,
    ) -> BOOL;
}

unsafe fn read_mem(h: HANDLE, addr: usize, buf: &mut [u8]) -> bool {
    let mut read = 0usize;
    ReadProcessMemory(
        h,
        addr as *const core::ffi::c_void,
        buf.as_mut_ptr() as *mut core::ffi::c_void,
        buf.len(),
        &mut read,
    ) != 0
        && read == buf.len()
}

unsafe fn read_ptr(h: HANDLE, addr: usize) -> Option<usize> {
    let mut out = [0u8; 8];
    if !read_mem(h, addr, &mut out) {
        return None;
    }
    Some(usize::from_le_bytes(out))
}

/// Read a UNICODE_STRING (Length u16 | MaxLength u16 | pad u32 | Buffer ptr @0x08)
/// at `addr` in the target process.
unsafe fn read_ustring(h: HANDLE, addr: usize) -> Option<String> {
    let mut head = [0u8; 0x10];
    if !read_mem(h, addr, &mut head) {
        return None;
    }
    let len = u16::from_le_bytes([head[0], head[1]]) as usize;
    if len == 0 || len > 0x8000 {
        return None;
    }
    let buffer = read_ptr(h, addr + 0x08)?;
    if buffer == 0 {
        return None;
    }
    let mut bytes = vec![0u8; len];
    if !read_mem(h, buffer, &mut bytes) {
        return None;
    }
    let wide: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    Some(String::from_utf16_lossy(&wide))
}

/// (CommandLine, CurrentDirectory) from the target's PEB, or None if the reads
/// fail (exited / access denied / bitness mismatch).
unsafe fn read_process_strings(h: HANDLE) -> Option<(String, String)> {
    let mut pbi = [0u8; 0x30];
    let mut ret_len = 0u32;
    if NtQueryInformationProcess(
        h,
        0, // ProcessBasicInformation
        pbi.as_mut_ptr() as *mut core::ffi::c_void,
        pbi.len() as u32,
        &mut ret_len,
    ) != 0
    {
        return None;
    }
    // 🔴 PebBaseAddress 就在**本地 buffer** 里（NtQueryInformationProcess 刚写进去的），
    // **必须直接取** —— 不能拿 `pbi.as_ptr()` 当"目标进程里的地址"去 read_ptr：
    // 那是**本进程的栈地址**，在目标进程里无效。
    //
    // 这个 bug 极其隐蔽（2026-09-18 定位）：读**自己**时，那个栈地址在本进程里
    // 恰好就是它本身 → 成功；读**别的进程**则几乎必然失败。实测：321 个进程里
    // OpenProcess 成功 304 个，而 PEB 读取只成功 **1** 个（自己）。
    // 后果是所有依赖它的清理逻辑全部静默失效 —— 孤儿插件进程清扫、卸载/更新的
    // cwd 扫杀、`--ide-mode` 后端的命令行判定（见文件头注释）。
    let peb = usize::from_le_bytes(pbi[0x08..0x10].try_into().ok()?);
    if peb == 0 {
        return None;
    }
    let params = read_ptr(h, peb + 0x20)?;
    // RTL_USER_PROCESS_PARAMETERS (x64): CurrentDirectory @0x38 (CURDIR =
    // UNICODE_STRING DosPath + HANDLE), CommandLine @0x70.
    let cmd = read_ustring(h, params + 0x70)?;
    let cwd = read_ustring(h, params + 0x38).unwrap_or_default();
    Some((cmd, cwd))
}

fn read_process_command_line(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            return None;
        }
        let result = read_process_strings(h).map(|(cmd, _)| cmd);
        let _ = CloseHandle(h);
        result
    }
}

/// (pid, parent_pid, cmd, cwd) for every live process. One snapshot + PEB reads.
/// Used by the orphan/cwd sweeps below.
pub fn snapshot_processes() -> Vec<(u32, u32, String, String)> {
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
                let pid = entry.th32ProcessID;
                let ppid = entry.th32ParentProcessID;
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
                if !h.is_null() {
                    if let Some((cmd, cwd)) = read_process_strings(h) {
                        out.push((pid, ppid, cmd, cwd));
                    }
                    let _ = CloseHandle(h);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// 本机有几个**同款 GUI 实例**（含当前这个，最小返回值 1）。
///
/// 用途：区分「全局热键注册失败」的两种来源 —— 另一个 GUI 实例（多开的正常现象，
/// 用户无需处理）vs 其它软件（微信/QQ/输入法，用户需要换键）。OS 只给一句
/// `HotKey already registered`，不区分这两者，而它们对用户意味着完全不同的动作。
///
/// 判定方式：数命令行里含**当前 exe 文件名**的进程（`snapshot_processes` 读的是
/// PEB 里的完整命令行）。用当前 exe 名而非硬编码 `claude-code-gui.exe`，
/// 这样改名/多版本共存时仍然正确。
pub fn count_sibling_instances() -> usize {
    let Ok(exe) = std::env::current_exe() else { return 1 };
    let Some(name) = exe.file_name().and_then(|s| s.to_str()) else { return 1 };
    let needle = name.to_ascii_lowercase();
    snapshot_processes()
        .iter()
        .filter(|(_, _, cmd, _)| cmd.to_ascii_lowercase().contains(&needle))
        .count()
        .max(1)
}

/// Terminate every process (plus its descendants) whose command line contains
/// `needle` (case-insensitive). Used with `--ide-mode` to kill only GUI
/// backends, never the terminal TUI.
pub fn kill_by_command_line(needle: &str) {
    let needle = needle.to_lowercase();
    let mut roots: Vec<u32> = Vec::new();
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return;
    }
    unsafe {
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                if let Some(cmd) = read_process_command_line(entry.th32ProcessID) {
                    if cmd.to_lowercase().contains(&needle) {
                        roots.push(entry.th32ProcessID);
                    }
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    for root in roots {
        let mut tree = collect_descendants(root);
        tree.push(root);
        for p in tree {
            terminate(p);
        }
    }
}

/// Normalize for comparison: lowercase + forward slashes + one trailing slash.
fn norm_dir(p: &str) -> String {
    let mut s = p.replace('\\', "/").to_lowercase();
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

/// Kill every process whose **current working directory** is `dir` or below.
/// This is the handle holder that blocks `remove_dir_all` on Windows: a
/// process's cwd is an open directory handle and, unlike open *files*, it is
/// invisible to the user and survives force-kill of its parent. Plugin
/// background processes are spawned with cwd = the plugin dir, so orphaned
/// instances pin that directory forever. Returns how many were killed.
pub fn kill_processes_with_cwd_under(dir: &str) -> usize {
    let base = norm_dir(dir);
    let procs = snapshot_processes();
    let mut killed = 0usize;
    for (pid, _, _, cwd) in procs {
        if pid == std::process::id() {
            continue;
        }
        let cwd_n = norm_dir(&cwd);
        if cwd_n == base || cwd_n.starts_with(&base) {
            kill_process_tree(pid);
            killed += 1;
        }
    }
    killed
}

/// Kill every process that has **loaded a module from** `dir` (or below).
///
/// 与 `kill_processes_with_cwd_under` 是**两种不同的占用来源，都要杀**：
/// - **cwd**：进程的工作目录 = 该目录的一个句柄，钉住目录本身
/// - **模块**：`.node` / `.dll` 被加载进进程地址空间 → 那个**文件**被锁到进程退出
///
/// 实测（2026-09-17）：卸载 `mouse-keyboard` 报「拒绝访问」，日志显示
/// `kill_processes_with_cwd_under` **一个都没命中**（没有 killed 日志），而按模块
/// 路径能精确找到持有 `vendor/win32-x64/*.node` 的进程；杀掉后立刻可删。
/// 日志里连"Plugin uninstalled"都没有 → 只补 cwd 那一路不够。
///
/// 用 Toolhelp32 的**模块快照**（不需要打开目标进程读 PEB，故不受权限/位数影响），
/// 比逐进程 OpenProcess+VM_READ 更稳。
pub fn kill_processes_loading_from(dir: &str) -> usize {
    let base = norm_dir(dir);
    let procs = snapshot_processes();
    let mut killed = 0usize;
    for (pid, _, _, _) in procs {
        if pid == std::process::id() {
            continue;
        }
        if process_loads_module_under(pid, &base) {
            kill_process_tree(pid);
            killed += 1;
        }
    }
    killed
}

/// 该进程是否加载了 `base_norm` 下的任何模块（base_norm 已 norm_dir）。
fn process_loads_module_under(pid: u32, base_norm: &str) -> bool {
    unsafe {
        // ⚠️ 模块快照必须**按 pid 单独取**（TH32CS_SNAPMODULE 不接受 0）——
        // 传 0 是"当前进程"，会漏掉全部目标。
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut me: MODULEENTRY32W = std::mem::zeroed();
        me.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
        let mut found = false;
        if Module32FirstW(snap, &mut me) != 0 {
            loop {
                // szExePath: [u16; 260]，NUL 结尾
                let end = me.szExePath.iter().position(|&c| c == 0).unwrap_or(me.szExePath.len());
                let path = String::from_utf16_lossy(&me.szExePath[..end]);
                if !path.is_empty() && norm_dir(&path).starts_with(base_norm) {
                    found = true;
                    break;
                }
                if Module32NextW(snap, &mut me) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// 判断一个进程是不是本 GUI（命令行情包含自己 exe 的文件名）。
/// 插件的**合法父进程只可能是 GUI** —— 这条性质是下面孤儿判定成立的基础。
///
/// 用 `current_exe` 的文件名而非硬编码字符串：与 `count_sibling_instances` 同款，
/// 改名/多版本共存时也正确。`needle` 由调用方预先算好（避免循环里重复取 exe 路径）。
fn is_gui_process(cmdline: &str, needle: &str) -> bool {
    !needle.is_empty() && cmdline.to_ascii_lowercase().contains(needle)
}

/// 这个进程是不是**孤儿插件进程**（该杀）。
///
/// 抽成纯函数是为了能测 —— 这里曾经的真 bug 不在"匹配"而在**判据选错**：
/// 用「父 PID 是否存在于活进程表」代替「父进程是不是 GUI」，被 PID 复用骗过。
///
/// `gui_pids` 是**活着的 GUI 进程**的 PID 集合（不是"所有活进程"）。
fn is_orphan_plugin_process(
    ppid: u32,
    cwd: &str,
    gui_pids: &std::collections::HashSet<u32>,
    plugins_root_norm: &str,
) -> bool {
    // 父进程是活着的 GUI → 这是它在用的插件进程，绝不能动
    if gui_pids.contains(&ppid) {
        return false;
    }
    // cwd 不在插件根下 → 与插件无关（可能是别的 node 程序）
    norm_dir(cwd).starts_with(plugins_root_norm)
}

/// Kill **orphaned** plugin processes: parent is NOT a running GUI AND cwd is
/// inside `plugins_root`. Cleanup for processes whose GUI was force-killed /
/// crashed / updated (bypassing RunEvent::Exit) — they hold their plugin dir
/// hostage so uninstall fails with os error 32. Returns how many were killed.
///
/// ⚠️ **判据是"父进程是不是 GUI"，不是"父 PID 是否还存在"。**
/// 后者看着更简单，但**会被 PID 复用骗过**：GUI 退出后它的 PID 很快被系统
/// 分配给别的进程，于是 `live.contains(ppid)` 为真 → 把孤儿当成"GUI 的子进程"
/// 放过。实测（2026-09-17）：这台机器上累积了 **8 组** git-viewer + screenshot
/// 孤儿进程（从早上 08:38 到 14:18 每次 GUI 更新遗留一组），全都因为这个误判而
/// 没被清理；其中 screenshot 的那组把插件目录 cwd 钉死，导致**卸载报「拒绝访问」**
/// 且改名兜底也失败（cwd 句柄阻止 rename），用户界面里留下一个删不掉的空壳。
pub fn kill_orphan_plugin_processes(plugins_root: &str) -> usize {
    let base = norm_dir(plugins_root);
    let procs = snapshot_processes();
    // 活着的 GUI 进程 PID 集合 —— 插件进程的父进程若在集合里，就是"正在服役"的
    let needle = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_else(|| "claude-code-gui".to_string());
    let gui_pids: std::collections::HashSet<u32> = procs
        .iter()
        .filter(|(_, _, cmd, _)| is_gui_process(cmd, &needle))
        .map(|(pid, _, _, _)| *pid)
        .collect();
    let mut killed = 0usize;
    for (pid, ppid, _, cwd) in &procs {
        if *pid == std::process::id() {
            continue;
        }
        if !is_orphan_plugin_process(*ppid, cwd, &gui_pids, &base) {
            continue;
        }
        {
            kill_process_tree(*pid);
            killed += 1;
        }
    }
    killed
}

// ── Session-end cleanup window ──
//
// tao (the windowing layer under Tauri 2) does NOT process WM_QUERYENDSESSION
// (see tao-0.35 event_loop.rs: "We don't process WM_QUERYENDSESSION yet"), so on
// Windows shutdown/logoff the app is simply killed and the IDE backend is
// orphaned. The next GUI launch then has to clean up the leftover — the exact
// moment (early logon, restricted token) where spawning taskkill used to pop the
// 0xc0000142 dialog. A hidden top-level window receives the broadcast
// WM_QUERYENDSESSION / WM_ENDSESSION, so we kill the backend synchronously here
// and Windows can proceed with the shutdown.
static CLEANUP_CALLBACK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

const WM_QUERYENDSESSION: u32 = 0x0011;
const WM_ENDSESSION: u32 = 0x0016;

unsafe extern "system" fn end_session_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_QUERYENDSESSION || msg == WM_ENDSESSION {
        if let Some(cb) = CLEANUP_CALLBACK.get() {
            cb();
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Register a hidden top-level window that calls `callback` when the user logs
/// off or Windows shuts down. The callback runs synchronously on the main
/// thread while the end-session message is being dispatched. Idempotent-ish:
/// the callback is stored once for the process lifetime (intentional leak).
pub fn install_session_end_cleanup(callback: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
    if CLEANUP_CALLBACK.set(Box::new(callback)).is_err() {
        return Err("session-end cleanup already installed".into());
    }
    let class: Vec<u16> = "ClaudeCodeEndSessionWnd"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let class_ptr = class.as_ptr();

    unsafe {
        let hinst: HINSTANCE = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(end_session_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_ptr,
        };
        let atom = RegisterClassW(&wc);
        if atom == 0 {
            let err = GetLastError();
            if err != ERROR_CLASS_ALREADY_EXISTS {
                return Err(format!("RegisterClassW failed: error {err}"));
            }
        }

        // WS_OVERLAPPED (0) without WS_VISIBLE → created hidden. Parent-less →
        // top-level, so it receives the WM_QUERYENDSESSION / WM_ENDSESSION
        // broadcasts during shutdown/logoff.
        let hwnd = CreateWindowExW(
            0,
            class_ptr,
            std::ptr::null::<u16>(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinst,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return Err(format!(
                "CreateWindowExW failed: error {}",
                GetLastError()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_gui_process, is_orphan_plugin_process, norm_dir};

    /// 🔴 **本测试锁的是一个真实事故**（2026-09-17）：
    /// 孤儿判定若用「父 PID 是否存在于活进程表」，会被 **PID 复用**骗过 ——
    /// GUI 退出后它的 PID 被系统分配给别的进程，孤儿子是被当成"GUI 的子进程"放过。
    /// 实测累积了 **8 组**孤儿（git-viewer + screenshot 各 8 个），其中 screenshot
    /// 那组把插件目录 cwd 钉死 → 卸载报「拒绝访问」、**改名兜底也失败**（cwd 句柄
    /// 阻止 rename）→ 用户界面里留下一个删不掉、也重装不了的空壳。
    ///
    /// 判据必须是「**父进程是不是 GUI**」（gui_pids），不是「父 PID 是否存在」。
    #[test]
    fn orphan_detection_survives_pid_reuse() {
        use std::collections::HashSet;
        let root = norm_dir(r"C:\Users\X\AppData\plugins");
        // 活着的 GUI 只有 1000
        let gui_pids: HashSet<u32> = [1000u32].into_iter().collect();
        let in_root = r"C:\Users\X\AppData\plugins\screenshot";

        // ① 正在服役：父进程是活着的 GUI → **不杀**
        assert!(
            !is_orphan_plugin_process(1000, in_root, &gui_pids, &root),
            "GUI 自己的插件进程绝不能被当孤儿杀掉"
        );

        // ② 真孤儿，且父 PID 已消失 → 杀
        assert!(
            is_orphan_plugin_process(9999, in_root, &gui_pids, &root),
            "父进程不存在的插件进程是孤儿"
        );

        // ③ 🔴 关键用例：父 PID **被复用**给了别的进程（不在 gui_pids 里）——
        //    旧实现（按"PID 是否存在"）会放过它，导致孤儿永久累积
        assert!(
            is_orphan_plugin_process(4242, in_root, &gui_pids, &root),
            "父 PID 被复用给非 GUI 进程时，仍必须判为孤儿（这正是旧实现的漏洞）"
        );

        // ④ cwd 不在插件根下 → 与插件无关，不动
        assert!(
            !is_orphan_plugin_process(9999, r"C:\Users\X\projects\my-app", &gui_pids, &root),
            "cwd 不在插件目录下的进程不该被杀"
        );
    }

    #[test]
    fn gui_process_match_uses_exe_name_not_pid_liveness() {
        let needle = "claude-code-gui.exe";
        // 真正的 GUI 进程
        assert!(is_gui_process(r#""C:\app\claude-code-gui.exe""#, needle));
        assert!(is_gui_process(r#""C:\Program Files (x86)\Claude Code Haha\claude-code-gui.exe" --flag"#, needle));
        // 大小写不敏感（Windows 路径）
        assert!(is_gui_process(r#""C:\APP\CLAUDE-CODE-GUI.EXE""#, needle));
        // ⚠️ 关键：PID 被复用后的"假父进程"长这样 —— 它不是 GUI，必须判为"非 GUI"
        assert!(!is_gui_process(r#""C:\Windows\System32\svchost.exe" -k netsvcs"#, needle));
        assert!(!is_gui_process(r#""node" server.cjs"#, needle));
        // needle 为空时一律 false（避免空串 contains 恒真把所有进程都当 GUI）
        assert!(!is_gui_process("anything", ""));
    }

    #[test]
    fn norm_dir_normalizes_case_separators_and_trailing_slash() {
        assert_eq!(norm_dir(r"C:\Users\X\AppData\plugins"), "c:/users/x/appdata/plugins/");
        assert_eq!(norm_dir("C:/Users/X/AppData/plugins/"), "c:/users/x/appdata/plugins/");
        assert_eq!(norm_dir(r"C:\Users\X\AppData\plugins\\").replace("//", "/"), "c:/users/x/appdata/plugins/");
    }

    #[test]
    fn norm_dir_prefix_match_does_not_span_sibling_dirs() {
        let base = norm_dir(r"C:\p\plugins\git-viewer");
        let sibling = norm_dir(r"C:\p\plugins\git-viewer-extra");
        assert!(!sibling.starts_with(&base), "sibling dir must not match as child");
        let child = norm_dir(r"C:\p\plugins\git-viewer\sub");
        assert!(child.starts_with(&base), "nested dir must match");
        let itself = norm_dir(r"C:\p\plugins\git-viewer");
        assert!(itself.starts_with(&base));
    }
}


#[cfg(test)]
mod regression_tests {
    use super::*;

    /// 🔴 **回归测试（2026-09-18）**：`snapshot_processes()` 必须能读到**别的**进程。
    ///
    /// 真 bug：`read_process_strings` 里用 `read_ptr(h, pbi.as_ptr() as usize + 0x08)`
    /// 取 PebBaseAddress —— 把**本进程的栈地址**当成"目标进程里的地址"去读。
    /// 读**自己**时那个地址恰好有效 → 成功；读**别人**几乎必然失败。
    /// 实测 321 个进程里只有 1 个（自己）能读出来，导致所有清理逻辑静默失效
    /// （孤儿插件进程清扫 / 卸载与更新的 cwd 扫杀 / `--ide-mode` 命令行判定）。
    ///
    /// 这个断言抓的正是那个特征："只读得到自己"。
    #[test]
    fn snapshot_reads_other_processes() {
        let procs = snapshot_processes();
        let others = procs
            .iter()
            .filter(|(pid, _, _, _)| *pid != std::process::id())
            .count();
        assert!(
            others >= 10,
            "snapshot_processes 只读到 {} 个别的进程（共 {} 个）—— PebBaseAddress 的读取可能又坏了",
            others,
            procs.len()
        );
    }

    /// 读到的 cwd **内容正确**（不只是"非空"）—— 用自己当靶子比对一个已知值。
    #[test]
    fn snapshot_reads_own_cwd_correctly() {
        let procs = snapshot_processes();
        let me = procs
            .iter()
            .find(|(pid, _, _, _)| *pid == std::process::id())
            .expect("应能在快照里找到自己");
        let expect = std::env::current_dir()
            .expect("current_dir 应可用")
            .to_string_lossy()
            .to_string();
        assert_eq!(
            norm_dir(&me.3),
            norm_dir(&expect),
            "读到的 cwd 与 current_dir 不符（读到 {:?}，实际 {:?}）",
            me.3,
            expect
        );
    }

    /// 命令行里应能认出自己（`read_ustring` 走通了、偏移没写错）。
    #[test]
    fn snapshot_reads_own_command_line() {
        let procs = snapshot_processes();
        let me = procs
            .iter()
            .find(|(pid, _, _, _)| *pid == std::process::id())
            .expect("应能在快照里找到自己");
        assert!(
            me.2.to_ascii_lowercase().contains("prockill") || me.2.to_ascii_lowercase().contains("claude_code_gui"),
            "自己的命令行读出来是 {:?} —— 看起来不像本测试进程",
            me.2
        );
    }
}

#[cfg(test)]
mod diag_tests {
    use super::*;

    /// 诊断：`snapshot_processes()` 在本机到底能读到什么？
    ///
    /// 背景（2026-09-18）：用户的插件更新报 os error 32，18 个孤儿插件进程
    /// 钉住了插件目录 —— 而启动清扫（依赖本函数）**一个都没杀掉**。
    /// 同样的判定逻辑用 Python（独立进程）跑能正确识别 18 个 → 怀疑
    /// **PEB 读取在 GUI/测试进程内失败**（注释里 2026-09-17 已有同类观察）。
    ///
    /// 手动跑：cargo test --lib diag_snapshot -- --ignored --nocapture
    #[test]
    #[ignore]
    fn diag_snapshot() {
        let procs = snapshot_processes();
        println!("snapshot 返回 {} 个进程", procs.len());
        let with_cwd = procs.iter().filter(|(_, _, _, c)| !c.is_empty()).count();
        let with_cmd = procs.iter().filter(|(_, _, c, _)| !c.is_empty()).count();
        println!("  读到 cwd 的: {} 个", with_cwd);
        println!("  读到 cmd 的: {} 个", with_cmd);

        println!("
-- 命令行含 server.cjs / git-viewer 的（即插件进程）--");
        let mut n = 0;
        for (pid, ppid, cmd, cwd) in &procs {
            if cmd.contains("server.cjs") || cmd.contains("git-viewer-server") {
                n += 1;
                println!("  pid={:<6} ppid={:<6} cwd={:?}", pid, ppid, cwd);
            }
        }
        println!("  共 {} 个", n);

        println!("
-- GUI 进程（gui_pids 的来源）--");
        let needle = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_ascii_lowercase()))
            .unwrap_or_default();
        println!("  needle = {:?}", needle);
        for (pid, _, cmd, _) in &procs {
            if is_gui_process(cmd, &needle) {
                println!("  pid={} cmd={}", pid, &cmd[..cmd.len().min(80)]);
            }
        }
    }

    /// 诊断 2：把 `snapshot_processes` 的每一步拆开打印 —— 定位是
    /// 「枚举」失败还是「OpenProcess」失败还是「读 PEB」失败。
    #[test]
    #[ignore]
    fn diag_snapshot_steps() {
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
        };
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            println!("CreateToolhelp32Snapshot -> {:?}", snap);
            println!("  INVALID_HANDLE_VALUE    -> {:?}", INVALID_HANDLE_VALUE);
            if snap == INVALID_HANDLE_VALUE {
                println!("  ** 快照创建失败 ** err={}", GetLastError());
                return;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            println!("  sizeof(PROCESSENTRY32W) = {}", entry.dwSize);

            let mut total = 0u32;
            let mut open_ok = 0u32;
            let mut read_ok = 0u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            println!("  Process32FirstW 返回 {} err={}", ok, GetLastError());
            let mut i = 0;
            while ok != 0 {
                total += 1;
                let pid = entry.th32ProcessID;
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
                let detail = if h.is_null() {
                    format!("OpenProcess 失败 err={}", GetLastError())
                } else {
                    open_ok += 1;
                    let r = read_process_strings(h);
                    if r.is_some() { read_ok += 1; }
                    CloseHandle(h);
                    if r.is_some() { "Open+读取 OK".to_string() } else { "Open OK 但读取失败".to_string() }
                };
                if i < 6 || pid == std::process::id() {
                    println!("    [{}] pid={:<6} ppid={:<6} {}", i, pid, entry.th32ParentProcessID, detail);
                }
                i += 1;
                ok = Process32NextW(snap, &mut entry);
                if ok == 0 {
                    println!("  Process32NextW 结束（第 {} 次后）err={}", i, GetLastError());
                }
            }
            CloseHandle(snap);
            println!();
            println!("  枚举到 {} 个 | OpenProcess 成功 {} | PEB 读取成功 {}", total, open_ok, read_ok);
        }
    }

    /// 诊断：cwd 读取对**指定 PID**能不能成功（逐个试权限组合）
    #[test]
    #[ignore]
    fn diag_cwd_probe() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let procs = snapshot_processes();
        for (pid, _, cmd, _) in procs.iter().take(400) {
            if !cmd.contains("server.cjs") && !cmd.contains("git-viewer-server") {
                continue;
            }
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x0010, 0, *pid);
                if h.is_null() {
                    println!("  pid={} OpenProcess 失败 (err={})", pid, std::io::Error::last_os_error());
                } else {
                    let r = read_process_strings(h);
                    match r {
                        Some((c, cw)) => println!("  pid={} OK cmd={:?} cwd={:?}", pid, &c[..c.len().min(40)], cw),
                        None => println!("  pid={} 打开了但 read_process_strings 返回 None", pid),
                    }
                    CloseHandle(h);
                }
            }
        }
    }
}
