/**
 * DataBus Hub Adapter — bridges EventBus → DataBus on the Hub (main) window.
 *
 * Subscribes to all relevant EventBus events and republishes the data
 * to DataBus topics, so Leaf windows receive them through the Bridge.
 *
 * This module requires NO changes to existing useChatBridge or Store code.
 * It's a pure subscriber that listens and forwards.
 */

import { windowBus } from "./windowBus";
import { Events } from "./events";
import type {
  ChatStateChangedPayload,
  PlanUpdatedPayload,
  SubAgentsChangedPayload,
  TerminalChangedPayload,
  EditorChangedPayload,
  SettingsChangedPayload,
  BackendStateChangedPayload,
} from "./events";
import { crossWindowBus } from "./crossWindowBus";
import { getSettings } from "../stores/settingsStore";
import { syncDesktopsFromBus, getActiveDesktopId } from "../stores/desktopStore";
import type { Desktop } from "../types/desktop";

// ── Chat state diffing (for delta extraction) ──

interface LastSeen {
  messagesLength: number;
  lastContent: string;
  lastThinking: string;
  streaming: boolean;
}

let _lastSeen: LastSeen = { messagesLength: 0, lastContent: "", lastThinking: "", streaming: false };

function syncChatState(state: ChatStateChangedPayload["state"]): void {
  const msgs = state.messages ?? [];
  const lastMsg = msgs[msgs.length - 1];

  // New messages added
  if (msgs.length > _lastSeen.messagesLength) {
    const newMsgs = msgs.slice(_lastSeen.messagesLength);
    for (const msg of newMsgs) {
      crossWindowBus.publish("chat.message", msg, { sticky: true });
    }
    // ⚠️ **发完整条之后，增量基线必须跟着它走**。
    //
    // 否则下面的 delta 会把"刚整条发过的那段内容"再追加一遍：叶子端的
    // `chat.message` 走 addMessage（按 id 去重，得到完整内容），而 `chat.delta.text`
    // 走 updateLastAssistant（**纯追加、不去重**）→ 叶子显示「你好你好」。
    //
    // 触发条件（2026-09-22 用户实测，只有挂件重复、主窗正常 —— 因为主窗的 messages
    // 是后端直给的权威源，不走这条镜像）：新消息首帧若已带内容，且旧基线（上一条消息
    // 的长度）短于它，delta 就会是整段而非增量。
    const lastNew = newMsgs[newMsgs.length - 1];
    if (lastNew?.role === "assistant") {
      _lastSeen.lastContent = lastNew.content || "";
      _lastSeen.lastThinking = lastNew.thinking || "";
    }
  }

  // Streaming text delta (approximate via string diff)
  if (state.streaming && lastMsg?.role === "assistant" && lastMsg.content) {
    const delta = lastMsg.content.slice(_lastSeen.lastContent.length);
    if (delta) {
      crossWindowBus.publish("chat.delta.text", { text: delta, index: msgs.length - 1 });
    }
  }

  // Thinking delta
  if (state.streaming && lastMsg?.role === "assistant" && lastMsg.thinking) {
    const delta = (lastMsg.thinking || "").slice(_lastSeen.lastThinking.length);
    if (delta) {
      crossWindowBus.publish("chat.delta.thinking", { text: delta, index: msgs.length - 1 });
    }
  }

  // Streaming state change
  if (state.streaming !== _lastSeen.streaming) {
    crossWindowBus.publish("chat.streaming", state.streaming, { sticky: true });
  }

  // Context tokens
  if (state.usedTokens !== undefined || state.contextPercent !== undefined) {
    crossWindowBus.publish("chat.context", {
      percent: state.contextPercent,
      used: state.usedTokens,
      output: state.outputTokens,
      windowSize: state.contextWindowSize,
    }, { sticky: true });
  }

  // Model
  if (state.model) {
    crossWindowBus.publish("chat.model", state.model, { sticky: true });
  }

  // Connection state
  crossWindowBus.publish("chat.connected", state.connected, { sticky: true });

  // 会话列表是否就绪 —— 必须镜像，否则叶子窗口里 `isChatReady()`（= connected && sessionsLoaded）
  // 恒为 false：`sessionsLoaded` 只在 hub 侧被置位（chatReduce 的 session_list 分支），
  // 叶子侧一直停在 emptyChatState() 的 false。后果是**浮窗里的发送按钮永久灰色**
  // （InputArea 的 disabled 判定），聊天挂件同理。
  if (state.sessionsLoaded !== undefined) {
    crossWindowBus.publish("chat.sessionsLoaded", !!state.sessionsLoaded, { sticky: true });
  }

  // Sessions
  if (state.sessions) {
    crossWindowBus.publish("chat.sessions", state.sessions, { sticky: true });
  }

  // Active session
  if (state.sessionId) {
    crossWindowBus.publish("chat.activeSession", state.sessionId, { sticky: true });
  }

  // Tasks
  if (state.tasks) {
    crossWindowBus.publish("chat.tasks", state.tasks, { sticky: true });
  }

  // Slash commands
  if (state.slashCommands) {
    crossWindowBus.publish("chat.slashCommands", state.slashCommands, { sticky: true });
  }

  // Input blocked
  if (state.inputBlockedReason !== undefined) {
    crossWindowBus.publish("chat.inputBlocked", state.inputBlockedReason, { sticky: true });
  }

  // Skills dialog
  if (state.activeSkillDialog !== undefined) {
    crossWindowBus.publish("chat.skills.dialog", state.activeSkillDialog, { sticky: true });
  }

  // Update last seen
  _lastSeen = {
    messagesLength: msgs.length,
    lastContent: lastMsg?.role === "assistant" ? (lastMsg.content || "") : _lastSeen.lastContent,
    lastThinking: lastMsg?.role === "assistant" ? (lastMsg.thinking || "") : _lastSeen.lastThinking,
    streaming: !!state.streaming,
  };
}

export function startCrossWindowBusHub(): void {
  // ── Chat state ──
  // Watch CHAT_STATE_CHANGED for all chat-related data.
  // Note: session_loaded triggers a full state reset, so we also
  // handle it by watching for messages count dropping to 0 then growing.
  windowBus.on(Events.CHAT_STATE_CHANGED, (data: ChatStateChangedPayload) => {
    const state = data.state;

    // Detect session load: messages cleared then repopulated
    if (state.messages && state.messages.length > 1 && _lastSeen.messagesLength === 0) {
      // Likely a session_loaded just happened — push bulk
      crossWindowBus.publish("chat.session.loaded", {
        sessionId: state.sessionId,
        messages: state.messages,
      });
    }

    syncChatState(state);

    // Flush stream buffer so RAF-merged deltas go out promptly
    crossWindowBus.flush();
  });

  // ── Commands from Leaf windows → forward to WS ──
  crossWindowBus.subscribe("cmd.*", (payload, meta) => {
    if (!meta.fromBridge || !meta.topic) return;
    const cmdType = meta.topic.slice(4); // "cmd.send" → "send", "cmd.interrupt" → "interrupt"
    if (!cmdType) return;

    // 两条命令要**走带副作用的入口**，不能用裸 send() 转发给 WS：
    //
    //  · `user`：裸发的话**没有任何窗口**会为这条消息生成用户气泡 —— chatReduce 的
    //    `case "user"` 只做 tool_result 配对，不因后端回显而 addMessage。而 hub 的
    //    `sendMessage()` 会 addMessage（于是经 `chat.message` 镜像回所有叶子），
    //    顺带正确处理「忙时入队」与打断标记。这同时保证了**退出挂件回主窗后
    //    历史里有刚才在挂件里发的话**。
    //  · `interrupt`：`interrupt()` 带乐观清 streaming + 队列暂停，语义才与主窗一致。
    if (cmdType === "user") {
      const content = String((payload as { content?: unknown } | undefined)?.content ?? "").trim();
      if (!content) return;
      import("../chat/chatSession").then((m) => m.chatSession.sendMessage(content)).catch(() => {});
      return;
    }
    if (cmdType === "interrupt") {
      import("../chat/chatSession").then((m) => m.chatSession.interrupt()).catch(() => {});
      return;
    }

    // 其余命令与后端 wire 类型一一对应，直接转发
    import("../components/chat/useChatBridge").then((m) => {
      m.send(cmdType, (payload ?? {}) as Record<string, unknown>);
    }).catch(() => {});
  });

  // ── 聊天挂件的历史回填（请求 → 应答）──
  //
  // 为什么需要：sticky 的 `chat.message` 每次覆写同一个 key，所以**新开的窗口只能
  // 拿到最后一条消息**；而 `chat.session.loaded` 是 bulk 且非 sticky，不进握手快照。
  // 挂件要显示"最近几条"就必须主动要一次。
  //
  // 为什么不用「sticky 最近 N 条」：`chat.delta.text` 是 **stream（非 sticky）**，
  // 若挂件打开时主窗正在流式输出，sticky 快照里的最后一条 assistant 消息只含"上次
  // 因消息数变化而重发时的内容"，**已累积的 token 前缀永远补不回来**（表现为
  // "AI 那半句话从中间开始"）。请求-应答读的是此刻真实的 messages，天然连续。
  crossWindowBus.subscribe("widget.history.request", (payload, meta) => {
    console.log("[widget] hub 收到历史请求", { fromBridge: meta.fromBridge, payload });
    if (!meta.fromBridge) return; // 忽略本窗自己的发布
    // 先把 stream 缓冲排空：被节流的合并写入若在快照之后才发出，
    // 挂件会把"已含在快照里"的文本再加一遍。
    crossWindowBus.flush();
    const limit = Math.max(1, Number((payload as { limit?: unknown } | undefined)?.limit) || 20);
    import("../stores/chatStore").then(({ getChatState }) => {
      const st = getChatState();
      console.log("[widget] hub 回历史", {
        sessionId: st.sessionId,
        total: st.messages.length,
        发出条数: Math.min(limit, st.messages.length),
      });
      crossWindowBus.publish("widget.history", {
        sessionId: st.sessionId,
        messages: st.messages.slice(-limit),
      });
    }).catch((e) => console.warn("[widget] hub 取 chatStore 失败", e));
  });

  // ── Plan ──
  windowBus.on(Events.PLAN_UPDATED, (data: PlanUpdatedPayload) => {
    crossWindowBus.publish("plan.tasks", data.tasks, { sticky: true });
  });

  // ── Sub-agents ──
  windowBus.on(Events.SUB_AGENTS_CHANGED, (data: SubAgentsChangedPayload) => {
    crossWindowBus.publish("subagents.list", data.state, { sticky: true });
  });

  // ── Terminal ──
  windowBus.on(Events.TERMINAL_CHANGED, (data: TerminalChangedPayload) => {
    if (data.entries && data.entries.length > 0) {
      const last = data.entries[data.entries.length - 1];
      crossWindowBus.publish("terminal.delta.output", { output: last.output, entryId: last.id });
      crossWindowBus.publish("terminal.output", { entries: data.entries, activeId: data.activeEntryId }, { sticky: true });
    }
  });

  // ── Editor ──
  windowBus.on(Events.EDITOR_CHANGED, (data: EditorChangedPayload) => {
    crossWindowBus.publish("editor.tabs", data.tabs, { sticky: true });
    crossWindowBus.publish("editor.activePath", data.activePath, { sticky: true });
  });

  // ── Settings ──
  windowBus.on(Events.SETTINGS_CHANGED, (data: SettingsChangedPayload) => {
    crossWindowBus.publish("settings", data.settings, { sticky: true });
  });

  // ── Backend status ──
  windowBus.on(Events.BACKEND_STATE_CHANGED, (data: BackendStateChangedPayload) => {
    crossWindowBus.publish("workers.status", data, { sticky: true });
  });

  // ── Files changed ──
  windowBus.on(Events.FILE_CHANGED, (data: { path: string }) => {
    crossWindowBus.publish("files.changed", data, { sticky: false });
  });

  // ── Desktop changed ──
  windowBus.on(Events.DESKTOP_CHANGED, (data: any) => {
    crossWindowBus.publish("desktop.list", data.desktops, { sticky: true });
    crossWindowBus.publish("desktop.items", data.activeDesktopId, { sticky: true });
  });

  // ── Desktop Leaf → Hub sync: apply incoming desktop state from Bridge back to local store ──
  crossWindowBus.subscribe("desktop.list", (payload, meta) => {
    if (!meta.fromBridge) return; // ignore local (Hub-initiated) publishes
    const currentActiveId = getActiveDesktopId();
    syncDesktopsFromBus(payload as Desktop[], currentActiveId);
  });

  // ── Push current settings immediately so Leaf init snapshots include them ──
  crossWindowBus.publish("settings", getSettings(), { sticky: true });

  console.log("[DataBus Hub] Started — bridging EventBus → DataBus");

  // Reset delta tracking
  _lastSeen = { messagesLength: 0, lastContent: "", lastThinking: "", streaming: false };
}
