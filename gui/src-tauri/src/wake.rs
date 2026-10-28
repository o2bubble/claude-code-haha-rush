//! 单实例唤醒 —— 启动第二个 GUI 时把已有实例的窗口拉回前台。
//!
//! ## 解决的问题（2026-10-27 用户反馈）
//!
//! 因为未知原因（截图插件隐藏窗口等）GUI 的所有窗口被隐藏了，用户看不到界面，
//! 但进程还在后台跑。用户不知道，会再启动一个 —— **新实例完全独立**，
//! 于是旧进程变成"看不见也管不着"的僵尸，越积越多（实测同名进程累积 5 个）。
//!
//! ## 为什么不在启动时直接拒绝
//!
//! 用户确实可能想开**多个**工作区窗口，所以不能简单"已有实例就不启动"。
//! 只在**同一工作区**且**裸启动**（无 `--workspace`/`--intent`/`--session`/
//! `--new-instance`）时才尝试唤醒 —— 这是"用户双击图标"的典型场景。
//!
//! ## 唤醒链路（三级降级）
//!
//! ```text
//! ① server WS：AllowSetForegroundWindow(target) → send_gui_message("focus:<me>")
//!    → 目标实例自己 show+focus → 写 ack 文件 → 本进程读到 ack → exit(0)
//! ② Win32 兜底：EnumWindows 找目标 pid 的顶层窗 → ShowWindow(RESTORE)+SetForegroundWindow
//! ③ 都不行：照常启动（绝不阻塞用户）
//! ```

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 等目标实例回复 ack 的时长。超过就不再等，走兜底或直接启动。
const ACK_TIMEOUT: Duration = Duration::from_millis(2500);
const ACK_POLL: Duration = Duration::from_millis(50);

/// `<app_data>/wake/` —— 唤醒握手的 ack 文件目录。
fn wake_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("wake")
}

/// ack 文件路径：`ack-<目标pid>-<发起方pid>.json`
fn ack_path(app_data_dir: &Path, target_pid: u32, from_pid: u32) -> PathBuf {
    wake_dir(app_data_dir).join(format!("ack-{target_pid}-{from_pid}.json"))
}

/// 目标实例写好 ack（表示"我已经把窗口拉到前台了"）。
pub fn write_wake_ack(app_data_dir: &Path, my_pid: u32, from_pid: u32) {
    let dir = wake_dir(app_data_dir);
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(ack_path(app_data_dir, my_pid, from_pid), "{\"ok\":true}");
}

/// 清理过期的 ack 文件（发起方被强杀时留下的）。启动时顺手扫一遍。
pub fn sweep_stale_acks(app_data_dir: &Path) {
    let dir = wake_dir(app_data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let now = std::time::SystemTime::now();
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        // 5 分钟前的 ack 不可能还有人在等
        if now.duration_since(modified).map(|d| d.as_secs()).unwrap_or(0) > 300 {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 尝试唤醒 `target_pid`，成功返回 true。
///
/// `attempt` 由调用方提供具体手段（发 WS 消息 / Win32），方便测试与降级。
/// 这里只负责"发起 → 等 ack → 判成败"的时序。
pub fn await_wake_ack<F>(app_data_dir: &Path, target_pid: u32, my_pid: u32, attempt: F) -> bool
where
    F: FnOnce(u32) -> bool,
{
    let ack = ack_path(app_data_dir, target_pid, my_pid);
    let _ = std::fs::remove_file(&ack); // 清掉可能存在的旧 ack

    if !attempt(target_pid) {
        return false;
    }

    let deadline = Instant::now() + ACK_TIMEOUT;
    while Instant::now() < deadline {
        if ack.exists() {
            let _ = std::fs::remove_file(&ack);
            return true;
        }
        std::thread::sleep(ACK_POLL);
    }
    false
}

/// Win32 兜底：直接对目标进程的顶层窗口 show + 置前。
///
/// 不必经过目标进程配合 —— 用 `EnumWindows` 按 pid 找窗口即可。
/// 注意 Windows 前台锁：调用方应先 `AllowSetForegroundWindow(target_pid)`，
/// 否则 `SetForegroundWindow` 可能只让任务栏图标闪烁而不置前。
#[cfg(windows)]
pub fn force_show_process_windows(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow,
        SW_RESTORE, SW_SHOW,
    };

    struct Ctx {
        pid: u32,
        hit: bool,
    }

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut Ctx);
        let mut win_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut win_pid);
        if win_pid == ctx.pid {
            // 先 SW_SHOW 撤销 SW_HIDE（截图插件那种隐藏），再 SW_RESTORE 处理最小化
            ShowWindow(hwnd, SW_SHOW);
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
            ctx.hit = true;
        }
        1 // 继续枚举（一个进程可能有多窗口）
    }

    let mut ctx = Ctx { pid, hit: false };
    unsafe {
        EnumWindows(Some(cb), &mut ctx as *mut Ctx as LPARAM);
    }
    let _ = IsWindowVisible; // 保持导入（部分配置下未使用）
    ctx.hit
}

#[cfg(not(windows))]
pub fn force_show_process_windows(_pid: u32) -> bool {
    false
}

/// 把本进程设为"允许目标进程抢前台"的授权方。
///
/// Windows 前台锁规则：只有**当前前台进程**才能把前台交给别人；
/// `AllowSetForegroundWindow(pid)` 显式授权后，目标进程的 `SetForegroundWindow`
/// 才会生效。这正是跨进程置前的关键一步。
#[cfg(windows)]
pub fn allow_set_foreground(pid: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
    unsafe {
        let _ = AllowSetForegroundWindow(pid);
    }
}

#[cfg(not(windows))]
pub fn allow_set_foreground(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ccgui-wake-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ack_file_unblocks_wait() {
        let d = tmp("ack");
        let ok = await_wake_ack(&d, 100, 200, |target| {
            // 模拟目标实例：稍后写 ack
            let dir = d.clone();
            assert_eq!(target, 100);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(80));
                write_wake_ack(&dir, 100, 200);
            });
            true
        });
        assert!(ok, "ack 出现后应返回 true");
    }

    #[test]
    fn attempt_failure_returns_immediately() {
        let d = tmp("fail");
        let t0 = Instant::now();
        let ok = await_wake_ack(&d, 100, 200, |_| false);
        assert!(!ok);
        assert!(
            t0.elapsed() < ACK_TIMEOUT,
            "尝试失败应立即返回，不该白等超时"
        );
    }

    #[test]
    fn stale_ack_is_ignored() {
        let d = tmp("stale");
        // 预置一个旧的 ack（模拟上一次成功的握手残留）
        std::fs::create_dir_all(wake_dir(&d)).unwrap();
        std::fs::write(ack_path(&d, 100, 200), "{}").unwrap();

        // 本次 attempt 失败 → 不该因为旧 ack 就判成功
        let ok = await_wake_ack(&d, 100, 200, |_| false);
        assert!(!ok, "出发点失败时不能因残留 ack 误判成功");
    }

    #[test]
    fn timeout_when_no_ack() {
        let d = tmp("timeout");
        let t0 = Instant::now();
        let ok = await_wake_ack(&d, 100, 200, |_| true); // 发出成功，但没人回应
        assert!(!ok);
        assert!(t0.elapsed() >= ACK_TIMEOUT);
    }
}
