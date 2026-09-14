// ── Chat domain types for the pure reducer ──
// The reducer (chatReduce) owns ChatState; everything it cannot do itself is
// returned as a typed ChatEffect that the runner applies. Input is the raw
// wire message (the protocol IS the interface — no second vocabulary).

import type { ChatState, ChatMessage, ToolUse } from "../stores/chatStore";
import type { PlanTask } from "../stores/planStore";
import type { SubAgentInfo, SubAgentMessage } from "../stores/subAgentStore";

export type { ChatState, ChatMessage, ToolUse, PlanTask, SubAgentInfo, SubAgentMessage };

/** A raw message as received on the WebSocket (post stream_event unwrap). */
export type WireMessage = Record<string, any>;

/** Side effects the fold returns for the runner to apply. */
export type ChatEffect =
  | { type: "terminal.start"; toolUseId: string; command: string }
  | { type: "terminal.update"; toolUseId: string; command: string }
  | { type: "terminal.append"; toolUseId: string; text: string }
  | { type: "terminal.output"; toolUseId: string; text: string }
  | { type: "terminal.finish"; toolUseId: string; exitCode: number }
  | { type: "terminal.clear" }
  | { type: "plan.update"; tasks: PlanTask[] }
  | { type: "plan.save"; sessionId: string; title: string; planText: string }
  | { type: "plan.clear" }
  | { type: "subagent.upsert"; agent: SubAgentInfo }
  | { type: "subagent.transcript"; taskId: string; messages: SubAgentMessage[]; error?: string }
  | { type: "subagent.transcript.append"; taskId: string; messages: SubAgentMessage[]; total?: number }
  | { type: "subagent.error"; taskId: string; message?: string }
  | { type: "subagent.clear" }
  | { type: "emit.fileChanged"; path: string }
  | { type: "command.resumeSession"; sessionId: string }
  | { type: "command.listSessions" }
  | { type: "command.resendPermissionMode"; mode: string };

/** Settings the fold needs to stay deterministic. The runner fills these from
 *  the settings store at dispatch time; tests pass explicit values. */
export interface ReduceCtx {
  savedPermissionMode?: string;
  now?: () => number;
  uuid?: () => string;
}
