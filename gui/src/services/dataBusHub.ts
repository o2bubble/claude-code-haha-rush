/**
 * DataBus Hub Adapter — bridges EventBus → DataBus on the Hub (main) window.
 *
 * Subscribes to all relevant EventBus events and republishes the data
 * to DataBus topics, so Leaf windows receive them through the Bridge.
 *
 * This module requires NO changes to existing useChatBridge or Store code.
 * It's a pure subscriber that listens and forwards.
 */

import { eventBus } from "./serviceBus";
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
import { dataBus } from "./dataBus";
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
      dataBus.publish("chat.message", msg, { sticky: true });
    }
  }

  // Streaming text delta (approximate via string diff)
  if (state.streaming && lastMsg?.role === "assistant" && lastMsg.content) {
    const delta = lastMsg.content.slice(_lastSeen.lastContent.length);
    if (delta) {
      dataBus.publish("chat.delta.text", { text: delta, index: msgs.length - 1 });
    }
  }

  // Thinking delta
  if (state.streaming && lastMsg?.role === "assistant" && lastMsg.thinking) {
    const delta = (lastMsg.thinking || "").slice(_lastSeen.lastThinking.length);
    if (delta) {
      dataBus.publish("chat.delta.thinking", { text: delta, index: msgs.length - 1 });
    }
  }

  // Streaming state change
  if (state.streaming !== _lastSeen.streaming) {
    dataBus.publish("chat.streaming", state.streaming, { sticky: true });
  }

  // Context tokens
  if (state.usedTokens !== undefined || state.contextPercent !== undefined) {
    dataBus.publish("chat.context", {
      percent: state.contextPercent,
      used: state.usedTokens,
      output: state.outputTokens,
      windowSize: state.contextWindowSize,
    }, { sticky: true });
  }

  // Model
  if (state.model) {
    dataBus.publish("chat.model", state.model, { sticky: true });
  }

  // Connection state
  dataBus.publish("chat.connected", state.connected, { sticky: true });

  // Sessions
  if (state.sessions) {
    dataBus.publish("chat.sessions", state.sessions, { sticky: true });
  }

  // Active session
  if (state.sessionId) {
    dataBus.publish("chat.activeSession", state.sessionId, { sticky: true });
  }

  // Tasks
  if (state.tasks) {
    dataBus.publish("chat.tasks", state.tasks, { sticky: true });
  }

  // Slash commands
  if (state.slashCommands) {
    dataBus.publish("chat.slashCommands", state.slashCommands, { sticky: true });
  }

  // Input blocked
  if (state.inputBlockedReason !== undefined) {
    dataBus.publish("chat.inputBlocked", state.inputBlockedReason, { sticky: true });
  }

  // Skills dialog
  if (state.activeSkillDialog !== undefined) {
    dataBus.publish("chat.skills.dialog", state.activeSkillDialog, { sticky: true });
  }

  // Update last seen
  _lastSeen = {
    messagesLength: msgs.length,
    lastContent: lastMsg?.role === "assistant" ? (lastMsg.content || "") : _lastSeen.lastContent,
    lastThinking: lastMsg?.role === "assistant" ? (lastMsg.thinking || "") : _lastSeen.lastThinking,
    streaming: !!state.streaming,
  };
}

export function startDataBusHub(): void {
  // ── Chat state ──
  // Watch CHAT_STATE_CHANGED for all chat-related data.
  // Note: session_loaded triggers a full state reset, so we also
  // handle it by watching for messages count dropping to 0 then growing.
  eventBus.on(Events.CHAT_STATE_CHANGED, (data: ChatStateChangedPayload) => {
    const state = data.state;

    // Detect session load: messages cleared then repopulated
    if (state.messages && state.messages.length > 1 && _lastSeen.messagesLength === 0) {
      // Likely a session_loaded just happened — push bulk
      dataBus.publish("chat.session.loaded", {
        sessionId: state.sessionId,
        messages: state.messages,
      });
    }

    syncChatState(state);

    // Flush stream buffer so RAF-merged deltas go out promptly
    dataBus.flush();
  });

  // ── Commands from Leaf windows → forward to WS ──
  dataBus.subscribe("cmd.*", (payload, meta) => {
    if (!meta.fromBridge || !meta.topic) return;
    const cmdType = meta.topic.slice(4); // "cmd.send" → "send", "cmd.interrupt" → "interrupt"
    if (!cmdType) return;
    // Dynamically import send from useChatBridge to forward to WS
    import("../components/chat/useChatBridge").then((m) => {
      m.send(cmdType, (payload ?? {}) as Record<string, unknown>);
    }).catch(() => {});
  });

  // ── Plan ──
  eventBus.on(Events.PLAN_UPDATED, (data: PlanUpdatedPayload) => {
    dataBus.publish("plan.tasks", data.tasks, { sticky: true });
  });

  // ── Sub-agents ──
  eventBus.on(Events.SUB_AGENTS_CHANGED, (data: SubAgentsChangedPayload) => {
    dataBus.publish("subagents.list", data.state, { sticky: true });
  });

  // ── Terminal ──
  eventBus.on(Events.TERMINAL_CHANGED, (data: TerminalChangedPayload) => {
    if (data.entries && data.entries.length > 0) {
      const last = data.entries[data.entries.length - 1];
      dataBus.publish("terminal.delta.output", { output: last.output, entryId: last.id });
      dataBus.publish("terminal.output", { entries: data.entries, activeId: data.activeEntryId }, { sticky: true });
    }
  });

  // ── Editor ──
  eventBus.on(Events.EDITOR_CHANGED, (data: EditorChangedPayload) => {
    dataBus.publish("editor.tabs", data.tabs, { sticky: true });
    dataBus.publish("editor.activePath", data.activePath, { sticky: true });
  });

  // ── Settings ──
  eventBus.on(Events.SETTINGS_CHANGED, (data: SettingsChangedPayload) => {
    dataBus.publish("settings", data.settings, { sticky: true });
  });

  // ── Backend status ──
  eventBus.on(Events.BACKEND_STATE_CHANGED, (data: BackendStateChangedPayload) => {
    dataBus.publish("workers.status", data, { sticky: true });
  });

  // ── Files changed ──
  eventBus.on(Events.FILE_CHANGED, (data: { path: string }) => {
    dataBus.publish("files.changed", data, { sticky: false });
  });

  // ── Desktop changed ──
  eventBus.on(Events.DESKTOP_CHANGED, (data: any) => {
    dataBus.publish("desktop.list", data.desktops, { sticky: true });
    dataBus.publish("desktop.items", data.activeDesktopId, { sticky: true });
  });

  // ── Desktop Leaf → Hub sync: apply incoming desktop state from Bridge back to local store ──
  dataBus.subscribe("desktop.list", (payload, meta) => {
    if (!meta.fromBridge) return; // ignore local (Hub-initiated) publishes
    const currentActiveId = getActiveDesktopId();
    syncDesktopsFromBus(payload as Desktop[], currentActiveId);
  });

  // ── Push current settings immediately so Leaf init snapshots include them ──
  dataBus.publish("settings", getSettings(), { sticky: true });

  console.log("[DataBus Hub] Started — bridging EventBus → DataBus");

  // Reset delta tracking
  _lastSeen = { messagesLength: 0, lastContent: "", lastThinking: "", streaming: false };
}
