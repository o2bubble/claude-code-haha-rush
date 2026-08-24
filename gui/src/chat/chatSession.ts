// ── ChatSession — the runner ──
// Owns the WebSocket lifecycle, outgoing wire encoding (send), fold dispatch
// (chatReduce → replaceState → effect execution) and command registration.
// The reducer is pure; everything here is connection policy + side effects.

import { commands } from "../services/serviceBus";
import {
  getChatState,
  updateChatState,
  addMessage,
  updateLastAssistant,
  replaceState,
} from "../stores/chatStore";
import { getSettings, updateSettings } from "../stores/settingsStore";
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
import { BackendService } from "../services/backendService";
import {
  registerGuardChatApi, reportGuardTurnEnded, guardActive, guardStop as guardStopBridge,
  markGuardReported, markUserInterruptedTurn, clearUserInterruptedTurn,
} from "../services/guardBridge";
import { wsDiagAdd } from "../services/wsDiag";

// 本实例是否是第一个 GUI 实例（缓存）。第二个实例跳过"自动加载最近会话"，
// 避免与已在运行（可能同一工作区）的实例争抢同一会话。
let _isFirstInstance: boolean | null = null;
async function checkFirstInstance(): Promise<boolean> {
  if (_isFirstInstance !== null) return _isFirstInstance;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    _isFirstInstance = await invoke("is_first_instance");
  } catch {
    _isFirstInstance = true;
  }
  return _isFirstInstance ?? true;
}
import { dataBus } from "../services/dataBus";
import { chatReduce } from "./chatReduce";
import { applyStoreEffects } from "./effects";
import type { WireMessage } from "./types";

export interface ChatSession {
  connect(port: number): void;
  send(type: string, payload?: any): void;
  interrupt(): void;
  sendMessage(content: string): void;
  respondToPermission(allowed: boolean, always?: boolean, updatedInput?: any): void;
  compact(): void;
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
    // 看门狗: 既无 error 也无回合(后端卡住) → 放弃, 别让 pendingDrain 堵死后续消化
    pendingDrainTimer = setTimeout(() => {
      if (pendingDrain && pendingDrain.id === msg.id && !getChatState().streaming) {
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
      if (pendingDrain && !getChatState().streaming) sendDrain(pendingDrain);
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
      case "list_tasks":
        msg.type = "list_tasks";
        break;
      default:
        msg.type = type;
    }
    const json = JSON.stringify(msg);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else if (ws === null && !p?.port) {
      // Leaf mode — no WebSocket, publish command to DataBus
      dataBus.publish(`cmd.${type}`, p);
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
    // 消化中的消息被后端 busy 拒绝 → 重发(吞掉错误, 不落 "Error:..." 气泡)
    if (msg.type === "error" && pendingDrain && isBusyRejectError(msg)) {
      retryDrain();
      return;
    }
    const prevStreaming = getChatState().streaming;
    const prevSessionId = getChatState().sessionId;
    // 权威回合结束信号: result / status:ready(见 chatReduce message_stop 注释)。
    // 与 reducer 相同的 unwrap: 顶层都是 stream_event 包裹(见 ideMode broadcast),
    // 顶层永无裸 type:"result" —— 必须在 event 内判。
    const innerMsg = msg.type === "stream_event" ? (msg.event || {}) : msg;
    const turnEndedMsg =
      innerMsg.type === "result" ||
      (msg.type === "status" && (msg as { status?: string }).status === "ready");
    const { nextState, effects } = chatReduce(getChatState(), msg, {
      savedPermissionMode: getSettings().permissionMode,
    });
    replaceState(nextState);
    // 队列: 同步活跃会话(切/载会话时队列跟着切); 切会话停守卫(守卫绑定单一会话)
    if (nextState.sessionId && nextState.sessionId !== prevSessionId) {
      setActiveSession(nextState.sessionId);
      if (guardActive()) void guardStopBridge();
    }
    if (nextState.streaming) {
      clearPendingDrain(); // 已起回合 → 消化消息被后端接住
    } else if (prevStreaming) {
      // 回合结束(streaming true→false) → 自动消化下一条 + 上报守卫(激活时)
      maybeDrain();
      markGuardReported(); // 去重: 就绪 watcher 2s 内不再补报
      // error 导致的中途复位不算真回合结束: 后端原 turn 可能仍在 busy, 此刻
      // 上报守卫会过早 SendAccept 撞 busy, 且错误文本会被当成验收回复解析。
      // 守卫只在权威 result/status:ready(下方 turnEndedMsg 分支)时才验收。
      if (msg.type !== "error") void reportGuardTurnEnded();
    } else if (guardActive() && turnEndedMsg) {
      // 非流式回合(result/status:ready 权威结束信号直达, streaming 未翻转):
      // 守卫必须感知回合结束才能验收, 否则卡在 Watching
      markGuardReported();
      void reportGuardTurnEnded();
    }
    for (const cmd of applyStoreEffects(effects)) {
      switch (cmd.type) {
        case "command.resumeSession":
          if (!_autoLoaded && getSettings().autoLoadLatestSession !== false) {
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
      updateChatState({ connected: true });
      addStatusMessage("WebSocket 已连接", "success");
      // Restore persisted permission mode on reconnect
      const savedMode = getSettings().permissionMode;
      if (savedMode && savedMode !== "default") {
        send("set_permission_mode", { mode: savedMode });
        updateChatState({ permissionMode: savedMode });
      }
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
    interruptQueue(); // 打断 → 队列暂停, 停止自动消化
    send("interrupt");
  }

  /**
   * 发用户消息。AI 忙(streaming)时一般入队; 守卫控制消息(验收/继续)必须
   * force 直发 WS——它是 agent 后续回合的指令, 塞进用户队列会被当成普通
   * 任务排队, 且守卫回合是串行验收的, 绝不能排队等待。
   */
  function sendMessage(content: string, opts?: { force?: boolean }) {
    if (opts?.force) {
      // 守卫控制消息(验收/继续): 直发, 属于自动回合 — 不标记用户插话
      clearUserInterruptedTurn();
      addMessage({ id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() });
      // 新回合开始：无响应计时从本消息发出时刻归零（避免沿用上一回合的旧 lastStreamEventAt）
      updateChatState({ lastStreamEventAt: Date.now() });
      send("user", { content });
      return;
    }
    if (getChatState().streaming) {
      if (enqueueMessage(content) === "full") {
        addStatusMessage("队列已满", "warn");
      }
      return;
    }
    // 用户手动发消息: 标记为插话回合 — Asking 期间的新回合守卫将忽略,
    // 避免把正常对话误当验收回复解析成「格式异常」
    markUserInterruptedTurn();
    addMessage({ id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() });
    // 无响应计时从本消息发出时刻归零（见上）
    updateChatState({ lastStreamEventAt: Date.now() });
    send("user", { content });
  }

  // 守卫执行 API 注入: sendMessage 强制直发(绕过 streaming 入队门)
  registerGuardChatApi({ sendMessage: (t) => sendMessage(t, { force: true }), releaseQueue: guardReleaseQueue });

  /** 恢复 auto + 空闲时立即消化。 */
  function queueResume() {
    resumeQueueStore();
    if (!getChatState().streaming) maybeDrain();
  }

  /** 立即发送某条: 提队首(暂停则恢复 auto); 空闲则立即消化。 */
  function queueSendNow(index: number) {
    sendNowAtStore(index);
    if (!getChatState().streaming) maybeDrain();
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
  }

  function clearMessages() {
    updateChatState({ messages: [] });
  }

  function registerCommands() {
    if (commandsRegistered) return;
    commandsRegistered = true;
    commands.register("SET_PERMISSION_MODE", (mode: string) => {
      // Persist immediately — don't wait for backend's permission_mode_changed
      // which would be "default" on fresh start and overwrite user's choice.
      updateChatState({ permissionMode: mode });
      updateSettings({ permissionMode: mode });
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("save_permission_mode", { mode }).catch(() => {});
      }).catch(() => {});
      send("set_permission_mode", { mode });
    });
    commands.register("SEND_MESSAGE", (content: string) => {
      sendMessage(content);
    });
    commands.register("DESKTOP_QUERY_DATA", async (itemId: string, key: string) => {
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
    listSessions: () => send("list_sessions"),
    loadSession: (sessionId: string) => send("load_session", { session_id: sessionId }),
    newSession: () => send("new_session"),
    deleteSession: (sessionId: string) => send("delete_session", { session_id: sessionId }),
    resetSession,
    registerCommands,
    queueResume,
    queueSendNow,
  };
}

/** The app-wide singleton — the facade (useChatBridge) delegates to this. */
export const chatSession = createChatSession();
