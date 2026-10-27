// ── 挂件标题栏文字：「工作区 · 会话名」──
//
// 为什么需要（用户 2026-10-27）：「挂件模式下最好也能展示当前的工作区和会话名，
// 方便知道是哪个的。」多开实例时挂件长得一模一样，光看消息内容分不清。
//
// 与主窗标题（services/windowTitle.ts）的区别：**截断长度不同**。
// 主窗标题给 50 字符，挂件只有 360px 宽、11px 字 —— 50 个字符会把工作区名挤没，
// 反而失去辨识作用。这里按挂件实际宽度给更短的上限。
// （路径解析复用 utils/workspace 的 workspaceBasename —— 两处边界语义必须一致。）

import { workspaceBasename } from "../../utils/workspace";

/** 会话名在挂件里保留的字符数。超出的部分用省略号，完整内容走 title 悬停。 */
export const WIDGET_SESSION_MAX_CHARS = 18;

/** 工作区名在挂件里保留的字符数（含中间省略的处理见下）。 */
export const WIDGET_WORKSPACE_MAX_CHARS = 16;

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/** 取路径最后一段。**复用主窗的实现**：两处对「C:\foo\」「/」这类边界的处理
 *  必须一致，否则同一个工作区在主窗和挂件里会显示成不同的名字。 */
export function widgetWorkspaceName(path: string | undefined | null): string {
  return workspaceBasename(path ?? "");
}

/**
 * 组装挂件标题栏文字。
 *
 * - 工作区 + 会话 → `工作区 · 会话名`
 * - 只有工作区   → `工作区`
 * - 只有会话     → `会话名`（工作区未绑定的极早期）
 * - 都没有       → `fallback`
 */
export function formatWidgetTitle(
  workspacePath: string | undefined | null,
  sessionTitle: string | undefined | null,
  fallback: string,
): string {
  const ws = truncate(widgetWorkspaceName(workspacePath), WIDGET_WORKSPACE_MAX_CHARS);
  const session = truncate(sessionTitle ?? "", WIDGET_SESSION_MAX_CHARS);
  if (ws && session) return `${ws} · ${session}`;
  if (ws) return ws;
  if (session) return session;
  return fallback;
}
