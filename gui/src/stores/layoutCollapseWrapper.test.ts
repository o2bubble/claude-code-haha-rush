import { describe, it, expect } from "vitest";
import { findCollapsibleWrapper } from "./layoutStore";
import type { LayoutNode } from "../types/layout";

// 2026-09-10 用户实测: 侧边栏内点「内部切割」后, activity bar 收缩只压窄自己,
// 包装列(内部切割产生的 sidebar-column)仍在根 split 里占原宽度 → 空间收不回来。
// 修复: 收缩时连带把「最顶层那个挂在水平 split 下的列」一并收起。

function group(id: string, tabStyle = "tabs"): LayoutNode {
  return { type: "group", id, tabs: [], activeTabId: null, tabStyle } as unknown as LayoutNode;
}
function split(id: string, direction: "horizontal" | "vertical", children: LayoutNode[]): LayoutNode {
  return { type: "split", id, direction, sizes: children.map(() => 50), children } as unknown as LayoutNode;
}

describe("findCollapsibleWrapper — 收缩时连带收起的列", () => {
  it("用户实测树: root(h) > sidebar-column(v) > [sidebar-left, sidebar-bottom] → 返回 sidebar-column", () => {
    const root = split("root", "horizontal", [
      split("sidebar-column", "vertical", [group("sidebar-left", "activity"), group("sidebar-bottom")]),
      group("center"),
      group("chat"),
    ]);
    expect(findCollapsibleWrapper(root, "sidebar-left")).toBe("sidebar-column");
  });

  it("无包装层(activity 直接挂水平父级) → null, 行为不变", () => {
    const root = split("root", "horizontal", [group("sidebar-left", "activity"), group("center")]);
    expect(findCollapsibleWrapper(root, "sidebar-left")).toBeNull();
  });

  it("多层包装 → 取最顶层那一列(整列收起才能回收宽度)", () => {
    const root = split("root", "horizontal", [
      split("col", "vertical", [
        split("inner", "vertical", [group("sidebar-left", "activity"), group("x")]),
        group("y"),
      ]),
      group("center"),
    ]);
    expect(findCollapsibleWrapper(root, "sidebar-left")).toBe("col");
  });

  it("包装列自身是水平的 → 仍是那一列(宽度由根分配)", () => {
    const root = split("root", "horizontal", [
      split("col", "horizontal", [group("sidebar-left", "activity"), group("side")]),
      group("center"),
    ]);
    expect(findCollapsibleWrapper(root, "sidebar-left")).toBe("col");
  });

  it("groupId 不存在 → null(防误伤)", () => {
    const root = split("root", "horizontal", [group("a"), group("b")]);
    expect(findCollapsibleWrapper(root, "nope")).toBeNull();
  });

  it("根就是 group(单组根) → null", () => {
    expect(findCollapsibleWrapper(group("solo", "activity"), "solo")).toBeNull();
  });
});
