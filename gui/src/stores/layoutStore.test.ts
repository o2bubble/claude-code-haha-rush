// ── layoutStore — icon IconKey 持久化 round-trip ──
// icon 现在是可序列化 IconKey，序列化→反序列化必须直通一致。
// 旧版持久化数据没有 icon 字段 → 回退到 registry 图标。

import { beforeEach, describe, it, expect } from "vitest";
import { resetLayout, serializeLayout, deserializeLayout, addFloatingPanel, addTab, mergeIntoTab, removeChildFromCompound, dissolveCompoundGroup, getTree, findGroup } from "./layoutStore";
import { registerPanel } from "./panelRegistry";
import type { TabGroup, TabInstance } from "../types/layout";

beforeEach(() => {
  resetLayout();
});

function collectIcons(node: any): string[] {
  if (node.type === "group") {
    return node.tabs.flatMap((t: any) => [
      ...(t.icon ? [t.icon] : []),
      ...(t.children ? t.children.flatMap((c: any) => (c.icon ? [c.icon] : [])) : []),
    ]);
  }
  return (node.children || []).flatMap(collectIcons);
}

describe("layout icon round-trip", () => {
  it("default tree icons survive serialize → deserialize", () => {
    const data = serializeLayout() as any;
    const restored = deserializeLayout(data);
    expect(collectIcons(restored.tree)).toEqual(collectIcons(data.tree));
    expect(collectIcons(data.tree).length).toBeGreaterThan(0);
  });

  it("custom compound-group icon key persists through round-trip", () => {
    const compoundTab: TabInstance = {
      id: "cmp", panelId: "", title: "Group",
      icon: "grid3x3",
      children: [
        { id: "c1", panelId: "plan", title: "Plan", icon: "plan" },
        { id: "c2", panelId: "files", title: "Files", icon: "files" },
      ],
      activeChildId: "c1",
    };
    const group: TabGroup = { type: "group", id: "g", tabs: [compoundTab], activeTabId: "cmp", tabStyle: "tabs" };
    addFloatingPanel(group, 10, 10, 400, 300);

    const data = serializeLayout() as any;
    expect(data.floatingPanels[0].group.tabs[0].icon).toBe("grid3x3");
    const restored = deserializeLayout(data);
    expect(restored.floatingPanels[0].group.tabs[0].icon).toBe("grid3x3");
    expect(restored.floatingPanels[0].group.tabs[0].children?.[0].icon).toBe("plan");
  });

  it("floating panel containing a compound tab survives deserialize (not treated as ephemeral)", () => {
    // 回归 e136511: deserializeLayout 的 ephemeral 过滤曾用 `!getPanel(panelId)?.userManaged`,
    // 复合 tab 的 panelId="" → getPanel("") undefined → 整个浮窗被丢弃。改为 `=== false` 语义后应保留。
    const legacy = {
      tree: { type: "group", id: "g", tabs: [], activeTabId: null },
      floatingPanels: [{
        type: "floating", id: "fp1", x: 0, y: 0, width: 400, height: 300, zIndex: 1000,
        group: {
          type: "group", id: "g1",
          tabs: [{
            id: "cmp", panelId: "", title: "Group", icon: "compoundGroup",
            children: [{ id: "c1", panelId: "plan", title: "Plan", icon: "plan" }],
            activeChildId: "c1",
          }],
          activeTabId: "cmp", tabStyle: "tabs",
        },
      }],
      tauriWindows: [],
    };
    const restored = deserializeLayout(legacy);
    expect(restored.floatingPanels).toHaveLength(1);
    expect(restored.floatingPanels[0].group.tabs[0].panelId).toBe("");
    expect(restored.floatingPanels[0].group.tabs[0].icon).toBe("compoundGroup");
  });

  it("legacy tab with ReactNode-serialized icon object falls back to registry icon", () => {
    registerPanel({
      id: "test-panel", title: "Test", icon: "editor", defaultView: "main",
      views: [{ id: "main", title: "Test", render: () => null }],
    });
    // 早期版本把 ReactNode 序列化进了 layoutTree — icon 是对象不是字符串，必须丢弃回退 registry
    const legacy = {
      tree: {
        type: "group", id: "g",
        tabs: [{ id: "t1", panelId: "test-panel", title: "Test", icon: { _owner: null, key: null, props: { size: 18 }, ref: null, type: { displayName: "History" } } }],
        activeTabId: "t1",
      },
      floatingPanels: [],
      tauriWindows: [],
    };
    const restored = deserializeLayout(legacy);
    const tab = (restored.tree as TabGroup).tabs[0];
    expect(tab.icon).toBe("editor");
  });

  it("legacy tab without icon field falls back to registry icon", () => {
    registerPanel({
      id: "test-panel", title: "Test", icon: "editor", defaultView: "main",
      views: [{ id: "main", title: "Test", render: () => null }],
    });
    // 模拟旧版持久化数据：tab 无 icon 字段
    const legacy = {
      tree: {
        type: "group", id: "g", tabs: [{ id: "t1", panelId: "test-panel", title: "Test" }], activeTabId: "t1",
      },
      floatingPanels: [],
      tauriWindows: [],
    };
    const restored = deserializeLayout(legacy);
    const tab = (restored.tree as TabGroup).tabs[0];
    expect(tab.icon).toBe("editor");
  });
});

// ── 复合组解散：图标/标题回归 + 右键「解散分组」 ──
describe("compound group dissolve", () => {
  // 在 bottom-panel 里构造一个 2 子面板的复合组，返回其 tab id（保留原 id "t-a"）
  function makeCompound(): string {
    addTab("bottom-panel", { id: "t-a", panelId: "plan", title: "Plan", icon: "plan" });
    addTab("bottom-panel", { id: "t-b", panelId: "files", title: "Files", icon: "files" });
    mergeIntoTab("bottom-panel", "t-a", "bottom-panel", "t-b");
    return "t-a";
  }

  it("auto-dissolve to last child reverts icon/title to that child (not compoundGroup)", () => {
    const compoundId = makeCompound();
    const g = findGroup(getTree(), "bottom-panel")!;
    const comp = g.tabs.find((t) => t.id === compoundId)!;
    expect(comp.panelId).toBe("");
    expect(comp.icon).toBe("compoundGroup");
    expect(comp.children?.length).toBe(2);

    const filesChild = comp.children!.find((c) => c.panelId === "files")!;
    removeChildFromCompound("bottom-panel", compoundId, filesChild.id);

    const after = findGroup(getTree(), "bottom-panel")!;
    const tab = after.tabs.find((t) => t.id === compoundId)!;
    expect(tab.children).toBeUndefined();
    expect(tab.panelId).toBe("plan");
    expect(tab.icon).toBe("plan"); // 不再保留 layers(compoundGroup) 图标
    expect(tab.title).toBe("Plan");
  });

  it("dissolveCompoundGroup splits a compound into independent tabs in the same group", () => {
    makeCompound();
    const before = findGroup(getTree(), "bottom-panel")!.tabs.length;
    dissolveCompoundGroup("bottom-panel", "t-a");

    const after = findGroup(getTree(), "bottom-panel")!;
    expect(after.tabs.length).toBe(before + 1); // 1 个复合组 → 2 个独立 tab
    const plans = after.tabs.filter((t) => t.panelId === "plan");
    const files = after.tabs.filter((t) => t.panelId === "files");
    expect(plans).toHaveLength(1);
    expect(files).toHaveLength(1);
    expect(plans[0].icon).toBe("plan");
    expect(files[0].icon).toBe("files");
    expect(after.tabs.some((t) => t.children?.length)).toBe(false);
  });

  it("dissolveCompoundGroup is a no-op on a plain (non-compound) tab", () => {
    addTab("bottom-panel", { id: "t-x", panelId: "plan", title: "Plan", icon: "plan" });
    const before = findGroup(getTree(), "bottom-panel")!.tabs.length;
    dissolveCompoundGroup("bottom-panel", "t-x");
    expect(findGroup(getTree(), "bottom-panel")!.tabs.length).toBe(before);
  });
});
