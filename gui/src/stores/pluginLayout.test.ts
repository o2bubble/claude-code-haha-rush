// ── pluginLayout 纯函数测试 ──
// T2: removePanelsFromTree — 插件停用/卸载时从布局树递归移除其面板(决策#5)。
// 纯递归, 无 I/O/react 依赖, 可单测。

import { describe, it, expect } from "vitest";
import { removePanelsFromTree } from "./pluginLayout";
import type { LayoutNode, TabInstance } from "../types/layout";

function tab(id: string, panelId: string, children?: TabInstance["children"]): TabInstance {
  return children
    ? { id, panelId: "", title: "", activeChildId: children[0]?.id ?? null, children }
    : { id, panelId, title: "" };
}

function group(id: string, tabs: TabInstance[]): LayoutNode {
  return { type: "group", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

function split(id: string, children: LayoutNode[], sizes: number[] = children.map(() => 1)): LayoutNode {
  return { type: "split", id, direction: "horizontal", children, sizes };
}

describe("removePanelsFromTree — 移除插件面板", () => {
  it("removes a single-panel tab from a group", () => {
    const tree: LayoutNode = group("g1", [tab("t1", "plugin:a:p1"), tab("t2", "chat")]);
    const out = removePanelsFromTree(tree, ["plugin:a:p1"]);
    expect(out).toEqual(group("g1", [tab("t2", "chat")]));
  });

  it("removes empty groups from a split (prunes empty children)", () => {
    const tree: LayoutNode = split("s1", [
      group("g1", [tab("t1", "plugin:a:p1")]),
      group("g2", [tab("t2", "chat")]),
    ]);
    const out = removePanelsFromTree(tree, ["plugin:a:p1"]);
    // g1 清空成叶子后, split 里应移除 g1(空组) — 递归后 split 只剩 g2
    expect(out).toEqual(group("g2", [tab("t2", "chat")]));
  });

  it("removes compound tab when all its children match", () => {
    const tree: LayoutNode = group("g1", [
      tab("c1", "", [
        { id: "c1a", panelId: "plugin:a:p1", title: "" },
        { id: "c1b", panelId: "plugin:a:p2", title: "" },
      ]),
      tab("t2", "chat"),
    ]);
    const out = removePanelsFromTree(tree, ["plugin:a:p1", "plugin:a:p2"]);
    expect(out).toEqual(group("g1", [tab("t2", "chat")]));
  });

  it("keeps compound tab with remaining children after partial removal", () => {
    // 内联构造（明确 children 传入，避免 helper 传递歧义）
    const tree: LayoutNode = {
      type: "group", id: "g1", activeTabId: "c1", tabs: [
        { id: "c1", panelId: "", title: "", activeChildId: "c1a", children: [
          { id: "c1a", panelId: "plugin:a:p1", title: "" },
          { id: "c1b", panelId: "chat", title: "" },
        ] },
      ],
    };
    const out = removePanelsFromTree(tree, ["plugin:a:p1"]);
    const c1 = (out as any).tabs[0];
    expect(c1.children.map((c: any) => c.id)).toEqual(["c1b"]);
    expect(c1.activeChildId).toBe("c1b");
  });

  it("returns unchanged tree when no panels match", () => {
    const tree: LayoutNode = group("g1", [tab("t1", "chat")]);
    expect(removePanelsFromTree(tree, ["plugin:x:y"])).toEqual(tree);
  });

  it("handles nested splits (two levels)", () => {
    const tree: LayoutNode = split("s1", [
      split("s2", [group("g1", [tab("t1", "plugin:a:p1")])]),
      group("g2", [tab("t2", "chat")]),
    ]);
    const out = removePanelsFromTree(tree, ["plugin:a:p1"]);
    expect(out).toEqual(group("g2", [tab("t2", "chat")]));
  });
});
