import { describe, it, expect } from "vitest";
import { computeContextWarning, dismiss, type ContextWarningState } from "./contextWarning";

const idle: ContextWarningState = { status: "idle" };
const showing: ContextWarningState = { status: "showing" };
const dismissed: ContextWarningState = { status: "dismissed" };

describe("computeContextWarning — 触发", () => {
  it("idle 且已用 >= 阈值 → 触发显示，进入 showing", () => {
    expect(computeContextWarning({ usedPct: 90, threshold: 90, enabled: true, state: idle }))
      .toEqual({ show: true, nextState: showing });
  });
  it("idle 且已用 > 阈值 → 触发显示", () => {
    expect(computeContextWarning({ usedPct: 95, threshold: 90, enabled: true, state: idle }))
      .toEqual({ show: true, nextState: showing });
  });
  it("idle 且已用 < 阈值 → 不显示，保持 idle", () => {
    expect(computeContextWarning({ usedPct: 89, threshold: 90, enabled: true, state: idle }))
      .toEqual({ show: false, nextState: idle });
  });
});

describe("computeContextWarning — 保持与不重复", () => {
  it("showing 且仍 >= 阈值 → 保持显示，不重复触发", () => {
    expect(computeContextWarning({ usedPct: 92, threshold: 90, enabled: true, state: showing }))
      .toEqual({ show: true, nextState: showing });
  });
  it("showing 且回落 < 阈值 → 隐藏并回到 idle", () => {
    expect(computeContextWarning({ usedPct: 80, threshold: 90, enabled: true, state: showing }))
      .toEqual({ show: false, nextState: idle });
  });
});

describe("computeContextWarning — 关闭后不再提醒", () => {
  it("dismissed 且仍 >= 阈值 → 不显示，保持 dismissed", () => {
    expect(computeContextWarning({ usedPct: 95, threshold: 90, enabled: true, state: dismissed }))
      .toEqual({ show: false, nextState: dismissed });
  });
  it("dismissed 且回落 < 阈值 → 重置为 idle", () => {
    expect(computeContextWarning({ usedPct: 50, threshold: 90, enabled: true, state: dismissed }))
      .toEqual({ show: false, nextState: idle });
  });
  it("回落重置后再跨过阈值 → 再次触发", () => {
    expect(computeContextWarning({ usedPct: 95, threshold: 90, enabled: true, state: idle }))
      .toEqual({ show: true, nextState: showing });
  });
});

describe("computeContextWarning — 开关关闭", () => {
  it("enabled=false 且已用超阈值 → 永不显示，回到 idle", () => {
    expect(computeContextWarning({ usedPct: 95, threshold: 90, enabled: false, state: idle }))
      .toEqual({ show: false, nextState: idle });
  });
  it("enabled=false 且当前 showing → 立即隐藏，回到 idle", () => {
    expect(computeContextWarning({ usedPct: 95, threshold: 90, enabled: false, state: showing }))
      .toEqual({ show: false, nextState: idle });
  });
  it("enabled=false 且当前 dismissed → 保持不显示", () => {
    expect(computeContextWarning({ usedPct: 95, threshold: 90, enabled: false, state: dismissed }))
      .toEqual({ show: false, nextState: idle });
  });
});

describe("dismiss", () => {
  it("showing 关闭 → dismissed", () => {
    expect(dismiss(showing)).toEqual(dismissed);
  });
  it("idle 关闭 → dismissed（幂等，任何状态都能关）", () => {
    expect(dismiss(idle)).toEqual(dismissed);
  });
});
