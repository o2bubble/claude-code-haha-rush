// ── 挂件里"这个工具在干什么"的一句话摘要 ──
//
// 挂件窗口小（400×600 左右），塞不下主窗那种可展开的完整工具卡片。
// 目标是**一眼知道大概在干啥**，不是完整复现。
//
// 纯函数，方便单测 —— 这里的规则很容易写错（比如把 MCP 名字拼成一坨）。

import type { ToolUse } from "../../stores/chatStore";

/**
 * 工具名 → 挂件显示名。
 *
 * 两种真实格式（别凭印象，见 pluginRegistry.ts:658）：
 *   1. 插件市场贡献的工具：`plugin_<pluginName>_<toolName>`
 *      例：`plugin_config-export_export_profile`
 *   2. 原生 MCP server：`mcp__<server>__<tool>`
 *      例：`mcp__memory__memory_search`
 */
export function prettyToolName(name: string): string {
  if (!name) return "工具";

  // 格式 1：plugin_<插件名>_<工具名>
  // 插件名里可能有 `-`，工具名里可能有 `_` —— 只能按**第一个** `_` 切
  if (name.startsWith("plugin_")) {
    const rest = name.slice("plugin_".length);
    const i = rest.indexOf("_");
    if (i > 0) {
      const server = rest.slice(0, i);
      const tool = rest.slice(i + 1);
      return server.length + tool.length > 28 ? tool : `${server}: ${tool}`;
    }
  }

  // 格式 2：mcp__<server>__<tool>
  const mcp = /^mcp__+(.+?)__+(.+)$/.exec(name);
  if (mcp) {
    const server = mcp[1];
    const tool = mcp[2];
    return server.length + tool.length > 28 ? tool : `${server}: ${tool}`;
  }

  const known: Record<string, string> = {
    BashTool: "Bash",
    Bash: "Bash",
    AgentTool: "Agent",
    FileEditTool: "Edit",
    FileReadTool: "Read",
    FileWriteTool: "Write",
    GrepTool: "Grep",
    GlobTool: "Glob",
    WebFetchTool: "WebFetch",
    WebSearchTool: "WebSearch",
    TodoWriteTool: "Todo",
    TodoWrite: "Todo",
  };
  return known[name] ?? name.replace(/Tool$/, "");
}

function firstLine(s: string, max: number): string {
  const line = (s || "").split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * 一句话描述这个工具在做什么（不含状态）。
 *
 * 每种工具挑**最能说明意图**的那个字段：命令、文件路径、搜索词…
 * 拿不到就回退到第一个字符串参数 —— 总比只显示工具名强。
 */
export function toolSummary(tool: ToolUse): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const lower = (tool.name || "").toLowerCase();

  // Bash / PowerShell：命令行最有信息量
  if (lower.includes("bash") || lower.includes("powershell") || lower.includes("shell")) {
    const cmd = str(input.command) || str(input.script);
    if (cmd) return firstLine(cmd, 80);
    const desc = str(input.description);
    if (desc) return desc;
  }

  // 文件类：路径
  const path = str(input.file_path) || str(input.filePath) || str(input.path);
  if (path) {
    // 只显示末两段，挂件宽度有限
    const parts = path.split(/[/\\]/).filter(Boolean);
    const short = parts.slice(-2).join("/");
    return short || path;
  }

  // 搜索类：pattern
  const pattern = str(input.pattern) || str(input.query) || str(input.q);
  if (pattern) return firstLine(pattern, 60);

  // URL 类
  const url = str(input.url);
  if (url) return firstLine(url, 60);

  // 通用回退：第一个非空字符串值
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim()) return firstLine(v, 60);
  }
  return "";
}

/**
 * 状态的形状提示 —— 挂件用一个小圆点，不占字。
 *   running → ●   error → !   done → ✓（done 在挂件里可以省，避免噪音）
 */
export function statusMark(status: ToolUse["status"]): string {
  switch (status) {
    case "running":
    case "pending":
      return "●";
    case "error":
      return "!";
    default:
      return "✓";
  }
}
