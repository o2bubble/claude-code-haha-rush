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
