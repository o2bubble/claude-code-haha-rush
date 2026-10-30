// ── ChatSession — the runner ──
// Owns the WebSocket lifecycle, outgoing wire encoding (send), fold dispatch
// (chatReduce → replaceState → effect execution) and command registration.
// The reducer is pure; everything here is connection policy + side effects.

import { commandRegistry } from "../services/windowBus";
import {
  getChatState,
  updateChatState,
  addMessage,
  updateLastAssistant,
  replaceState,
  setMessages,
  isChatReady,
  type EffortLevelUI,
  type MetaKind,
} from "../stores/chatStore";
import { getSettings, updateSettings, saveSettings } from "../stores/settingsStore";
import { clear as clearTerminal } from "../stores/terminalStore";
import { clearPlan } from "../stores/planStore";
import { clearSubAgents } from "../stores/subAgentStore";
import { addStatusMessage } from "../stores/statusMsgStore";
import {
  getActiveQueue, setActiveSession, enqueueMessage, interruptQueue,
  drainNext, loadMsgQueues,
  resumeQueue as resumeQueueStore, sendNowAt as sendNowAtStore,
} from "../stores/msgQueueStore";
import type { QueuedMsg } from "../stores/msgQueueState";
import { DEFAULT_STALL_WAKE_PROMPT } from "../utils/streamStallDecision";
import { clampRecentMax, recordSessionRecent } from "../utils/sessionRecents";
import { BackendService } from "../services/backendService";
import {
  registerGuardChatApi, reportGuardTurnEnded, guardActive, guardStop as guardStopBridge,
  markGuardReported, markUserInterruptedTurn, clearUserInterruptedTurn, suppressWatcherReport,
} from "../services/guardBridge";
import { registerPluginInstallChatApi } from "../services/pluginInstallBridge";
import { wsDiagAdd } from "../services/wsDiag";
import { crossWindowBus } from "../services/crossWindowBus";
import { chatReduce, isBackendBusy } from "./chatReduce";
import { applyStoreEffects } from "./effects";
import { CONTINUE_PROMPT } from "./sessionMerge";
import type { ChatState, WireMessage } from "./types";

// ── 旁问（/btw）的请求-响应登记表 ──
//
// 后端的 side_question 通道是**一问一答**式的（见 ideMode 的 handleSideQuestion）：
// 发 `{type:'side_question', question, context_id}`，回
// `{type:'side_question_result', context_id, response|error}`。
// 用 context_id 把响应配回发起的那次调用 —— 所以支持并发（同时翻译多段）。
const pendingSideQuestions = new Map<
  string,
  (r: { response?: string; error?: string }) => void
>();

/** 旁问超时（毫秒）。后端要起一次 API 调用，给足时间；超时后 UI 不会永远转圈。 */
const SIDE_QUESTION_TIMEOUT_MS = 120_000;

/**
 * 本实例是否是**当前绑定工作区**的第一个 GUI 实例。
 *
 * ⚠️ **不能缓存**（2026-10-26 用户实测：切到没有其他实例的工作区仍不自动加载）。
 * Rust 侧 `is_first_instance` 是**按工作区**算的（每次 bind_workspace 重算锁），
 * 而这里曾把它缓存成模块级常量 —— 第一个工作区里若有别的实例（false），
 * 之后用户切到任何工作区都永远拿到 false，"自动加载最近会话"被永久关掉。
 * 这个 IPC 只是一次内存读，每次问一次即可。
 */
async function checkFirstInstance(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("is_first_instance");
  } catch {
    // 非 Tauri 环境（浏览器/单测）—— 没有多实例概念，按"首个"处理
    return true;
  }
}

/** `awaitSessionListThenLoad` 的结果。 */
export type PendingTargetResult = "loaded" | "preempted" | "timeout";

export interface ChatSession {
  connect(port: number): void;
  send(type: string, payload?: any): void;
  /** 旁问（/btw）：同进程 fork 轻量 agent 回答，不打断主对话。见实现处注释。 */
  askSideQuestion(question: string): Promise<{ response?: string; error?: string }>;
  interrupt(): void;
  sendMessage(content: string): void;
  respondToPermission(allowed: boolean, always?: boolean, updatedInput?: any): void;
  compact(): void;
  /** 流卡死唤醒: 中断当前流 + 发醒词让 AI 继续未完成的工作 */
  wakeStream(): void;
  listSessions(): void;
  loadSession(sessionId: string): void;
  newSession(): void;
  deleteSession(sessionId: string): void;
  resetSession(): void;
  registerCommands(): void;
  /** 队列: 恢复自动(并立即消化若空闲) */
  queueResume(): void;
  /** 队列: 立即发送某条(提队首; 暂停则恢复 auto; 空闲则立即消化) */
  queueSendNow(index: number): void;
  /** 启动意图: 标记已有明确的意图目标会话(抑制"自动加载最近会话"一步到位) */
  setIntentTargeted(v: boolean): void;
  /** 启动意图: 直接打开目标会话(不先切最近), 并置 autoLoaded 防后续回跳 */
  launchIntentSession(sessionId: string): void;
  /**
   * 等会话列表就绪后自动加载目标会话（事件驱动，无轮询）。
   * - 列表已就绪 → 立即加载，返回 `loaded`
   * - 等待期间用户手动切了会话 → 放弃，返回 `preempted`
   * - 超过 `timeoutMs`（默认 60s）→ 放弃并释放抑制，返回 `timeout`
   */
  awaitSessionListThenLoad(
    sessionId: string,
    timeoutMs?: number,
    ensureRequested?: () => void,
  ): Promise<PendingTargetResult>;
  /** 用户主动切会话时调用：取消待加载目标（尊重用户选择）。 */
  preemptPendingTargetLoad(): void;
}

export function createChatSession(): ChatSession {
  loadMsgQueues();
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;
  let messageQueue: string[] = [];
  let _connectedPort: number | null = null;
  let _lastRequestedPort: number | null = null;
  let _autoLoaded = false;
  let commandsRegistered = false;
  // 队列消化: 一条在途消息(pendingDrain)在等后端起回合或被拒绝。
  // 被后端 busy 拒绝 → 收到 error → retryDrain 重发(不重复入消息流);
  // 起回合(streaming→true) → clearPendingDrain 表示接住; 看门狗兜底防卡死。
  let pendingDrain: QueuedMsg | null = null;
  let pendingDrainRetries = 0;
  let pendingDrainTimer: ReturnType<typeof setTimeout> | null = null;
  // 跨 GUI 会话列表同步: 记录最近一次 session_list 的签名; 只在列表真正变化时
  // 中继给 server(避免 refetch 回显触发无限 A⇄B 互刷)。
  let _lastSessionsSig: string | null = null;
  // 启动意图模式: 已有明确的目标会话(open_session)。置 true 抑制"自动加载最近会话",
  // 使新实例一步打开意图目标而非先跳最近再切目标。
  let _intentTargeted = false;

  // 意图目标会话 —— **跨连接粘住**，直到真的加载成功才清。
  //
  // 为什么必须有它（2026-09-20 用户实测，慢机器必现"进了工作区但没加载会话"）：
  //   `resume_session` 是**一次性 WebSocket 消息**。新实例启动时 GUI 的 WS
  //   常比后端先就绪 → 首连失败/闪断 → 那条 resume_session 打在死连接上**丢了**，
  //   而重连（`ws.onopen`）只会重发 `messageQueue` 里的消息，**没人重发目标**。
  //   此时 `_autoLoaded` 被 onopen 复位、`_intentTargeted` 仍是 true →
  //   "最近会话"被抑制、目标又没发 → **两边都空**，用户看到就是"没加载目标会话"。
  //
  //   本机不复现是因为后端起得快、WS 一次连上；慢机器才踩。
  //
  // 修法：目标存成**粘性状态**，`onopen` 重放；`session_loaded` 确认到位后才清。
  let _intentTargetSessionId: string | null = null;

  /** 自动加载的目标会话 id —— 它真加载完时给一条「会话已加载」提示，然后清空。 */
  let _autoLoadTargetNoticeId: string | null = null;

  // ── 待加载的目标会话（等会话列表就绪后加载）──
  //
  // 为什么需要（2026-10-21 用户实测，两条体验问题）：
  //   ① **不及时**：App 侧原来用 `retryUntil(sessionsLoaded, 300ms)` 轮询 ——
  //      列表到了也要等下一次轮询（最多 300ms）才加载目标，这段空窗里用户
  //      已经能看到列表并开始点击了；
  //   ② **抢回用户的选择**：等待期间用户手动点了别的会话，之后目标仍会发
  //      一次 resume_session 把他**切回去**。
  //
  // 现在的语义（事件驱动）：
  //   - 会话列表一到（dispatch 里 sessionsLoaded 翻 true 的同一 tick）立即加载；
  //   - 等待期间用户主动切了会话（`switchSession` / `loadSession`）→ 放弃，
  //     并释放 `_intentTargeted`（否则"自动加载最近会话"被永久抑制）；
  //   - 整个等待有超时上限（默认 60s），超时同样放弃 + 释放。
  let _pendingTargetLoad: {
    id: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (r: PendingTargetResult) => void;
    /**
     * 发出目标 `resume_session` 的**同一时刻**同步调用（可选）。
     *
     * 解决"意图通路的晚到抢回"（2026-10-21）：
     * 发起方用 120s 轮询 `query_intent_status`，而新实例等待上限已降到 60s。
     * 若用户在 60s 之前**自己手选**了一个会话，本等待器会让位（`preempted`）——
     * 但若用户是在**第 60s 之后**才选（此时早已 `timeout`、ack 已发），
     * 轮询方早已结束，不会造成影响；真正的风险是**轮询仍在进行**时目标到位。
     * 所以让发起方在"目标真正发出"的瞬间把意图标成已受理，之后轮询退出即退出，
     * 但不会把一次"已加载"误报成"无法打开"。
     */
    ensureRequested?: () => void;
  } | null = null;

  /** 兑现/放弃待加载目标。幂等：没有 pending 时是 no-op。 */
  function settlePendingTarget(result: PendingTargetResult) {
    const p = _pendingTargetLoad;
    if (!p) return;
    _pendingTargetLoad = null;
    clearTimeout(p.timer);
    if (result === "loaded") {
      applyIntentTarget(p.id);
      p.ensureRequested?.();
      // 目标已发出（`_autoLoaded` 已挡住后续自动加载）→ 释放"抑制自动加载"
      // 标记，与修复前 `launchIntentSession + setIntentTargeted(false)`
      // 的等价语义保持一致。
      _intentTargeted = false;
      // 遮罩由 applyIntentTarget 统一设置（等待文案 → 加载文案，同一遮罩不中断）。
    } else {
      // 放弃：不加载目标，把抑制标记交还给正常流程（保留用户的当前会话）
      _intentTargeted = false;
      _intentTargetSessionId = null;
      _autoLoadTargetNoticeId = null; // 不会再有"已加载"提示
      // 清掉遮罩：否则用户会一直看到「正在等待…」而其实已经放弃了。
      // 只在 switchingTo 仍是本次目标时才清 —— 避免误清用户刚点开的另一个会话。
      if (getChatState().switchingTo === p.id) {
        updateChatState({ switchingTo: null, waitingForSessionList: false });
      } else {
        updateChatState({ waitingForSessionList: false });
      }
    }
    p.resolve(result);
  }

  /** 一步打开目标会话：置 autoLoaded 防回跳 + 粘性目标（断线重连重放）。 */
  function applyIntentTarget(sessionId: string) {
    // 记下"这条是自动加载的目标"，等它真加载完给一条成功提示（见 dispatch）。
    _autoLoadTargetNoticeId = sessionId;
    _autoLoaded = true;
    _intentTargeted = true;
    _intentTargetSessionId = sessionId;
    // 加载期**必须有可见反馈**：本地装了 SessionStart 类插件时，一次会话加载
    // 要 5~6 秒（2026-10-23 日志实测）。这段静默期用户会以为"什么都没发生"、
    // 进而怀疑自动加载根本没触发 —— 实际早就触发了，只是没有反馈。
    //
    // ⚠️ 放在这里而不是调用方：有两条路径都会走到本函数
    //   ① 等列表后加载（settlePendingTarget）  ② 列表已就绪 → 立即加载
    // 原来只在 ① 里设了遮罩，② 完全没有 —— 那正是"ready 后等半天没反应"。
    updateChatState({ switchingTo: sessionId, waitingForSessionList: false });
    send("resume_session", { session_id: sessionId });
  }

  function relaySessionsChanged() {
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("notify_sessions_changed").catch(() => {}));
  }

  function clearPendingDrain() {
    pendingDrain = null;
    pendingDrainRetries = 0;
    if (pendingDrainTimer) {
      clearTimeout(pendingDrainTimer);
      pendingDrainTimer = null;
    }
  }

  function sendDrain(msg: QueuedMsg) {
    send("user", { content: msg.text });
    if (pendingDrainTimer) clearTimeout(pendingDrainTimer);
    // 看门狗: 既无 error 也无回合(后端卡住) → 放弃, 别让 pendingDrain 堵死后续消化。
    // 用权威 backendBusy（等子代理时 streaming 可能波动，后端却仍忙，不该放弃）。
    pendingDrainTimer = setTimeout(() => {
      if (pendingDrain && pendingDrain.id === msg.id && !isBackendBusy(getChatState())) {
        clearPendingDrain();
      }
    }, 12000);
  }

  // 守卫模式: 队列自动消化被拦截(每个任务必须先验收), 仅守卫放行时绕过一次
  let guardBypassDrain = false;

  /** 守卫放行下一条: 恢复队列(若 paused)并绕过守卫门发队首 */
  function guardReleaseQueue() {
    guardBypassDrain = true;
    queueResume();
  }

  /** 回合结束(streaming→false)且 auto 且队列非空 → 发下一条。 */
  function maybeDrain() {
    // 守卫激活时禁止自动消化(防止跳过验收); 守卫放行(ReleaseNext)时绕过
    if (guardActive() && !guardBypassDrain) return;
    guardBypassDrain = false;
    if (pendingDrain) return; // 一条在途, 等它被接住/放弃后再排下一条
    const queue = getActiveQueue();
    if (!queue.autoSend || queue.messages.length === 0) return;
    const msg = drainNext();
    if (!msg) return;
    pendingDrain = msg;
    pendingDrainRetries = 0;
    addMessage({ id: msg.id, role: "user", content: msg.text, timestamp: Date.now() });
    sendDrain(msg);
  }

  /** 后端 busy 拒绝消化消息 → 重发(消息已在消息流, 不重复加)。 */
  function retryDrain() {
    if (!pendingDrain) return;
    if (pendingDrainRetries >= 3) {
      clearPendingDrain();
      return;
    }
    pendingDrainRetries++;
    setTimeout(() => {
      if (pendingDrain && !isBackendBusy(getChatState())) sendDrain(pendingDrain);
    }, 400);
  }

  function isBusyRejectError(msg: WireMessage): boolean {
    const m = (msg as unknown as { message?: unknown }).message;
    return typeof m === "string" && m.includes("already being processed");
  }

  function send(type: string, payload?: any) {
    const p = payload || {};
    const msg: any = {};
    switch (type) {
      case "user":
        msg.type = "user";
        msg.message = { role: "user", content: p.content || "" };
        msg.parent_tool_use_id = null;
        msg.attachments = p.attachments || [];
        msg.session_id = getChatState().sessionId || undefined;
        break;
      case "control_response":
        msg.type = "control_response";
        msg.request_id = p.request_id;
        msg.response = { allowed: p.allowed, session: p.session, always: !!p.always, reason: p.reason, updatedInput: p.updatedInput };
        break;
      case "interrupt":
        msg.type = "interrupt";
        break;
      case "list_sessions":
      case "new_session":
      case "compact":
      case "plugin_refresh":
        msg.type = type;
        break;
      case "load_session":
      case "resume_session":
      case "delete_session":
      case "rename_session":
      // fork_session 的 session_id 是**源会话**（可不同于当前活跃会话）；
      // 后端据此复制出一份新会话并回 session_forked，不切换当前会话。
      case "fork_session":
        msg.type = type;
        msg.session_id = p.session_id;
        msg.title = p.title;
        break;
      case "kill_task":
        msg.type = "kill_task";
        msg.task_id = p.task_id;
        break;
      case "load_agent_transcript":
        msg.type = "load_agent_transcript";
        msg.task_id = p.task_id;
        break;
      case "set_permission_mode":
        msg.type = "set_permission_mode";
        msg.mode = p.mode;
        break;
      case "set_thinking_mode":
        msg.type = "set_thinking_mode";
        msg.enabled = p.enabled;
        if (p.effort !== undefined) msg.effort = p.effort;
        break;
      case "set_effort":
        msg.type = "set_effort";
        msg.level = p.level;
        break;
      case "list_tasks":
        msg.type = "list_tasks";
        break;
      // 旁问（翻译按钮）：后端起同进程的轻量 agent 回答，回 side_question_result。
      // 见 chatSession.askSideQuestion 与 ideMode 的 handleSideQuestion。
      case "side_question":
        msg.type = "side_question";
        msg.question = p.question;
        msg.context_id = p.context_id;
        break;
      default:
        msg.type = type;
    }
    const json = JSON.stringify(msg);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else if (ws === null && !p?.port) {
      // Leaf mode — no WebSocket, publish command to DataBus
      crossWindowBus.publish(`cmd.${type}`, p);
    } else {
      if (messageQueue.length < 200) messageQueue.push(json);
      if (!ws) scheduleReconnect(p?.port || 0);
    }
  }

  function scheduleReconnect(port: number) {
    if (reconnectTimer) return;
    addStatusMessage("WebSocket 已断开，正在重连...", "warn");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect(port);
    }, reconnectDelay);
  }

  function dispatch(msg: WireMessage) {
    // 旁问（/btw 的翻译按钮）的结果 —— **必须最先拦截、不进 chatReduce**：
    // 它是独立的"一问一答"，不属于会话状态机（既不是消息也不是状态变更），
    // 丢给 reducer 只会多出一堆要忽略的 case。用 context_id 匹配回对应的 Promise。
    if (msg.type === "side_question_result") {
      const m = msg as unknown as { context_id?: string; response?: string; error?: string };
      const id = m.context_id ?? "";
      const resolver = pendingSideQuestions.get(id);
      if (resolver) {
        pendingSideQuestions.delete(id);
        resolver({ response: m.response, error: m.error });
      }
      return;
    }
    // 消化中的消息被后端 busy 拒绝 → 重发(吞掉错误, 不落 "Error:..." 气泡)
    if (msg.type === "error" && pendingDrain && isBusyRejectError(msg)) {
      retryDrain();
      return;
    }
    const prevStreaming = getChatState().streaming;
    const prevSessionId = getChatState().sessionId;
    const prevSessionsLoaded = getChatState().sessionsLoaded;
    // 意图目标已**确认加载到位** → 解除粘性（否则断线重连会把它又 resume 一次）。
    // 只认目标会话本身：会话待加载期间后端可能先回别的（如自动加载的最近会话），
    // 那种 `session_loaded` 不能当作"目标已兑现"。
    if (_intentTargetSessionId && (msg as { session_id?: string }).session_id === _intentTargetSessionId) {
      _intentTargetSessionId = null;
    }
    // 自动加载的**目标会话真的到位了** → 给一条成功提示，收尾那段等待。
    // 只认目标本身（用户中途切走则 preempt 已清掉，不会误报）。
    if (
      msg.type === "session_loaded" &&
      _autoLoadTargetNoticeId &&
      (msg as { session_id?: string }).session_id === _autoLoadTargetNoticeId
    ) {
      _autoLoadTargetNoticeId = null;
      addStatusMessage("会话已加载", "success");
    }
    // 权威回合结束信号: result / status:ready(见 chatReduce message_stop 注释)。
    // 与 reducer 相同的 unwrap: 顶层都是 stream_event 包裹(见 ideMode broadcast),
    // 顶层永无裸 type:"result" —— 必须在 event 内判。
    const innerMsg = msg.type === "stream_event" ? (msg.event || {}) : msg;
    const turnEndedMsg =
      innerMsg.type === "result" ||
      (msg.type === "status" && (msg as { status?: string }).status === "ready");
    const { nextState, effects } = chatReduce(getChatState(), msg, {
      savedPermissionMode: getSettings().permissionMode,
      // 自动唤醒醒词：后端把它们当普通 user 消息落盘（无 isMeta），
      // 重载历史时只能靠文本认出是「程序代发」而不是用户打的字。
      stallWakePrompts: [DEFAULT_STALL_WAKE_PROMPT, getSettings().streamStallWakePrompt ?? ""],
    });
    replaceState(nextState);
    // 会话列表**刚就绪** → 立即兑现待加载目标（同一 tick，没有轮询间隔）。
    // 这是"进入工作区后自动加载目标会话"的唯一触发点 —— 事件驱动，越早越好。
    if (!prevSessionsLoaded && nextState.sessionsLoaded && _pendingTargetLoad) {
      settlePendingTarget("loaded");
    }
    // 「最近」Tab：sessionId 变了 = 打开了一个会话（切换 / 自动加载 / 意图 / 新建）。
    //
    // 在这里集中记录，覆盖全部路径且自动去重（同一会话反复下发 current_session
    // 不会重复写盘）。存进**工作区作用域**设置 = 同工作区多窗口共享 + 重启保留。
    const openedId = nextState.sessionId;
    if (openedId && openedId !== prevSessionId) {
      const max = clampRecentMax(getSettings().recentSessionMax);
      const list = recordSessionRecent(
        getSettings().recentSessions ?? [],
        openedId,
        Date.now(),
        max,
      );
      // saveSettings 已含"更新内存 + 落盘 + 跨窗口广播"，不要再调 updateSettings
      // （会二次 emit）。dispatch 是同步上下文 —— 用 void + catch 吞掉，
      // 记录失败（如无 window 的测试环境）绝不能影响会话切换本身。
      void saveSettings({ recentSessions: list }, "workspace").catch(() => {});
    }
    // 唤醒/守卫发送时序：等后端真正就绪(ready/result)再发，防撞 busy。
    // 必须在 replaceState 之后——reducer 已把 backendBusy 清 false，flush 读到
    // 权威空闲信号才直发（早于 replaceState 会读到旧的乐观 streaming）。
    if (turnEndedMsg) { flushPendingWake(); flushPendingGuard(); }
    // 「自动续跑被中断的回合」：会话刚加载完就在此判定（见 maybeResumeInterruptedTurn）
    if (innerMsg.type === "session_loaded") {
      maybeResumeInterruptedTurn(nextState);
    }
    // 跨 GUI 同步：后端确认列表变化(session_created/session_renamed) 或 session_list
    // 内容真的变了(create/rename/delete 都会触发) → 中继给 server 广播，其他 GUI
    // 重新拉取自己的列表。session_list 只在签名变化时中继，避免 refetch 回显死循环。
    const sessType = innerMsg.type;
    if (sessType === "session_created" || sessType === "session_renamed") {
      relaySessionsChanged();
    } else if (sessType === "session_list" || sessType === "sessions_updated") {
      // 签名"排序后比较"，顺序不敏感：仅会话**集合**变化(新建/删除/改名 → id/title 变)才跨实例中继。
      // 切到某会话只是后端把它排到最前(recency 重排)，集合不变 → 不中继 → 别处不跟着重排。
      const sig = JSON.stringify(
        (innerMsg.sessions || []).map((x: any) => ((x.sessionId || x.id || "") + "|" + (x.title || ""))).sort(),
      );
      if (_lastSessionsSig === null) {
        _lastSessionsSig = sig; // 首次列表 → 只记录不中继（其他实例加载时自会呈现）
      } else if (_lastSessionsSig !== sig) {
        _lastSessionsSig = sig;
        relaySessionsChanged();
      }
    }
    // 队列: 同步活跃会话(切/载会话时队列跟着切); 切会话停守卫(守卫绑定单一会话)
    if (nextState.sessionId && nextState.sessionId !== prevSessionId) {
      setActiveSession(nextState.sessionId);
      if (guardActive()) void guardStopBridge();
      // 切会话 → 清掉未发的唤醒醒词/守卫消息，避免误发到新会话
      if (pendingWakeTimer) { clearTimeout(pendingWakeTimer); pendingWakeTimer = null; }
      pendingWakePrompt = null;
      wakeTurnInFlight = false;
      if (pendingGuardTimer) { clearTimeout(pendingGuardTimer); pendingGuardTimer = null; }
      pendingGuardSend = null;
    }
    if (nextState.streaming) {
      clearPendingDrain(); // 已起回合 → 消化消息被后端接住
    } else if (prevStreaming) {
      // 回合结束(streaming true→false) → 自动消化下一条 + 上报守卫(激活时)
      // 唤醒醒词的回合刚结束 → 此时才恢复队列(interrupt 暂停过)。
      // error 翻转除外: 后端 turn 可能仍 busy(同守卫 dedup 的理由), 此时 resume
      // + drain 会撞 busy 丢消息——保持 paused, 等权威 ready/用户手动恢复。
      if (wakeTurnInFlight && msg.type !== "error") {
        wakeTurnInFlight = false;
        queueResume();
      }
      maybeDrain();
      // 去重: 就绪 watcher 2s 内不再补报。⚠️ 仅非 error 翻转执行——error 中途复位
      // 不是真回合结束(后端 turn 可能仍 busy), 若在此解除 interrupt 抑制/盖 dedup 章,
      // error 过后 watcher 会立刻误报验收(re-撞 busy)。error 复位什么都不做。
      if (msg.type !== "error") {
        markGuardReported();
        void reportGuardTurnEnded();
      }
    } else if (guardActive() && turnEndedMsg) {
      // 非流式回合(result/status:ready 权威结束信号直达, streaming 未翻转):
      // 守卫必须感知回合结束才能验收, 否则卡在 Watching
      markGuardReported();
      void reportGuardTurnEnded();
    }
    for (const cmd of applyStoreEffects(effects)) {
      switch (cmd.type) {
        case "command.resumeSession":
          // 启动意图模式(已有明确目标会话)时跳过"自动加载最近会话"——否则新实例
          // 先切到最近会话、再被 runIntent 切到意图目标, 造成两次跳变。
          if (!_autoLoaded && getSettings().autoLoadLatestSession !== false && !_intentTargeted) {
            _autoLoaded = true;
            // 非首个 GUI 实例不自动加载最近会话（await 后再决定，时序安全）
            void (async () => {
              if (await checkFirstInstance()) {
                send("resume_session", { session_id: cmd.sessionId });
              }
            })();
          }
          break;
        case "command.listSessions":
          send("list_sessions");
          break;
        case "command.resendPermissionMode":
          send("set_permission_mode", { mode: cmd.mode });
          break;
      }
    }
  }

  function connect(port: number) {
    if (ws && _connectedPort === port && ws.readyState === WebSocket.OPEN) return;
    if (ws && _connectedPort === port && ws.readyState === WebSocket.CONNECTING) return;
    // A fresh connect (e.g. backend restarted → new port from BACKEND_PORT_READY)
    // supersedes any pending stale-port reconnect timer. Without this, the old
    // timer fires, kills this good connection and reconnects to the dead port,
    // whose failure re-triggers BackendService.start() → infinite reconnect loop.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // A NEW port means the backend restarted on a different socket — reset the
    // reconnect backoff. Same-port reconnect attempts keep growing the delay.
    if (_lastRequestedPort !== port) {
      _lastRequestedPort = port;
      reconnectDelay = 1000;
    }

    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    _connectedPort = port;
    const url = `ws://127.0.0.1:${port}/ws`;
    wsDiagAdd({ kind: "connect", port, ts: Date.now() });
    try {
      ws = new WebSocket(url);
    } catch (_e) {
      wsDiagAdd({ kind: "error", port, ts: Date.now() });
      scheduleReconnect(port);
      return;
    }
    ws.onopen = () => {
      wsDiagAdd({ kind: "open", port, ts: Date.now() });
      console.log("[WS] connected");
      reconnectDelay = 1000;
      // Connected — cancel any pending reconnect timer (belt-and-braces with
      // the connect() guard above).
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      _autoLoaded = false;
      while (messageQueue.length > 0) {
        ws!.send(messageQueue.shift()!);
      }
      // 重放粘性意图目标 —— 首连那条 `resume_session` 可能已随断线丢失（见
      // `_intentTargetSessionId` 的注释）。放在队列之后发，保证顺序：队列里的
      // 旧命令（若有）先落地。目标确认加载后（`session_loaded`）才清，见 dispatch。
      if (_intentTargetSessionId && ws!.readyState === WebSocket.OPEN) {
        ws!.send(JSON.stringify({ type: "resume_session", session_id: _intentTargetSessionId }));
      }
      updateChatState({ connected: true });
      addStatusMessage("WebSocket 已连接", "success");
      // Restore persisted permission mode on reconnect
      const savedMode = getSettings().permissionMode;
      if (savedMode && savedMode !== "default") {
        send("set_permission_mode", { mode: savedMode });
        updateChatState({ permissionMode: savedMode });
      }
      // Restore persisted thinking/effort — the backend holds these as process
      // memory (default off) and restarts silently drop them, leaving the
      // toolbar showing "on" while requests go out without thinking. Same
      // lifecycle as permissionMode above.
      const savedThinking = getSettings().thinkingModeEnabled ?? true; // 默认开(未点过开关的老用户)
      const savedEffort = getSettings().effort;
      send("set_thinking_mode", { enabled: savedThinking, ...(savedThinking && savedEffort && { effort: savedEffort }) });
      updateChatState({ thinkingModeEnabled: savedThinking });
      if (savedEffort) updateChatState({ effort: savedEffort as never });
      dispatch({ type: "status", status: "connected" });
    };
    ws.onmessage = (e) => {
      console.log("[WS] onmessage:", e.data.substring(0, 200));
      try { dispatch(JSON.parse(e.data)); } catch (_) { console.error("[WS] parse error"); }
    };
    ws.onclose = (e) => {
      ws = null;
      _connectedPort = null;
      wsDiagAdd({ kind: "close", port, code: e?.code, reason: e?.reason, ts: Date.now() });
      updateChatState({ connected: false });
      addStatusMessage("WebSocket 已断开", "warn");
      dispatch({ type: "status", status: "disconnected" });
      const bs = BackendService.getState();
      // A manual restart / in-flight start already owns the backend lifecycle —
      // it will poll the new port and update BackendService state → useChatBridge
      // re-renders → connect(port) with the live port. Kicking a second concurrent
      // start races its 3s quick-poll timeout into restart_ide_backend, killing the
      // freshly-started backend (repeated WS connect/disconnect).
      // Reconnecting to the OLD port is a dead end — a restart allocates a new
      // socket; only re-polI discovers the current one. Any pending stale timer
      // must die now so the new-port path (BackendService.start → poll → state
      // update → UI effect → connect) is the sole reconnection driver.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (bs.status === "starting" || bs.status === "stopped") {
        return;
      }
      // Unexpected death — re-detect the backend port via BackendService (its
      // poll returns the live port; if stale it restarts and polls the new one).
      // scheduleReconnect(old port) was REMOVED: it raced the new-port connect
      // from start(), and old-port retry loops forever once the port changes.
      BackendService.start().catch(() => {
        // backend fully dead / start failed: bounded stale-port retry as last resort
        if (!reconnectTimer) scheduleReconnect(bs.port ?? port);
      });
    };
    ws.onerror = (e) => {
      wsDiagAdd({ kind: "error", port, ts: Date.now() });
      console.error("[WS] error:", e);
    };
  }

  function interrupt() {
    // Optimistically reset streaming. If the backend has no active turn (e.g.
    // the AI already finished but a stop signal was missed), interrupt would
    // otherwise no-op and leave the UI stuck showing the stop button forever.
    updateChatState({ streaming: false });
    updateLastAssistant((m) => ({ ...m, streaming: false }));
    // 守卫 watcher 别把这次"乐观翻转"当回合结束上报——后端 turn 仍 busy, 此刻验收
    // force 直发会撞 busy("A prompt is already being processed")且消息丢失。
    // 验收由权威 turnEndedMsg(result/status:ready)分支接管。
    suppressWatcherReport();
    interruptQueue(); // 打断 → 队列暂停, 停止自动消化
    send("interrupt");
  }

  /**
   * 发用户消息。AI 忙(streaming)时一般入队; 守卫控制消息(验收/继续)必须
   * force 直发 WS——它是 agent 后续回合的指令, 塞进用户队列会被当成普通
   * 任务排队, 且守卫回合是串行验收的, 绝不能排队等待。
   */
  function sendMessage(content: string, opts?: { force?: boolean; metaKind?: MetaKind }) {
    // 程序代为发送的消息（如流卡死唤醒）在 UI 上要弱化成「程序自动消息」。
    // 它走的是正常发送通道，后端看到的仍是一条普通 user 消息 —— 这点无法避免，
    // 但至少本地气泡不该长得像用户打的字。
    const meta = opts?.metaKind ? { isMeta: true, metaKind: opts.metaKind } : {};
    if (opts?.force) {
      // 守卫控制消息(验收/继续): 直发, 属于自动回合 — 不标记用户插话
      clearUserInterruptedTurn();
      addMessage({ id: crypto.randomUUID(), role: "user", content, timestamp: Date.now(), ...meta });
      // 新回合开始：无响应计时从本消息发出时刻归零（避免沿用上一回合的旧 lastStreamEventAt）
      updateChatState({ lastStreamEventAt: Date.now() });
      send("user", { content });
      return;
    }
    // 后端未就绪(WS 未连接) 或会话列表未加载时静默拒绝：此时 send() 会把消息推进
    // messageQueue 排队、用户气泡却先出现 → 假发送。静默 return（不加气泡、不入队），
    // 用户可见反馈由 UI 层 disabled 按钮 + ChatStatusBar 状态点承担。
    if (!isChatReady()) {
      return;
    }
    const st = getChatState();
    if (isBackendBusy(st)) {
      if (enqueueMessage(content) === "full") {
        addStatusMessage("队列已满", "warn");
      }
      return;
    }
    // 用户手动发消息: 标记为插话回合 — Asking 期间的新回合守卫将忽略,
    // 避免把正常对话误当验收回复解析成「格式异常」
    markUserInterruptedTurn();
    addMessage({ id: crypto.randomUUID(), role: "user", content, timestamp: Date.now(), ...meta });
    // 无响应计时从本消息发出时刻归零（见上）
    updateChatState({ lastStreamEventAt: Date.now() });
    send("user", { content });
  }

  // 守卫执行 API 注入: sendMessage 走 sendForceWhenIdle(空闲直发; 忙则暂存等后端就绪, 防撞 busy)
  registerGuardChatApi({ sendMessage: sendForceWhenIdle, releaseQueue: guardReleaseQueue });

  // 插件市场「AI 帮我安装/卸载」指令通道: 用户主动点击 = 普通消息(忙则入队),
  // 不走守卫 force 语义。busy 时 sendMessage 自动入队, 指令不会丢。
  registerPluginInstallChatApi({ sendMessage });

  /** 恢复 auto + 空闲时立即消化。 */
  function queueResume() {
    resumeQueueStore();
    if (!isBackendBusy(getChatState())) maybeDrain();
  }

  // 唤醒时序：interrupt() 是乐观的——前端立即清 streaming，但后端 `busy`
  // (ideMode.ts) 要等 turn 真正结束、广播 status:ready/result 后才置 false。
  // 若 interrupt 后立即 force 直发醒词，会撞后端 "A prompt is already being
  // processed. Interrupt it first."（守卫也有同样问题）。所以醒词改为"待发"，
  // 等后端就绪信号(turnEndedMsg)到达时再 flush，附 3s 兜底(interrupt 为 no-op 时)。
  let pendingWakePrompt: string | null = null;
  let pendingWakeTimer: ReturnType<typeof setTimeout> | null = null;
  // 醒词已发出、其回合尚未结束 → 队列保持 paused。等醒词回合结束(streaming
  // true→false 翻转)再 queueResume+drain。否则 queueResume 当场 maybeDrain 会
  // 把队首消息和醒词几乎同时砸向后端：时序 inverted 时队列内容抢在醒词前被
  // 放出去(用户看到"中断后队列直接泄出")；正常时序也会让队首挤进醒词回合尾。
  let wakeTurnInFlight = false;

  // 自动续跑去重键：`<sessionId>:<合成续写消息 uuid>`。
  // 同一回合只续跑一次 —— 断线重连/重复 session_loaded 会再走一遍加载路径，
  // 不记住就会反复续跑、反复烧 token。
  let _lastResumeKey: string | null = null;

  function flushPendingWake(): void {
    if (pendingWakeTimer) { clearTimeout(pendingWakeTimer); pendingWakeTimer = null; }
    if (!pendingWakePrompt) return;
    // 后端权威 busy: interrupt 乐观清 streaming 后此处若误判空闲会撞 busy
    // ["A prompt is already being processed"]。改判 backendBusy——等 turnEndedMsg
    // 真正把后端置空闲。3s 兜底处理 interrupt 为 no-op（后端永不广播）的死角。
    if (isBackendBusy(getChatState())) return;
    const prompt = pendingWakePrompt;
    pendingWakePrompt = null;
    wakeTurnInFlight = true;              // 醒词回合期间队列保持 paused
    // metaKind：这条醒词是**程序自动发的**，不是用户打的字 —— UI 要弱化渲染。
    // 用户手动点「继续」快捷提示走的是另一条路（正常 sendMessage），仍是真用户消息。
    sendMessage(prompt, { force: true, metaKind: "stall-wake" });
    // 队列恢复不在此时执行——等醒词回合 turnEnded 后由 watchQueueGate 统一 resume
  }

  /**
   * 自动续跑被中断的回合（设置项 autoResumeInterruptedTurn，**默认关**）。
   *
   * ## 为什么需要
   *
   * 上一轮做到一半（工具刚跑完、模型还没回话）就关窗/进程被杀后，后端恢复会话
   * 时会补一条 `"Continue from where you left off."` 让 API 上下文合法 ——
   * 但 `--ide-mode` 只做"补"，不做"跑"（那一步只有 headless 的 print.ts 有，
   * 受 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 控制）。结果那条消息是一句空话，
   * 用户看到的是"会话并没有真的继续"（2026-10-30 用户反馈）。
   *
   * ## 做什么
   *
   * 开关打开时：把那条合成续写当作真实输入发出去 → 模型接着干活。
   *
   * ## 为什么默认关
   *
   * 这会**自动消耗 token**，而且可能在用户没盯着的时候跑工具改文件。
   * 有风险的功能不能默认替用户打开。
   *
   * ## 去重
   *
   * 同一个 `会话 id + 那条消息的 uuid` 只触发一次 —— 防止断线重连、
   * 重复 session_loaded 把同一个回合反复续跑（每次都烧钱）。
   */
  function maybeResumeInterruptedTurn(st: ChatState) {
    if (!(getSettings().autoResumeInterruptedTurn ?? false)) return;
    const msgs = st.messages;
    // 合成续写：isMeta + 固定文案（后端 conversationRecovery.ts 的产物）
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user" && m.isMeta && (m.content || "").trim() === CONTINUE_PROMPT) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;

    const key = `${st.sessionId ?? ""}:${msgs[idx].id}`;
    if (_lastResumeKey === key) return;
    _lastResumeKey = key;

    // 去掉展示里的合成行 —— 立刻会用真实发送的那条替代，否则并排两条一样的
    setMessages(msgs.filter((_, i) => i !== idx));

    // force：会话刚加载完，后端不在回合里；走后端就绪判定反而可能被误判 busy。
    // metaKind=resume：UI 弱化成「自动续跑」，落盘后重载也靠文案识别。
    sendMessage(CONTINUE_PROMPT, { force: true, metaKind: "resume" });
  }

  /**
   * 流卡死唤醒：中断当前流，并让醒词等后端真正就绪后再发（防撞 busy）。
   */
  function wakeStream() {
    const prompt = getSettings().streamStallWakePrompt ?? DEFAULT_STALL_WAKE_PROMPT;
    interrupt();                          // 触发后端 abort（在 turn 中）→ 最终广播 ready
    pendingWakePrompt = prompt;
    if (pendingWakeTimer) clearTimeout(pendingWakeTimer);
    // 兜底：interrupt 是 no-op（已无 active turn、不广播 ready）时，3s 后强行发
    pendingWakeTimer = setTimeout(flushPendingWake, 3000);
  }

  // 守卫文本发送(验收/继续)的时序：guard-action 经 Rust 裁决 → 事件回调，异步链路
  // 可能在某个回合(streaming=true)进行中送达。若此刻 force 直发会撞后端 busy
  // ("A prompt is already being processed")。与唤醒同样的处理：后端在忙 → 暂存，
  // 等 turnEndedMsg(权威 ready)时 flush；空闲则立即发(守卫原行为不变)。
  let pendingGuardSend: string | null = null;
  let pendingGuardTimer: ReturnType<typeof setTimeout> | null = null;
  function sendForceWhenIdle(text: string): void {
    if (!isBackendBusy(getChatState())) {
      sendMessage(text, { force: true });
      return;
    }
    pendingGuardSend = text;
    if (pendingGuardTimer) clearTimeout(pendingGuardTimer);
    pendingGuardTimer = setTimeout(flushPendingGuard, 3000);
  }
  function flushPendingGuard(): void {
    if (pendingGuardTimer) { clearTimeout(pendingGuardTimer); pendingGuardTimer = null; }
    if (!pendingGuardSend) return;
    // 后端权威 busy: 仍忙则不硬发(会撞 busy 丢消息)，等 turnEndedMsg；guard 看门狗兜底。
    if (isBackendBusy(getChatState())) return;
    const text = pendingGuardSend;
    pendingGuardSend = null;
    sendMessage(text, { force: true });
  }

  /** 立即发送某条: 提队首(暂停则恢复 auto); 空闲则立即消化。 */
  function queueSendNow(index: number) {
    sendNowAtStore(index);
    if (!isBackendBusy(getChatState())) maybeDrain();
  }

  function respondToPermission(allowed: boolean, always = false, updatedInput?: any) {
    const req = getChatState().pendingControlRequest;
    if (!req) return;
    send("control_response", {
      request_id: req.request_id,
      allowed,
      session: always,
      always,
      updatedInput,
    });
    updateChatState({ pendingControlRequest: null, inputBlockedReason: null });
  }

  /** Reset all session-scoped UI state — before switching/creating a session. */
  function resetSession() {
    clearMessages();
    clearPlan();
    clearTerminal();
    clearSubAgents();
    setActiveSession(null);
    updateChatState({
      sessionId: null,
      tasks: [],
      contextPercent: 0,
      contextWindowSize: 0,
      usedTokens: 0,
      outputTokens: 0,
      model: "",
    });
    // 用户新建会话 → 自述里确实该没有会话了。
    // 这里是**唯一**会清空自述会话的地方：其它路径（CHAT_STATE_CHANGED 带 null、
    // 切工作区）都只是"还没就绪"，必须保留旧值 —— 否则升级后恢复不了会话
    // （2026-09-22 用户实测）。见 instanceRegistry 的 keepSession 注释。
    void import("../services/instanceRegistry").then(({ reportInstanceState }) => {
      reportInstanceState(getSettings().workDir ?? "", "", { keepSession: false });
    }).catch(() => {});
  }

  function clearMessages() {
    updateChatState({ messages: [] });
  }

  function registerCommands() {
    if (commandsRegistered) return;
    commandsRegistered = true;
    commandRegistry.register("SET_PERMISSION_MODE", (mode: string) => {
      // Persist immediately — don't wait for backend's permission_mode_changed
      // which would be "default" on fresh start and overwrite user's choice.
      updateChatState({ permissionMode: mode });
      updateSettings({ permissionMode: mode });
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("save_permission_mode", { mode }).catch(() => {});
      }).catch(() => {});
      send("set_permission_mode", { mode });
    });
    commandRegistry.register("SET_THINKING_MODE", (v: { enabled: boolean; effort?: string }) => {
      updateChatState({ thinkingModeEnabled: v.enabled });
      // Persist to disk — updateSettings is memory-only, and the backend holds
      // thinking state as process memory that restarts drop. saveSettings goes
      // through save_app_settings (global scope: thinking preference follows
      // the user, not the workspace).
      void saveSettings({ thinkingModeEnabled: v.enabled, ...(v.effort && { effort: v.effort }) }, "global");
      send("set_thinking_mode", { enabled: v.enabled, ...(v.effort && { effort: v.effort }) });
    });
    commandRegistry.register("SET_EFFORT", (level: EffortLevelUI) => {
      updateChatState({ effort: level });
      void saveSettings({ effort: level }, "global");
      send("set_effort", { level });
    });
    commandRegistry.register("SEND_MESSAGE", (content: string) => {
      sendMessage(content);
    });
    commandRegistry.register("DESKTOP_QUERY_DATA", async (itemId: string, key: string) => {
      const { queryData } = await import("../services/dataRegistry");
      return queryData(itemId, key);
    });
  }

  return {
    connect,
    send,
    interrupt,
    sendMessage,
    respondToPermission,
    compact: () => send("compact"),
    wakeStream,
    listSessions: () => send("list_sessions"),
    loadSession: (sessionId: string) => send("load_session", { session_id: sessionId }),
    newSession: () => send("new_session"),
    deleteSession: (sessionId: string) => send("delete_session", { session_id: sessionId }),
    resetSession,
    registerCommands,
    queueResume,
    queueSendNow,
    setIntentTargeted: (v: boolean) => { _intentTargeted = v; },
    launchIntentSession: (sessionId: string) => applyIntentTarget(sessionId),
    awaitSessionListThenLoad: (
      sessionId: string,
      timeoutMs = 60_000,
      ensureRequested?: () => void,
    ) => {
      // 已有待加载目标 → 先放弃旧的（最后一次调用为准）
      if (_pendingTargetLoad) settlePendingTarget("preempted");
      // 列表已就绪 → 立即加载，没有任何等待
      if (getChatState().sessionsLoaded) {
        applyIntentTarget(sessionId);
        ensureRequested?.();
        return Promise.resolve<PendingTargetResult>("loaded");
      }
      return new Promise<PendingTargetResult>((resolve) => {
        const timer = setTimeout(
          () => settlePendingTarget("timeout"),
          Math.max(0, timeoutMs),
        );
        _pendingTargetLoad = { id: sessionId, timer, resolve, ensureRequested };
        // 立刻给用户一个**可见**的"我在等"信号：复用切换遮罩（250ms 后显现），
        // 但用 waitingForSessionList 区分文案 —— 这段空白期用户原本一脸茫然，
        // 不知道是在启动、卡住、还是根本没在做事（2026-10-23 用户反馈）。
        updateChatState({ switchingTo: sessionId, waitingForSessionList: true });
        // 立刻主动拉一次列表 —— 不依赖 useChatBridge 里那个 500ms 定时器
        // （那是"列表出来得慢"的另一半原因）。
        send("list_sessions");
      });
    },
    preemptPendingTargetLoad: () => settlePendingTarget("preempted"),
    /**
     * 旁问（`/btw`）—— 用后端**同一个进程**里 fork 的轻量 agent 回答，
     * 不新起 claude 实例、不打断主对话（见 ideMode 的 handleSideQuestion）。
     * 目前用于消息块上的「翻译」按钮。
     */
    askSideQuestion: (question: string): Promise<{ response?: string; error?: string }> => {
      return new Promise((resolve) => {
        const contextId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
        const timer = setTimeout(() => {
          if (pendingSideQuestions.delete(contextId)) resolve({ error: "timeout" });
        }, SIDE_QUESTION_TIMEOUT_MS);
        // 包一层：无论走 timeout 还是正常响应，都要清掉定时器
        pendingSideQuestions.set(contextId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        send("side_question", { question, context_id: contextId });
      });
    },
  };
}

/** The app-wide singleton — the facade (useChatBridge) delegates to this. */
export const chatSession = createChatSession();
