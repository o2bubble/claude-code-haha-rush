// ── 消息队列 · 纯状态机（可测，无副作用）──
// 单会话队列的增删改查与 auto/paused 状态迁移。
// store 层（msgQueueStore.ts）负责按会话持有、localStorage 持久化、订阅。

export interface QueuedMsg {
  id: string;
  text: string;
}

export interface SessionQueue {
  messages: QueuedMsg[];
  /** auto: 回合结束自动发下一条；paused: 打断后停止自动发送，需手动恢复 */
  autoSend: boolean;
}

export function createQueue(autoSend = true): SessionQueue {
  return { messages: [], autoSend };
}

/** 入队。满（>=maxItems）返回 null 拒绝；空队列入队恢复 auto。 */
export function enqueue(q: SessionQueue, text: string, maxItems: number, newId: () => string): SessionQueue | null {
  if (q.messages.length >= maxItems) return null;
  const wasEmpty = q.messages.length === 0;
  return {
    messages: [...q.messages, { id: newId(), text }],
    // 队列排空后新入队 → 回到 auto；非空时保持当前状态（paused 保持 paused）
    autoSend: wasEmpty ? true : q.autoSend,
  };
}

/** 打断 → 停止自动发送（消息保留）。空队列无需暂停——否则后续新入队的消息还得手动恢复。 */
export function interrupt(q: SessionQueue): SessionQueue {
  if (q.messages.length === 0) return q;
  return { ...q, autoSend: false };
}

export function resume(q: SessionQueue): SessionQueue {
  return { ...q, autoSend: true };
}

/** 立即发送：提到队首；paused 则同时恢复 auto。 */
export function sendNow(q: SessionQueue, index: number): SessionQueue {
  if (index < 0 || index >= q.messages.length) return q;
  const msg = q.messages[index];
  return {
    messages: [msg, ...q.messages.filter((_, i) => i !== index)],
    autoSend: true,
  };
}

/** 改序（上/下移），from→to，to 越界 clamp。 */
export function moveItem(q: SessionQueue, from: number, to: number): SessionQueue {
  if (from < 0 || from >= q.messages.length) return q;
  const target = Math.max(0, Math.min(to, q.messages.length - 1));
  if (target === from) return q;
  const next = [...q.messages];
  const [m] = next.splice(from, 1);
  next.splice(target, 0, m);
  return { ...q, messages: next };
}

export function removeAt(q: SessionQueue, index: number): SessionQueue {
  if (index < 0 || index >= q.messages.length) return q;
  return { ...q, messages: q.messages.filter((_, i) => i !== index) };
}

export function clearQueue(q: SessionQueue): SessionQueue {
  return { ...q, messages: [] };
}

export function updateText(q: SessionQueue, index: number, text: string): SessionQueue {
  if (index < 0 || index >= q.messages.length) return q;
  return { ...q, messages: q.messages.map((m, i) => (i === index ? { ...m, text } : m)) };
}

/** 取出队首（待发送），同时从队列移除。空队列 → msg null。 */
export function drainHead(q: SessionQueue): { queue: SessionQueue; msg: QueuedMsg | null } {
  if (q.messages.length === 0) return { queue: q, msg: null };
  const [head, ...rest] = q.messages;
  return { queue: { ...q, messages: rest }, msg: head };
}

// ── 持久化形状 ──

/** 序列化：只存 messages（autoSend 不落盘 — 重启一律 paused）。 */
export function persistQueueData(data: Record<string, SessionQueue>): string {
  const slim: Record<string, { messages: QueuedMsg[] }> = {};
  for (const [k, v] of Object.entries(data)) slim[k] = { messages: v.messages };
  return JSON.stringify(slim);
}

/** 反序列化：恢复队列但一律 paused（绝不自动发）。畸形条目丢弃。 */
export function loadQueueData(raw: string): Record<string, SessionQueue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: Record<string, SessionQueue> = {};
  if (typeof parsed !== "object" || parsed === null) return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const msgs = (v as { messages?: unknown })?.messages;
    if (Array.isArray(msgs)) {
      const valid = msgs.filter(
        (m): m is QueuedMsg => !!m && typeof (m as QueuedMsg).text === "string",
      );
      // 重启恢复: 非空队列一律 paused(绝不自动发); 空队列保持 auto(无消息可暂停)
      out[k] = { messages: valid, autoSend: valid.length > 0 ? false : true };
    }
  }
  return out;
}
