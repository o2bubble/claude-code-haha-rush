/**
 * Lightweight selection state for the Super Desktop canvas.
 * Ephemeral (not persisted), pub/sub pattern for React integration.
 */

import { useState, useEffect } from "react";

let _selectedIds = new Set<string>();
const _listeners = new Set<() => void>();

function notify(): void {
  for (const fn of _listeners) fn();
}

// ─── Getters ───

export function getSelectedIds(): Set<string> {
  return _selectedIds;
}

export function isSelected(itemId: string): boolean {
  return _selectedIds.has(itemId);
}

// ─── Mutations ───

export function setSelection(ids: Set<string>): void {
  _selectedIds = ids;
  notify();
}

export function clearSelection(): void {
  if (_selectedIds.size === 0) return;
  _selectedIds = new Set();
  notify();
}

/** Toggle a single item (Ctrl+click). */
export function toggleSelection(itemId: string): void {
  const next = new Set(_selectedIds);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  _selectedIds = next;
  notify();
}

/** Add items to selection (Shift+click). */
export function addToSelection(ids: Set<string>): void {
  if (ids.size === 0) return;
  const next = new Set(_selectedIds);
  for (const id of ids) next.add(id);
  _selectedIds = next;
  notify();
}

// ─── Subscription ───

export function subscribeToSelection(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ─── React hook ───

export function useSelection(): Set<string> {
  const [snapshot, setSnapshot] = useState(getSelectedIds());
  useEffect(() => {
    return subscribeToSelection(() => setSnapshot(getSelectedIds()));
  }, []);
  return snapshot;
}
