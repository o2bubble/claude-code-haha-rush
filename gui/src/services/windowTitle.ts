// ── 主窗口标题：跟随「当前工作区 + 当前会话」──
//
// 为什么需要（2026-09-21 用户反馈）：多开几个 GUI 实例后，任务栏上全是
// 「Claude Code Desktop (Preview)」，**完全分不清哪个是哪个**。用户要求把
// 「绑定的工作区 + 加载的会话名」显示到窗口标题上。
//
// 顺序讲究：Windows 任务栏空间有限、**从尾部截断**，所以把最关键的
// **工作区名放最前**（它才是区分实例的第一要素），会话名在后。

import { workspaceBasename } from "../utils/workspace";

/**
 * 应用默认窗口标题 —— **必须与 Rust 建窗时的字面量一致**
 * （`lib.rs` 主窗口 `.title("Claude Code Desktop (Preview)")`）。
 * 两边不一致的话，未绑定工作区时标题会在"启动时的名字"和"前端设的名字"之间跳。
 */
export const DEFAULT_WINDOW_TITLE = "Claude Code Desktop (Preview)";

/** 会话名的长度上限 —— 太长会把工作区名挤出去；任务栏本来也只显示开头部分。 */
const MAX_SESSION_CHARS = 50;

/** 标题里工作区/会话谁在前。用户可在 设置 → 通用 里切换（见 settingsStore）。 */
export type WindowTitleOrder = "workspace-first" | "session-first";

/**
 * 组装窗口标题（纯函数，便于测试）。
 *
 * - 工作区 + 会话 → 按 `order` 决定谁在前（缺省工作区在前）
 * - 只有工作区   → `工作区`
 * - 都没有       → `fallback`（应用默认名）
 *
 * 缺省 "workspace-first"：任务栏空间不够时**从尾部截断**，工作区才是区分多实例的
 * 第一要素。但有人更常靠会话名认窗口 —— 故做成可选（用户反馈）。
 */
export function formatWindowTitle(
  workspacePath: string | undefined,
  sessionTitle: string | undefined,
  fallback: string,
  order: WindowTitleOrder = "workspace-first",
): string {
  const ws = workspacePath ? workspaceBasename(workspacePath) : "";
  const raw = (sessionTitle ?? "").trim();
  const session = raw.length > MAX_SESSION_CHARS ? raw.slice(0, MAX_SESSION_CHARS) + "…" : raw;

  if (ws && session) {
    return order === "session-first" ? `${session} · ${ws}` : `${ws} · ${session}`;
  }
  if (ws) return ws;
  if (session) return `${fallback} · ${session}`;
  return fallback;
}

/** 上一次真正设过的标题 —— setTitle 是 IPC，别在状态抖动时反复发。 */
let lastApplied: string | null = null;

/**
 * 把标题应用到主窗口。幂等：标题没变就不发 IPC。
 *
 * 失败静默（权限缺失/非 Tauri 环境）—— 标题只是锦上添花，绝不能因此报错打断应用。
 */
export async function syncWindowTitle(
  workspacePath: string | undefined,
  sessionTitle: string | undefined,
  fallback: string,
  order: WindowTitleOrder = "workspace-first",
): Promise<void> {
  const next = formatWindowTitle(workspacePath, sessionTitle, fallback, order);
  if (next === lastApplied) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // ⚠️ getCurrentWindow() 返回**当前**窗口 —— 本模块只在主窗口挂载处调用
    // （浮窗 FloatingApp 不调），否则会把浮窗标题也改掉。
    await getCurrentWindow().setTitle(next);
    lastApplied = next;
  } catch {
    // 非 Tauri 环境（浏览器开发）或权限未开 —— 忽略
  }
}

/** 仅测试用：重置去重状态。 */
export function __resetWindowTitleCache(): void {
  lastApplied = null;
}
