// ── 消息队列 store — 按会话持有 + localStorage 持久化 + 订阅 ──
// 纯状态机在 msgQueueState.ts；这里做会话维度聚合、持久化、通知。
// 重启时从磁盘恢复队列，但一律 paused（见 loadQueueData）。

import {
  createQueue, enqueue, interrupt, resume, sendNow, moveItem,
  removeAt as stateRemoveAt, clearQueue, updateText, drainHead,
  persistQueueData, loadQueueData,
  type SessionQueue, type QueuedMsg,
} from "./msgQueueState";
import { getSettings } from "./settingsStore";

const STORAGE_KEY = "claude-msg-queue";

let queues: Record<string, SessionQueue> = {};
let activeSessionId: string | null = null;
let listeners: Array<() => void> = [];
let loaded = false;

function notify() {
  for (const fn of listeners) fn();
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, persistQueueData(queues));
  } catch {
    // 存储失败不致命 — 队列仍在内存可用
  }
}

/** 启动时加载持久化队列；状态一律 paused。 */
export function loadMsgQueues() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) queues = loadQueueData(raw);
  } catch {
    queues = {};
  }
  notify();
}

export function setActiveSession(sessionId: string | null) {
  if (sessionId !== activeSessionId) {
    activeSessionId = sessionId;
    notify();
  }
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function getQueue(sessionId: string): SessionQueue {
  return queues[sessionId] ?? createQueue();
}

export function getActiveQueue(): SessionQueue {
  return activeSessionId ? getQueue(activeSessionId) : createQueue();
}

function active() {
  if (!activeSessionId) return null;
  return queues[activeSessionId] ?? (queues[activeSessionId] = createQueue());
}

/** 入队到活跃会话。满 → "full"; 无活跃会话 → "no-session"; 成功 → "ok"。 */
export function enqueueMessage(text: string, maxItems?: number): "ok" | "full" | "no-session" {
  if (!activeSessionId) return "no-session";
  const q = active();
  if (!q) return "no-session";
  const next = enqueue(q, text, maxItems ?? getSettings().msgQueueMaxItems ?? 20, () => crypto.randomUUID());
  if (next === null) return "full";
  queues[activeSessionId!] = next;
  saveToStorage();
  notify();
  return "ok";
}

/** 打断 → 停止自动发送。 */
export function interruptQueue() {
  const q = active();
  if (!q) return;
  queues[activeSessionId!] = interrupt(q);
  saveToStorage();
  notify();
}

export function resumeQueue() {
  const q = active();
  if (!q) return;
  queues[activeSessionId!] = resume(q);
  saveToStorage();
  notify();
}

/** 立即发送：提到队首；paused 同时恢复 auto。 */
export function sendNowAt(index: number) {
  const q = active();
  if (!q) return;
  queues[activeSessionId!] = sendNow(q, index);
  saveToStorage();
  notify();
}

export function moveItemAt(from: number, to: number) {
  const q = active();
  if (!q) return;
  queues[activeSessionId!] = moveItem(q, from, to);
  saveToStorage();
  notify();
}

export function removeAt(index: number) {
  const q = active();
  if (!q) return;
  queues[activeSessionId!] = stateRemoveAt(q, index);
  saveToStorage();
  notify();
}

export function clearQueueNow() {
  const q = active();
  if (!q) return;
  queues[activeSessionId!] = clearQueue(q);
  saveToStorage();
  notify();
}

export function updateTextAt(index: number, text: string) {
  const q = active();
  if (!q) return;
  queues[activeSessionId!] = updateText(q, index, text);
  saveToStorage();
  notify();
}

/** 取出活跃会话队首（待发送）；空 → null。不改 autoSend。 */
export function drainNext(): QueuedMsg | null {
  const q = active();
  if (!q) return null;
  const { queue, msg } = drainHead(q);
  queues[activeSessionId!] = queue;
  saveToStorage();
  notify();
  return msg;
}

export function subscribeMsgQueues(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}
