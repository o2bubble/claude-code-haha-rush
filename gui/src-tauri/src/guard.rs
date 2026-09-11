// ── 无人值守守护模式 — 纯函数裁决器 + 运行时 ──
//
// 唯一重 seam：全部业务决策（状态流转/完成判定/异常计数/队列放行/空闲处理）
// 都在本模块的纯函数里，Rust 运行时与前端只是薄执行层。测试见 cfg(test)。
//
// 设计来源: .scratch/guard-mode/PRD.md（grilling 三轮定稿）

use serde::{Deserialize, Serialize};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

// ── 公开类型 ──

/// 守护模式对外可见状态（供 UI 展示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GuardStatus {
    /// 未激活
    Off,
    /// 等 agent 回合结束（工作中不插话）
    Watching,
    /// 验收询问发出, 等验收回合结束
    Asking,
    /// 异常暂停（格式连续不符 / 验收超时）, 需用户介入
    Paused,
}

/// 裁决器内部状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardState {
    pub status: GuardStatus,
    /// 连续格式异常/超时计数（>=2 → Paused）
    pub malformed_streak: u32,
    /// 当前验收询问是否已发出（Watching→Asking 的过渡标记）
    pub accept_sent: bool,
    /// 启动时是否已放行过队列（避免守卫激活瞬间重复放行）
    pub released_once: bool,
}

impl Default for GuardState {
    fn default() -> Self {
        Self {
            status: GuardStatus::Off,
            malformed_streak: 0,
            accept_sent: false,
            released_once: false,
        }
    }
}

/// 由前端/心跳上报的输入事件。
/// 变体名 + 字段名都按 camelCase(前端 invoke 发 lastAssistantText/queueLen);
/// 之前只有变体名 camelCase、字段名仍是 snake_case, 导致 turnEnded 反序列化
/// 报 missing field `last_assistant_text`, 且旧前端 catch 静默吞掉 → 守卫永不推进。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum GuardEvent {
    /// 用户开启守护
    Start,
    /// 用户关闭守护
    Stop,
    /// agent 回合结束（最后一条 assistant 文本 + 当前队列长度）
    /// `user_interruption`: 该回合由用户手动插话引起（区别于对验收消息的回复）。
    /// Asking 状态收到插话回合 → 忽略(不当作验收回复解析), 等待后续真正的验收
    /// 回复; 用户一直插话导致验收迟迟不回 → 由 ACCEPT_TIMEOUT 超时兜底。
    /// 前端与 Rust 绑定发布, 字段不设 default —— 缺字段即硬失败, 及时暴露 wire 不一致。
    TurnEnded {
        last_assistant_text: String,
        queue_len: usize,
        user_interruption: bool,
    },
    /// agent 回合进行中（streaming 变 true）。守卫据此在 Watching 下"跳过"回合卡死计时——
    /// 合法的长回合（单回合 15min+）不是僵尸；TurnEnded 到来时清该标志。
    Working,
    /// 心跳（兜底超时检测, 由运行时在确认超时后喂入）
    Tick,
}

/// 裁决输出：需要前端执行的动作。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum GuardAction {
    /// 发验收询问（等待 ask 回合）
    SendAccept,
    /// 发「继续」消息（附上轮差项）
    SendResume { gaps: String },
    /// 放行队列下一条（恢复消化）
    ReleaseNext,
    /// 守护正常退出（任务完成且队列空）
    Exit,
    /// 暂停 + 醒目提示（需用户介入）
    Pause { reason: String },
}

/// 验收回复的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Acceptance {
    Done,
    NotDone { gaps: String },
    /// 格式不符：按未完成处理, 原文保留给下一轮
    Malformed { original: String },
}

// ── 验收解析（写死规则, 不看模型脸色）──

pub fn parse_acceptance(text: &str) -> Acceptance {
    let t = text.trim();
    if t.is_empty() {
        return Acceptance::Malformed { original: text.to_string() };
    }
    if t.starts_with("DONE") || t.starts_with("完成") {
        return Acceptance::Done;
    }
    if t.starts_with("NOTDONE") || t.starts_with("未完成") {
        let gaps = t
            .trim_start_matches("NOTDONE")
            .trim_start_matches("未完成")
            .trim()
            .trim_start_matches(|c: char| c == '|' || c == '：' || c == ':' || c == ' ');
        return Acceptance::NotDone {
            gaps: if gaps.is_empty() { "未提供".to_string() } else { gaps.to_string() },
        };
    }
    Acceptance::Malformed { original: text.to_string() }
}

// ── 裁决器 ──

/// 验收超时（ms）与格式异常暂停阈值。
pub const ACCEPT_TIMEOUT_MS: u64 = 300_000; // 5 分钟
/// Watching 无任何回合活动的卡死阈值。远大于正常单回合耗时
/// （agent 干活/编译可能持续数分钟），只有"回合该结束却什么都没发生"
/// 的僵尸场景才触发。
pub const TURN_STALL_TIMEOUT_MS: u64 = 900_000; // 15 分钟
pub const MALFORMED_LIMIT: u32 = 2;

pub fn guard_reduce(state: &GuardState, ev: &GuardEvent) -> (GuardState, Vec<GuardAction>) {
    match ev {
        GuardEvent::Start => {
            // 守卫激活: 等当前回合结束; 若队列有待办且 agent 空闲, 放行第一条由守卫接管验收
            let mut next = GuardState { status: GuardStatus::Watching, ..GuardState::default() };
            let actions = if !state.released_once {
                next.released_once = true;
                vec![GuardAction::ReleaseNext]
            } else {
                vec![]
            };
            (next, actions)
        }
        GuardEvent::Stop => (GuardState::default(), vec![]),
        // 回合进行中是纯运行时标记(见 GuardRuntime::handle), reducer 不动状态
        GuardEvent::Working => (state.clone(), vec![]),
        GuardEvent::TurnEnded { last_assistant_text, queue_len, user_interruption } => match state.status {
            GuardStatus::Off => (state.clone(), vec![]),
            // 战斗回合结束 → 发验收
            GuardStatus::Watching => {
                (
                    GuardState { status: GuardStatus::Asking, accept_sent: true, ..state.clone() },
                    vec![GuardAction::SendAccept],
                )
            }
            // 用户插话回合(非验收回复) → Asking 下忽略, 继续等真正验收回复。
            // 否则用户手动发消息会被误解析为验收回复(格式异常→暂停/继续假象)。
            GuardStatus::Asking if *user_interruption => (state.clone(), vec![]),
            // 验收回合结束 → 解析
            GuardStatus::Asking => {
                match parse_acceptance(last_assistant_text) {
                    Acceptance::Done => {
                        // 验收通过: 异常计数清零(「连续」只在单任务内累计);
                        // 队列有下一条 → 放行; 队列空 → Exit 并复位为 Off(心跳线程不再空转)
                        if *queue_len > 0 {
                            (
                                GuardState {
                                    status: GuardStatus::Watching,
                                    accept_sent: false,
                                    malformed_streak: 0,
                                    ..state.clone()
                                },
                                vec![GuardAction::ReleaseNext],
                            )
                        } else {
                            (GuardState::default(), vec![GuardAction::Exit])
                        }
                    }
                    Acceptance::NotDone { gaps } => {
                        (
                            GuardState { status: GuardStatus::Watching, accept_sent: false, ..state.clone() },
                            vec![GuardAction::SendResume { gaps }],
                        )
                    }
                    Acceptance::Malformed { original } => {
                        // 格式异常按未完成处理 + 异常计数; 连续 MALFORMED_LIMIT 次 → 暂停
                        let streak = state.malformed_streak + 1;
                        if streak >= MALFORMED_LIMIT {
                            (
                                GuardState {
                                    status: GuardStatus::Paused,
                                    malformed_streak: streak,
                                    accept_sent: false,
                                    ..state.clone()
                                },
                                vec![GuardAction::Pause {
                                    reason: format!("验收回复连续 {} 次异常（最近: {}）", streak, original),
                                }],
                            )
                        } else {
                            (
                                GuardState {
                                    status: GuardStatus::Watching,
                                    malformed_streak: streak,
                                    accept_sent: false,
                                    ..state.clone()
                                },
                                vec![GuardAction::SendResume { gaps: format!("验收回复异常, 原文: {}", original) }],
                            )
                        }
                    }
                }
            }
            // 暂停中收到回合事件 → 忽略（用户介入后重新开始）
            GuardStatus::Paused => (state.clone(), vec![]),
        },
        GuardEvent::Tick => match state.status {
            // 验收回合超时 → 按未完成处理(SendResume) + 异常计数(与格式异常一致,
            // 连续 MALFORMED_LIMIT 次才暂停)。运行时只在 asking 超过 ACCEPT_TIMEOUT_MS
            // 后喂入 Tick, 不会误杀正常慢回复。
            GuardStatus::Asking if state.accept_sent => {
                let streak = state.malformed_streak + 1;
                if streak >= MALFORMED_LIMIT {
                    (
                        GuardState {
                            status: GuardStatus::Paused,
                            malformed_streak: streak,
                            accept_sent: false,
                            ..state.clone()
                        },
                        vec![GuardAction::Pause {
                            reason: format!("验收回复连续 {} 次无响应/异常（每次 {} 秒）", streak, ACCEPT_TIMEOUT_MS / 1000),
                        }],
                    )
                } else {
                    (
                        GuardState {
                            status: GuardStatus::Watching,
                            malformed_streak: streak,
                            accept_sent: false,
                            ..state.clone()
                        },
                        vec![GuardAction::SendResume {
                            gaps: format!("验收回复超时（{} 秒无回复）", ACCEPT_TIMEOUT_MS / 1000),
                        }],
                    )
                }
            }
            // Watching 长时间无任何回合活动 → 疑似卡死/后端重启, 暂停提示
            // (不做自动验收探测: agent 可能仍在忙碌, 探测消息会被涌入队列)
            GuardStatus::Watching => (
                GuardState {
                    status: GuardStatus::Paused,
                    accept_sent: false,
                    ..state.clone()
                },
                vec![GuardAction::Pause {
                    reason: format!("守卫观察超时：{} 分钟内无任何回合活动，agent 可能已卡死或后端已重启", TURN_STALL_TIMEOUT_MS / 60000),
                }],
            ),
            _ => (state.clone(), vec![]),
        },
    }
}

// ── 运行时 ──

const HEARTBEAT_MS: u64 = 30_000;

pub struct GuardRuntime {
    inner: std::sync::Arc<GuardInner>,
    tx: Mutex<Option<Sender<GuardEvent>>>,
}

struct GuardInner {
    state: Mutex<GuardState>,
    asking_since: Mutex<Option<Instant>>,
    /// 最近一次回合活动(Start/TurnEnded/Stop); 用于 Watching 卡死检测
    last_activity: Mutex<Option<Instant>>,
    /// agent 回合是否进行中（Working→true, TurnEnded→false）。Watching 卡死检测
    /// 在回合进行中跳过——合法长回合(streaming 15min+)不是僵尸, 别误判 Pause。
    in_turn: Mutex<bool>,
}

impl Default for GuardRuntime {
    fn default() -> Self {
        Self {
            inner: std::sync::Arc::new(GuardInner {
                state: Mutex::new(GuardState::default()),
                asking_since: Mutex::new(None),
                last_activity: Mutex::new(None),
                in_turn: Mutex::new(false),
            }),
            tx: Mutex::new(None),
        }
    }
}

impl GuardRuntime {
    /// 惰性启动守护线程（30s 心跳, 免疫 WebView 定时器节流）。幂等。
    pub fn ensure_running(&self, app: &tauri::AppHandle) {
        let mut tx_guard = self.tx.lock().unwrap();
        if tx_guard.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel::<GuardEvent>();
        *tx_guard = Some(tx);
        let inner = self.inner.clone();
        let app = app.clone();
        std::thread::spawn(move || loop {
            match rx.recv_timeout(Duration::from_millis(HEARTBEAT_MS)) {
                Ok(ev) => Self::handle(&inner, &app, ev),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // 心跳: 只在真实超时后喂 Tick(Ask: 验收 5min 无回复;
                    // Watching: 15min 无任何回合活动), 不干扰正常慢回合
                    let stalled = {
                        let state = inner.state.lock().unwrap();
                        match state.status {
                            GuardStatus::Asking => inner
                                .asking_since
                                .lock()
                                .unwrap()
                                .map_or(false, |t| t.elapsed() >= Duration::from_millis(ACCEPT_TIMEOUT_MS)),
                            GuardStatus::Watching => {
                                // 回合进行中(streaming)不算僵尸——跳过; 只有空闲却无回合活动才判死
                                if *inner.in_turn.lock().unwrap() {
                                    false
                                } else {
                                    inner
                                        .last_activity
                                        .lock()
                                        .unwrap()
                                        .map_or(true, |t| t.elapsed() >= Duration::from_millis(TURN_STALL_TIMEOUT_MS))
                                }
                            }
                            _ => false,
                        }
                    };
                    if stalled {
                        Self::handle(&inner, &app, GuardEvent::Tick);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        });
    }

    fn handle(inner: &std::sync::Arc<GuardInner>, app: &tauri::AppHandle, ev: GuardEvent) {
        // Working: 回合进行中标记 — 不是 reducer 事件, 只更新回合基线, 让 Watching 卡死检测跳过。
        if matches!(ev, GuardEvent::Working) {
            *inner.in_turn.lock().unwrap() = true;
            *inner.last_activity.lock().unwrap() = Some(Instant::now());
            return;
        }
        // TurnEnded: 回合结束 → 清除进行中标记。
        if matches!(ev, GuardEvent::TurnEnded { .. }) {
            *inner.in_turn.lock().unwrap() = false;
        }
        let mut state = inner.state.lock().unwrap();
        let (next, actions) = guard_reduce(&state, &ev);
        // 验收计时基线: 进入 Asking 起算, 离开 Asking 清零
        let mut since = inner.asking_since.lock().unwrap();
        match next.status {
            GuardStatus::Asking => {
                if since.is_none() {
                    *since = Some(Instant::now());
                }
            }
            _ => *since = None,
        }
        // 回合活动基线: 真实事件(非心跳)更新, 用于 Watching 卡死检测
        if !matches!(ev, GuardEvent::Tick) {
            *inner.last_activity.lock().unwrap() = Some(Instant::now());
        }
        *state = next;
        drop(state);
        drop(since);
        for action in actions {
            let _ = app.emit("guard-action", action);
        }
    }

    pub fn current_status(&self) -> GuardStatus {
        self.inner.state.lock().unwrap().status
    }
}

#[tauri::command]
pub fn guard_event(
    app: tauri::AppHandle,
    runtime: tauri::State<GuardRuntime>,
    event: GuardEvent,
) -> Result<GuardStatus, String> {
    runtime.ensure_running(&app);
    let tx = runtime
        .tx
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "守卫线程未运行".to_string())?;
    tx.send(event).map_err(|e| format!("守卫线程已退出: {}", e))?;
    Ok(runtime.current_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_acceptance ──

    // ── wire 序列化/反序列化(真机 root cause: 字段 camelCase 对齐) ──

    #[test]
    fn turn_ended_wire_roundtrip_camel_case() {
        // 前端 invoke 发 camelCase 字段; 反序列化必须成功(曾是 missing field bug)
        let wire = r#"{"type":"turnEnded","lastAssistantText":"改好了","queueLen":3,"userInterruption":false}"#;
        let ev: GuardEvent = serde_json::from_str(wire).unwrap();
        assert_eq!(ev, GuardEvent::TurnEnded { last_assistant_text: "改好了".into(), queue_len: 3, user_interruption: false });
        // 反向序列化也应输出 camelCase(前端 emit/readback 一致)
        let out = serde_json::to_string(&GuardEvent::TurnEnded { last_assistant_text: "x".into(), queue_len: 1, user_interruption: false }).unwrap();
        assert!(out.contains("\"lastAssistantText\""));
        assert!(out.contains("\"queueLen\""));
        assert!(out.contains("\"userInterruption\""));
    }

    #[test]
    fn turn_ended_wire_missing_interruption_hard_fails() {
        // 去掉 serde default 后: 缺字段即硬失败 — 及时暴露前后端 wire 不一致,
        // 而不是静默按 false 解析(那会让插话被当验收回复, 重演 missing field 静默坑)
        let wire = r#"{"type":"turnEnded","lastAssistantText":"改好了","queueLen":3}"#;
        assert!(serde_json::from_str::<GuardEvent>(wire).is_err());
    }

    #[test]
    fn start_stop_wire_roundtrip() {
        let ev: GuardEvent = serde_json::from_str(r#"{"type":"start"}"#).unwrap();
        assert_eq!(ev, GuardEvent::Start);
        let ev: GuardEvent = serde_json::from_str(r#"{"type":"stop"}"#).unwrap();
        assert_eq!(ev, GuardEvent::Stop);
        let ev: GuardEvent = serde_json::from_str(r#"{"type":"tick"}"#).unwrap();
        assert_eq!(ev, GuardEvent::Tick);
    }

    #[test]
    fn accept_done_variants() {
        assert_eq!(parse_acceptance("DONE"), Acceptance::Done);
        assert_eq!(parse_acceptance("DONE|完成"), Acceptance::Done);
        assert_eq!(parse_acceptance("完成"), Acceptance::Done);
        assert_eq!(parse_acceptance("完成! 全部搞定"), Acceptance::Done);
        assert_eq!(parse_acceptance("  DONE  "), Acceptance::Done);
    }

    #[test]
    fn accept_notdone_variants_with_gaps() {
        assert_eq!(
            parse_acceptance("NOTDONE|还差测试没写"),
            Acceptance::NotDone { gaps: "还差测试没写".into() }
        );
        assert_eq!(
            parse_acceptance("未完成：编译失败"),
            Acceptance::NotDone { gaps: "编译失败".into() }
        );
        assert_eq!(
            parse_acceptance("NOTDONE"),
            Acceptance::NotDone { gaps: "未提供".into() }
        );
    }

    #[test]
    fn accept_malformed_variants() {
        assert_eq!(
            parse_acceptance("我觉得差不多了吧"),
            Acceptance::Malformed { original: "我觉得差不多了吧".into() }
        );
        assert_eq!(parse_acceptance(""), Acceptance::Malformed { original: "".into() });
        assert_eq!(parse_acceptance("   "), Acceptance::Malformed { original: "   ".into() });
        // 「完成」必须是前缀; 含 DONE 但不在开头不算
        assert_eq!(
            parse_acceptance("先做 X 再 DONE"),
            Acceptance::Malformed { original: "先做 X 再 DONE".into() }
        );
    }

    // ── guard_reduce: Start/Stop ──

    #[test]
    fn start_enters_watching_and_releases_once() {
        let (s, actions) = guard_reduce(&GuardState::default(), &GuardEvent::Start);
        assert_eq!(s.status, GuardStatus::Watching);
        assert_eq!(actions, vec![GuardAction::ReleaseNext]);
        assert!(s.released_once);
        // 重复 Start 不再重复放行
        let (s2, a2) = guard_reduce(&s, &GuardEvent::Start);
        assert!(a2.is_empty());
        assert_eq!(s2.status, GuardStatus::Watching);
    }

    #[test]
    fn stop_returns_off() {
        let on = guard_reduce(&GuardState::default(), &GuardEvent::Start).0;
        let (s, a) = guard_reduce(&on, &GuardEvent::Stop);
        assert_eq!(s, GuardState::default());
        assert!(a.is_empty());
    }

    // ── guard_reduce: Watching → 验收 ──

    #[test]
    fn watching_turn_ended_sends_accept() {
        let on = guard_reduce(&GuardState::default(), &GuardEvent::Start).0;
        let (s, actions) = guard_reduce(
            &on,
            &GuardEvent::TurnEnded { last_assistant_text: "改好了".into(), queue_len: 3, user_interruption: false },
        );
        assert_eq!(s.status, GuardStatus::Asking);
        assert!(s.accept_sent);
        assert_eq!(actions, vec![GuardAction::SendAccept]);
    }

    #[test]
    fn off_ignores_turn_ended() {
        let (s, a) = guard_reduce(&GuardState::default(), &GuardEvent::TurnEnded { last_assistant_text: "x".into(), queue_len: 0, user_interruption: false });
        assert_eq!(s, GuardState::default());
        assert!(a.is_empty());
    }

    // ── guard_reduce: Asking → 解析 ──

    fn asking_state() -> GuardState {
        let on = guard_reduce(&GuardState::default(), &GuardEvent::Start).0;
        guard_reduce(&on, &GuardEvent::TurnEnded { last_assistant_text: "改好了".into(), queue_len: 1, user_interruption: false }).0
    }

    #[test]
    fn asking_done_with_queue_releases_next() {
        let (s, a) = guard_reduce(&asking_state(), &GuardEvent::TurnEnded { last_assistant_text: "DONE|完成".into(), queue_len: 2, user_interruption: false });
        assert_eq!(s.status, GuardStatus::Watching);
        assert!(!s.accept_sent);
        assert_eq!(a, vec![GuardAction::ReleaseNext]);
        assert_eq!(s.malformed_streak, 0);
    }

    #[test]
    fn asking_done_with_empty_queue_exits_and_resets() {
        // Exit 同时复位为 Off(心跳线程不再空转, 前端状态一致)
        let (s, a) = guard_reduce(&asking_state(), &GuardEvent::TurnEnded { last_assistant_text: "完成".into(), queue_len: 0, user_interruption: false });
        assert_eq!(s, GuardState::default());
        assert_eq!(a, vec![GuardAction::Exit]);
    }

    #[test]
    fn malformed_streak_not_carried_across_tasks() {
        // 前置状态: 上一任务有一次格式异常(streak=1)... 模拟: 手动构造 with streak
        let prev = GuardState { status: GuardStatus::Asking, malformed_streak: 1, accept_sent: true, released_once: true };
        // 本任务 Done → streak 清零, 队列空 → Exit
        let (s, a) = guard_reduce(&prev, &GuardEvent::TurnEnded { last_assistant_text: "DONE".into(), queue_len: 0, user_interruption: false });
        assert_eq!(s, GuardState::default());
        assert_eq!(a, vec![GuardAction::Exit]);
    }

    #[test]
    fn asking_notdone_resumes_with_gaps() {
        let (s, a) = guard_reduce(&asking_state(), &GuardEvent::TurnEnded { last_assistant_text: "NOTDONE|文档没写完".into(), queue_len: 0, user_interruption: false });
        assert_eq!(s.status, GuardStatus::Watching);
        assert_eq!(a, vec![GuardAction::SendResume { gaps: "文档没写完".into() }]);
    }

    #[test]
    fn asking_user_interruption_is_ignored_not_parsed() {
        // 守卫 Ask 验收时用户手动插话: 回合结束被忽略, 不当作验收回复,
        // 状态保持 Asking(继续等真实验收), malformed_streak 不变
        let (s, a) = guard_reduce(
            &asking_state(),
            &GuardEvent::TurnEnded {
                last_assistant_text: "验收消息弹出来了 —— 正常对话内容".into(),
                queue_len: 0,
                user_interruption: true,
            },
        );
        assert_eq!(s.status, GuardStatus::Asking);
        assert!(s.accept_sent);
        assert_eq!(s.malformed_streak, 0);
        assert!(a.is_empty());
        // 非插话的相同文本仍按验收回复解析(对照: 不因该逻辑放宽)
        let (s2, _) = guard_reduce(
            &asking_state(),
            &GuardEvent::TurnEnded {
                last_assistant_text: "验收消息弹出来了 —— 链路已通".into(),
                queue_len: 0,
                user_interruption: false,
            },
        );
        assert_eq!(s2.status, GuardStatus::Watching); // Malformed → resume 回 Watching
        assert_eq!(s2.malformed_streak, 1);
    }

    #[test]
    fn watching_user_interruption_still_sends_accept() {
        // Watching 状态下插话回合 = 正常回合结束 → 仍发验收
        // (插话忽略只作用于 Asking: 验收等待期间才不应误判)
        let on = guard_reduce(&GuardState::default(), &GuardEvent::Start).0;
        let (s, a) = guard_reduce(
            &on,
            &GuardEvent::TurnEnded { last_assistant_text: "用户插话内容".into(), queue_len: 3, user_interruption: true },
        );
        assert_eq!(s.status, GuardStatus::Asking);
        assert_eq!(a, vec![GuardAction::SendAccept]);
    }

    #[test]
    fn asking_malformed_first_time_resumes_not_pauses() {
        let (s, a) = guard_reduce(&asking_state(), &GuardEvent::TurnEnded { last_assistant_text: "我感觉还行".into(), queue_len: 0, user_interruption: false });
        assert_eq!(s.status, GuardStatus::Watching);
        assert_eq!(s.malformed_streak, 1);
        match &a[..] {
            [GuardAction::SendResume { gaps }] => assert!(gaps.contains("异常")),
            other => panic!("expected SendResume, got {:?}", other),
        }
    }

    #[test]
    fn asking_malformed_twice_pauses_with_reason() {
        // 完整两轮验收链: malformed#1 → 继续 → 再验收 → malformed#2 → 暂停
        let once = guard_reduce(&asking_state(), &GuardEvent::TurnEnded { last_assistant_text: "再等等".into(), queue_len: 0, user_interruption: false }).0;
        assert_eq!(once.status, GuardStatus::Watching);
        assert_eq!(once.malformed_streak, 1);
        // 「继续」后 agent 干活回合结束 → 发第二次验收
        let (twice_ask, a2) = guard_reduce(&once, &GuardEvent::TurnEnded { last_assistant_text: "继续干完了".into(), queue_len: 0, user_interruption: false });
        assert_eq!(twice_ask.status, GuardStatus::Asking);
        assert_eq!(a2, vec![GuardAction::SendAccept]);
        // 第二次验收回复仍格式异常 → 暂停
        let (s, a) = guard_reduce(&twice_ask, &GuardEvent::TurnEnded { last_assistant_text: "不这么说行不".into(), queue_len: 0, user_interruption: false });
        assert_eq!(s.status, GuardStatus::Paused);
        assert_eq!(s.malformed_streak, 2);
        match &a[..] {
            [GuardAction::Pause { reason }] => assert!(reason.contains("2 次")),
            other => panic!("expected Pause, got {:?}", other),
        }
    }

    // ── tick 超时 ──

    #[test]
    fn tick_timeout_first_is_resume_with_streak() {
        // 超时按未完成处理(与格式异常一致): 第一次 → SendResume + streak=1
        let (s, a) = guard_reduce(&asking_state(), &GuardEvent::Tick);
        assert_eq!(s.status, GuardStatus::Watching);
        assert_eq!(s.malformed_streak, 1);
        match &a[..] {
            [GuardAction::SendResume { gaps }] => assert!(gaps.contains("超时")),
            other => panic!("expected SendResume, got {:?}", other),
        }
    }

    #[test]
    fn tick_timeout_twice_pauses() {
        let once = guard_reduce(&asking_state(), &GuardEvent::Tick).0;
        // 第二次验收仍超时(经完整链: 继续→回合→再验收→tick)
        let (again, _) = guard_reduce(&once, &GuardEvent::TurnEnded { last_assistant_text: "干活中".into(), queue_len: 0, user_interruption: false });
        assert_eq!(again.status, GuardStatus::Asking);
        let (s, a) = guard_reduce(&again, &GuardEvent::Tick);
        assert_eq!(s.status, GuardStatus::Paused);
        assert_eq!(s.malformed_streak, 2);
        match &a[..] {
            [GuardAction::Pause { reason }] => assert!(reason.contains("2 次")),
            other => panic!("expected Pause, got {:?}", other),
        }
    }

    #[test]
    fn tick_in_off_is_noop_but_watching_stalls() {
        let (s, a) = guard_reduce(&GuardState::default(), &GuardEvent::Tick);
        assert_eq!(s, GuardState::default());
        assert!(a.is_empty());

        // Watching 长时间无回合活动(运行时只在超时后喂 Tick) → 卡死暂停
        let on = guard_reduce(&GuardState::default(), &GuardEvent::Start).0;
        let (s2, a2) = guard_reduce(&on, &GuardEvent::Tick);
        assert_eq!(s2.status, GuardStatus::Paused);
        match &a2[..] {
            [GuardAction::Pause { reason }] => assert!(reason.contains("无任何回合活动")),
            other => panic!("expected Pause, got {:?}", other),
        }
    }

    #[test]
    fn watching_activity_resets_stall() {
        // Start 后收到回合活动(TurnEnded → 进入 Asking), 再 Tick 是 Ask 超时语义
        let ask = guard_reduce(&GuardState::default(), &GuardEvent::Start).0;
        let (ask2, a) = guard_reduce(&ask, &GuardEvent::TurnEnded { last_assistant_text: "干活".into(), queue_len: 0, user_interruption: false });
        assert_eq!(ask2.status, GuardStatus::Asking);
        assert_eq!(a, vec![GuardAction::SendAccept]);
    }

    #[test]
    fn paused_ignores_turn_ended() {
        // 构造 Paused 状态(第二次 tick 超时)
        let once = guard_reduce(&asking_state(), &GuardEvent::Tick).0;
        let again = guard_reduce(&once, &GuardEvent::TurnEnded { last_assistant_text: "干活中".into(), queue_len: 0, user_interruption: false }).0;
        let paused = guard_reduce(&again, &GuardEvent::Tick).0;
        assert_eq!(paused.status, GuardStatus::Paused);
        let (s, a) = guard_reduce(&paused, &GuardEvent::TurnEnded { last_assistant_text: "DONE".into(), queue_len: 0, user_interruption: false });
        assert_eq!(s.status, GuardStatus::Paused);
        assert!(a.is_empty());
    }
}