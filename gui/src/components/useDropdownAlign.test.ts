import { describe, it, expect } from "vitest";
import { pickDropdownAlign, dropdownMaxWidth, EDGE_MARGIN } from "./useDropdownAlign";

describe("pickDropdownAlign — 展开方向", () => {
  it("按钮在左侧、空间充足 → 向右展开（贴左缘）", () => {
    expect(pickDropdownAlign(100, 130, 220, 1200)).toEqual({ left: 0 });
  });

  it("按钮靠右、右边放不下但左边放得下 → 翻左", () => {
    // left=900, w=220 → 900+220+8=1128 > 1000；右边不够
    // right=930 → 930-220=710 >= 8；左边够
    expect(pickDropdownAlign(900, 930, 220, 1000)).toEqual({ right: 0 });
  });

  it("按钮在最右端 → 翻左", () => {
    expect(pickDropdownAlign(1150, 1180, 220, 1200)).toEqual({ right: 0 });
  });

  it("宽弹层两边都放不下 → 保持向右（翻也没用，靠 maxWidth 收缩）", () => {
    // 截图实测场景：520px 弹层、按钮 left=450、视口 800
    // 右：450+520+8=978 > 800 ✗  左：480-520=-40 < 8 ✗
    expect(pickDropdownAlign(450, 480, 520, 800)).toEqual({ left: 0 });
  });

  it("刚好卡在边界 → 判定为放得下（不多翻一次）", () => {
    // 272+520+8 = 800 = 视口宽
    expect(pickDropdownAlign(272, 300, 520, 800)).toEqual({ left: 0 });
  });

  it("超出边界 1px、且左边也放不下 → 仍保持向右", () => {
    // 273+520+8=801 > 800 ✗；301-520=-219 < 8 ✗
    expect(pickDropdownAlign(273, 301, 520, 800)).toEqual({ left: 0 });
  });

  it("超出边界 1px、但左边放得下 → 翻左", () => {
    // 弹层 200：273+200+8=481 <= 800 其实放得下…
    // 构造真正超出右边的：left=620,w=200 → 828 > 800 ✗；right=650-200=450 >= 8 ✓
    expect(pickDropdownAlign(620, 650, 200, 800)).toEqual({ right: 0 });
  });

  it("自定义留白生效", () => {
    // left=772,w=20,edge=8 → 800 <= 800 放得下
    expect(pickDropdownAlign(772, 800, 20, 800)).toEqual({ left: 0 });
    // edge=20 → 812 > 800，右边不够；右边 right=800-20=780 >= 20 → 翻左
    expect(pickDropdownAlign(772, 800, 20, 800, 20)).toEqual({ right: 0 });
  });
});

describe("dropdownMaxWidth — 限宽兜底", () => {
  it("视口足够宽 → 用估算宽度", () => {
    expect(dropdownMaxWidth(520, 1200)).toBe(520);
  });

  it("视口比估算宽度还窄 → 收缩到视口内（留两侧留白）", () => {
    expect(dropdownMaxWidth(520, 400)).toBe(400 - EDGE_MARGIN * 2);
  });

  it("恰好等于视口宽 - 留白 → 不变", () => {
    const w = 400 - EDGE_MARGIN * 2;
    expect(dropdownMaxWidth(w, 400)).toBe(w);
  });

  it("极窄视口（小于两侧留白）→ 负数，调用方靠 CSS maxWidth 下限兜底", () => {
    // 不常见，但边界要明确：返回值可能 <= 0
    expect(dropdownMaxWidth(520, 10)).toBeLessThanOrEqual(0);
  });
});
