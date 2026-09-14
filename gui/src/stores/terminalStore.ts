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

/**
 * 合并一段**滚动尾部窗口**到已累积的输出。
 *
 * 后端进度回调送来的不是增量：`exec` 的 onProgress 传的是「最近 5 行 / 最近
 * 100 行」的滚动窗口（`src/utils/task/TaskOutput.ts` → `CircularBuffer.getRecent`），
 * 每次 poll 窗口滑动并与上一次重叠。直接 `output += text` 会把重叠部分反复
 * 累积 —— 短输出（≤5 行）时整段重复，表现为"命令和结果出现了两遍"。
 * （既有注释声称 `output` 是 delta，与后端实现不符。）
 *
 * 合并规则：**按行**找 incoming 的哪些行已经出现在 acc 尾部（最长匹配），
 * 只追加新行。内容真的重复输出（如连续两次 `echo same`）无法与窗口滑动区分，
 * 此时保守处理：仍追加（宁可多留也不丢数据）。
 */
function mergeTailWindow(acc: string, incoming: string): string {
  if (!incoming) return acc;
  if (!acc) return incoming;

  const accLines = splitLines(acc);
  const incLines = splitLines(incoming);

  // incoming 的 k 行（k 从大到小）是否与 acc 的末尾 k 行完全一致 → 最长重叠。
  const max = Math.min(accLines.length, incLines.length);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (accLines[accLines.length - k + i] !== incLines[i]) { match = false; break; }
    }
    if (match) {
      const rest = incLines.slice(k);
      if (rest.length === 0) return acc;          // 窗口完全没动 → 原样
      return joinLines([...accLines, ...rest]);
    }
  }
  return joinLines([...accLines, ...incLines]);
}

/** 按 \n 切分，丢弃末尾空串（trailing newline 不算一行）。 */
function splitLines(s: string): string[] {
  const parts = s.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

export function appendOutput(toolUseId: string, text: string) {
  // 找不到条目时回落到"最后一个"而不是丢弃：进度包的真实 id 来自
  // parent_tool_use_id，若某条链路（子代理内 bash、协议演进）拿不到对应 id，
  // 宁可按原行为写到最近条目，也不要静默丢输出。
  const entry = (toolUseId ? toolToEntry.get(toolUseId) : undefined) ?? lastEntry;
  if (!entry) return;
  entry.output = mergeTailWindow(entry.output, text);
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
