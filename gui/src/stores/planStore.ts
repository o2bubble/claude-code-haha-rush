// ── Plan store — tracks agent task plan from TodoWrite tool_use blocks ──

import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";
import { getChatState } from "./chatStore";

export interface PlanTask {
  content: string;       // imperative form, e.g. "创建 planStore.ts"
  activeForm: string;    // present continuous, e.g. "创建 planStore.ts 中"
  status: "pending" | "in_progress" | "completed";
}

let tasks: PlanTask[] = [];

export function getPlanTasks(): PlanTask[] {
  return tasks;
}

/** Stable hash of task contents — used for dedup ID across auto-save and ExitPlanMode */
export function tasksDigest(ts: PlanTask[]): string {
  const content = ts.map(t => t.content).sort().join("::");
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

export function updatePlan(newTasks: PlanTask[]) {
  // Auto-save old tasks to history if they represent a different plan
  if (tasks.length > 0) {
    const oldDigest = tasksDigest(tasks);
    const newDigest = tasksDigest(newTasks);
    if (oldDigest !== newDigest) {
      const state = getChatState();
      const sid = state.sessionId || "";
      const stitle = state.sessions.find(s => s.id === sid)?.title || "";
      const planText = "# Plan (auto-saved)\n\n" + tasks.map(t => `- [${t.status}] ${t.content}`).join("\n");
      // Dynamic import to avoid circular dependency at module level
      import("./planHistoryStore").then(({ saveCurrentPlan }) => {
        saveCurrentPlan(sid, stitle, tasks, planText);
      });
    }
  }

  tasks = newTasks;
  windowBus.emit(Events.PLAN_UPDATED, { tasks }, { sticky: true });
}

export function clearPlan() {
  tasks = [];
  windowBus.emit(Events.PLAN_UPDATED, { tasks: [] }, { sticky: true });
}

/** Test hook — identical to clearPlan(). */
export const _reset = clearPlan;
