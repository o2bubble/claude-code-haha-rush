//! GUI 实例注册表 —— **GUI 与 server 共用**。
//!
//! 原本在 GUI crate 的 `src/instances.rs` 里。2026-10-27 下沉到这里，因为
//! `claude-gui-server` 的托盘菜单也要列出所有 GUI 实例（并结束它们）——
//! server 是独立 crate，拿不到 GUI 的模块。
//!
//! 这里只放**两边都要用**的部分（记录格式、判活、目录定位）；
//! GUI 专属的升级快照/认领逻辑仍留在 `gui/src-tauri/src/instances.rs`。
//!
//! 为什么用"每实例一个文件"而不是"一个共享文件"：
//!   · 多实例**并发写**同一个 JSON 会互相覆盖（少写即丢失实例）；
//!   · 各自的文件互不干扰，读的时候合并即可。
//!
//! 为什么放在 app_data_dir 而不是安装目录：安装目录在升级时会被整体替换，
//! 放在那里的文件会被清掉（或阻塞替换）。app_data_dir 不受升级影响。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 一个实例的自述（写在 `<app_data>/instances/<pid>.json`）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstanceRecord {
    pub pid: u32,
    /// 绑定的工作区绝对路径。空 = 尚未绑定（启动早期）。
    #[serde(default)]
    pub workspace: String,
    /// 当前加载的会话 id。空 = 还没加载会话（只有工作区）。
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    /// 当前会话的**标题**（2026-10-28 新增）。
    ///
    /// 为什么单独存：托盘菜单要显示「工作区 · 会话名」帮用户认出是哪个窗口
    /// （用户要求）。会话名只有 GUI 的业务层知道（在会话列表里），server 拿不到 ——
    /// 所以由 GUI 随自述一起写下来。
    ///
    /// 空 = 没加载会话 / 旧版本写的记录 → 菜单只显示工作区（不显示空括号）。
    #[serde(rename = "sessionTitle", default)]
    pub session_title: String,
    /// **进程启动时刻**（Unix ms，由 `GetProcessTimes` 得来）。
    ///
    /// 判存活的唯一正确姿势是 **pid + 启动时间**，因为 pid 会被系统复用：
    /// 升级强杀实例后自述文件必然残留（强杀不走清理），若某个新进程恰好分到
    /// 死实例的 pid，只看 pid 就会把残留误判成"还活着"。实测事故（2026-09-21/22）：
    /// 恢复快照里绑同一工作区的残留被误判存活 → 「跳过（已有实例绑定该工作区）」
    /// → **该工作区的窗口少恢复一个**（用户感知："有时没拉起新实例"）。
    ///
    /// 0 = 旧版本写的记录（无此字段）→ 一律视为**不可信**（当死处理）。
    #[serde(default)]
    pub started_at: u64,
    /// 最后更新时刻（ms）。用于排序/诊断；判存活不用它（见 `started_at`）。
    #[serde(default)]
    pub updated_at: u64,
}

/// 与 `tauri.conf.json` 的 `identifier` **必须一致**。
///
/// 存在的唯一理由：**在 Tauri App 建立之前**也要能定位 app_data_dir ——
/// GUI 认领自己的状态必须赶在 `settings::load_settings()` 之前，
/// 而那时还没有 AppHandle；server 则根本没有 AppHandle。
///
/// 不一致的后果是**功能降级**（早期认领失败 → 退到 setup() 里的兜底认领），
/// 不会崩。改 identifier 时记得同步这里。
pub const APP_BUNDLE_ID: &str = "com.claudecode.gui";

/// `<数据目录>/<bundle id>`，等价于 Tauri 的 `app.path().app_data_dir()`。
pub fn app_data_dir_early() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join(APP_BUNDLE_ID))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .ok()
            .map(|p| PathBuf::from(p).join(".config").join(APP_BUNDLE_ID))
    }
}

/// 实例自述目录：`<app_data>/instances/`。
pub fn instances_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("instances")
}

/// 写一个实例的自述（原子替换：先 tmp 再 rename —— 升级时可能被强杀在读一半的时刻）。
pub fn write_instance_record(app_data_dir: &Path, rec: &InstanceRecord) -> Result<(), String> {
    let dir = instances_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建实例目录失败: {e}"))?;
    let path = dir.join(format!("{}.json", rec.pid));
    let json = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写实例自述失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("提交实例自述失败: {e}"))?;
    Ok(())
}

/// 读指定 pid 的自述（不存在/损坏 → None）。
pub fn read_instance_record(app_data_dir: &Path, pid: u32) -> Option<InstanceRecord> {
    let path = instances_dir(app_data_dir).join(format!("{pid}.json"));
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<InstanceRecord>(&text).ok()
}

/// 删指定 pid 的自述。
pub fn remove_instance_record(app_data_dir: &Path, pid: u32) {
    let _ = std::fs::remove_file(instances_dir(app_data_dir).join(format!("{pid}.json")));
}

/// 收集**所有还活着**的实例自述，并顺带清理死实例留下的文件。
///
/// `alive` 由调用方注入（GUI 用 `is_instance_alive`，测试可传桩）。
/// 顺带清理的意义：升级强杀 / 崩溃留下的残留不会无限累积
/// （实测曾积压 5 个死进程文件）。
pub fn collect_live_instances<F>(app_data_dir: &Path, alive: F) -> Vec<InstanceRecord>
where
    F: Fn(&InstanceRecord) -> bool,
{
    let dir = instances_dir(app_data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            let _ = std::fs::remove_file(&path); // 读不出 → 损坏，清掉
            continue;
        };
        let Ok(rec) = serde_json::from_str::<InstanceRecord>(&text) else {
            let _ = std::fs::remove_file(&path); // 解析失败 → 损坏，清掉
            continue;
        };
        if alive(&rec) {
            out.push(rec);
        } else {
            let _ = std::fs::remove_file(&path); // 死实例 → 清理
        }
    }
    out.sort_by_key(|r| r.pid);
    out
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 进程启动时刻（Unix ms）。
///
/// 🔴 **必须同时检查退出码**（2026-10-27 事故）：
///
/// `OpenProcess` 对**已退出但句柄未被回收**的进程仍会成功，`GetProcessTimes`
/// 也照样返回**原来的创建时间** —— 于是本函数返回 `Some(原值)`，调用方认为
/// "进程还活着"。
///
/// 实测事故：锁文件记着 pid=19896（早已退出，`GetExitCodeProcess` 返回 1 而不是
/// 259=STILL_ACTIVE），但本函数返回了**和锁里一模一样的启动时刻** → 判定"持有者
/// 活着" → 本实例被当成第二个实例 → **前端跳过自动加载最近会话**。
pub fn process_start_time_ms(pid: u32) -> Option<u64> {
    if pid == 0 {
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }

            // ⚠️ 先确认还在运行 —— 见上面的说明。
            let mut code: u32 = 0;
            let code_ok = GetExitCodeProcess(h, &mut code);
            if code_ok == 0 || code != STILL_ACTIVE as u32 {
                CloseHandle(h);
                return None;
            }

            let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let mut exit = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let ok = GetProcessTimes(h, &mut creation, &mut exit, &mut kernel, &mut user);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            let raw = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
            // Windows FILETIME 纪元（1601）→ Unix 纪元的偏移，单位 100ns
            const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
            raw.checked_sub(EPOCH_DIFF_100NS).map(|v| v / 10_000)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// 判断一条实例自述对应的进程是否**还活着** —— **pid + 启动时间双因子**。
///
/// 只看 pid 会踩 pid 复用（见 `InstanceRecord::started_at` 的事故记录）；
/// 启动时间不同 = 这是另一个进程（复用了同一个 pid），原实例已死。
/// 记录缺启动时间（0，旧版本写的）→ 不可信，当死。
pub fn is_instance_alive(rec: &InstanceRecord) -> bool {
    // 记录里没有启动时间 → 旧版残留，不可信（当死）
    if rec.started_at == 0 {
        return false;
    }
    // 取不到 = 进程已退出（或 pid 不存在）
    match process_start_time_ms(rec.pid) {
        Some(now) => now == rec.started_at,
        None => false,
    }
}

/// 工作区路径归一化 —— 判"同一个工作区"时用。
///
/// Windows 路径大小写不敏感、`\` 与 `/` 等价、尾斜杠无意义，
/// 不归一化会导致同一工作区被当成两个（唤醒/去重都失效）。
pub fn normalize_workspace(p: &str) -> String {
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

/// 从实例列表里挑一个"应该被唤醒"的目标。
///
/// 规则：排除自己、只要活着的、工作区必须一致、取 `updated_at` 最新的。
/// 纯函数，便于测试。
pub fn pick_wake_target(
    records: &[InstanceRecord],
    my_pid: u32,
    workspace: &str,
) -> Option<InstanceRecord> {
    let want = normalize_workspace(workspace);
    records
        .iter()
        .filter(|r| r.pid != my_pid && !want.is_empty())
        .filter(|r| normalize_workspace(&r.workspace) == want)
        // 最后更新时刻最新 = 用户最有可能正在用的那个
        .max_by_key(|r| r.updated_at)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(pid: u32, ws: &str, updated: u64) -> InstanceRecord {
        InstanceRecord {
            pid,
            workspace: ws.into(),
            session_id: String::new(),
            started_at: 12345,
            updated_at: updated,
        }
    }

    #[test]
    fn normalize_handles_slashes_and_case() {
        assert_eq!(
            normalize_workspace("C:\\Work\\Proj\\"),
            normalize_workspace("c:/work/proj"),
        );
        assert_eq!(normalize_workspace("/a/b//"), "/a/b");
    }

    #[test]
    fn picks_latest_matching_workspace() {
        let recs = vec![
            rec(1, "C:/ws/a", 100),
            rec(2, "C:/ws/a", 300), // 最新 → 选它
            rec(3, "C:/ws/b", 999), // 工作区不同
        ];
        let t = pick_wake_target(&recs, 9, "c:\\ws\\a").unwrap();
        assert_eq!(t.pid, 2);
    }

    #[test]
    fn never_picks_self() {
        let recs = vec![rec(7, "C:/ws/a", 100)];
        assert!(pick_wake_target(&recs, 7, "C:/ws/a").is_none());
    }

    #[test]
    fn empty_workspace_never_matches() {
        // 没绑定工作区的实例不该被当成唤醒目标（否则会醒错窗口）
        let recs = vec![rec(1, "", 100)];
        assert!(pick_wake_target(&recs, 9, "").is_none());
        assert!(pick_wake_target(&recs, 9, "C:/ws/a").is_none());
    }

    #[test]
    fn live_process_detected_and_dead_rejected() {
        let me = std::process::id();
        assert!(process_start_time_ms(me).is_some(), "自进程必须是活的");
        assert!(process_start_time_ms(999_999).is_none(), "不存在的 pid 必须判死");
    }

    #[test]
    fn record_without_started_at_is_never_alive() {
        let mut r = rec(1, "C:/ws/a", 0);
        r.started_at = 0;
        assert!(!is_instance_alive(&r), "旧格式（无启动时间）必须当死");
    }
}
