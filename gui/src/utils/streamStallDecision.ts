/**
 * 流静默决策期状态机。
 *
 * 模型流可能"静默停流"——TCP 连接没断、但不再吐 SSE 事件，前端 `streaming`
 * 标志只在收到 result/status:ready/error/disconnect 时才复位（chatReduce.ts），
 * 无任何超时自动清。本状态机把"确定性硬杀"升级为可裁量的软中断：
 * 流静默超过 ENTER_DECISION_SECS 进入决策期（弹「是否中断？」），用户点
 * 「继续等」则抑制再弹直到流恢复活动，用户无响应超过分级超时才自动中断。
 *
 * ## 决策阶段不做工具豁免（2026-09-10 定案）
 *
 * 此前按工具分级豁免决策条的弹出（Bash/Task 600s、快速工具 60s），但**分级判不准**
 * ——连续工具调用会不断续期，真卡死也一直沉默（实测：状态栏「已 165s 无响应」
 * 而决策条不弹）。现改为**一刀切**：静默 30s 一律弹条，把选择权交给用户
 * （发现不对可趁早中断/唤醒）。豁免只剩两类**确定性非卡死**状态，由调用方
 * （ChatInputPanel）在进入本状态机之前拦掉，不在本模块：
 *   ① 等用户回答（权限请求 / AskUserQuestion）
 *   ② 压缩会话中（compacting）/ 子代理在跑（有 task_* 心跳）
 *
 * ## 自动中断按在跑工具分级
 *
 * 决策阶段不豁免，但**自动中断**（用户一直不理）仍按在跑工具给不同宽限：
 * 长命令/子代理不该被过早杀掉（见 autoInterruptGraceMs）。无工具在跑时用
 * AUTO_INTERRUPT_SECS。
 *
 * 纯函数（模仿 contextWarning.ts），不读全局状态、无副作用，便于单测。
 */

export type StreamStallDecisionStatus = "idle" | "showing" | "waiting";

export type StreamStallDecisionState =
  | { status: "idle"; lastSeenActivity: number | null }
  /** showing 也带 waitCount: 从 waiting 重新弹出时保住退避级数, 否则永远停在第一级。
   *  初次弹出(idle→showing)为 0。 */
  | { status: "showing"; waitCount: number }
  /** waiting = 用户已点「继续等」, 接管决定权。
   *  suppressUntil: 抑制到此刻(epoch ms)——到点前不再弹条。
   *  waitCount: 本轮流静默期内点过几次「继续等」(退避倍数, 流恢复后归零)——避免
   *  "点了等 3s 又弹"的反复骚扰(用户实测)。 */
  | { status: "waiting"; lastSeenActivity: number | null; suppressUntil: number; waitCount: number };

/** 流静默多久进入决策期（弹窗）。
 *  与「已 N 秒无响应」提示阈值(chatReduce.computeStreamStall 默认 30s)统一。
 *  **不做工具豁免**——静默 30s 一律弹条，把选择权交给用户（见文件头说明）。 */
export const ENTER_DECISION_SECS = 30;
/** 决策期无响应多久自动中断（无工具在跑时的基准值）。
 *  有工具在跑时用 autoInterruptGraceMs 的分级宽限，见下。 */
export const AUTO_INTERRUPT_SECS = 120;
/** 自动中断的分级宽限（秒），按**在跑工具名**判定：长命令/子代理给更长宽限，
 *  避免真在干活时被过早杀掉；其余工具或无工具用 AUTO_INTERRUPT_SECS。
 *  注意：这只影响"用户一直不理时多久自动中断"，不影响决策条何时弹（恒 30s）。 */
export const AUTO_INTERRUPT_GRACE_BASH_SECS = 300;
export const AUTO_INTERRUPT_GRACE_TASK_SECS = 600;

/**
 * 按在跑工具名算自动中断宽限（毫秒）。空数组 / 全未知工具 → AUTO_INTERRUPT_SECS。
 * 取在跑工具里**最长**的一类。
 */
export function autoInterruptGraceMs(activeToolNames: readonly string[]): number {
  let grace = AUTO_INTERRUPT_SECS;
  for (const raw of activeToolNames) {
    const n = (raw || "").toLowerCase();
    if (n === "task" || n.includes("agent")) {
      grace = Math.max(grace, AUTO_INTERRUPT_GRACE_TASK_SECS);
    } else if (n.includes("bash") || n.includes("powershell")) {
      grace = Math.max(grace, AUTO_INTERRUPT_GRACE_BASH_SECS);
    }
  }
  return grace * 1000;
}
/** 点「继续等」后的抑制时长(秒)——这段时间内不再弹条, 到点仍未恢复才重新询问。
 *  递进退避: 第 N 次点「继续等」抑制 N×该值(上限 WAIT_SUPPRESS_MAX_SECS), 让
 *  反复点"继续等"的用户越来越安静, 而不是每 3s 被弹一次(用户实测痛点)。 */
export const WAIT_SUPPRESS_SECS = 30;
/** 抑制时长的退避上限(秒)——继续等下去时最多安静 5 分钟。 */
export const WAIT_SUPPRESS_MAX_SECS = 300;
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
  /** 在跑工具名（tool_use 已开始、tool_result 未回）——**只用于自动中断分级宽限**，
   *  不参与决策条弹出判定（决策恒 30s，见文件头说明）。 */
  activeToolNames?: readonly string[];
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
  // 无工具豁免——静默达阈值一律弹条，把选择权尽早交给用户。
  const tripped = silentSecs >= ENTER_DECISION_SECS;
  const recovering = silentSecs < ENTER_DECISION_SECS;
  // 自动中断宽限按在跑工具分级（只影响"用户一直不理"的兜底动作，不影响弹条时机）。
  const graceSecs = autoInterruptGraceMs(i.activeToolNames ?? []) / 1000;

  switch (i.state.status) {
    case "idle": {
      if (!i.streaming)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      if (tripped)
        return { show: true, autoInterrupt: false, nextState: { status: "showing", waitCount: 0 } };
      return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
    }
    case "showing": {
      if (!i.streaming)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      // 弹条后用户一直不理 → 按在跑工具分级宽限自动中断。有工具在跑（可能是正常
      // 长命令/子代理）给更长宽限, 无工具用 AUTO_INTERRUPT_SECS。
      if (silentSecs >= graceSecs)
        return { show: false, autoInterrupt: true, nextState: IDLE(i.lastStreamEventAt) };
      if (recovering)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      return { show: true, autoInterrupt: false, nextState: { status: "showing", waitCount: i.state.waitCount } };
    }
    case "waiting": {
      if (!i.streaming)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      // 流恢复活动(lastStreamEventAt 变) → 抑制解除, 重进 idle(退避计数归零)
      if (i.lastStreamEventAt !== i.state.lastSeenActivity)
        return { show: false, autoInterrupt: false, nextState: IDLE(i.lastStreamEventAt) };
      const keep: StreamStallDecisionState = {
        status: "waiting",
        lastSeenActivity: i.state.lastSeenActivity,
        suppressUntil: i.state.suppressUntil,
        waitCount: i.state.waitCount,
      };
      // 用户已接管（点了「继续等」）→ 抑制期内绝不弹、绝不自动中断(尊重接管)。
      // 抑制期到点仍未恢复 → 重新弹条让用户再决策(不 autoInterrupt)。
      // 修复: 此前抑制期一过就每 3s 弹一次("点了继续等 3s 后又弹", 用户实测反复);
      // 现在抑制到点才弹, 且用户每多点一次「继续等」退避时长递增(上限 5min)。
      if (i.now < i.state.suppressUntil)
        return { show: false, autoInterrupt: false, nextState: keep };
      return { show: true, autoInterrupt: false, nextState: { status: "showing", waitCount: i.state.waitCount } };
    }
  }
}

/** 用户点「继续等」：接管决定权。
 *  抑制时长递进退避——本轮流静默期内第 N 次点, 安静 N×WAIT_SUPPRESS_SECS
 *  (上限 WAIT_SUPPRESS_MAX_SECS), 避免每 3s 被反复弹条。流恢复后计数归零。 */
export function enterWaiting(state: StreamStallDecisionInput): StreamStallDecisionState {
  // waiting 与 showing 都带 waitCount——从任一状态点「继续等」都延续退避级数
  // (否则 waiting→showing 一轮后退避被打回第一级, 又变成每 30s 弹)。
  const prev = state.state.status === "idle" ? 0 : state.state.waitCount;
  const waitCount = prev + 1;
  const suppressSecs = Math.min(waitCount * WAIT_SUPPRESS_SECS, WAIT_SUPPRESS_MAX_SECS);
  return {
    status: "waiting",
    lastSeenActivity: state.lastStreamEventAt,
    suppressUntil: state.now + suppressSecs * 1000,
    waitCount,
  };
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
