// Chat state - module-level singleton

import { eventBus } from "../services/serviceBus";
import { Events } from "../services/events";
import { emptyChatState } from "../chat/chatReduce";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  streaming?: boolean;
  thinking?: string;
  toolUses?: ToolUse[];
}

export interface ToolUse {
  id: string;
  index: number;
  name: string;
  input: Record<string, unknown>;
  inputRaw?: string;
  output?: string;
  status: "pending" | "running" | "done" | "error";
}

export interface ControlRequest {
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  description: string;
}

export interface Session {
  id: string;
  title: string;
  timestamp: number;
  isActive?: boolean;
}

export interface BackgroundTask {
  id: string;
  description: string;
  status: "running" | "done" | "error" | "killed";
  toolCount: number;
  tokenCount: number;
}

export interface SlashCommand {
  cmd: string;
  desc: string;
  type: string;
}

export interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  connected: boolean;
  sessionId: string | null;
  sessions: Session[];
  tasks: BackgroundTask[];
  permissionMode: string;
  pendingControlRequest: ControlRequest | null;
  inputBlockedReason: string | null;
  slashCommands: SlashCommand[];
  activeSkillDialog: { skill: SlashCommand; isFav: boolean } | null;
  contextPercent: number;
  contextWindowSize: number;
  usedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
  /** True once a session list has arrived from the backend — used to avoid
   *  mislabeling favorites as stale before the list loads. */
  sessionsLoaded: boolean;
  /** 后端报告的总会话数（session_list.total）。会话文件夹孤儿清理只在
   *  `sessions.length >= sessionTotal`（列表完整）时执行——截断/分页时 total
   *  大于返回数，跳过清理以免把真实存在的会话归属当孤儿删掉。null = 未知。 */
  sessionTotal: number | null;
  /** 最近一次流式活动的时间戳（null=尚无）；无响应提示据此计算卡顿秒数。 */
  lastStreamEventAt: number | null;
}

let state: ChatState = emptyChatState();

export function getChatState(): ChatState {
  return state;
}

export function updateChatState(partial: Partial<ChatState>) {
  state = { ...state, ...partial };
  eventBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

export function addMessage(msg: ChatMessage) {
  // Dedup by message id — a re-delivered message_start (stream retry/fallback
  // re-emitting the same message) must not add the same message twice.
  if (msg.id && state.messages.some((m) => m.id === msg.id)) return;
  state = { ...state, messages: [...state.messages, msg] };
  eventBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

/** Replace the entire message list in one emit — for bulk loads (session restore). */
export function setMessages(msgs: ChatMessage[]) {
  state = { ...state, messages: msgs, streaming: false };
  eventBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

/** Replace the entire chat state in one emit — used by the chatReduce runner
 *  to apply a fold result (single emit per wire message). */
export function replaceState(next: ChatState) {
  state = { ...next };
  eventBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

export function updateLastAssistant(fn: (m: ChatMessage) => ChatMessage) {
  const msgs = [...state.messages];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      msgs[i] = fn(msgs[i]);
      break;
    }
  }
  state = { ...state, messages: msgs };
  eventBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

export function clearMessages() {
  state = { ...state, messages: [] };
  eventBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}
