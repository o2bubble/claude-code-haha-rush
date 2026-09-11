// ── 消息划词工具栏 · 定位纯函数测试（T3）──
// 接缝：selectionToolbarPosition.ts 的 computeToolbarPosition（无 DOM 依赖）

import { describe, it, expect } from "vitest";
import { computeToolbarPosition, POPUP_SIZE } from "./selectionToolbarPosition";

const VIEW = { width: 1200, height: 800 };

// 构造选区矩形（viewport 坐标）
function rect(top: number, left: number, width = 60, height = 16) {
  return { top, left, width, height, bottom: top + height, right: left + width };
}

describe("computeToolbarPosition", () => {
  it("选区在中间 → 落在选区右下（右对齐选区末尾），不夹紧", () => {
    const r = rect(300, 400);
    const { top, left } = computeToolbarPosition(r, VIEW, POPUP_SIZE);
    expect(top).toBe(300 + 16 + 8);
    expect(left).toBe(400 + 60 - POPUP_SIZE.width);
  });

  it("选区靠近右边缘 → left 夹紧，工具栏整体留在视口内", () => {
    const r = rect(300, VIEW.width - 30);
    const { left } = computeToolbarPosition(r, VIEW, POPUP_SIZE);
    expect(left).toBe(VIEW.width - POPUP_SIZE.width - 8);
    expect(left + POPUP_SIZE.width).toBeLessThanOrEqual(VIEW.width);
  });

  it("选区在左下 → 夹紧 + 翻到选区上方", () => {
    const r = rect(VIEW.height - 20, 10);
    const { top } = computeToolbarPosition(r, VIEW, POPUP_SIZE);
    // 下方放不下 → 翻到上方（选区 top 之上减高度减边距）
    expect(top).toBe(r.top - POPUP_SIZE.height - 8);
  });

  it("选区贴顶部又贴底部（上下都放不下）→ 夹紧到视口内", () => {
    // 选区长到几乎占满视口高度：上下都无法完整放置
    const r = rect(0, 100, 200, VIEW.height - POPUP_SIZE.height);
    const { top, left } = computeToolbarPosition(r, VIEW, POPUP_SIZE);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + POPUP_SIZE.height).toBeLessThanOrEqual(VIEW.height);
    expect(left).toBeGreaterThanOrEqual(8);
  });

  it("视口比工具栏还窄 → 夹紧到 8px 边距", () => {
    const tiny = { width: 40, height: 800 };
    const { left } = computeToolbarPosition(rect(300, 0, 30, 16), tiny, POPUP_SIZE);
    expect(left).toBe(8);
  });
});
