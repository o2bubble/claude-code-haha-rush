//! 系统托盘 —— 常驻在 **server** 进程里（2026-10-27）。
//!
//! ## 为什么放 server 而不是 GUI
//!
//! 放 GUI 的话，多开 N 个实例就有 N 个托盘图标（用户明确否决了这个方案）。
//! server 是**单实例**（绑定 8766 端口的 bind-to-claim），天然只有一个托盘。
//!
//! ## 为什么需要一个独立线程
//!
//! `tray-icon` 在 Windows 上要求**创建托盘的线程自己跑 Win32 消息循环**
//! （见 crate README：「you have to create the tray icon on the same thread as
//! the event loop」）。而 server 是 `#[tokio::main]` 的纯异步进程，没有消息循环。
//! 所以这里起一个 `std::thread`，在里面建托盘 + `GetMessageW` 循环。
//!
//! ## 菜单为什么必须在这个线程里改
//!
//! `muda` 的 `Menu`/`MenuItem` 内部是 `Rc<RefCell<...>>`，**不是 Send**。
//! 所以别的线程只能通过 channel 把"要显示哪些实例"送进来，
//! 由托盘线程自己重建菜单。
//!
//! ## 线程间唤醒
//!
//! `GetMessageW` 会阻塞，别的线程要它立刻处理 channel 里的新数据时，
//! 用 `PostThreadMessageW(tid, WM_APP + 1, ..)` 戳一下。

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};

use claude_gui_shared::instances::InstanceRecord;

/// 托盘要执行的动作。由托盘线程解析菜单点击后送回 tokio 侧执行
/// （托盘线程只碰菜单，不碰业务）。
#[derive(Debug, Clone)]
pub enum TrayAction {
    /// 把某个实例的窗口拉到前台
    Focus(u32),
    /// 结束某个实例（含其子进程树）
    Kill(u32),
    /// 关闭**所有** GUI 实例（不动 server 自己）
    KillAll,
    /// 新开一个 GUI 实例
    NewInstance,
    /// 退出托盘 + 关闭 server
    Quit,
}

/// 托盘菜单要展示的一帧快照。
///
/// 为什么不是裸的 `Vec<InstanceRecord>`：菜单还要显示"后台服务多久后自动退出"
/// 的倒计时（用户要求 —— 让客户知道它自己会退，不会常驻）。两者必须同帧更新，
/// 否则会出现"已经没有实例了、倒计时却晚一秒才出现"。
#[derive(Debug, Clone, Default)]
pub struct TrayMenuState {
    pub instances: Vec<InstanceRecord>,
    /// `Some(secs)` = 当前没有 GUI 连着，server 将在约 secs 秒后自动退出。
    /// `None` = 有 GUI 连着（或不启用宽限退出）→ 菜单不显示倒计时。
    pub idle_remaining_secs: Option<u64>,
}

/// 送给托盘线程的指令。
pub enum TrayCmd {
    /// 更新菜单内容（托盘线程据此重建菜单）
    Update(TrayMenuState),
    /// 关闭托盘（server 要退出了）
    Shutdown,
}

/// 托盘线程的句柄。
pub struct TrayHandle {
    pub tx: Sender<TrayCmd>,
    /// 托盘线程的 OS 线程 id —— 用 `PostThreadMessageW` 唤醒它
    thread_id: u32,
}

impl TrayHandle {
    /// 送新数据并立刻唤醒托盘线程（否则要等下一个 GetMessage 才处理）。
    pub fn update(&self, state: TrayMenuState) {
        if self.tx.send(TrayCmd::Update(state)).is_ok() {
            wake_thread(self.thread_id);
        }
    }

    /// 让托盘线程退出。
    pub fn shutdown(&self) {
        let _ = self.tx.send(TrayCmd::Shutdown);
        wake_thread(self.thread_id);
    }

    /// 托盘线程的 OS 线程 id —— 调用方直接发 TrayCmd 后用它唤醒。
    pub fn thread_id_for_hint(&self) -> u32 {
        self.thread_id
    }
}

/// 唤醒托盘线程（公开版，供"自己发 TrayCmd 再唤醒"的调用方使用）。
pub fn wake_by_thread_id(tid: u32) {
    wake_thread(tid);
}

const WM_APP_WAKE: u32 = 0x8000 + 1; // WM_APP + 1
const WM_TRAY_QUIT: u32 = 0x0012;    // WM_QUIT

#[cfg(windows)]
fn wake_thread(tid: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
    unsafe {
        let _ = PostThreadMessageW(tid, WM_APP_WAKE, 0, 0);
    }
}

#[cfg(not(windows))]
fn wake_thread(_tid: u32) {}

/// 菜单项 id 编码：`pid * 2 + kind`（kind 0=切前台 1=结束）。
/// 用 pid 而不是序号，避免列表变动时点错目标。
fn encode_id(pid: u32, kind: u8) -> String {
    format!("{}:{}", pid, kind)
}

/// 解码菜单 id → 动作。纯函数，便于测试。
pub fn decode_action(id: &str) -> Option<TrayAction> {
    let (pid_s, kind_s) = id.split_once(':')?;
    let pid: u32 = pid_s.parse().ok()?;
    match kind_s {
        "0" => Some(TrayAction::Focus(pid)),
        "1" => Some(TrayAction::Kill(pid)),
        _ => None,
    }
}

/// 「新建窗口」菜单项的 id。
pub const NEW_INSTANCE_ID: &str = "new-instance";
/// 「关闭所有实例窗口」菜单项的 id。
pub const KILL_ALL_ID: &str = "kill-all";
/// 空闲倒计时提示项的 id（不可点，纯展示）。
pub const IDLE_COUNTDOWN_ID: &str = "idle-countdown";
/// 没有实例时的占位项 id。
pub const EMPTY_ID: &str = "empty";

/// 把剩余秒数写成中文时长。纯函数，便于单测。
///
/// 只做到「分秒」为止：倒计时最长 3 分钟，不需要小时。
pub fn format_countdown(secs: u64) -> String {
    if secs >= 60 {
        format!("{}分{:02}秒", secs / 60, secs % 60)
    } else {
        format!("{}秒", secs)
    }
}

/// 空闲倒计时那一行的文案。纯函数。
///
/// 措辞刻意写明「自动退出」：用户要的就是**让人看到它会自己关**，不用担心
/// 后台一直常驻。只写「剩余 2分58秒」读者还得猜在倒数什么。
pub fn idle_countdown_label(secs: u64) -> String {
    format!("（无窗口）后台将在 {} 后自动退出", format_countdown(secs))
}

/// 菜单一条文案里，会话名最多留多少字（菜单项太窄，长了会被系统截断得很丑）。
const MAX_SESSION_LABEL_CHARS: usize = 20;

/// 菜单里显示的一条文案。纯函数（便于单测）。
///
/// 三种形态：
/// - `工作区 · 会话名`  —— 常见情形
/// - `工作区`           —— 会话名未知（还没加载 / 旧版本写的自述）
/// - `(未绑定工作区) · 会话名` / `(未绑定工作区)` —— 启动早期
///
/// **不带 pid**：它有实际用途（区分同工作区的两个实例），但放在菜单里
/// 太长且对用户没意义；同工作区多开的情形很少，真需要时看任务管理器。
pub fn instance_label(rec: &InstanceRecord) -> String {
    let ws = rec.workspace.trim();
    let ws_name = if ws.is_empty() {
        "(未绑定工作区)".to_string()
    } else {
        // 只取最后一段，菜单太窄放不下完整路径
        ws.replace('\\', "/")
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or(ws)
            .to_string()
    };

    let title = rec.session_title.trim();
    if title.is_empty() {
        return ws_name;
    }
    let shown: String = if title.chars().count() > MAX_SESSION_LABEL_CHARS {
        let mut s: String = title.chars().take(MAX_SESSION_LABEL_CHARS).collect();
        s.push('…');
        s
    } else {
        title.to_string()
    };
    format!("{ws_name} · {shown}")
}

// ── Windows 实现 ───────────────────────────────────────────────────

#[cfg(windows)]
pub fn spawn(actions_tx: tokio::sync::mpsc::UnboundedSender<TrayAction>) -> Option<TrayHandle> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<TrayCmd>();
    let (tid_tx, tid_rx) = mpsc::channel::<u32>();

    let spawned = std::thread::Builder::new()
        .name("gui-tray".into())
        .spawn(move || {
            run_tray_thread(cmd_rx, actions_tx, tid_tx);
        });

    if spawned.is_err() {
        return None;
    }

    // 等托盘线程把自己的 OS 线程 id 报回来（建完托盘后立刻发）
    let thread_id = match tid_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("[tray] 等线程 id 超时: {e}");
            return None;
        }
    };
    Some(TrayHandle { tx: cmd_tx, thread_id })
}

#[cfg(not(windows))]
pub fn spawn(_actions_tx: tokio::sync::mpsc::UnboundedSender<TrayAction>) -> Option<TrayHandle> {
    None // 托盘只做了 Windows
}

#[cfg(windows)]
fn run_tray_thread(
    cmd_rx: Receiver<TrayCmd>,
    actions_tx: tokio::sync::mpsc::UnboundedSender<TrayAction>,
    tid_tx: Sender<u32>,
) {
    use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{TrayIcon, TrayIconBuilder};

    // 菜单事件回调：在**托盘线程**里被调用（消息循环派发），
    // 把动作原样送回 tokio 侧执行。
    {
        let actions = actions_tx.clone();
        MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
            let id = e.id().0.clone();
            if id == "quit" {
                let _ = actions.send(TrayAction::Quit);
                return;
            }
            if id == NEW_INSTANCE_ID {
                let _ = actions.send(TrayAction::NewInstance);
                return;
            }
            if id == KILL_ALL_ID {
                let _ = actions.send(TrayAction::KillAll);
                return;
            }
            // 倒计时/占位项是 disabled 的，正常不会进来；真点到了也没有动作。
            if id == IDLE_COUNTDOWN_ID || id == EMPTY_ID {
                return;
            }
            if let Some(a) = decode_action(&id) {
                let _ = actions.send(a);
            }
        }));
    }

    let menu = Menu::new();
    let new_item = MenuItem::with_id(NEW_INSTANCE_ID, "新建窗口", true, None);
    let quit_item = MenuItem::with_id("quit", "退出（关闭后台服务）", true, None);
    let sep1 = PredefinedMenuItem::separator();
    let sep2 = PredefinedMenuItem::separator();
    let _ = menu.append(&sep1);
    let _ = menu.append(&new_item);
    let _ = menu.append(&sep2);
    let _ = menu.append(&quit_item);

    let icon = match load_icon() {
        Some(i) => i,
        None => {
            eprintln!("[tray] 图标加载失败");
            return;
        }
    };

    let tray: TrayIcon = match TrayIconBuilder::new()
        .with_tooltip("Claude Code — GUI 实例管理")
        .with_menu(Box::new(menu.clone()))
        .with_icon(icon)
        .build()
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[tray] 创建托盘失败: {e}");
            return;
        }
    };
    eprintln!("[tray] 托盘已创建");

    // 把自己的 OS 线程 id 报回去，让别的线程能 PostThreadMessage 唤醒
    unsafe {
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        let _ = tid_tx.send(GetCurrentThreadId());
    }

    // 菜单里**可变的那部分**（实例项 / 占位项 / 倒计时 / 关闭全部）
    let mut dyn_items = DynamicItems::default();

    // 消息循环
    loop {
        if !pump_one_message(&cmd_rx, &menu, &mut dyn_items) {
            break;
        }
    }

    drop(tray);
}

/// 重建时必须先摘掉的动态菜单部分。
///
/// ⚠️ 每个字段都是"上一帧建出来的"，重建前必须 `remove` —— 漏一个就会叠加
/// （2026-10-27 事故：占位项没被记下来，每 2s 刷新叠一条，
/// 用户右键看到 8 条「(没有正在运行的 GUI)」）。
#[cfg(windows)]
#[derive(Default)]
struct DynamicItems {
    /// pid → 实例子菜单
    instances: HashMap<u32, muda::Submenu>,
    /// 「(没有正在运行的 GUI)」占位项（最多一条）
    empty: Option<muda::MenuItem>,
    /// 空闲倒计时提示项（最多一条；只在没有 GUI 连着时出现）
    countdown: Option<muda::MenuItem>,
    /// 「关闭所有实例窗口」—— 有实例时可用、没实例时置灰。
    /// 必须每帧重建：`muda` 的 MenuItem 不是 Send，拿不到就改不了 enabled。
    kill_all: Option<muda::MenuItem>,
}

/// 处理一条消息（或一次 channel 更新）。返回 false = 该退出了。
#[cfg(windows)]
fn pump_one_message(
    cmd_rx: &Receiver<TrayCmd>,
    menu: &muda::Menu,
    dyn_items: &mut DynamicItems,
) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, TranslateMessage, MSG,
    };

    // 先看有没有待处理指令（不阻塞）
    loop {
        match cmd_rx.try_recv() {
            Ok(TrayCmd::Update(state)) => rebuild(menu, dyn_items, state),
            Ok(TrayCmd::Shutdown) => return false,
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => return false,
        }
    }

    // 阻塞等一条 Windows 消息（别的线程 PostThreadMessage 会把它唤醒）
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
        if r <= 0 {
            return false; // 0 = WM_QUIT；-1 = 错误
        }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    true
}

/// 重建菜单里可变的那部分。**只能在托盘线程调用**（muda 菜单不是 Send）。
#[cfg(windows)]
fn rebuild(menu: &muda::Menu, dyn_items: &mut DynamicItems, state: TrayMenuState) {
    use muda::{MenuItem, Submenu};

    // 先摘掉上一帧的全部动态项（漏一个就会叠加，见 DynamicItems 的注释）
    for (_pid, sub) in dyn_items.instances.drain() {
        let _ = menu.remove(&sub);
    }
    if let Some(prev) = dyn_items.empty.take() {
        let _ = menu.remove(&prev);
    }
    if let Some(prev) = dyn_items.countdown.take() {
        let _ = menu.remove(&prev);
    }
    if let Some(prev) = dyn_items.kill_all.take() {
        let _ = menu.remove(&prev);
    }

    let has_instances = !state.instances.is_empty();

    // 「关闭所有实例窗口」—— 没有实例时置灰（点了也没事做，但灰着直观）
    let kill_all = MenuItem::with_id(KILL_ALL_ID, "关闭所有实例窗口", has_instances, None);
    let _ = menu.prepend(&kill_all);
    dyn_items.kill_all = Some(kill_all);

    // 空闲倒计时：只在**确实没有窗口**时出现。
    // 用户要求它是**给客户看的安心提示** —— 让他们知道后台会自己退，不会常驻。
    //
    // ⚠️ 必须同时要求 `!has_instances`：空闲判定看的是"连到**本 server** 的 GUI"
    // （`live` 计数），而实例列表是**全局扫描**目录得来的。两者不是一回事 ——
    // 多开一个 server（调试、或旧 server 没退干净）时，就会出现
    // 「上面列着实例、下面却说无窗口并在倒计时」这种自相矛盾的菜单（实测截图）。
    // 有实例时以实例为准：倒计时的语义本来就是"没有窗口了"。
    if let (Some(secs), false) = (state.idle_remaining_secs, has_instances) {
        let item = MenuItem::with_id(IDLE_COUNTDOWN_ID, idle_countdown_label(secs), false, None);
        let _ = menu.prepend(&item);
        dyn_items.countdown = Some(item);
    }

    // 没有实例时给一条灰掉的占位项
    if !has_instances {
        let placeholder = MenuItem::with_id(EMPTY_ID, "(没有正在运行的 GUI)", false, None);
        let _ = menu.prepend(&placeholder);
        dyn_items.empty = Some(placeholder);
        return;
    }

    for rec in state.instances {
        let label = instance_label(&rec);
        let sub = Submenu::new(&label, true);

        let focus = MenuItem::with_id(encode_id(rec.pid, 0), "切换到前台", true, None);
        let kill = MenuItem::with_id(encode_id(rec.pid, 1), "结束进程", true, None);

        let _ = sub.append(&focus);
        let _ = sub.append(&kill);
        let _ = menu.prepend(&sub);
        dyn_items.instances.insert(rec.pid, sub);
    }
}

#[cfg(windows)]
fn load_icon() -> Option<tray_icon::Icon> {
    // 32x32 PNG 编进二进制 —— server 是独立 exe，不能依赖安装目录里的图标文件
    static PNG: &[u8] = include_bytes!("../../icons/32x32.png");

    let decoder = png::Decoder::new(PNG);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());

    // PNG 可能是 RGB 或 RGBA，统一转成 RGBA
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf
            .chunks_exact(3)
            .flat_map(|c| [c[0], c[1], c[2], 255])
            .collect(),
        _ => return None,
    };

    tray_icon::Icon::from_rgba(rgba, info.width, info.height).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_maps_ids_to_actions() {
        assert!(matches!(decode_action("1234:0"), Some(TrayAction::Focus(1234))));
        assert!(matches!(decode_action("1234:1"), Some(TrayAction::Kill(1234))));
        assert!(decode_action("bogus").is_none());
        assert!(decode_action("1234:9").is_none());
        assert!(decode_action("abc:0").is_none());
    }

    #[test]
    fn label_uses_last_path_segment() {
        let mut r = InstanceRecord::default();
        r.pid = 42;
        r.workspace = "D:\\Development\\claude-code-haha-dev".into();
        let l = instance_label(&r);
        assert!(l.contains("claude-code-haha-dev"), "应取最后一段: {l}");
        assert!(!l.contains("Development"), "不该带中间路径: {l}");
    }

    #[test]
    fn label_shows_session_title_when_known() {
        let mut r = InstanceRecord::default();
        r.workspace = "C:\\Storage\\work\\docs".into();
        r.session_title = "修一下登录".into();
        assert_eq!(instance_label(&r), "docs · 修一下登录");
    }

    #[test]
    fn label_falls_back_to_workspace_without_session_title() {
        // 旧版本自述没有 sessionTitle 字段 → 只显示工作区，不能出现空的「 · 」
        let mut r = InstanceRecord::default();
        r.workspace = "C:\\Storage\\work\\docs".into();
        assert_eq!(instance_label(&r), "docs");

        // 只有空白也算没有
        r.session_title = "   ".into();
        assert_eq!(instance_label(&r), "docs");
    }

    #[test]
    fn label_handles_unbound_workspace_with_session() {
        let mut r = InstanceRecord::default();
        r.session_title = "新会话".into();
        assert_eq!(instance_label(&r), "(未绑定工作区) · 新会话");
    }

    #[test]
    fn label_truncates_long_session_titles() {
        let mut r = InstanceRecord::default();
        r.workspace = "C:\\w\\docs".into();
        r.session_title = "这是一个非常非常长的会话标题应该在菜单里被截断掉".into();
        let l = instance_label(&r);
        assert!(l.starts_with("docs · "), "工作区名必须完整保留: {l}");
        assert!(l.ends_with('…'), "超长要省略: {l}");
        let shown = l.strip_prefix("docs · ").unwrap();
        assert_eq!(shown.chars().count(), MAX_SESSION_LABEL_CHARS + 1, "+1 是省略号: {l}");
    }

    #[test]
    fn label_truncates_by_chars_not_bytes() {
        // 中文按字符截断，不能把一个汉字的字节切一半（会出乱码）
        let mut r = InstanceRecord::default();
        r.workspace = "C:/w/d".into();
        r.session_title = "中".repeat(MAX_SESSION_LABEL_CHARS + 5);
        let l = instance_label(&r);
        assert!(l.chars().all(|c| c != '\u{FFFD}'), "不该出现替换字符: {l}");
        assert_eq!(l.strip_prefix("d · ").unwrap().chars().count(), MAX_SESSION_LABEL_CHARS + 1);
    }

    #[test]
    fn countdown_label_spells_out_auto_exit() {
        // 这条提示的存在意义就是"让用户知道它会自己退"，
        // 所以文案里必须有「自动退出」，不能只写个数字。
        let l = idle_countdown_label(178);
        assert!(l.contains("自动退出"), "必须写明会自动退出: {l}");
        assert!(l.contains("2分58秒"), "剩余时间要可读: {l}");
    }

    #[test]
    fn format_countdown_boundaries() {
        assert_eq!(format_countdown(0), "0秒");
        assert_eq!(format_countdown(59), "59秒");
        assert_eq!(format_countdown(60), "1分00秒");
        assert_eq!(format_countdown(180), "3分00秒");
        assert_eq!(format_countdown(125), "2分05秒");
    }

    #[test]
    fn fixed_menu_ids_are_distinct() {
        // 固定项 id 不能和 `pid:kind` 解码撞上，也不能互相撞。
        for id in [NEW_INSTANCE_ID, KILL_ALL_ID, IDLE_COUNTDOWN_ID, EMPTY_ID, "quit"] {
            assert!(decode_action(id).is_none(), "{id} 不该被解码成实例动作");
        }
        let all = [NEW_INSTANCE_ID, KILL_ALL_ID, IDLE_COUNTDOWN_ID, EMPTY_ID, "quit"];
        for i in 0..all.len() {
            for j in (i + 1)..all.len() {
                assert_ne!(all[i], all[j], "固定 id 重复");
            }
        }
    }

    // ── 下面几条用**真的 muda::Menu** 跑，直接验"反复刷新不会叠加" ──
    //
    // 2026-10-27 事故：占位项创建后从未被移除，每 2s 刷新叠一条，
    // 用户右键看到 8 条「(没有正在运行的 GUI)」。
    // 当时的回归测试只断言了一个纯辅助函数，**测不到真正的记账逻辑** ——
    // 所以这里直接对着菜单数条目。

    #[cfg(windows)]
    fn rec(pid: u32, ws: &str) -> InstanceRecord {
        let mut r = InstanceRecord::default();
        r.pid = pid;
        r.workspace = ws.into();
        r
    }

    /// 把菜单拍平成一行行文字（`MenuItemKind` 没有 Debug，只取得到 text）。
    #[cfg(windows)]
    fn menu_text(menu: &muda::Menu) -> String {
        menu.items()
            .into_iter()
            .map(|k| match k {
                muda::MenuItemKind::MenuItem(m) => m.text(),
                muda::MenuItemKind::Check(m) => m.text(),
                muda::MenuItemKind::Icon(m) => m.text(),
                muda::MenuItemKind::Submenu(m) => m.text(),
                muda::MenuItemKind::Predefined(_) => "---".into(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[cfg(windows)]
    #[test]
    fn repeated_refresh_does_not_stack_entries() {
        use muda::Menu;
        let menu = Menu::new();
        let mut dyns = DynamicItems::default();

        rebuild(&menu, &mut dyns, TrayMenuState::default());
        let empty_count = menu.items().len();

        for _ in 0..5 {
            rebuild(&menu, &mut dyns, TrayMenuState::default());
        }
        assert_eq!(menu.items().len(), empty_count, "空列表反复刷新不该叠条目");
    }

    #[cfg(windows)]
    #[test]
    fn countdown_item_is_a_single_line_that_updates() {
        use muda::Menu;
        let menu = Menu::new();
        let mut dyns = DynamicItems::default();

        rebuild(&menu, &mut dyns, TrayMenuState { instances: vec![], idle_remaining_secs: Some(178) });
        rebuild(&menu, &mut dyns, TrayMenuState { instances: vec![], idle_remaining_secs: Some(120) });
        rebuild(&menu, &mut dyns, TrayMenuState { instances: vec![], idle_remaining_secs: Some(118) });

        let joined = menu_text(&menu);
        let hits = joined.matches("自动退出").count();
        assert_eq!(hits, 1, "倒计时项恒为一条，且显示最新时间:\n{joined}");
        assert!(joined.contains("1分58秒"), "应显示最后一次的剩余时间:\n{joined}");
    }

    /// 有实例时**绝不**显示倒计时 —— 即使 server 自己一个 GUI 都没连。
    ///
    /// 2026-10-27 实测暴露：多开一个 server（调试场景）时，它会全局扫到别的
    /// server 的 GUI，同时自己的 live=0 → 菜单上同时出现实例项和「无窗口…自动退出」，
    /// 自相矛盾。有实例时以实例为准。
    #[cfg(windows)]
    #[test]
    fn countdown_hidden_when_instances_exist_even_if_no_local_client() {
        use muda::Menu;
        let menu = Menu::new();
        let mut dyns = DynamicItems::default();

        rebuild(
            &menu,
            &mut dyns,
            TrayMenuState { instances: vec![rec(13240, "C:/ws")], idle_remaining_secs: Some(108) },
        );

        let joined = menu_text(&menu);
        assert!(!joined.contains("自动退出"), "有实例时不该倒计时:\n{joined}");
        assert!(joined.contains("关闭所有实例窗口"), "{joined}");
    }

    #[cfg(windows)]
    #[test]
    fn countdown_disappears_when_an_instance_returns() {
        use muda::Menu;
        let menu = Menu::new();
        let mut dyns = DynamicItems::default();

        rebuild(&menu, &mut dyns, TrayMenuState { instances: vec![], idle_remaining_secs: Some(30) });
        rebuild(&menu, &mut dyns, TrayMenuState { instances: vec![rec(9, "C:/ws")], idle_remaining_secs: None });

        let joined = menu_text(&menu);
        assert!(!joined.contains("自动退出"), "有实例连着时不该再显示倒计时:\n{joined}");
        assert!(!joined.contains("没有正在运行的 GUI"), "有实例时不该留占位项:\n{joined}");
    }

    #[cfg(windows)]
    #[test]
    fn kill_all_item_disabled_only_when_there_are_no_instances() {
        use muda::Menu;
        let menu = Menu::new();
        let mut dyns = DynamicItems::default();

        let find_kill_all_enabled = |menu: &Menu| -> Option<bool> {
            menu.items().into_iter().find_map(|k| match k {
                muda::MenuItemKind::MenuItem(m) if m.id().0 == KILL_ALL_ID => Some(m.is_enabled()),
                _ => None,
            })
        };

        rebuild(&menu, &mut dyns, TrayMenuState::default());
        assert_eq!(find_kill_all_enabled(&menu), Some(false), "没有实例时应置灰");

        rebuild(&menu, &mut dyns, TrayMenuState { instances: vec![rec(11, "C:/a")], idle_remaining_secs: None });
        assert_eq!(find_kill_all_enabled(&menu), Some(true), "有实例时应可点");

        // 反序再走一遍 —— 确认不会残留上一次的 enabled 状态
        rebuild(&menu, &mut dyns, TrayMenuState::default());
        assert_eq!(find_kill_all_enabled(&menu), Some(false), "回到无实例应重新置灰");
    }

    #[test]
    fn new_instance_id_is_not_confused_with_pid_ids() {
        // 「新建窗口」用固定 id，不能和 `pid:kind` 格式撞上，
        // 否则点了会被解码成 Focus/Kill 某个不存在的 pid。
        assert!(decode_action(NEW_INSTANCE_ID).is_none());
        assert_ne!(NEW_INSTANCE_ID, "quit");
    }

    #[test]
    fn label_handles_empty_workspace() {
        let mut r = InstanceRecord::default();
        r.pid = 7;
        assert_eq!(instance_label(&r), "(未绑定工作区)");
    }

    #[test]
    fn encode_decode_roundtrip() {
        for pid in [1u32, 9999, 123456] {
            for kind in [0u8, 1] {
                let id = encode_id(pid, kind);
                match decode_action(&id) {
                    Some(TrayAction::Focus(p)) => {
                        assert_eq!(p, pid);
                        assert_eq!(kind, 0);
                    }
                    Some(TrayAction::Kill(p)) => {
                        assert_eq!(p, pid);
                        assert_eq!(kind, 1);
                    }
                    _ => panic!("往返失败: {id}"),
                }
            }
        }
    }
}
