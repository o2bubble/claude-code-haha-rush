import { describe, it, expect } from "vitest";
import { sameSet } from "./useToolbarCollapse";

// 回归：Toolbar 曾报 "Maximum update depth exceeded" —— measure() 无条件
// setCollapsed(new Set(...))，新引用触发重渲染 → 再测量 → 再 setState 死循环。
// sameSet 是切断该循环的关键：内容没变就返回旧引用，React 跳过重渲染。

describe("sameSet — 防无限重渲染", () => {
  it("内容相同的两个不同 Set 实例视为相同（关键：保住旧引用）", () => {
    const a = new Set(["x", "y"]);
    const b = new Set(["x", "y"]); // 新引用，内容相同
    expect(a).not.toBe(b);
    expect(sameSet(a, b)).toBe(true);
  });

  it("元素顺序不同但内容相同 → 相同", () => {
    expect(sameSet(new Set(["a", "b", "c"]), new Set(["c", "a", "b"]))).toBe(true);
  });

  it("大小不同 → 不同", () => {
    expect(sameSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });

  it("大小相同但元素不同 → 不同", () => {
    expect(sameSet(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(false);
  });

  it("两个空集 → 相同", () => {
    expect(sameSet(new Set(), new Set())).toBe(true);
  });

  it("同一实例 → 相同", () => {
    const s = new Set(["a"]);
    expect(sameSet(s, s)).toBe(true);
  });
});
