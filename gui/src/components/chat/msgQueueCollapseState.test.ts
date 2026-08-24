// ── 消息队列收起/展开状态机测试 ──
import { describe, it, expect } from "vitest";
import { createCollapseState, onCountChange, onClickStub, onCollapse, onExpand } from "./msgQueueCollapseState";

describe("createCollapseState", () => {
  it("空队列 → stub(小占位条)", () => {
    expect(createCollapseState(0)).toEqual({ display: "stub", userCollapsed: false, lastCount: 0 });
  });
  it("非空 → expanded", () => {
    expect(createCollapseState(3).display).toBe("expanded");
  });
});

describe("onCountChange — 内容驱动", () => {
  it("stub(空) → 新入队 → expanded", () => {
    const s = onCountChange(createCollapseState(0), 1);
    expect(s.display).toBe("expanded");
    expect(s.lastCount).toBe(1);
  });
  it("非空 → 排空 → stub", () => {
    expect(onCountChange(createCollapseState(3), 0).display).toBe("stub");
  });
  it("非空 → 消化掉一条 → 保持 expanded", () => {
    expect(onCountChange(createCollapseState(3), 2).display).toBe("expanded");
  });
});

describe("onClickStub — 占位条点击", () => {
  it("stub → expanded(看完整空态)", () => {
    const s = onClickStub(createCollapseState(0));
    expect(s.display).toBe("expanded");
    expect(s.userCollapsed).toBe(false);
  });
  it("slim/expanded 点占位逻辑 → 无操作", () => {
    const slim = onCollapse(createCollapseState(3));
    expect(onClickStub(slim)).toBe(slim); // 同引用, 无变更
    const expanded = createCollapseState(3);
    expect(onClickStub(expanded)).toBe(expanded);
  });
});

describe("onCollapse / onExpand — 手动", () => {
  it("expanded(非空) → 收起 → slim + userCollapsed", () => {
    const s = onCollapse(createCollapseState(3));
    expect(s).toEqual({ display: "slim", userCollapsed: true, lastCount: 3 });
  });
  it("expanded(空) → 收起 → stub", () => {
    const s = onClickStub(createCollapseState(0)); // 先展开空态
    expect(onCollapse(s).display).toBe("stub");
  });
  it("slim 再点收起 → 无操作", () => {
    const slim = onCollapse(createCollapseState(3));
    expect(onCollapse(slim)).toBe(slim);
  });
  it("stub 点收起 → 无操作", () => {
    expect(onCollapse(createCollapseState(0))).toEqual(createCollapseState(0));
  });
  it("slim → 展开 → expanded + 重置 userCollapsed", () => {
    const slim = onCollapse(createCollapseState(3));
    expect(onExpand(slim)).toEqual({ display: "expanded", userCollapsed: false, lastCount: 3 });
  });
  it("expanded 点展开 → 无操作", () => {
    expect(onExpand(createCollapseState(3))).toEqual(createCollapseState(3));
  });
});

describe("手动收起与内容驱动的交互", () => {
  it("收起后消化掉一条 → 保持 slim（不重新展开）", () => {
    const slim = onCollapse(createCollapseState(3));
    expect(onCountChange(slim, 2).display).toBe("slim");
  });
  it("收起后新入队一条 → 重新 expanded + 重置 userCollapsed", () => {
    const slim = onCollapse(createCollapseState(3));
    const s = onCountChange(slim, 4);
    expect(s.display).toBe("expanded");
    expect(s.userCollapsed).toBe(false);
    expect(s.lastCount).toBe(4);
  });
  it("收起 → 排空 → stub → 再新入队 → expanded", () => {
    const slim = onCollapse(createCollapseState(3));
    const empty = onCountChange(slim, 0);
    expect(empty.display).toBe("stub");
    expect(onCountChange(empty, 1).display).toBe("expanded");
  });
});
