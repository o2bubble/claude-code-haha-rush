// ── 分隔条拖动数学测试 ──
// 回归锁: 隐藏一侧子节点后, 另一侧分隔条必须仍可拖动。
// 曾因 childRefs.current.filter(Boolean) 压缩数组(索引前移) + 顺序游标回写,
// 导致 px[dividerIndex+1] 取到 undefined → NaN → flex 无效 → 完全拖不动(用户实测)。

import { describe, it, expect } from "vitest";
import { applyDividerDelta, sizesFromDomPx } from "./LayoutRenderer";

describe("applyDividerDelta — 拖动中", () => {
  it("全部可见: 相邻两面板此消彼长, 归一化到 100%", () => {
    const out = applyDividerDelta([200, 800], 0, 100, [true, true])!;
    expect(out).toEqual([30, 70]); // (200+100)/1000, (800-100)/1000
  });

  it("首个子节点隐藏(idx0): 索引仍与 children 对齐, 拖动可用(核心回归)", () => {
    // children = [隐藏, A, B], dividerIndex=1(A|B 之间)
    // 修复前: filter(Boolean) 压缩 → px[2]=undefined → NaN → 完全拖不动
    const out = applyDividerDelta([0, 300, 700], 1, 50, [false, true, true])!;
    expect(out).toEqual([0, 35, 65]); // (300+50)/1000, (700-50)/1000
  });

  it("归一化只算可见元素(隐藏节点不稀释比例)", () => {
    // 隐藏的 0 若被计入 total, 可见两panel 之和会 <100 → 容器留白
    const out = applyDividerDelta([0, 500, 500], 1, 0, [false, true, true])!;
    expect(out[1] + out[2]).toBeCloseTo(100, 5);
  });

  it("相邻面板隐藏 → 返回 null(不可拖动, 不把空间分给隐藏节点)", () => {
    expect(applyDividerDelta([500, 0, 500], 0, 50, [true, false, true])).toBeNull();
    expect(applyDividerDelta([500, 500, 0], 1, 50, [true, true, false])).toBeNull();
  });

  it("保留 80px 最小宽度(拖到极端不塌缩)", () => {
    const out = applyDividerDelta([200, 200], 0, -10_000, [true, true])!;
    expect(out[0]).toBeGreaterThan(0); // 未被拖成 0 或负数
    expect(out[0] + out[1]).toBeCloseTo(100, 5);
  });
});

describe("sizesFromDomPx — 松手回写", () => {
  it("索引与 children 对齐: 隐藏位写 0, 可见位按实测比例", () => {
    const out = sizesFromDomPx([0, 250, 750], [false, true, true], [20, 20, 60])!;
    expect(out).toEqual([0, 25, 75]);
  });

  it("回归: 不用顺序游标——隐藏节点不占位时不会把可见尺寸写错位", () => {
    // 旧实现 finalPx[vi++] 会把 25 写给 idx0(隐藏), 75 写给 idx1 → 完全错位
    const out = sizesFromDomPx([0, 250, 750], [false, true, true], [20, 20, 60])!;
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(25);
    expect(out[2]).toBe(75);
  });

  it("全隐藏/总量 0 → null(不写入无意义尺寸)", () => {
    expect(sizesFromDomPx([0, 0], [false, false], [50, 50])).toBeNull();
  });

  it("恢复可见后尺寸总和仍为 100(隐藏期间拖动的结果可继续编辑)", () => {
    const out = sizesFromDomPx([300, 700], [true, true], [0, 30, 70])!;
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
  });
});
