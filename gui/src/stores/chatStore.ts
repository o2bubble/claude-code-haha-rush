// Chat state - module-level singleton

import { windowBus } from "../services/windowBus";
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
  /** 由子代理（Task/Agent）产生 — 后端 parent_tool_use_id 非空。仅用于 UI 区分。 */
  subagent?: boolean;
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

/** GUI 侧 effort 档位（与后端 EffortLevel 对齐）。 */
export type EffortLevelUI = 'low' | 'medium' | 'high' | 'max';

/** 后端上报的当前模型能力，GUI 据此决定显示哪些档位。 */
export interface ModelCapabilities {
  effort: boolean;
  maxEffort: boolean;
  thinking: boolean;
  adaptiveThinking: boolean;
  reasoning: boolean;
  defaultEffort?: EffortLevelUI | number;
}

export interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  /** 压缩会话中：status compacting → compact_boundary 之间。压缩期流无事件、lastStreamEventAt 停更，
   *  用于抑制"流卡死决策期"（压缩不是卡死）。 */
  compacting?: boolean;
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
  /** 思考模式开/关（后端 thinkingEnabled 回播同步）。 */
  thinkingModeEnabled: boolean;
  /** GUI 手动设置的 effort 档位；null = 跟随模型默认。 */
  effort: EffortLevelUI | null;
  /** 当前模型能力（后端 model_capabilities 回播）。 */
  modelCapabilities: ModelCapabilities | null;
  /** True once a session list has arrived from the backend — used to avoid
   *  mislabeling favorites as stale before the list loads. */
  sessionsLoaded: boolean;
  /** 后端报告的总会话数（session_list.total）。会话文件夹孤儿清理只在
   *  `sessions.length >= sessionTotal`（列表完整）时执行——截断/分页时 total
   *  大于返回数，跳过清理以免把真实存在的会话归属当孤儿删掉。null = 未知。 */
  sessionTotal: number | null;
  /** 最近一次流式活动的时间戳（null=尚无）；无响应提示据此计算卡顿秒数。 */
  lastStreamEventAt: number | null;
  /** 在途工具数（tool_use 已开始、tool_result 未回）。
   *  仅供自动中断分级宽限判定（Bash/Task 给更长宽限），**不豁免决策条**
   *  （2026-09-10 一刀切：静默 30s 一律弹条，见 streamStallDecision）。 */
  activeToolUses?: number;
  /** 后端权威忙闲信号（status 广播携带 busy 布尔写入）。undefined = 后端尚无信号
   *  （初始化/WS 半开），回落 streaming；true/false 后即用权威值。用于消除乐观
   *  streaming 与后端 busy 的失同步（interrupt 乐观清空/等子代理静默/error 卡 true）。 */
  backendBusy?: boolean;
}

let state: ChatState = emptyChatState();

export function getChatState(): ChatState {
  return state;
}

/** 聊天是否就绪可发送：后端 WS 已连接(connected) 且会话列表已加载(sessionsLoaded)。
 *  未就绪时不入队、不加气泡（消息可能排进 messageQueue 而用户气泡先出现，造成"假发送"）。
 *  纯版收一个状态便于测试；无参版读全局。 */
export function isChatReady(s?: ChatState): boolean {
  const st = s ?? state;
  return !!(st.connected && st.sessionsLoaded);
}

export function updateChatState(partial: Partial<ChatState>) {
  state = { ...state, ...partial };
  windowBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

export function addMessage(msg: ChatMessage) {
  // Dedup by message id — a re-delivered message_start (stream retry/fallback
  // re-emitting the same message) must not add the same message twice.
  if (msg.id && state.messages.some((m) => m.id === msg.id)) return;
  state = { ...state, messages: [...state.messages, msg] };
  windowBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

/** Replace the entire message list in one emit — for bulk loads (session restore). */
export function setMessages(msgs: ChatMessage[]) {
  state = { ...state, messages: msgs, streaming: false };
  windowBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

/** Replace the entire chat state in one emit — used by the chatReduce runner
 *  to apply a fold result (single emit per wire message). */
export function replaceState(next: ChatState) {
  state = { ...next };
  windowBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
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
  windowBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}

export function clearMessages() {
  state = { ...state, messages: [] };
  windowBus.emit(Events.CHAT_STATE_CHANGED, { state: { ...state } }, { sticky: true });
}
