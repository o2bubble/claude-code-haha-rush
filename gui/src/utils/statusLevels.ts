// ── 状态级别共享展示映射 — StatusBar / ToastContainer 共用 ──

import type { StatusMessage } from "../stores/statusMsgStore";

/** level → 文字/图标颜色（CSS 变量，自动适配明暗主题） */
export const STATUS_LEVEL_COLOR: Record<StatusMessage["level"], string> = {
  info: "var(--fg-muted)",
  warn: "var(--semantic-warning)",
  error: "var(--semantic-error)",
  success: "var(--semantic-success)",
};
