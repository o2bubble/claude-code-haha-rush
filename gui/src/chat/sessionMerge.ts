// ── session_loaded merge — pure ──
// Migrated verbatim from useChatBridge (formerly lines ~470-552): converts raw
// wire messages from session_loaded into display messages, merging adjacent
// thinking + content assistant messages and deduping tool_use blocks by id.

import type { ChatMessage, ToolUse } from "./types";

export function extractContent(content: any, uuid: () => string = () => crypto.randomUUID()): {
  text: string;
  thinking: string;
  toolUses: ToolUse[];
} {
  if (typeof content === "string") return { text: content, thinking: "", toolUses: [] };
  if (Array.isArray(content)) {
    const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const thinking = content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("");
    const toolUses = content
      .filter((c: any) => c.type === "tool_use")
      .map((c: any, i: number) => ({
        id: c.id || uuid(),
        index: i,
        name: c.name || "",
        input: c.input || {},
        status: "done" as const,
      }));
    return { text, thinking, toolUses };
  }
  return { text: "", thinking: "", toolUses: [] };
}

function toTimestamp(t: unknown): number {
  return t ? new Date(t as string | number).getTime() : Date.now();
}

export function mergeSessionMessages(raw: any[], uuid: () => string = () => crypto.randomUUID()): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    const curParts = extractContent(cur?.message?.content, uuid);
    const curMsg: ChatMessage = {
      id: cur.uuid || uuid(),
      role: cur.type === "user" ? "user" : "assistant",
      content: curParts.text,
      thinking: curParts.thinking || undefined,
      toolUses: curParts.toolUses.length > 0 ? curParts.toolUses : undefined,
      timestamp: toTimestamp(cur.timestamp),
    };
    if (!curMsg.content && !curMsg.thinking && !curMsg.toolUses?.length) continue;

    if (curMsg.role === "assistant" && !curMsg.content && curMsg.thinking && i + 1 < raw.length) {
      const next = raw[i + 1];
      const nextParts = extractContent(next?.message?.content, uuid);
      if (next.type === "assistant" && nextParts.text && !nextParts.thinking) {
        const allToolUses = [...(curMsg.toolUses || []), ...(nextParts.toolUses || [])];
        const seen = new Set<string>();
        const deduped = allToolUses.filter((t) => {
          if (seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        });
        merged.push({
          id: curMsg.id,
          role: "assistant",
          content: nextParts.text,
          thinking: curMsg.thinking,
          toolUses: deduped.length > 0 ? deduped : undefined,
          timestamp: toTimestamp(next.timestamp),
        });
        i++;
        continue;
      }
    }
    merged.push(curMsg);
  }
  return merged;
}
