// ── Plan extraction — TodoWrite/TaskCreate → task list ──
// Single pure helper; replaces the three copies that lived in useChatBridge
// (stream content_block_stop, non-streamed assistant, session_loaded restore).

import type { PlanTask } from "./types";

export function isPlanTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("todowrite") || n.includes("taskcreate");
}

/** Pull TodoWrite/TaskCreate tasks from a tool input. Returns null when absent or invalid. */
export function extractPlanTasks(input: any): PlanTask[] | null {
  if (!input) return null;
  const todos = input.todos || input.tasks;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return todos as PlanTask[];
}
