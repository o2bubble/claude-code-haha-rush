// ── session_loaded merge — pure ──
// Migrated verbatim from useChatBridge (formerly lines ~470-552): converts raw
// wire messages from session_loaded into display messages, merging adjacent
// thinking + content assistant messages and deduping tool_use blocks by id.

import type { ChatMessage, MetaKind, ToolUse } from "./types";

/** 用户按 Esc 中断时，后端写入的标记文本。
 *
 *  ⚠️ **这两条消息没有 `isMeta` 字段** —— 见 `src/utils/messages.ts` 的
 *  `createUserInterruptionMessage()`（它只调 `createUserMessage({content})`）。
 *  原生 TUI 靠内容比对把它们渲染成 "Interrupted · What should Claude do instead?"
 *  而不是用户气泡（`components/messages/UserTextMessage.tsx`），GUI 这里同理。
 *
 *  与 `isMeta` 那条的区别：`isMeta` 是**协议字段**，这是**内容约定** ——
 *  因为后端没给字段，只能比文本。常量必须与后端逐字一致。 */
const INTERRUPT_TEXT = "[Request interrupted by user]";
const INTERRUPT_TEXT_TOOL = "[Request interrupted by user for tool use]";

export function isInterruptMessage(text: string): boolean {
  return text === INTERRUPT_TEXT || text === INTERRUPT_TEXT_TOOL;
}

/** 恢复被中断的回合时，程序补/发的那句续写提示。
 *
 *  · 后端 `conversationRecovery.ts` 会补一条 `isMeta: true` 的同文案消息（合成，
 *    只用于让 API 上下文合法）；
 *  · GUI 开启「自动续跑」时会**真发**一条同文案（chatSession.maybeResumeInterruptedTurn）。
 *
 *  后者落盘后**没有 isMeta**，重载时只能按文案认出它也是程序发的。逐字一致。 */
export const CONTINUE_PROMPT = "Continue from where you left off.";

/** 判定一条 session_loaded 消息在 UI 上算不算「程序消息」，返回其成因。
 *
 *  四种来源按可靠性排序判定：
 *   ① 协议字段 `isMeta` —— 最可靠（合成消息）
 *   ② 中断标记文本 —— 后端不写字段，只能比文本
 *   ③ 自动续跑续写 —— GUI 真发的，落盘后没有 isMeta，只能比文本
 *   ④ 自动唤醒醒词 —— 同上，且醒词可由用户自定义（从设置传入）
 */
function detectMetaKind(
  cur: any,
  text: string,
  stallWakePrompts: readonly string[] = [],
): MetaKind | undefined {
  if (cur?.isMeta === true) return "auto";
  // 只有 user 文本消息才可能是标记（tool_result 里的同名文本属于工具输出，
  // 由工具块自己渲染，不该冒出一条独立消息）
  if (cur?.type !== "user") return undefined;
  if (isInterruptMessage(text)) return "interrupt";
  const t = text.trim();
  if (t === CONTINUE_PROMPT) return "resume";
  if (t && stallWakePrompts.some((p) => p.trim() === t)) return "stall-wake";
  return undefined;
}

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

export function mergeSessionMessages(
  raw: any[],
  uuid: () => string = () => crypto.randomUUID(),
  opts: { stallWakePrompts?: readonly string[] } = {},
): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    const curParts = extractContent(cur?.message?.content, uuid);
    // 程序消息：透传给 UI 做弱化渲染 —— 见 ChatMessage.isMeta / metaKind。
    // 三种来源都要识别：协议字段 isMeta、**没有该字段**的中断标记文本、自动唤醒醒词。
    const metaKind = detectMetaKind(cur, curParts.text, opts.stallWakePrompts);
    const curMsg: ChatMessage = {
      id: cur.uuid || uuid(),
      role: cur.type === "user" ? "user" : "assistant",
      content: curParts.text,
      thinking: curParts.thinking || undefined,
      toolUses: curParts.toolUses.length > 0 ? curParts.toolUses : undefined,
      timestamp: toTimestamp(cur.timestamp),
      ...(metaKind ? { isMeta: true, metaKind } : {}),
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
