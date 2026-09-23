/**
 * DataBus Leaf Adapter — bridges DataBus → local stores on Leaf (child) windows.
 *
 * Subscribes to DataBus topics and writes data into local store mirrors.
 * This makes Leaf windows display real data without a WebSocket connection.
 *
 * Each store is a thin mirror — components use the same stores, so no
 * component changes are needed.
 */

import { crossWindowBus } from "./crossWindowBus";
import {
  updateChatState,
  addMessage,
  updateLastAssistant,
  clearMessages,
  type ChatState,
} from "../stores/chatStore";
import { updatePlan, clearPlan } from "../stores/planStore";
import { upsertSubAgent, setTranscript, setTranscriptLoading } from "../stores/subAgentStore";
import { startCommand, appendOutput, setOutput, finishCommand, updateCommand } from "../stores/terminalStore";
import { syncDesktopsFromBus, getDesktops, getActiveDesktopId } from "../stores/desktopStore";
import type { Desktop } from "../types/desktop";
import { addStatusMessage } from "../stores/statusMsgStore";

// ── State ──

let _started = false;

// Track the last assistant message index for delta appends
let _lastAssistantIdx = -1;
let _pendingFinishTimer: ReturnType<typeof setTimeout> | null = null;

// ── Chat sync ──

function syncChatDeltaText(payload: { text: string; index: number }): void {
  updateLastAssistant((m) => ({ ...m, content: (m.content || "") + payload.text }));
}

function syncChatDeltaThinking(payload: { text: string; index: number }): void {
  updateLastAssistant((m) => ({ ...m, thinking: (m.thinking || "") + payload.text }));
}

function syncChatMessage(payload: Record<string, unknown>): void {
  // Dedup by message ID — skip if already present
  const id = payload.id as string;
  if (!id) return;
  addMessage(payload as any);
}

function syncChatStreaming(payload: boolean): void {
  updateChatState({ streaming: payload });
}

function syncChatContext(payload: Record<string, unknown>): void {
  updateChatState({
    contextPercent: payload.percent as number | undefined,
    contextWindowSize: payload.windowSize as number | undefined,
    usedTokens: payload.used as number | undefined,
    outputTokens: payload.output as number | undefined,
  });
}

function syncChatModel(payload: string): void {
  updateChatState({ model: payload });
}

function syncChatConnected(payload: boolean): void {
  updateChatState({ connected: payload });
}

/** 会话列表就绪（hub 侧 session_list 到达后置位）。叶子侧靠它才能通过 isChatReady()。 */
function syncChatSessionsLoaded(payload: boolean): void {
  updateChatState({ sessionsLoaded: payload });
}

function syncChatSessions(payload: unknown): void {
  updateChatState({ sessions: payload as any });
}

function syncChatActiveSession(payload: string): void {
  updateChatState({ sessionId: payload });
}

function syncChatTasks(payload: unknown): void {
  updateChatState({ tasks: payload as any });
}

function syncChatSlashCommands(payload: unknown): void {
  updateChatState({ slashCommands: payload as any });
}

function syncChatInputBlocked(payload: string | null): void {
  updateChatState({ inputBlockedReason: payload });
}

function syncChatSkillsDialog(payload: unknown): void {
  updateChatState({ activeSkillDialog: payload as any });
}

function syncSessionLoaded(payload: { messages: unknown[]; sessionId?: string }): void {
  clearMessages();
  clearPlan();
  _lastAssistantIdx = -1;
  if (payload.sessionId) {
    updateChatState({ sessionId: payload.sessionId });
  }
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      addMessage(msg as any);
    }
  }
}

// ── Plan ──

function syncPlanTasks(payload: unknown): void {
  if (Array.isArray(payload)) {
    updatePlan(payload as any);
  }
}

// ── Sub-agents ──

function syncSubAgents(payload: unknown): void {
  const state = payload as any;
  if (state?.agents) {
    for (const agent of state.agents) {
      upsertSubAgent(agent);
    }
  }
}

// ── Terminal ──

let _termEntryId: string | null = null;

function syncTerminalDelta(payload: { output: string; entryId: string }): void {
  if (payload.entryId !== _termEntryId) {
    _termEntryId = payload.entryId;
    startCommand(payload.entryId, "");
  }
  // 主窗口发来的是累积输出（非增量，见 crossWindowBusHub）—— appendOutput 内部
  // 做尾部窗口合并，重复内容不会累积。
  appendOutput(payload.entryId, payload.output);
}

function syncTerminalOutput(payload: { entries: unknown[]; activeId: string }): void {
  // Full terminal state replacement
  _termEntryId = payload.activeId || null;
}

// ── Editor ──

function syncEditorTabs(_payload: unknown): void {
  // Editor store is complex — defer to full implementation in Phase 3
}

function syncEditorActivePath(_payload: string): void {
  // Defer to Phase 3
}

// ── Settings ──

function syncSettings(payload: unknown): void {
  import("../stores/settingsStore").then(({ updateSettings }) => {
    if (payload && typeof payload === "object") {
      updateSettings(payload as any);
    }
  }).catch(() => {});
}

// ── Workers ──

function syncWorkersStatus(payload: unknown): void {
  const st = payload as { status?: string; port?: number; error?: string };
  if (st.status === "running") {
    addStatusMessage(`IDE 后端已连接 (端口 ${st.port})`, "info");
  } else if (st.status === "error") {
    addStatusMessage(`后端错误: ${st.error || "Unknown"}`, "error");
  }
}

// ── Files ──

function syncFilesChanged(_payload: { path: string }): void {
  // File change notifications — defer to Phase 3
}

// ── Desktop ──

function syncDesktopList(payload: unknown): void {
  const currentActiveId = getActiveDesktopId();
  syncDesktopsFromBus(payload as Desktop[], currentActiveId);
}

function syncDesktopItems(payload: unknown): void {
  const currentDesktops = getDesktops();
  syncDesktopsFromBus(currentDesktops, payload as string | null);
}

// ── Startup ──

/**
 * 重置"已启动"标志（**子窗口关闭时必须调**）。
 *
 * 与 `bridge.resetLeaf` 同因（2026-09-22 用户实测："退出挂件再进来，消息列表是空的"）：
 * 同一 GUI 进程内所有窗口共享一个 WebView2 数据目录，子窗口关闭后模块级状态不会
 * 随 webview 清掉 —— 不重置的话第二次进入时 `_started` 仍是 true，**全部订阅都不再
 * 注册**，新窗口收不到任何镜像数据（历史、增量、状态全无）。
 *
 * 与 `bridge.resetLeaf()` 一起调用（见 WidgetApp / FloatingApp 的卸载路径）。
 */
export function resetCrossWindowBusLeaf(): void {
  _started = false;
}

export function startCrossWindowBusLeaf(subscriptions: string[]): void {
  if (_started) return;
  _started = true;
  // try/catch 是**有意的**：一旦某个 subscribe 抛错，后面的订阅全都不会注册，
  // 表现为"部分数据收不到"（极难排查 —— 2026-09-22 挂件历史回填就曾往这个方向误查）。
  // 这里让它至少留下一条明确的错误日志。
  try {

  // ── Chat topics ──
  crossWindowBus.subscribe("chat.delta.text", (p) => syncChatDeltaText(p as { text: string; index: number }));
  crossWindowBus.subscribe("chat.delta.thinking", (p) => syncChatDeltaThinking(p as { text: string; index: number }));
  crossWindowBus.subscribe("chat.message", (p) => syncChatMessage(p as Record<string, unknown>));
  crossWindowBus.subscribe("chat.streaming", (p) => syncChatStreaming(p as boolean));
  crossWindowBus.subscribe("chat.context", (p) => syncChatContext(p as Record<string, unknown>));
  crossWindowBus.subscribe("chat.model", (p) => syncChatModel(p as string));
  crossWindowBus.subscribe("chat.connected", (p) => syncChatConnected(p as boolean));
  // 就绪标志 —— 不镜像的话叶子侧 `isChatReady()` 恒 false，InputArea 的发送按钮永久灰
  crossWindowBus.subscribe("chat.sessionsLoaded", (p) => syncChatSessionsLoaded(!!p));
  crossWindowBus.subscribe("chat.sessions", (p) => syncChatSessions(p));
  crossWindowBus.subscribe("chat.activeSession", (p) => syncChatActiveSession(p as string));
  crossWindowBus.subscribe("chat.tasks", (p) => syncChatTasks(p));
  crossWindowBus.subscribe("chat.slashCommands", (p) => syncChatSlashCommands(p));
  crossWindowBus.subscribe("chat.inputBlocked", (p) => syncChatInputBlocked(p as string | null));
  crossWindowBus.subscribe("chat.skills.dialog", (p) => syncChatSkillsDialog(p));
  crossWindowBus.subscribe("chat.session.loaded", (p) => syncSessionLoaded(p as any));
  // 挂件历史回填：整批替换消息列表。
  // ⚠️ 用 updateChatState 而不是 setMessages —— 后者会顺带把 streaming 清成 false，
  // 而快照很可能正好取在流式过程中（setMessages 定义见 chatStore）。
  crossWindowBus.subscribe("widget.history", (p) => {
    const messages = (p as { messages?: unknown } | undefined)?.messages;
    console.log("[widget] leaf 收到历史", { 条数: Array.isArray(messages) ? messages.length : `非数组(${typeof messages})` });
    if (Array.isArray(messages)) updateChatState({ messages: messages as ChatState["messages"] });
  });

  // ── Plan ──
  crossWindowBus.subscribe("plan.tasks", (p) => syncPlanTasks(p));

  // ── Sub-agents ──
  crossWindowBus.subscribe("subagents.list", (p) => syncSubAgents(p));

  // ── Terminal ──
  crossWindowBus.subscribe("terminal.delta.output", (p) => syncTerminalDelta(p as any));
  crossWindowBus.subscribe("terminal.output", (p) => syncTerminalOutput(p as any));

  // ── Editor ──
  crossWindowBus.subscribe("editor.tabs", (p) => syncEditorTabs(p));
  crossWindowBus.subscribe("editor.activePath", (p) => syncEditorActivePath(p as string));

  // ── Settings ──
  crossWindowBus.subscribe("settings", (p) => syncSettings(p));

  // ── Workers ──
  crossWindowBus.subscribe("workers.status", (p) => syncWorkersStatus(p));

  // ── Files ──
  crossWindowBus.subscribe("files.changed", (p) => syncFilesChanged(p as { path: string }));

  // ── Desktop ──
  crossWindowBus.subscribe("desktop.list", (p) => syncDesktopList(p));
  crossWindowBus.subscribe("desktop.items", (p) => syncDesktopItems(p));

  // ── Layout mode ──
  crossWindowBus.subscribe("layout.mode", (p) => {
    import("../stores/layoutMode").then((m) => m.layoutMode.syncFromBus(p as boolean));
  });

  console.log("[DataBus Leaf] Started — mirroring stores from DataBus");
  } catch (e) {
    console.error("[DataBus Leaf] 订阅过程中抛错:", e);
    throw e;
  }
}
