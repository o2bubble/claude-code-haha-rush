/** 上下文告警开关默认值（开） */
export const DEFAULT_CONTEXT_WARNING_ENABLED = true;
/** 上下文告警阈值默认值（已用 90%，即剩余 10%） */
export const DEFAULT_CONTEXT_WARNING_PERCENT = 90;

export type ContextWarningStatus = "idle" | "showing" | "dismissed";

export interface ContextWarningState {
  status: ContextWarningStatus;
}

export interface ComputeContextWarningInput {
  /** 上下文已用百分比 (0-100) */
  usedPct: number;
  /** 告警阈值百分比 */
  threshold: number;
  /** 告警功能开关 */
  enabled: boolean;
  state: ContextWarningState;
}

export interface ComputeContextWarningResult {
  show: boolean;
  nextState: ContextWarningState;
}

/**
 * 上下文告警状态机：决定当前是否应显示告警浮动层。
 * - 回落（usedPct < threshold）任何状态回到 idle，压缩/新会话后自然重置。
 * - idle 跨过阈值触发 showing；showing 保持不重复触发；dismissed 不再提醒。
 * - enabled=false 永不显示。
 */
export function computeContextWarning({
  usedPct,
  threshold,
  enabled,
  state,
}: ComputeContextWarningInput): ComputeContextWarningResult {
  if (!enabled) return { show: false, nextState: { status: "idle" } };
  if (usedPct < threshold) return { show: false, nextState: { status: "idle" } };

  switch (state.status) {
    case "idle":
      return { show: true, nextState: { status: "showing" } };
    case "showing":
      return { show: true, nextState: { status: "showing" } };
    case "dismissed":
      return { show: false, nextState: { status: "dismissed" } };
  }
}

/** 用户手动关闭告警 → dismissed（本次会话不再提醒，直到回落重置）。 */
export function dismiss(_state: ContextWarningState): ContextWarningState {
  return { status: "dismissed" };
}
