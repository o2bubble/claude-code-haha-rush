// ── Effect runner — applies ChatEffects to the neighbouring stores ──
// The pure fold cannot touch stores; this module executes the store/eventBus
// side of an effect list and returns the remaining command effects for the
// ChatSession runner to handle (they need `send` / connection policy).

import { eventBus } from "../services/serviceBus";
import { Events } from "../services/events";
import type { ChatEffect } from "./types";
import {
  startCommand,
  updateCommand,
  appendToLastEntry,
  setOutput,
  finishCommand,
  clear as clearTerminal,
} from "../stores/terminalStore";
import { updatePlan, clearPlan, getPlanTasks } from "../stores/planStore";
import { saveCurrentPlan } from "../stores/planHistoryStore";
import { upsertSubAgent, setTranscript, clearSubAgents } from "../stores/subAgentStore";

/** Applies store/eventBus effects; returns the command effects for the runner. */
export function applyStoreEffects(effects: ChatEffect[]): ChatEffect[] {
  const commands: ChatEffect[] = [];
  for (const e of effects) {
    switch (e.type) {
      case "terminal.start":
        startCommand(e.toolUseId, e.command);
        break;
      case "terminal.update":
        updateCommand(e.toolUseId, e.command);
        break;
      case "terminal.append":
        appendToLastEntry(e.text);
        break;
      case "terminal.output":
        setOutput(e.toolUseId, e.text);
        break;
      case "terminal.finish":
        finishCommand(e.toolUseId, e.exitCode);
        break;
      case "terminal.clear":
        clearTerminal();
        break;
      case "plan.update":
        updatePlan(e.tasks);
        break;
      case "plan.save":
        saveCurrentPlan(e.sessionId, e.title, getPlanTasks(), e.planText).catch(() => {});
        break;
      case "plan.clear":
        clearPlan();
        break;
      case "subagent.upsert":
        upsertSubAgent(e.agent);
        break;
      case "subagent.transcript":
        setTranscript(e.taskId, e.messages, e.error);
        break;
      case "subagent.clear":
        clearSubAgents();
        break;
      case "emit.fileChanged":
        eventBus.emit(Events.FILE_CHANGED, { path: e.path });
        break;
      default:
        commands.push(e);
        break;
    }
  }
  return commands;
}
