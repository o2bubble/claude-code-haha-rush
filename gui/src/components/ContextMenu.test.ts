import { describe, it, expect } from "vitest";
import { clampMenuPosition } from "./ContextMenu";

// 用户 2026-10-23 反馈：会话列表很长时，在底部右键 → 菜单向下弹、溢出视口，
// 完全没法交互。根因是主菜单直接把鼠标坐标当 left/top，**没有任何溢出检查**。

const VP = { width: 1920, height: 1080 };
const MENU = { width: 180, height: 260 };
const MARGIN = 4;

describe("clampMenuPosition — 把弹层钳进视口", () => {
  it("空间充足 → 原地不动", () => {
    expect(clampMenuPosition(500, 300, MENU, VP)).toEqual({ x: 500, y: 300 });
  });

  it("底部放不下 → 向上翻（右键菜单常见行为）", () => {
    // 鼠标在 1000，菜单高 260 → 1000+260 > 1076，翻到鼠标上方
    const { y } = clampMenuPosition(500, 1000, MENU, VP);
    expect(y).toBe(1000 - MENU.height);
    expect(y + MENU.height).toBeLessThanOrEqual(VP.height - MARGIN);
  });

  it("翻上去也放不下 → 贴住上边缘（不会被推到负数）", () => {
    const tall = { width: 180, height: 900 };
    const { y } = clampMenuPosition(500, 1000, tall, VP);
    expect(y).toBeGreaterThanOrEqual(MARGIN);
    expect(y + tall.height).toBeLessThanOrEqual(VP.height - MARGIN);
  });

  it("右侧放不下 → 向左翻", () => {
    const { x } = clampMenuPosition(1900, 300, MENU, VP);
    expect(x).toBe(1900 - MENU.width);
    expect(x + MENU.width).toBeLessThanOrEqual(VP.width - MARGIN);
  });

  it("左右都放不下（菜单比视口还宽）→ 贴左边缘", () => {
    const wide = { width: 2000, height: 100 };
    const { x } = clampMenuPosition(1000, 300, wide, VP);
    expect(x).toBe(MARGIN);
  });

  it("右下角同时溢出 → 两个方向都翻", () => {
    const { x, y } = clampMenuPosition(1900, 1050, MENU, VP);
    expect(x + MENU.width).toBeLessThanOrEqual(VP.width - MARGIN);
    expect(y + MENU.height).toBeLessThanOrEqual(VP.height - MARGIN);
  });

  it("鼠标在视口外（负数）→ 拉回边缘内", () => {
    const { x, y } = clampMenuPosition(-50, -20, MENU, VP);
    expect(x).toBeGreaterThanOrEqual(MARGIN);
    expect(y).toBeGreaterThanOrEqual(MARGIN);
  });

  it("结果永远完整落在视口内（模糊测试 200 组坐标）", () => {
    for (let i = 0; i < 200; i++) {
      const mx = Math.round((i * 37) % 2000) - 40;
      const my = Math.round((i * 53) % 1200) - 40;
      const { x, y } = clampMenuPosition(mx, my, MENU, VP);
      expect(x).toBeGreaterThanOrEqual(MARGIN);
      expect(y).toBeGreaterThanOrEqual(MARGIN);
      expect(x + MENU.width).toBeLessThanOrEqual(VP.width - MARGIN);
      expect(y + MENU.height).toBeLessThanOrEqual(VP.height - MARGIN);
    }
  });
});
