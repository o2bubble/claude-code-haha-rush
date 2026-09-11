import { describe, it, expect } from "vitest";
import { isSubtreeHidden } from "../components/LayoutRenderer";
import type { LayoutNode } from "../types/layout";

// 2026-09-09 用户实测 bug: 隐藏左侧边栏后空间不回收。
// 根因: sidebar 被包装进嵌套 split(sub-split), 其两个 group 都 hidden 后,
// sub-split 作为父 split 的 child 仍是 "expanded" 且占 sizes[0] → 空区。
// isSubtreeHidden 修复: split child 内部全 hidden → 视为 hidden → 父 SplitView
// 不渲染 + visibleTotal 归一化把空间给可见兄弟。

function group(id: string, visibility?: string): LayoutNode {
  return { type: "group", id, tabs: [], activeTabId: null, visibility, tabStyle: "activity" } as unknown as LayoutNode;
}

const emptySplit = (id: string, children: LayoutNode[]): LayoutNode =>
  ({ type: "split", id, direction: "horizontal", sizes: [50, 50], children }) as unknown as LayoutNode;

describe("isSubtreeHidden — 嵌套全 hidden 塌缩", () => {
  it("group hidden → true / expanded → false", () => {
    expect(isSubtreeHidden(group("a", "hidden"))).toBe(true);
    expect(isSubtreeHidden(group("a"))).toBe(false);
  });

  it("split 内全部 group hidden → true (sub-split 塌缩)", () => {
    const sub = emptySplit("sub", [group("sidebar-left", "hidden"), group("g2", "hidden")]);
    expect(isSubtreeHidden(sub)).toBe(true);
  });

  it("split 任一半 visible → false", () => {
    const sub = emptySplit("sub", [group("sidebar-left", "hidden"), group("g2")]);
    expect(isSubtreeHidden(sub)).toBe(false);
  });

  it("多层嵌套全 hidden → true (用户实测树: 根 split 第一个 child 是 sub-split 全 hidden)", () => {
    const inner = emptySplit("inner", [group("a", "hidden"), group("b", "hidden")]);
    const outer = emptySplit("outer", [inner, group("plan", "hidden")]);
    expect(isSubtreeHidden(outer)).toBe(true);
  });

  it("多层嵌套含可见 → false", () => {
    const inner = emptySplit("inner", [group("a", "hidden"), group("b", "hidden")]);
    const outer = emptySplit("outer", [inner, group("plan")]);
    expect(isSubtreeHidden(outer)).toBe(false);
  });
});
