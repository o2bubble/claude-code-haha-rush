// ── 消息区全文搜索 — 纯函数，可单测 ──

export interface SearchResult {
  /** 命中消息在 messages 数组中的下标 */
  index: number;
  /** 命中位置的上下文片段（含省略号） */
  snippet: string;
}

/** 大小写不敏感全文搜索；一条消息多个命中各自成一条结果。空 query 返回 []。 */
export function searchMessages(messages: Array<{ content?: string }>, query: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchResult[] = [];
  for (let i = 0; i < messages.length; i++) {
    const content = typeof messages[i].content === "string" ? (messages[i].content as string) : "";
    const lower = content.toLowerCase();
    let pos = lower.indexOf(q);
    while (pos >= 0) {
      const start = Math.max(0, pos - 24);
      const end = Math.min(content.length, pos + q.length + 48);
      const snippet = (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
      out.push({ index: i, snippet });
      pos = lower.indexOf(q, pos + 1);
    }
  }
  return out;
}

/** 上一个/下一个循环导航：step=+1 下一个，step=-1 上一个 */
export function cycleMatch(current: number, total: number, step: 1 | -1): number {
  if (total === 0) return 0;
  return (current + step + total) % total;
}
