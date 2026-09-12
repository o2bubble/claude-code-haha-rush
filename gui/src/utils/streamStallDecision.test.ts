import { describe, it, expect } from "vitest";
import {
  computeStreamStallDecision, enterWaiting, resetToIdle, shouldAutoWake,
  ENTER_DECISION_SECS, AUTO_INTERRUPT_SECS, WAKE_COOLDOWN_MS,
  AUTO_INTERRUPT_GRACE_BASH_SECS, AUTO_INTERRUPT_GRACE_TASK_SECS, autoInterruptGraceMs,
  WAIT_SUPPRESS_SECS, WAIT_SUPPRESS_MAX_SECS,
  type StreamStallDecisionState,
} from "./streamStallDecision";

const T = 1_000_000; // 任意基准时间戳
const idle = (activity: number | null = T): StreamStallDecisionState => ({
  status: "idle",
  lastSeenActivity: activity,
});
const showing: StreamStallDecisionState = { status: "showing", waitCount: 0 };
/** 用户点过 n 次「继续等」后处于抑制期(抑制到 suppressUntil) */
const waiting = (activity: number | null = T, waitCount = 1, suppressUntil = 0): StreamStallDecisionState => ({
  status: "waiting",
  lastSeenActivity: activity,
  suppressUntil,
  waitCount,
});

function run(
  streaming: boolean,
  lastStreamEventAt: number | null,
  now: number,
  state: StreamStallDecisionState,
  activeToolNames: readonly string[] = [],
) {
  return computeStreamStallDecision({ streaming, lastStreamEventAt, now, state, activeToolNames });
}

describe("computeStreamStallDecision — idle", () => {
  it("streaming=false → 保持 idle，不显示", () => {
    expect(run(false, T, T, idle())).toEqual({
      show: false, autoInterrupt: false, nextState: idle(T),
    });
  });
  it("流活动正常(静默 <30s 阈值) → 保持 idle，不显示", () => {
    expect(run(true, T, T + 29_000, idle())).toEqual({
      show: false, autoInterrupt: false, nextState: idle(T),
    });
  });
  it("静默达阈值 → 进入 showing，显示", () => {
    expect(run(true, T, T + ENTER_DECISION_SECS * 1000, idle())).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
  });
});

describe("computeStreamStallDecision — showing", () => {
  it("静默未达自动中断 → 保持 showing，仍显示", () => {
    expect(run(true, T, T + 90_000, showing)).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
  });
  it("静默达自动中断阈值 → autoInterrupt + 回 idle（去重）", () => {
    expect(run(true, T, T + AUTO_INTERRUPT_SECS * 1000, showing)).toEqual({
      show: false, autoInterrupt: true, nextState: idle(T),
    });
  });
  it("流恢复(静默 <60s) → 关闭并回 idle，不误中断", () => {
    expect(run(true, T, T + 10_000, showing)).toEqual({
      show: false, autoInterrupt: false, nextState: idle(T),
    });
  });
  it("streaming=false → 关闭回 idle", () => {
    expect(run(false, T, T + 200_000, showing)).toEqual({
      show: false, autoInterrupt: false, nextState: idle(T),
    });
  });
});

describe("computeStreamStallDecision — waiting(用户点继续等)", () => {
  it("抑制期内 → 不弹条、不自动中断(修复: 曾每 3s 又弹, 用户实测反复)", () => {
    // 用户点「继续等」→ 安静 WAIT_SUPPRESS_SECS; 抑制期内任何 tick 都不得弹回
    const state = waiting(T, 1, T + WAIT_SUPPRESS_SECS * 1000);
    for (const elapsed of [3_000, 10_000, WAIT_SUPPRESS_SECS * 1000 - 1]) {
      expect(run(true, T, T + elapsed, state), `${elapsed}ms`).toEqual({
        show: false, autoInterrupt: false, nextState: state,
      });
    }
  });
  it("抑制期到点仍未恢复 → 重新弹条(不 autoInterrupt, 尊重接管)", () => {
    const state = waiting(T, 1, T + WAIT_SUPPRESS_SECS * 1000);
    expect(run(true, T, T + WAIT_SUPPRESS_SECS * 1000, state)).toEqual({
      show: true, autoInterrupt: false, nextState: { status: "showing", waitCount: 1 },
    });
  });
  it("流恢复活动(lastStreamEventAt 变) → 解除抑制回 idle(退避归零)", () => {
    expect(run(true, T + 5_000, T + 300_000, waiting(T))).toEqual({
      show: false, autoInterrupt: false, nextState: idle(T + 5_000),
    });
  });
  it("streaming=false → 回 idle", () => {
    expect(run(false, T, T + 300_000, waiting(T))).toEqual({
      show: false, autoInterrupt: false, nextState: idle(T),
    });
  });
});

describe("computeStreamStallDecision — 决策阶段不豁免(2026-09-10 一刀切)", () => {
  // 语义变更: 此前按工具分级豁免决策条弹出（Bash 600s / 快速工具 60s），但分级
  // 判断屡屡不准——连续工具调用不断续期，真卡死也一直沉默（实测状态栏"已 165s
  // 无响应"而决策条不弹，用户被迫无限等待）。现改为静默 30s 一律弹条，
  // 把选择权尽早交给用户。工具类型只影响"自动中断"的分级宽限。
  it("有工具在跑 → 不再豁免, 静默达 30s 照常弹条", () => {
    expect(run(true, T, T + ENTER_DECISION_SECS * 1000, idle(), ["Edit"])).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
    expect(run(true, T, T + ENTER_DECISION_SECS * 1000, idle(), ["Bash"])).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
    expect(run(true, T, T + ENTER_DECISION_SECS * 1000, idle(), ["Task"])).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
  });
  it("waiting + 抑制期到点 → 重新弹条让用户再决策(不 autoInterrupt, 尊重接管)", () => {
    expect(run(true, T, T + 300_000, waiting(T, 1, T + 30_000), ["Edit"])).toEqual({
      show: true, autoInterrupt: false, nextState: { status: "showing", waitCount: 1 },
    });
  });
  it("waiting + 抑制期内 → 保持抑制(与工具无关)", () => {
    const state = waiting(T, 1, T + 300_001);
    expect(run(true, T, T + 300_000, state, ["Bash"])).toEqual({
      show: false, autoInterrupt: false, nextState: state,
    });
  });
});

describe("computeStreamStallDecision — 自动中断按在跑工具分级宽限", () => {
  it("无工具在跑 → AUTO_INTERRUPT_SECS 自动中断", () => {
    expect(run(true, T, T + AUTO_INTERRUPT_SECS * 1000, showing)).toEqual({
      show: false, autoInterrupt: true, nextState: idle(T),
    });
    // 未到基准值 → 不中断
    expect(run(true, T, T + AUTO_INTERRUPT_SECS * 1000 - 1000, showing)).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
  });
  it("Bash 在跑 → 宽限到 BASH_SECS(长命令不该被过早杀)", () => {
    expect(run(true, T, T + AUTO_INTERRUPT_SECS * 1000, showing, ["Bash"])).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
    expect(run(true, T, T + AUTO_INTERRUPT_GRACE_BASH_SECS * 1000, showing, ["Bash"])).toEqual({
      show: false, autoInterrupt: true, nextState: idle(T),
    });
  });
  it("Task 在跑 → 宽限到 TASK_SECS(子代理长跑是常态)", () => {
    expect(run(true, T, T + AUTO_INTERRUPT_GRACE_BASH_SECS * 1000, showing, ["Task"])).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
    expect(run(true, T, T + AUTO_INTERRUPT_GRACE_TASK_SECS * 1000, showing, ["Task"])).toEqual({
      show: false, autoInterrupt: true, nextState: idle(T),
    });
  });
  it("混合在跑 → 取最长宽限(Task > Bash > 其他)", () => {
    expect(run(true, T, T + AUTO_INTERRUPT_GRACE_BASH_SECS * 1000, showing, ["Edit", "Task"])).toEqual({
      show: true, autoInterrupt: false, nextState: showing,
    });
  });
});

describe("autoInterruptGraceMs — 分级口径", () => {
  it("空/未知工具 → 基准 AUTO_INTERRUPT_SECS", () => {
    expect(autoInterruptGraceMs([])).toBe(AUTO_INTERRUPT_SECS * 1000);
    expect(autoInterruptGraceMs(["Edit", "Read", "Grep"])).toBe(AUTO_INTERRUPT_SECS * 1000);
  });
  it("Bash / Task / Agent → 各自宽限", () => {
    expect(autoInterruptGraceMs(["Bash"])).toBe(AUTO_INTERRUPT_GRACE_BASH_SECS * 1000);
    expect(autoInterruptGraceMs(["PowerShell"])).toBe(AUTO_INTERRUPT_GRACE_BASH_SECS * 1000);
    expect(autoInterruptGraceMs(["Task"])).toBe(AUTO_INTERRUPT_GRACE_TASK_SECS * 1000);
    expect(autoInterruptGraceMs(["SomeAgent"])).toBe(AUTO_INTERRUPT_GRACE_TASK_SECS * 1000);
  });
});

describe("enterWaiting / resetToIdle", () => {
  it("点继续等 → 记录当前活动 + 抑制到点", () => {
    expect(enterWaiting({ streaming: true, lastStreamEventAt: 42, now: T, state: showing }))
      .toEqual({ status: "waiting", lastSeenActivity: 42, suppressUntil: T + WAIT_SUPPRESS_SECS * 1000, waitCount: 1 });
  });
  it("反复点继续等 → 退避递增(30s, 60s, 90s...)", () => {
    let st = enterWaiting({ streaming: true, lastStreamEventAt: 42, now: T, state: showing });
    expect(st).toMatchObject({ waitCount: 1, suppressUntil: T + 30_000 });
    st = enterWaiting({ streaming: true, lastStreamEventAt: 42, now: T + 30_000, state: st });
    expect(st).toMatchObject({ waitCount: 2, suppressUntil: T + 30_000 + 60_000 });
    st = enterWaiting({ streaming: true, lastStreamEventAt: 42, now: T + 90_000, state: st });
    expect(st).toMatchObject({ waitCount: 3, suppressUntil: T + 90_000 + 90_000 });
  });
  it("退避封顶 5 分钟(不会无限增长)", () => {
    const st = enterWaiting({ streaming: true, lastStreamEventAt: 42, now: T, state: waiting(42, 100, 0) });
    expect(st).toMatchObject({ waitCount: 101, suppressUntil: T + WAIT_SUPPRESS_MAX_SECS * 1000 });
  });
  it("从 showing 再点继续等 → 延续退避级数(waiting→showing 一轮后不归零)", () => {
    const st = enterWaiting({ streaming: true, lastStreamEventAt: 42, now: T, state: { status: "showing", waitCount: 2 } });
    expect(st).toMatchObject({ waitCount: 3 });
  });
  it("点中断 → 复位到 idle", () => {
    expect(resetToIdle()).toEqual({ status: "idle", lastSeenActivity: null });
  });
});

describe("shouldAutoWake — 冷却防死循环", () => {
  it("从未自动唤醒过(null) → 允许唤醒", () => {
    expect(shouldAutoWake(null, T)).toBe(true);
  });
  it("冷却期内 → 禁止(只纯中断)", () => {
    expect(shouldAutoWake(T, T + WAKE_COOLDOWN_MS)).toBe(false);
  });
  it("冷却已过 → 允许唤醒", () => {
    expect(shouldAutoWake(T, T + WAKE_COOLDOWN_MS + 1)).toBe(true);
  });
});
