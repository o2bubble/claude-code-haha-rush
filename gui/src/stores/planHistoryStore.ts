// ── Plan history store — DB-backed persistent plan records ──

import { tasksDigest, type PlanTask } from "./planStore";
import { eventBus } from "../services/serviceBus";
import { Events } from "../services/events";

export interface PlanRecord {
  id: string;
  session_id: string;
  session_title: string;
  tasks_json: string;
  plan_text: string;
  created_at: string;
  updated_at: string;
}

export interface PlanSession {
  session_id: string;
  title: string;
  plan_count: number;
  latest_at: string;
}

const PAGE_SIZE = 20;
let records: PlanRecord[] = [];
let sessions: PlanSession[] = [];
let offset = 0;
let noMore = false;
let generation = 0;  // bumped on reset to cancel in-flight loads

function notify() {
  eventBus.emit(Events.PLAN_HISTORY_CHANGED, { records });
}

async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

export type PlanRecordStatus = "completed" | "in_progress" | "pending" | "empty";

export function getPlanStatus(tasks: PlanTask[]): PlanRecordStatus {
  if (tasks.length === 0) return "empty";
  const done = tasks.filter(t => t.status === "completed").length;
  if (done === tasks.length) return "completed";
  if (done > 0) return "in_progress";
  return "pending";
}

export function getRecords(): PlanRecord[] {
  return records;
}

export function getSessions(): PlanSession[] {
  return sessions;
}

export function hasMore(): boolean {
  return !noMore;
}

export function resetPagination() {
  generation++;
  records = [];
  sessions = [];
  offset = 0;
  noMore = false;
  notify();
}

export async function loadSessionList(): Promise<void> {
  if (!isTauri()) return;
  try {
    sessions = await tauriInvoke("db_get_plan_sessions");
    notify();
  } catch {}
}

export async function loadMorePlans(): Promise<void> {
  if (!isTauri() || noMore) return;
  const gen = generation;
  try {
    const rows: PlanRecord[] = await tauriInvoke("db_get_plans", { offset, limit: PAGE_SIZE });
    if (gen !== generation) return; // cancelled by reset
    if (rows.length < PAGE_SIZE) noMore = true;
    records = [...records, ...rows];
    offset += rows.length;
    notify();
  } catch {}
}

export async function saveCurrentPlan(
  sessionId: string,
  sessionTitle: string,
  tasks: PlanTask[],
  planText: string,
): Promise<void> {
  if (!isTauri() || !sessionId) return;
  if (tasks.length === 0) return;
  // ID = session + task content hash → same tasks in same session always upsert
  const id = `${sessionId}-${tasksDigest(tasks)}`;
  try {
    await tauriInvoke("db_save_plan", {
      plan: {
        id,
        session_id: sessionId,
        session_title: sessionTitle,
        tasks_json: JSON.stringify(tasks),
        plan_text: planText,
      },
    });
    // Reload list to show the saved/updated plan
    loadMorePlansFresh();
  } catch {}
}

async function loadMorePlansFresh(): Promise<void> {
  resetPagination();
  await loadSessionList();
  await loadMorePlans();
}