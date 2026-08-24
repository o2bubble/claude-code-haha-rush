/**
 * Undo/Redo history for desktop operations.
 * Persisted via DB (cross-session), max 100 snapshots per desktop.
 *
 * IMPORTANT: This module does NOT import from desktopStore (avoids circular deps).
 * All functions that need desktop state accept it as a parameter.
 * Use the wrapper functions in desktopStore for convenience.
 */

import type { DesktopItem, Connection } from "../types/desktop";

// ─── Types ───

export interface DesktopSnapshot {
  items: DesktopItem[];
  connections: Connection[];
  panX: number;
  panY: number;
  zoom: number;
}

export interface DesktopStateLike {
  items: DesktopItem[];
  connections: Connection[];
  panX: number;
  panY: number;
  zoom: number;
}

// ─── State ───

const MAX_DEPTH = 100;
const undoStacks = new Map<string, DesktopSnapshot[]>();
const redoStacks = new Map<string, DesktopSnapshot[]>();

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// ─── Persistence ───

async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
  } catch {
    return undefined;
  }
}

async function persistHistory(desktopId: string): Promise<void> {
  const undoStack = undoStacks.get(desktopId) ?? [];
  const redoStack = redoStacks.get(desktopId) ?? [];
  await tauriInvoke("db_save_desktop_history", {
    desktopId,
    undoJson: JSON.stringify(undoStack),
    redoJson: JSON.stringify(redoStack),
  });
}

// ─── Public API (no store dependency) ───

/** Push current desktop state onto undo stack. Call BEFORE a mutation. */
export function pushSnapshot(desktopId: string, state: DesktopStateLike): void {
  const snapshot: DesktopSnapshot = {
    items: clone(state.items),
    connections: clone(state.connections),
    panX: state.panX,
    panY: state.panY,
    zoom: state.zoom,
  };

  let stack = undoStacks.get(desktopId) ?? [];
  stack.push(snapshot);
  if (stack.length > MAX_DEPTH) stack = stack.slice(-MAX_DEPTH);
  undoStacks.set(desktopId, stack);

  // New action invalidates redo
  redoStacks.set(desktopId, []);
}

/** Undo: returns previous state. Caller must apply it. Returns null if nothing to undo. */
export function undo(desktopId: string, currentState: DesktopStateLike): DesktopSnapshot | null {
  const stack = undoStacks.get(desktopId);
  if (!stack || stack.length === 0) return null;

  // Push current state to redo
  const currentSnapshot: DesktopSnapshot = {
    items: clone(currentState.items),
    connections: clone(currentState.connections),
    panX: currentState.panX,
    panY: currentState.panY,
    zoom: currentState.zoom,
  };
  let redoStack = redoStacks.get(desktopId) ?? [];
  redoStack.push(currentSnapshot);
  redoStacks.set(desktopId, redoStack);

  // Pop from undo
  const prev = stack.pop()!;
  undoStacks.set(desktopId, stack);

  persistHistory(desktopId);
  return prev;
}

/** Redo: returns next state. Caller must apply it. Returns null if nothing to redo. */
export function redo(desktopId: string, currentState: DesktopStateLike): DesktopSnapshot | null {
  const stack = redoStacks.get(desktopId);
  if (!stack || stack.length === 0) return null;

  // Push current state to undo
  const currentSnapshot: DesktopSnapshot = {
    items: clone(currentState.items),
    connections: clone(currentState.connections),
    panX: currentState.panX,
    panY: currentState.panY,
    zoom: currentState.zoom,
  };
  let undoStack = undoStacks.get(desktopId) ?? [];
  undoStack.push(currentSnapshot);
  undoStacks.set(desktopId, undoStack);

  // Pop from redo
  const next = stack.pop()!;
  redoStacks.set(desktopId, stack);

  persistHistory(desktopId);
  return next;
}

export function canUndo(desktopId: string): boolean {
  const stack = undoStacks.get(desktopId);
  return !!(stack && stack.length > 0);
}

export function canRedo(desktopId: string): boolean {
  const stack = redoStacks.get(desktopId);
  return !!(stack && stack.length > 0);
}

/** Clear all history for a desktop (e.g. after clear canvas). */
export function clearHistory(desktopId: string): void {
  undoStacks.set(desktopId, []);
  redoStacks.set(desktopId, []);
  persistHistory(desktopId);
}

/** Load persisted history stacks from DB. Called once at startup. */
export async function loadHistory(desktopId: string): Promise<void> {
  const data = await tauriInvoke("db_load_desktop_history", { desktopId });
  if (data) {
    try {
      undoStacks.set(desktopId, JSON.parse(data.undo_json || "[]"));
      redoStacks.set(desktopId, JSON.parse(data.redo_json || "[]"));
    } catch { /* ignore corrupt history */ }
  }
}
