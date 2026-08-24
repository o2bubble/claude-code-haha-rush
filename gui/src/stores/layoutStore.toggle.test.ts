// ── layoutStore — togglePanelInTree 切换开关逻辑 ──
// Toolbar 面板下拉 & 命令面板共用同一函数，行为必须一致：
//   已打开 → 移除；已存在但隐藏 → 显示激活；不存在 → 添加到默认组。

import { beforeEach, describe, it, expect } from "vitest";
import { resetLayout, getTree, setTree, togglePanelInTree, isPanelOpenInTree } from "./layoutStore";
import { registerPanel } from "./panelRegistry";
import type { TabGroup } from "../types/layout";

beforeEach(() => {
  resetLayout();
  if (!(getTree() as any).tabs?.find?.((t: any) => t.panelId === "test")) {
    registerPanel({ id: "test", title: "测试", icon: "editor", defaultView: "main", views: [{ id: "main", title: "测试", render: () => null }] });
    registerPanel({ id: "hidden-panel", title: "隐藏面板", icon: "notes", defaultView: "main", views: [{ id: "main", title: "隐藏面板", render: () => null }] });
  }
});

/** 构造一个含指定 tabs 的 group 树 */
function makeTree(tabs: { panelId: string; visibility?: "expanded" | "hidden" }[]): void {
  const group: TabGroup = {
    type: "group",
    id: "sidebar-left",
    tabs: tabs.map((t, i) => ({
      id: `tab-${t.panelId}-${i}`,
      panelId: t.panelId,
      title: t.panelId,
      icon: "default",
    })),
    activeTabId: tabs[0] ? `tab-${tabs[0].panelId}-0` : null,
    visibility: tabs[0]?.visibility ?? "expanded",
  };
  setTree(group);
}

describe("togglePanelInTree", () => {
  it("面板不存在 → 添加到默认组并打开", () => {
    makeTree([]);
    togglePanelInTree("test");
    const tabs = (getTree() as TabGroup).tabs;
    expect(tabs.some((t) => t.panelId === "test")).toBe(true);
    expect(isPanelOpenInTree("test")).toBe(true);
  });

  it("面板已打开 → 移除（关闭）", () => {
    makeTree([{ panelId: "test" }]);
    expect(isPanelOpenInTree("test")).toBe(true);
    togglePanelInTree("test");
    expect(isPanelOpenInTree("test")).toBe(false);
    expect((getTree() as TabGroup).tabs.some((t) => t.panelId === "test")).toBe(false);
  });

  it("面板已存在但组隐藏 → 显示并激活", () => {
    makeTree([{ panelId: "test", visibility: "hidden" }]);
    expect(isPanelOpenInTree("test")).toBe(false);
    togglePanelInTree("test");
    expect(isPanelOpenInTree("test")).toBe(true);
    // 组变为可见
    expect((getTree() as TabGroup).visibility).not.toBe("hidden");
  });

  it("未注册面板 → 返回 false 不产生副作用", () => {
    makeTree([]);
    expect(togglePanelInTree("nonexistent")).toBe(false);
    expect((getTree() as TabGroup).tabs.length).toBe(0);
  });
});
