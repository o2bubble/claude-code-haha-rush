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

// ── 与 server 共用的部分（2026-10-27 下沉到 claude-gui-shared）──
//
// 托盘菜单在 `claude-gui-server` 里，也要读实例注册表 / 判活 / 结束进程。
// 记录格式、目录定位、判活、进程终止这些**两边都要用**的逻辑统一下沉，
// 避免两份实现漂移（尤其是判活逻辑，踩过僵尸进程的坑）。
pub use claude_gui_shared::instances::{
    app_data_dir_early, collect_live_instances, instances_dir, is_instance_alive,
    normalize_workspace, pick_wake_target, process_start_time_ms, read_instance_record,
    remove_instance_record, write_instance_record, InstanceRecord, APP_BUNDLE_ID,
};

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

/// 升级恢复快照的路径：`<app_data>/pending-restore.json`。
pub fn restore_snapshot_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("pending-restore.json")
}

/// **清空全部实例自述** —— 升级流程专用（杀掉所有实例之后调用）。
///
/// 为什么必须清：升级强杀不走优雅退出 → 自述文件**必然残留**；而 pid 复用会让
/// 残留被后续的存活判定误判（2026-09-21/22 的"跳过（已有实例绑定该工作区）"
/// 事故）。`is_instance_alive` 的双因子判定已是治本，这里再加一道兜底：
/// 升级 = 全部实例确定死亡，记下的东西没有价值，直接清空最干净。
pub fn clear_instance_records(app_data_dir: &Path) {
    let dir = instances_dir(app_data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let mut n = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json")
            && std::fs::remove_file(&path).is_ok()
        {
            n += 1;
        }
    }
    if n > 0 {
        log::info!("[instances] 升级前清空 {n} 条实例自述（全部实例已杀）");
    }
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

/// **恢复选集**：从存活实例里挑出"升级后将被恢复的那些"，快照与计数共用本函数。
///
/// 返回 `(自己, 其它实例)`：
/// - 自己：有工作区才有值（供 updater 重启出的无参实例认领）
/// - 其它：排除自己 + 排除无工作区 + **按工作区去重**（同一工作区只留一条）
///   + 截断到 `MAX_RESTORE_INSTANCES`
///
/// ⚠️ 计数按钮与快照**必须**共用本函数 —— 曾各自过滤（计数漏了去重），
/// 按钮写着"恢复 3 个"而快照只写 1 个，是明确的错误信息。
pub fn select_restorable(
    self_pid: u32,
    live: &[InstanceRecord],
) -> (Option<InstanceRecord>, Vec<InstanceRecord>) {
    let has_ws = |r: &&InstanceRecord| !r.workspace.trim().is_empty();
    let self_record = live.iter().find(|r| r.pid == self_pid).filter(has_ws).cloned();
    let mut seen_ws: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 自己占用的工作区也算"已见" —— 否则会给自己那个工作区再拉一个
    if let Some(me) = &self_record {
        seen_ws.insert(me.workspace.clone());
    }
    let others: Vec<InstanceRecord> = live
        .iter()
        .filter(|r| r.pid != self_pid)
        .filter(has_ws)
        .filter(|r| seen_ws.insert(r.workspace.clone())) // insert=false 表示已见过 → 丢弃
        .take(MAX_RESTORE_INSTANCES)
        .cloned()
        .collect();
    (self_record, others)
}

/// 写恢复快照（升级前）。
///
/// 选集规则见 `select_restorable`（与本函数共用，保证"计数"与"快照"永不失配）。
/// 返回值 = **本次升级将恢复的窗口总数**（含自己）—— 按钮与提示都按这个数展示，
/// 与用户直觉一致（开 3 个窗口 → "恢复 3 个"）。
pub fn save_restore_snapshot(
    app_data_dir: &Path,
    self_pid: u32,
    live: &[InstanceRecord],
) -> Result<usize, String> {
    let (self_record, instances) = select_restorable(self_pid, live);
    let total = instances.len() + usize::from(self_record.is_some());
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
    Ok(total)
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

/// 等一个**新拉起**的实例完成绑定（出现一条不在 `before` 里的自述）。
///
/// 为什么要等：spawn **只是启动进程**，实例真正占资源的是随后的初始化
/// （建 WebView2 + 起 IDE 后端 + 起 5 个插件进程），要十几秒。只按固定间隔 spawn 的话，
/// 上一个还在初始化、下一个就开始初始化 → **实际仍是并行**，瞬时峰值没降下来。
/// 等它就绪再拉下一个，才是真正的串行。
///
/// `before` = 发起前的存活实例**身份集合**（pid + 启动时间）。用双因子而不是
/// 裸 pid：pid 复用下，新实例可能恰好分到某个旧已死实例的 pid —— 裸 pid 集合
/// 会把它误认为"本来就在的"，等待一直空转到超时。
/// 返回 `false` 表示超时 —— 调用方记日志后**继续下一个**，不要卡住整轮恢复。
pub fn wait_for_new_instance<F>(
    app_data_dir: &Path,
    before: &std::collections::HashSet<(u32, u64)>,
    alive: F,
    timeout_ms: u64,
) -> bool
where
    F: Fn(&InstanceRecord) -> bool,
{
    let deadline = now_ms().saturating_add(timeout_ms);
    loop {
        let fresh = collect_live_instances(app_data_dir, &alive)
            .into_iter()
            .find(|r| {
                !before.contains(&(r.pid, r.started_at)) && !r.workspace.trim().is_empty()
            });
        if fresh.is_some() {
            return true;
        }
        if now_ms() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(INSTANCE_READY_POLL_MS));
    }
}

/// 查询某 pid 的**进程启动时刻**（Unix ms）。进程不存在/无权限 → None。
///
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

    // ── 僵尸进程判定（2026-10-27 事故）──
    //
    // 用户反馈：「重启 GUI 并没有自动加载最近的会话」。
    // 根因：锁文件记着早已退出的 pid，但 `OpenProcess` 对**句柄未回收**的
    // 僵尸进程仍成功、`GetProcessTimes` 仍返回原创建时间 → 判"活着"
    // → 本实例被当成第二个 → 前端跳过自动加载。

    #[test]
    fn live_process_has_start_time() {
        // 自己一定是活的 —— 必须能取到启动时间，否则所有"存活判定"都会失效
        let me = std::process::id();
        assert!(
            process_start_time_ms(me).is_some(),
            "存活的自进程必须能取到启动时间"
        );
    }

    #[test]
    fn never_started_pid_reports_none() {
        // 一个几乎不可能存在的 pid：应判死
        assert!(
            process_start_time_ms(999_999).is_none(),
            "不存在的 pid 必须返回 None（否则僵尸锁永远不会被接管）"
        );
    }

    #[test]
    fn pid_zero_reports_none() {
        assert!(process_start_time_ms(0).is_none());
    }

    /// 🔴 **复现事故场景**：进程已退出，但句柄还没被回收。
    ///
    /// `Child` 持有进程句柄，`wait()` 之后句柄仍在 —— 此时 PID 对应的是
    /// 一个"已退出但内核对象还活着"的进程。`OpenProcess` 对它会成功，
    /// `GetProcessTimes` 也会返回原创建时间。
    ///
    /// 修复前：本函数返回 `Some(原值)` → 判定"持有者活着" → 跳过自动加载。
    /// 修复后：退出码 != STILL_ACTIVE → 返回 None。
    #[cfg(windows)]
    #[test]
    fn exited_process_with_live_handle_reports_none() {
        use std::process::Command;

        // cmd /c exit 退出很快；Child 不 drop → 进程句柄不释放
        let mut child = Command::new("cmd")
            .args(["/c", "exit", "0"])
            .spawn()
            .expect("spawn 失败");
        let pid = child.id();
        let _ = child.wait(); // 进程已退出，但 Child（含句柄）仍在作用域内

        assert!(
            process_start_time_ms(pid).is_none(),
            "已退出但句柄未回收的进程必须判死 —— 否则僵尸锁永不接管，             前端会一直跳过自动加载最近会话"
        );

        drop(child);
    }

    #[test]
    fn writes_reads_and_removes_record() {
        let d = tmp_dir("rw");
        let rec = InstanceRecord {
            pid: 111,
            workspace: "C:/ws/a".into(),
            session_id: "sess-1".into(),
            session_title: "我的会话".into(),
            started_at: 12345,
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
        let live = collect_live_instances(&d, |rec| rec.pid == 2);
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
        // 返回的是**总数（含自己）**：别人 1 + self 1 = 2 —— 按钮按这个数展示
        // （2026-10-12 用户反馈"开 3 个只显示 2"后改的口径）
        assert_eq!(n, 2, "返回将恢复的窗口总数（含自己）");

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
        let before: std::collections::HashSet<(u32, u64)> = [(1u32, 0u64)].into_iter().collect();

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
        let before: std::collections::HashSet<(u32, u64)> = [(5u32, 0u64)].into_iter().collect();
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

    /// **pid 复用免疫**：pid 相同但启动时间不同 = 另一个进程（复用了该 pid），
    /// 原实例已死。这是 2026-09-21/22「跳过（已有实例绑定该工作区）」事故的直接
    /// 回归测试 —— 只看 pid 时，死实例残留 + pid 复用会被误判"还活着"，
    /// 导致该工作区的窗口少恢复一个。
    #[test]
    fn is_instance_alive_requires_matching_start_time() {
        let me = std::process::id();
        let started = process_start_time_ms(me).expect("查自己的启动时间必须成功");

        // 真身：pid + 启动时间都对 → 活
        assert!(is_instance_alive(&InstanceRecord {
            pid: me, started_at: started, ..Default::default()
        }));

        // pid 复用模拟：同 pid、不同启动时间 → 另一个进程，判定已死
        assert!(!is_instance_alive(&InstanceRecord {
            pid: me, started_at: started + 1, ..Default::default()
        }));

        // 旧版本写的记录（无启动时间）→ 不可信，当死
        assert!(!is_instance_alive(&InstanceRecord {
            pid: me, started_at: 0, ..Default::default()
        }));

        // 不存在的 pid → 死
        assert!(!is_instance_alive(&InstanceRecord {
            pid: 0, started_at: started, ..Default::default()
        }));
    }

    /// 升级流程的兜底：杀完实例后清空全部自述。
    #[test]
    fn clear_instance_records_removes_all() {
        let d = tmp_dir("clear");
        write_instance_record(&d, &InstanceRecord { pid: 1, workspace: "C:/a".into(), ..Default::default() }).unwrap();
        write_instance_record(&d, &InstanceRecord { pid: 2, workspace: "C:/b".into(), ..Default::default() }).unwrap();
        clear_instance_records(&d);
        let remaining = std::fs::read_dir(instances_dir(&d)).unwrap().flatten().count();
        assert_eq!(remaining, 0, "自述目录应被清空");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 计数与快照必须同口径（含去重）：曾各自过滤 → 按钮数与实际恢复数失配。
    #[test]
    fn count_and_snapshot_share_the_same_selection() {
        let d = tmp_dir("same-sel");
        let live = vec![
            InstanceRecord { pid: 7, workspace: "C:/me".into(), ..Default::default() },   // 自己
            InstanceRecord { pid: 8, workspace: "C:/b".into(), ..Default::default() },
            InstanceRecord { pid: 9, workspace: "C:/b".into(), ..Default::default() },    // 同工作区 → 去重
            InstanceRecord { pid: 10, workspace: "C:/c".into(), ..Default::default() },
        ];
        let (me, others) = select_restorable(7, &live);
        let count_total = others.len() + usize::from(me.is_some());
        let save_total = save_restore_snapshot(&d, 7, &live).unwrap();
        assert_eq!(count_total, 3, "3 个不同工作区的窗口（含自己）→ 总数 3");
        assert_eq!(count_total, save_total, "计数与快照必须同口径");
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
            session_title: "保留的会话".into(),
            started_at: 12345, updated_at: now_ms(),
        }).unwrap();

        let back = read_instance_record(&d, 42).expect("应读回");
        assert_eq!(back.session_id, "sess-keep");
        assert_eq!(back.workspace, "C:/ws");
        let _ = std::fs::remove_dir_all(&d);
    }
}
