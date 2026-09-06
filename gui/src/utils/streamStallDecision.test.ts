import { describe, it, expect } from "vitest";
import {
  computeStreamStallDecision, enterWaiting, resetToIdle, shouldAutoWake,
  ENTER_DECISION_SECS, AUTO_INTERRUPT_SECS, WAKE_COOLDOWN_MS,
  type StreamStallDecisionState,
} from "./streamStallDecision";

const T = 1_000_000; // 任意基准时间戳
const idle = (activity: number | null = T): StreamStallDecisionState => ({
  status: "idle",
  lastSeenActivity: activity,
});
const showing: StreamStallDecisionState = { status: "showing" };
const waiting = (activity: number | null = T): StreamStallDecisionState => ({
  status: "waiting",
  lastSeenActivity: activity,
});

function run(
  streaming: boolean,
  lastStreamEventAt: number | null,
  now: number,
  state: StreamStallDecisionState,
) {
  return computeStreamStallDecision({ streaming, lastStreamEventAt, now, state });
}

describe("computeStreamStallDecision — idle", () => {
  it("streaming=false → 保持 idle，不显示", () => {
    expect(run(false, T, T, idle())).toEqual({
      show: false, autoInterrupt: false, nextState: idle(T),
    });
  });
  it("流活动正常(静默 <60s) → 保持 idle，不显示", () => {
    expect(run(true, T, T + 30_000, idle())).toEqual({
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
  it("流一直静默且未恢复 → 保持 waiting 抑制，不自动中断", () => {
    const state = waiting(T);
    expect(run(true, T, T + 300_000, state)).toEqual({
      show: false, autoInterrupt: false,
      nextState: { status: "waiting", lastSeenActivity: T },
    });
  });
  it("流恢复活动(lastStreamEventAt 变) → 解除抑制回 idle", () => {
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

describe("enterWaiting / resetToIdle", () => {
  it("点继续等 → 记录当前活动，进入 waiting", () => {
    expect(enterWaiting({ streaming: true, lastStreamEventAt: 42, now: T, state: showing }))
      .toEqual({ status: "waiting", lastSeenActivity: 42 });
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
