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
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
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

fn read_process_command_line(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            return None;
        }
        let result = (|| {
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
            let peb = read_ptr(h, pbi.as_ptr() as usize + 0x08)?;
            let params = read_ptr(h, peb + 0x20)?;
            // UNICODE_STRING: Length(u16) | MaximumLength(u16) | Buffer(ptr @0x08)
            let mut cmd = [0u8; 0x10];
            if !read_mem(h, params + 0x70, &mut cmd) {
                return None;
            }
            let len = u16::from_le_bytes([cmd[0], cmd[1]]) as usize;
            if len == 0 || len > 0x8000 {
                return None;
            }
            let buffer = read_ptr(h, params + 0x70 + 0x08)?;
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
        })();
        let _ = CloseHandle(h);
        result
    }
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
