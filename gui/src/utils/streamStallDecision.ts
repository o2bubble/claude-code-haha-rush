/**
 * 流静默决策期状态机。
 *
 * 模型流可能"静默停流"——TCP 连接没断、但不再吐 SSE 事件，前端 `streaming`
 * 标志只在收到 result/status:ready/error/disconnect 时才复位（chatReduce.ts），
 * 无任何超时自动清。本状态机把"确定性硬杀"升级为可裁量的软中断：
 * 流静默超过 ENTER_DECISION_SECS 进入决策期（弹「是否中断？」），用户点
 * 「继续等」则抑制再弹直到流恢复活动，用户无响应超过 AUTO_INTERRUPT_SECS
 * 才自动中断。
 *
 * 纯函数（模仿 contextWarning.ts），不读全局状态、无副作用，便于单测。
 */

export type StreamStallDecisionStatus = "idle" | "showing" | "waiting";

export type StreamStallDecisionState =
  | { status: "idle"; lastSeenActivity: number | null }
  | { status: "showing" }
  | { status: "waiting"; lastSeenActivity: number | null };

/** 流静默多久进入决策期（弹窗） */
export const ENTER_DECISION_SECS = 60;
/** 决策期无响应多久自动中断（= 弹窗后仍无用户输入再等 60s） */
export const AUTO_INTERRUPT_SECS = 120;
/** 流卡死中断后发给 AI 的唤醒(接力)提示词默认值：请求它检查会话、继续未完成的内容 */
export const DEFAULT_STALL_WAKE_PROMPT =
  "消息流因未知原因卡死导致中断。请检查当前会话消息，如因本次中断导致还有未完成的内容，请继续。";
/** 自动唤醒冷却：一次自动唤醒后，此时间内再次卡死只纯中断，不再自动唤醒(防死循环) */
export const WAKE_COOLDOWN_MS = 5 * 60 * 1000;

export interface StreamStallDecisionInput {
  streaming: boolean;
  lastStreamEventAt: number | null;
  now: number;
  state: StreamStallDecisionState;
}

export interface StreamStallDecisionOutput {
  /** 是否显示「是否中断？」决策条 */
  show: boolean;
  /** 决策期无响应超时 → 调用方应立即 interrupt() 中断当前流 */
  autoInterrupt: boolean;
  nextState: StreamStallDecisionState;
}

const IDLE = (activity: number | null): StreamStallDecisionState => ({
  status: "idle",
  lastSeenActivity: activity,
});

export function computeStreamStallDecision(
  i: StreamStallDecisionInput,
): StreamStallDecisionOutput {
  const silentSecs =
    i.streaming && i.lastStreamEventAt != null
      ? (i.now - i.lastStreamEventAt) / 1000
      : 0;

  switch (i.state.status) {
    case "idle": {
      if (!i.streaming)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      if (silentSecs >= ENTER_DECISION_SECS)
        return { show: true, autoInterrupt: false, nextState: { status: "showing" } };
      return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
    }
    case "showing": {
      if (!i.streaming)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      if (silentSecs >= AUTO_INTERRUPT_SECS)
        return { show: false, autoInterrupt: true, nextState: IDLE(i.lastStreamEventAt) };
      if (silentSecs < ENTER_DECISION_SECS)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      return { show: true, autoInterrupt: false, nextState: { status: "showing" } };
    }
    case "waiting": {
      if (!i.streaming)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      if (i.lastStreamEventAt !== i.state.lastSeenActivity)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      // 用户已接管（点了「继续等」），流未恢复前保持抑制，不自动中断
      return {
        show: false,
        autoInterrupt: false,
        nextState: { status: "waiting", lastSeenActivity: i.state.lastSeenActivity },
      };
    }
  }
}

/** 用户点「继续等」：接管决定权，直到流恢复活动才重新武装 */
export function enterWaiting(state: StreamStallDecisionInput): StreamStallDecisionState {
  return { status: "waiting", lastSeenActivity: state.lastStreamEventAt };
}

/** 用户点「中断」：立即中断并把状态机复位 */
export function resetToIdle(): StreamStallDecisionState {
  return { status: "idle", lastSeenActivity: null };
}

/**
 * 判断自动中断时是否该"唤醒"（中断 + 发醒词让 AI 接力）。
 * 冷却防死循环：一次自动唤醒后，cooldownMs 内再次卡死只纯中断，不重复唤醒。
 * null（从未自动唤醒过）→ 允许唤醒。
 */
export function shouldAutoWake(
  lastAutoWakeAt: number | null,
  now: number,
  cooldownMs: number = WAKE_COOLDOWN_MS,
): boolean {
  return lastAutoWakeAt === null || now - lastAutoWakeAt > cooldownMs;
}
