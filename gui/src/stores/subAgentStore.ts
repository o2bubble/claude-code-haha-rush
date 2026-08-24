// ── Sub-agent store — tracks in-process teammates from backend broadcast ──

import { eventBus } from "../services/serviceBus";
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
  eventBus.emit(Events.SUB_AGENTS_CHANGED, { state });
}

/** Test hook — identical to clearSubAgents(). */
export const _reset = clearSubAgents;

function notify() {
  eventBus.emit(Events.SUB_AGENTS_CHANGED, { state: { ...state } });
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

export function setTranscript(taskId: string, messages: SubAgentMessage[], error?: string) {
  state.transcripts = {
    ...state.transcripts,
    [taskId]: { messages, loaded: true, loading: false, error },
  };
  notify();
}
