// ── 实例注册表 + 升级恢复快照 ──
//
// 解决的问题（2026-09-21 用户实测反馈）：**升级重启后所有工作区/会话重置、
// 实例只剩一个**。同时开多个 GUI 的用户，升级后要手工重建整个工作环境。
//
// 为什么需要"注册表"这一层：升级时会**强杀所有 GUI 实例**（为释放 exe 文件锁，
// 见 update.rs 的 launch_updater_and_exit），杀之前没有任何地方记录了"刚才有哪些
// 实例、各自绑了什么工作区、开着哪个会话"。而**进程内**的记忆随进程一起消失。
//
// 方案：每个实例在自己的数据目录下**写一份小小的自述文件**（按 pid 命名，天然无
// 冲突），升级前把所有**还活着**的实例自述读出来合并成一份"恢复快照"，升级后由
// 首个启动的新 GUI 按快照逐个拉起（带 --workspace / --session，跳过选择器）。
//
// 为什么用"每实例一个文件"而不是"一个共享文件"：
//   · 多实例**并发写**同一个 JSON 会互相覆盖（少写即丢失实例）；
//   · 各自的文件互不干扰，读的时候合并即可。
//
// 为什么放在 app_data_dir 而不是安装目录：安装目录在升级时会被整体替换，
// 放在那里的文件会被清掉（或阻塞替换）。app_data_dir 不受升级影响。

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
    /// 最后更新时刻（ms）。用于排序/诊断；判存活靠 pid 而不是它。
    #[serde(default)]
    pub updated_at: u64,
}

/// 恢复快照：升级前存下来，升级后由新 GUI 消费一次。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RestoreSnapshot {
    /// 创建时刻（ms），用于诊断与"过期快照"判断。
    #[serde(default)]
    pub created_at: u64,
    /// **发起升级那个实例自己的状态**。
    ///
    /// 为什么必须有它（2026-09-21 用户实测"升级后没进工作区"）：updater 替换完文件
    /// 只会**裸 spawn 一个 exe（不带任何参数）** —— 它不知道原来绑的哪个工作区。
    /// 所以那个新实例启动后只能弹工作区选择器，用户感知就是"升级完工作区没了"。
    /// 这个字段让**无参数启动的新实例**认领回自己的工作区与会话。
    ///
    /// 认领条件见 `adopt_self_record`：仅当本进程**没有** `--workspace` 参数时
    /// （= 它就是 updater 重启的那个）才会认领，避免普通启动误用旧快照。
    #[serde(rename = "self", default)]
    pub self_record: Option<InstanceRecord>,
    /// 要拉起**其它**实例（不含自己 —— 自己在 self_record 里）。
    #[serde(default)]
    pub instances: Vec<InstanceRecord>,
}

/// 实例自述目录：`<app_data>/instances/`。
fn instances_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("instances")
}

/// 与 `tauri.conf.json` 的 `identifier` **必须一致**。
///
/// 存在的唯一理由：**在 Tauri App 建立之前**也要能定位 app_data_dir ——
/// 认领自己的状态必须赶在 `settings::load_settings()` 之前（见 lib.rs 的调用点），
/// 而那时还没有 AppHandle，拿不到 `app.path().app_data_dir()`。
///
/// 不一致的后果是**功能降级**（早期认领失败 → 退到 setup() 里的兜底认领），
/// 不会崩。改 identifier 时记得同步这里。
const APP_BUNDLE_ID: &str = "com.claudecode.gui";

/// `<数据目录>/<bundle id>`，等价于 Tauri 的 `app.path().app_data_dir()`。
/// 只在启动早期（无 AppHandle）使用 —— 见 APP_BUNDLE_ID 的注释。
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

/// 升级恢复快照的路径：`<app_data>/pending-restore.json`。
pub fn restore_snapshot_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("pending-restore.json")
}

/// 写本实例的自述（覆盖写，原子替换）。
pub fn write_instance_record(app_data_dir: &Path, rec: &InstanceRecord) -> Result<(), String> {
    let dir = instances_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建实例目录失败: {e}"))?;
    let path = dir.join(format!("{}.json", rec.pid));
    let json = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    // 原子写：先 tmp 再 rename —— 升级时可能被强杀在读一半的时刻
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写实例自述失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("提交实例自述失败: {e}"))?;
    Ok(())
}

/// 读本实例的自述（不存在/损坏 → None）。
///
/// 用途：`update_instance_record` 在"会话为空但要求保留"时读回旧值，
/// 避免把已经报过的会话冲成空（见该命令的注释）。
pub fn read_instance_record(app_data_dir: &Path, pid: u32) -> Option<InstanceRecord> {
    let path = instances_dir(app_data_dir).join(format!("{pid}.json"));
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<InstanceRecord>(&text).ok()
}

/// 删本实例的自述（正常退出时）。
pub fn remove_instance_record(app_data_dir: &Path, pid: u32) {
    let _ = std::fs::remove_file(instances_dir(app_data_dir).join(format!("{pid}.json")));
}

/// 收集**所有还活着**的实例自述，并顺带清理死实例留下的文件。
///
/// `alive` 由调用方注入（判断"这个 pid 是不是还活着"）——便于单测，
/// 也避免本模块依赖 prockill 的平台细节。
pub fn collect_live_instances<F>(app_data_dir: &Path, alive: F) -> Vec<InstanceRecord>
where
    F: Fn(u32) -> bool,
{
    let dir = instances_dir(app_data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue; // 跳过 .tmp / 其它杂项
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(rec) = serde_json::from_str::<InstanceRecord>(&text) else {
            // 坏文件（写了一半就被杀）→ 清掉，免得每次升级都读到
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if rec.pid == 0 || !alive(rec.pid) {
            // 死实例 → 删文件（顺手清理，避免目录无限增长）
            let _ = std::fs::remove_file(&path);
            continue;
        }
        out.push(rec);
    }
    out
}

/// 单次恢复的实例数上限 —— 防止一次拉起十几个把机器拖死。
/// 超出部分**丢弃**而不是排队：用户真要开那么多，升级后手工开更稳。
pub const MAX_RESTORE_INSTANCES: usize = 8;

/// 等一个**新拉起**的实例"就绪"（= 已绑定工作区、写出自述）的超时。
///
/// 进程启动后要建 WebView2 + 起后端 + 起插件才能写自述，实测十几秒；给足余量。
/// 超时不算失败 —— 记一条日志后继续拉下一个（不能让一个慢实例卡死整轮恢复）。
pub const INSTANCE_READY_TIMEOUT_MS: u64 = 90_000;

/// 等就绪时的轮询间隔。
const INSTANCE_READY_POLL_MS: u64 = 800;

/// 写恢复快照（升级前）。
///
/// 自己的状态存进 `self_record`（供 updater 重启出的无参实例认领，见 adopt_self_record），
/// **其它**实例存进 `instances`（由新 GUI 逐个拉起）。
///
/// 只保留**有工作区**的实例：没有工作区的实例拉起后还是要弹选择器，
/// 恢复它没有意义（反而多开一个空窗口）。
///
/// **按工作区去重**（同一工作区只留一条）：用户可能同时开着两个绑同一工作区的窗口
/// （`2026-09-22` 实测确有 —— 那正是实例数只增不减、每次升级都要拉更多进程的原因之一）。
/// 不去重的话每轮升级都会把它们原样恢复，数量永远降不下来。
pub fn save_restore_snapshot(
    app_data_dir: &Path,
    self_pid: u32,
    live: &[InstanceRecord],
) -> Result<usize, String> {
    let has_ws = |r: &&InstanceRecord| !r.workspace.trim().is_empty();
    let self_record = live
        .iter()
        .find(|r| r.pid == self_pid)
        .filter(has_ws)
        .cloned();
    let mut seen_ws: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 自己占用的工作区也算"已见" —— 否则会给自己那个工作区再拉一个
    if let Some(me) = &self_record {
        seen_ws.insert(me.workspace.clone());
    }
    let instances: Vec<InstanceRecord> = live
        .iter()
        .filter(|r| r.pid != self_pid)
        .filter(has_ws)
        .filter(|r| seen_ws.insert(r.workspace.clone())) // insert=false 表示已见过 → 丢弃
        .take(MAX_RESTORE_INSTANCES)
        .cloned()
        .collect();
    let snap = RestoreSnapshot {
        created_at: now_ms(),
        self_record,
        instances,
    };
    let path = restore_snapshot_path(app_data_dir);
    let json = serde_json::to_string_pretty(&snap).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写恢复快照失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("提交恢复快照失败: {e}"))?;
    Ok(snap.instances.len())
}

/// **认领自己**：无参数启动的实例（= updater 重启出来的那个）从快照里取回
/// 自己的工作区/会话，并把它从快照里摘掉（避免重复认领）。
///
/// 前置条件由调用方保证：**仅当本进程没有 `--workspace` 参数时**才调用 ——
/// 有参数的实例（用户手动指定、或被 restore 拉起）绝不该被旧快照覆盖。
///
/// 返回 `Some((workspace, session_id))` 表示认领成功。
/// 认领后快照文件被重写（self 置空）——下次那个实例再启动时不会又认领一遍。
pub fn adopt_self_record(app_data_dir: &Path) -> Option<(String, String)> {
    let path = restore_snapshot_path(app_data_dir);
    let text = std::fs::read_to_string(&path).ok()?;
    let mut snap: RestoreSnapshot = serde_json::from_str(&text).ok()?;
    let rec = snap.self_record.take()?;
    if rec.workspace.trim().is_empty() {
        return None;
    }
    // 摘掉 self 后写回（其余 instances 留给后台线程拉起）
    if let Ok(json) = serde_json::to_string_pretty(&snap) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
    Some((rec.workspace, rec.session_id))
}

/// 读取并**删除**恢复快照（消费一次）。
///
/// 读完就删是刻意的：快照只该被消费一次。若留着，用户下次正常启动 GUI 会又拉起
/// 一批实例（而且他可能早就手工关掉了那些窗口）—— 那比不恢复更烦人。
/// 因此即使拉起过程失败也不保留（宁可少恢复，也不要重复恢复）。
pub fn take_restore_snapshot(app_data_dir: &Path) -> Option<RestoreSnapshot> {
    let path = restore_snapshot_path(app_data_dir);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    match serde_json::from_str::<RestoreSnapshot>(&text) {
        Ok(snap) => Some(snap),
        Err(e) => {
            log::warn!("[instances] 恢复快照解析失败，已丢弃: {e}");
            None
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 等一个**新拉起**的实例完成绑定（出现一条 pid 不在 `before_pids` 里的自述）。
///
/// 为什么要等：spawn **只是启动进程**，实例真正占资源的是随后的初始化
/// （建 WebView2 + 起 IDE 后端 + 起 5 个插件进程），要十几秒。只按固定间隔 spawn 的话，
/// 上一个还在初始化、下一个就开始初始化 → **实际仍是并行**，瞬时峰值没降下来。
/// 等它就绪再拉下一个，才是真正的串行。
///
/// `before_pids` = 发起前的存活 pid 集合（用于区分"新起来的"和"本来就在的"）。
/// 返回 `false` 表示超时 —— 调用方记日志后**继续下一个**，不要卡住整轮恢复。
pub fn wait_for_new_instance<F>(
    app_data_dir: &Path,
    before_pids: &std::collections::HashSet<u32>,
    alive: F,
    timeout_ms: u64,
) -> bool
where
    F: Fn(u32) -> bool,
{
    let deadline = now_ms().saturating_add(timeout_ms);
    loop {
        let fresh = collect_live_instances(app_data_dir, &alive)
            .into_iter()
            .find(|r| !before_pids.contains(&r.pid) && !r.workspace.trim().is_empty());
        if fresh.is_some() {
            return true;
        }
        if now_ms() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(INSTANCE_READY_POLL_MS));
    }
}

/// 判断某 pid 是否**还活着**。
///
/// Windows：`OpenProcess` 拿到句柄且退出码仍是 `STILL_ACTIVE`。
/// ⚠️ 不用"返回 0 就失败"这类简化判断 —— pid 复用会让刚死的进程"看起来活着"，
/// 但这里只用于筛掉明显死掉的实例，偶发误判的后果仅是少恢复一个窗口。
/// 其它平台：`/proc` 不存在即视为已退出。
pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false; // 已退出 / 无权限（后者对同用户进程几乎不会发生）
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
            ok != 0 && code == STILL_ACTIVE as u32
        }
    }
    #[cfg(not(windows))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
}

/// 拉起一个新实例，带可选的工作区 / 会话。
///
/// 用 `--workspace` 跳过工作区选择器、`--session` 让它在绑定后自动加载该会话
/// （见 lib.rs 里这两个参数的解析）。新进程**脱离**本进程（用户可能马上关掉
/// 当前窗口），Windows 下加 `CREATE_NO_WINDOW` 避免闪控制台。
///
/// 返回新实例的 pid（拿不到则 None）—— 供调用方去重。
pub fn spawn_instance(exe: &Path, workspace: &str, session_id: &str) -> Result<Option<u32>, String> {
    let mut cmd = std::process::Command::new(exe);
    if !workspace.trim().is_empty() {
        cmd.arg("--workspace").arg(workspace);
    }
    if !session_id.trim().is_empty() {
        cmd.arg("--session").arg(session_id);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("拉起实例失败: {e}"))?;
    Ok(Some(child.id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ccgui-instances-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_reads_and_removes_record() {
        let d = tmp_dir("rw");
        let rec = InstanceRecord {
            pid: 111,
            workspace: "C:/ws/a".into(),
            session_id: "sess-1".into(),
            updated_at: now_ms(),
        };
        write_instance_record(&d, &rec).unwrap();

        let live = collect_live_instances(&d, |_| true);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].workspace, "C:/ws/a");
        assert_eq!(live[0].session_id, "sess-1");

        remove_instance_record(&d, 111);
        assert!(collect_live_instances(&d, |_| true).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 死实例的文件必须被清掉 —— 否则升级时会试图恢复早就关掉的窗口。
    #[test]
    fn dead_instances_are_pruned() {
        let d = tmp_dir("dead");
        write_instance_record(&d, &InstanceRecord { pid: 1, workspace: "C:/a".into(), ..Default::default() }).unwrap();
        write_instance_record(&d, &InstanceRecord { pid: 2, workspace: "C:/b".into(), ..Default::default() }).unwrap();

        // 只有 2 号活着
        let live = collect_live_instances(&d, |pid| pid == 2);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].pid, 2);
        // 死掉的那个文件应已被删除（目录里只剩 2.json）
        let remaining: Vec<String> = std::fs::read_dir(instances_dir(&d))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(remaining, vec!["2.json".to_string()], "死实例文件应被清理");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 坏 JSON（写一半就被强杀）不该让整个收集崩掉，且应被清掉。
    #[test]
    fn corrupt_record_is_skipped_and_removed() {
        let d = tmp_dir("corrupt");
        let dir = instances_dir(&d);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("999.json"), "{ this is not json").unwrap();

        let live = collect_live_instances(&d, |_| true);
        assert!(live.is_empty());
        assert!(!dir.join("999.json").exists(), "坏文件应被清掉");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 快照排除自己 + 排除没有工作区的实例。
    #[test]
    fn snapshot_separates_self_from_others() {
        let d = tmp_dir("snap");
        let live = vec![
            InstanceRecord { pid: 1, workspace: "C:/a".into(), session_id: "s1".into(), ..Default::default() },
            InstanceRecord { pid: 2, workspace: "C:/b".into(), session_id: "s2".into(), ..Default::default() }, // 自己
            InstanceRecord { pid: 3, workspace: "".into(), session_id: "s3".into(), ..Default::default() }, // 无工作区
        ];
        let n = save_restore_snapshot(&d, 2, &live).unwrap();
        assert_eq!(n, 1, "instances 只含别人（自己走 self_record）");

        let snap = take_restore_snapshot(&d).unwrap();
        // 自己单独存 —— updater 会把它重启成无参实例，那个实例靠这个认领回来
        let me = snap.self_record.expect("自己的状态必须存下来");
        assert_eq!(me.pid, 2);
        assert_eq!(me.workspace, "C:/b");
        assert_eq!(me.session_id, "s2");
        // 别人照旧
        assert_eq!(snap.instances.len(), 1);
        assert_eq!(snap.instances[0].pid, 1);
        assert_eq!(snap.instances[0].session_id, "s1");
        // 无工作区的不出现在任何一边
        assert!(!snap.instances.iter().any(|r| r.pid == 3));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 自己没绑工作区时不该写 self_record（否则无参实例会"认领"一个空工作区）。
    #[test]
    fn self_without_workspace_yields_no_self_record() {
        let d = tmp_dir("noself");
        let live = vec![
            InstanceRecord { pid: 9, workspace: "".into(), ..Default::default() }, // 自己，未绑定
        ];
        save_restore_snapshot(&d, 9, &live).unwrap();
        assert!(take_restore_snapshot(&d).unwrap().self_record.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 无参实例认领自己的状态，且**认领后快照里的 self 被摘掉**（不会认领两次）。
    #[test]
    fn adopt_self_record_takes_it_once() {
        let d = tmp_dir("adopt");
        let live = vec![
            InstanceRecord { pid: 7, workspace: "C:/me".into(), session_id: "mine".into(), ..Default::default() },
            InstanceRecord { pid: 8, workspace: "C:/other".into(), ..Default::default() },
        ];
        save_restore_snapshot(&d, 7, &live).unwrap();

        let got = adopt_self_record(&d).expect("应认领成功");
        assert_eq!(got.0, "C:/me");
        assert_eq!(got.1, "mine");

        // 再认领一次 → 空（self 已摘掉）
        assert!(adopt_self_record(&d).is_none(), "不该认领两次");
        // 但 instances（别人）还在，等后台线程拉起
        let snap = take_restore_snapshot(&d).unwrap();
        assert_eq!(snap.instances.len(), 1);
        assert_eq!(snap.instances[0].workspace, "C:/other");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn adopt_self_record_on_missing_file_is_none() {
        let d = tmp_dir("adopt-missing");
        std::fs::remove_dir_all(&d).unwrap();
        assert!(adopt_self_record(&d).is_none());
    }

    /// **消费一次**：读走就删 —— 否则下次正常启动会重复拉起一批窗口。
    #[test]
    fn snapshot_is_consumed_once() {
        let d = tmp_dir("once");
        save_restore_snapshot(&d, 999, &[InstanceRecord { pid: 1, workspace: "C:/a".into(), ..Default::default() }]).unwrap();

        assert!(take_restore_snapshot(&d).is_some(), "第一次应读到");
        assert!(take_restore_snapshot(&d).is_none(), "第二次应为空（已被消费）");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 数量上限：一次拉起十几个会把机器拖死，超出部分丢弃。
    #[test]
    fn snapshot_caps_instance_count() {
        let d = tmp_dir("cap");
        let many: Vec<InstanceRecord> = (0..20)
            .map(|i| InstanceRecord { pid: 100 + i, workspace: format!("C:/ws/{i}"), ..Default::default() })
            .collect();
        let n = save_restore_snapshot(&d, 999, &many).unwrap();
        assert_eq!(n, MAX_RESTORE_INSTANCES, "应被截断到上限");
        assert_eq!(take_restore_snapshot(&d).unwrap().instances.len(), MAX_RESTORE_INSTANCES);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 同一工作区只留一条 —— 否则每轮升级都会把它们原样恢复，实例数只增不减。
    #[test]
    fn snapshot_dedups_same_workspace() {
        let d = tmp_dir("dedup");
        let live = vec![
            InstanceRecord { pid: 1, workspace: "C:/same".into(), session_id: "s1".into(), ..Default::default() },
            InstanceRecord { pid: 2, workspace: "C:/same".into(), session_id: "s2".into(), ..Default::default() },
            InstanceRecord { pid: 3, workspace: "C:/other".into(), ..Default::default() },
        ];
        let n = save_restore_snapshot(&d, 999, &live).unwrap();
        assert_eq!(n, 2, "同工作区的两条应合成一条");
        let snap = take_restore_snapshot(&d).unwrap();
        let ws: Vec<&str> = snap.instances.iter().map(|r| r.workspace.as_str()).collect();
        assert_eq!(ws, vec!["C:/same", "C:/other"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// **自己占用的工作区不该出现在 instances 里** —— 否则会给自己那个工作区再拉一个。
    #[test]
    fn snapshot_excludes_own_workspace_from_others() {
        let d = tmp_dir("ownws");
        let live = vec![
            InstanceRecord { pid: 7, workspace: "C:/mine".into(), ..Default::default() },   // 自己
            InstanceRecord { pid: 8, workspace: "C:/mine".into(), ..Default::default() },   // 撞车（同工作区）
            InstanceRecord { pid: 9, workspace: "C:/other".into(), ..Default::default() },
        ];
        save_restore_snapshot(&d, 7, &live).unwrap();
        let snap = take_restore_snapshot(&d).unwrap();
        assert_eq!(snap.self_record.unwrap().workspace, "C:/mine");
        assert_eq!(snap.instances.len(), 1, "同工作区的 8 号不该被恢复");
        assert_eq!(snap.instances[0].workspace, "C:/other");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 新实例一出现就立刻返回（不干等满超时）。
    #[test]
    fn wait_for_new_instance_returns_when_fresh_record_appears() {
        let d = tmp_dir("wait-ok");
        let existing = InstanceRecord { pid: 1, workspace: "C:/old".into(), ..Default::default() };
        write_instance_record(&d, &existing).unwrap();
        let before: std::collections::HashSet<u32> = [1u32].into_iter().collect();

        // 模拟"新实例已完成绑定"
        write_instance_record(&d, &InstanceRecord { pid: 2, workspace: "C:/new".into(), ..Default::default() }).unwrap();
        let ok = wait_for_new_instance(&d, &before, |_| true, 5_000);
        assert!(ok, "发现新 pid 就应立刻返回 true");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// **已有实例不算"新"** —— before_pids 里的 pid 必须被忽略（否则等就绪立刻误判成功）。
    #[test]
    fn wait_for_new_instance_ignores_preexisting() {
        let d = tmp_dir("wait-old");
        write_instance_record(&d, &InstanceRecord { pid: 5, workspace: "C:/old".into(), ..Default::default() }).unwrap();
        let before: std::collections::HashSet<u32> = [5u32].into_iter().collect();
        // 超时设很短，避免测试变慢
        let ok = wait_for_new_instance(&d, &before, |_| true, 50);
        assert!(!ok, "只有旧实例时应超时返回 false");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 新实例**尚未绑定**（工作区为空）时不算就绪 —— 那时它还在初始化，正是要避开的峰值。
    #[test]
    fn wait_for_new_instance_requires_bound_workspace() {
        let d = tmp_dir("wait-unbound");
        write_instance_record(&d, &InstanceRecord { pid: 9, workspace: "".into(), ..Default::default() }).unwrap();
        let ok = wait_for_new_instance(&d, &std::collections::HashSet::new(), |_| true, 50);
        assert!(!ok, "未绑定工作区不算就绪（初始化还在进行）");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_dirs_yield_empty_not_error() {
        let d = tmp_dir("missing");
        std::fs::remove_dir_all(&d).unwrap();
        assert!(collect_live_instances(&d, |_| true).is_empty());
        assert!(take_restore_snapshot(&d).is_none());
    }
}

#[cfg(test)]
mod keep_session_tests {
    use super::*;

    /// `update_instance_record` 的"保留会话"语义靠 `read_instance_record` 实现 ——
    /// 这里锁住读回旧值的正确性（会话为空时 Rust 侧拿它兜底，见该命令的注释）。
    #[test]
    fn read_instance_record_returns_written_session() {
        let d = std::env::temp_dir().join(format!("ccgui-readrec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();

        // 没写过 → None（等价于"没有可保留的旧值"）
        assert!(read_instance_record(&d, 42).is_none());

        write_instance_record(&d, &InstanceRecord {
            pid: 42, workspace: "C:/ws".into(), session_id: "sess-keep".into(),
            updated_at: now_ms(),
        }).unwrap();

        let back = read_instance_record(&d, 42).expect("应读回");
        assert_eq!(back.session_id, "sess-keep");
        assert_eq!(back.workspace, "C:/ws");
        let _ = std::fs::remove_dir_all(&d);
    }
}
