import type { ToolUse } from "../stores/chatStore";

/** Deduplicate tool_use blocks by id (in case merging multiple sources produces duplicates). */
export function dedupTools(tools: ToolUse[] | undefined): ToolUse[] {
  if (!tools) return [];
  const seen = new Set<string>();
  return tools.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
