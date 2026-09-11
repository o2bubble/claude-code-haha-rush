// ── Sub-agent store — tracks in-process teammates from backend broadcast ──

import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";

export interface SubAgentInfo {
  taskId: string;
  agentName: string;
  teamName: string;
  agentId: string;         // full: "agentName@teamName"
  color?: string;
  description: string;
  status: "running" | "completed" | "failed" | "killed";
  toolCount: number;
  tokenCount: number;
  /** 当前/最近工具描述（task_progress 推送，如 "Reading src/foo.ts"） */
  lastTool?: string;
  /** 开始时间戳（task_progress 推送，面板据此显示耗时） */
  startTime?: number;
}

export interface SubAgentMessage {
  role: "user" | "assistant";
  content: unknown;
  timestamp?: number;
}

export interface SubAgentTranscript {
  messages: SubAgentMessage[];
  loaded: boolean;
  loading: boolean;
  error?: string;
}

export interface SubAgentState {
  agents: SubAgentInfo[];
  expandedAgentId: string | null;
  transcripts: Record<string, SubAgentTranscript>;
}

let state: SubAgentState = {
  agents: [],
  expandedAgentId: null,
  transcripts: {},
};

export function getSubAgentState(): SubAgentState {
  return state;
}

export function clearSubAgents() {
  state = { agents: [], expandedAgentId: null, transcripts: {} };
  windowBus.emit(Events.SUB_AGENTS_CHANGED, { state });
}

/** Test hook — identical to clearSubAgents(). */
export const _reset = clearSubAgents;

function notify() {
  windowBus.emit(Events.SUB_AGENTS_CHANGED, { state: { ...state } });
}

export function upsertSubAgent(agent: SubAgentInfo) {
  const idx = state.agents.findIndex(a => a.taskId === agent.taskId);
  if (idx >= 0) {
    const prev = state.agents[idx];
    // Preserve meaningful name/description from first broadcast (subsequent
    // progress/completed messages may lack agent_type, falling back to "agent")
    state.agents[idx] = {
      ...agent,
      agentName: agent.agentName !== "agent" ? agent.agentName : prev.agentName,
      teamName: agent.teamName !== "local" ? agent.teamName : prev.teamName,
      description: agent.description || prev.description,
      lastTool: agent.lastTool ?? prev.lastTool,
      startTime: agent.startTime ?? prev.startTime,
    };
  } else {
    state.agents = [...state.agents, agent];
  }
  notify();
}

export function removeSubAgent(taskId: string) {
  state.agents = state.agents.filter(a => a.taskId !== taskId);
  const { [taskId]: _, ...rest } = state.transcripts;
  state.transcripts = rest;
  if (state.expandedAgentId === taskId) state.expandedAgentId = null;
  notify();
}

export function setExpandedAgent(taskId: string | null) {
  state.expandedAgentId = taskId;
  notify();
}

export function setTranscriptLoading(taskId: string) {
  // Keep any existing messages while (re)loading — the running-agent poll calls
  // this every 2s, and clearing messages would re-mount the list empty, resetting
  // the transcript scroll position to the top on every refresh.
  const existing = state.transcripts[taskId]?.messages ?? [];
  state.transcripts = {
    ...state.transcripts,
    [taskId]: { messages: existing, loaded: false, loading: true },
  };
  notify();
}

/** 推送式增量: 追加消息到已有 transcript(不重置 loaded/loading 状态)。
 *  尾部去重: 逐条比对末尾已含的相同 (role+content+timestamp) 消息, 防未来
 *  广播路径重复推送导致屏上重复。 */
export function appendTranscriptMessages(taskId: string, messages: SubAgentMessage[]) {
  if (messages.length === 0) return;
  const cur = state.transcripts[taskId];
  // 尚未加载过全量 → 不追加(等首次 load_agent_transcript 全量, 防乱序半截开头)
  if (!cur?.loaded) return;
  const same = (a: SubAgentMessage, b: SubAgentMessage) =>
    a.role === b.role && a.timestamp === b.timestamp &&
    JSON.stringify(a.content) === JSON.stringify(b.content);
  // 从头找第一条未存在的新消息(重叠前缀跳过), 其余追加
  let start = 0;
  while (start < messages.length) {
    const exists = cur.messages.some((m) => same(m, messages[start]));
    if (!exists) break;
    start++;
  }
  const fresh = messages.slice(start);
  if (fresh.length === 0) return;
  state.transcripts = {
    ...state.transcripts,
    [taskId]: { ...cur, messages: [...cur.messages, ...fresh] },
  };
  notify();
}

/** task_error 落点: 任务已不在(被清掉)的过期请求静默忽略; 已有 transcript 的
 *  只标错误+停 loading, 不动消息与 loaded。 */
export function setTranscriptError(taskId: string, error?: string) {
  if (!state.agents.some(a => a.taskId === taskId)) return;
  const cur = state.transcripts[taskId];
  if (!cur) return;
  state.transcripts = {
    ...state.transcripts,
    [taskId]: { ...cur, loading: false, error },
  };
  notify();
}

export function setTranscript(taskId: string, messages: SubAgentMessage[], error?: string) {
  const cur = state.transcripts[taskId];
  // 全量快照可能早于在途增量序列化(窄窗口)——若快照尾部是现有消息的前缀子集,
  // 保留现有尾部(增量), 只更新加载态。
  let merged = messages;
  if (cur?.loaded && messages.length < cur.messages.length) {
    const tail = cur.messages.slice(messages.length);
    const same = (a: SubAgentMessage, b: SubAgentMessage) =>
      a.role === b.role && a.timestamp === b.timestamp &&
      JSON.stringify(a.content) === JSON.stringify(b.content);
    const isPrefix = messages.every((m, i) => same(m, cur.messages[i]));
    if (isPrefix && tail.length > 0) merged = [...messages, ...tail];
  }
  state.transcripts = {
    ...state.transcripts,
    [taskId]: { messages: merged, loaded: true, loading: false, error },
  };
  notify();
}
