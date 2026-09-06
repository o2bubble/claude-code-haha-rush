// Terminal output store

import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";

export interface TerminalEntry {
  id: string;
  toolUseId: string;
  command: string;
  output: string;
  cwd?: string;
  exitCode: number | null;
  timestamp: number;
}

let entries: TerminalEntry[] = [];
let toolToEntry = new Map<string, TerminalEntry>();
let lastEntry: TerminalEntry | null = null;
let _activeEntryId: string | null = null;

function notify() {
  windowBus.emit(Events.TERMINAL_CHANGED, { entries, activeEntryId: _activeEntryId });
}

export function getEntries(): TerminalEntry[] {
  return entries;
}

export function getActiveEntryId(): string | null {
  return _activeEntryId;
}

export function getActiveEntry(): TerminalEntry | null {
  if (!_activeEntryId) return entries.length > 0 ? entries[entries.length - 1] : null;
  return entries.find((e) => e.id === _activeEntryId) ?? null;
}

export function setActiveEntryId(id: string | null) {
  _activeEntryId = id;
  notify();
}

function maxEntries(): number {
  try {
    const { getSettings } = require("./settingsStore") as typeof import("./settingsStore");
    return getSettings().terminalMaxEntries || 50;
  } catch {
    return 50;
  }
}

export function startCommand(toolUseId: string, command: string, cwd?: string) {
  // Dedup: a re-delivered content_block_start for the same tool_use (stream
  // retry/fallback can re-emit it — see inc-4258) must not create a second
  // entry. Reuse the existing entry and reset its run state instead.
  const existing = toolToEntry.get(toolUseId);
  if (existing) {
    existing.command = command || existing.command;
    if (cwd) existing.cwd = cwd;
    existing.output = "";
    existing.exitCode = null;
    lastEntry = existing;
    _activeEntryId = existing.id;
    notify();
    return;
  }
  const limit = maxEntries();
  while (entries.length >= limit) {
    const oldest = entries.shift();
    if (oldest) {
      toolToEntry.delete(oldest.toolUseId);
      if (lastEntry === oldest) lastEntry = null;
      if (_activeEntryId === oldest.id) _activeEntryId = null;
    }
  }
  const entry: TerminalEntry = {
    id: crypto.randomUUID(),
    toolUseId,
    command,
    output: "",
    cwd,
    exitCode: null,
    timestamp: Date.now(),
  };
  entries.push(entry);
  toolToEntry.set(toolUseId, entry);
  lastEntry = entry;
  _activeEntryId = entry.id;
  notify();
}

export function appendToLastEntry(text: string) {
  if (!lastEntry) return;
  lastEntry.output += text;
  notify();
}

export function appendOutput(toolUseId: string, text: string) {
  const entry = toolToEntry.get(toolUseId);
  if (!entry) return;
  entry.output += text;
  notify();
}

export function setOutput(toolUseId: string, text: string) {
  const entry = toolToEntry.get(toolUseId);
  if (!entry) return;
  entry.output = text;
  notify();
}

export function updateCommand(toolUseId: string, command: string) {
  const entry = toolToEntry.get(toolUseId);
  if (!entry) return;
  entry.command = command;
  notify();
}

export function finishCommand(toolUseId: string, exitCode: number) {
  const entry = toolToEntry.get(toolUseId);
  if (!entry) return;
  entry.exitCode = exitCode;
  if (lastEntry === entry) lastEntry = null;
  notify();
}

export function removeEntry(entryId: string) {
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return;
  const entry = entries[idx];
  entries.splice(idx, 1);
  toolToEntry.delete(entry.toolUseId);
  if (lastEntry === entry) lastEntry = null;
  if (_activeEntryId === entryId) {
    _activeEntryId = entries.length > 0 ? entries[entries.length - 1].id : null;
  }
  notify();
}

export function clear() {
  entries = [];
  toolToEntry.clear();
  lastEntry = null;
  _activeEntryId = null;
  notify();
}

/** Test hook — identical to clear(). */
export const _reset = clear;
