// ── 终端标签栏自动滚动判定 · 纯函数测试 ──
// 接缝：terminalTabBar.ts 的 shouldScrollTabBar（无 DOM 依赖）

import { describe, it, expect } from "vitest";
import { shouldScrollTabBar } from "./terminalTabBar";

describe("shouldScrollTabBar", () => {
  it("挂载期间数量增长（新标签加入）→ 滚动到最新", () => {
    expect(shouldScrollTabBar(3, 4, true)).toBe(true);
  });

  it("挂载期间数量不变 → 不滚动", () => {
    expect(shouldScrollTabBar(4, 4, true)).toBe(false);
  });

  it("首次挂载时已有标签（面板隐藏期间堆积）→ 滚动到最新", () => {
    expect(shouldScrollTabBar(12, 12, false)).toBe(true);
  });

  it("首次挂载时无标签 → 不滚动", () => {
    expect(shouldScrollTabBar(0, 0, false)).toBe(false);
  });

  it("数量减少（关闭标签）→ 不滚动", () => {
    expect(shouldScrollTabBar(5, 4, true)).toBe(false);
  });
});
