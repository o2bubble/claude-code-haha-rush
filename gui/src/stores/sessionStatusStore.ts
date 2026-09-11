// ── 会话打开/代理状态索引（跨 GUI）──
// 仅保存"其他实例"上报的会话状态：本实例自己的会话状态被 forwarder 跳过
// （self 不回灌），所以索引天然不含自身 —— "open elsewhere" 语义成立。
// 纯 store：事件从 sessionStatusSync 灌入，会话列表订阅渲染标记/圆点。

export type SessionState = "working" | "idle";

export interface SessionStatusEntry {
  sessionId: string;
  state: SessionState;
  clientId: string;
  workspace: string;
}

let entries = new Map<string, SessionStatusEntry>(); // keyed by clientId
let listeners: Array<() => void> = [];

function notify() {
  for (const fn of listeners) fn();
}

export function upsertSessionStatus(e: SessionStatusEntry) {
  entries.set(e.clientId, e);
  notify();
}

export function removeClient(clientId: string) {
  if (entries.delete(clientId)) notify();
}

export function replaceAllSessionStatus(list: SessionStatusEntry[]) {
  const m = new Map<string, SessionStatusEntry>();
  for (const e of list) m.set(e.clientId, e);
  entries = m;
  notify();
}

export function getAllSessionStatuses(): SessionStatusEntry[] {
  return [...entries.values()];
}

/** 某会话在"其他实例"打开的状态（本实例自身已过滤）。按 sessionId + workspace 匹配。 */
export function getSessionOpenElsewhere(sessionId: string, workspace: string): SessionStatusEntry[] {
  return [...entries.values()].filter(
    (e) => e.sessionId === sessionId && e.workspace === workspace,
  );
}

export function subscribeSessionStatus(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}
