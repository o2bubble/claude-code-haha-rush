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
    // Dynamically import send from useChatBridge to forward to WS
    import("../components/chat/useChatBridge").then((m) => {
      m.send(cmdType, (payload ?? {}) as Record<string, unknown>);
    }).catch(() => {});
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
