import { describe, it, expect } from "vitest";
import { computeCollapsed, partitionItems, type ToolbarItem } from "./toolbarItems";

function item(id: string, alwaysVisible = false): ToolbarItem {
  return { id, label: id, icon: null, onClick: () => {}, alwaysVisible };
}
function fixed(id: string): ToolbarItem {
  return { id, label: id, icon: null, onClick: () => {}, inMenuByDefault: true };
}

// 优先级顺序：数组靠前 = 最先折叠（最低优先级）
const ITEMS: ToolbarItem[] = [
  item("feedback"),
  item("diagnostics"),
  item("help"),
  item("update"),
  item("profile"),
  item("terminal"),
  item("newInstance"),
  item("panel"),
  item("guard"),
  item("settings", true),
  item("search", true),
];

// 两套机制并存：固定降级 + 响应式折叠
const MIXED: ToolbarItem[] = [
  fixed("theme"),
  fixed("hardRefresh"),
  item("newInstance"),
  item("extra"),
  item("settings", true),
];

describe("computeCollapsed — 折叠优先级", () => {
  it("全部放得下 → 不折叠", () => {
    const c = computeCollapsed(ITEMS, () => true);
    expect(c.size).toBe(0);
  });

  it("只差一点 → 只折最低优先级那一个", () => {
    // 9 个可折叠项：放得下 8 个，放不下 9 个
    const c = computeCollapsed(ITEMS, (kept) => kept <= 8);
    expect([...c]).toEqual(["feedback"]);
  });

  it("折多个时从数组头部按序折", () => {
    const c = computeCollapsed(ITEMS, (kept) => kept <= 6);
    expect([...c]).toEqual(["feedback", "diagnostics", "help"]);
  });

  it("全折了仍放不下 → 全部折叠", () => {
    const c = computeCollapsed(ITEMS, () => false);
    expect(c.size).toBe(9); // 9 个可折叠项，常驻项不在内
  });

  it("常驻项永不被折叠", () => {
    for (const kept of [0, 3, 5, 9]) {
      const c = computeCollapsed(ITEMS, (k) => k <= kept);
      expect(c.has("settings")).toBe(false);
      expect(c.has("search")).toBe(false);
    }
  });

  it("没有可折叠项时返回空集（不去调 fits 之外的逻辑）", () => {
    const onlyFixed = [item("a", true), item("b", true)];
    const c = computeCollapsed(onlyFixed, () => false);
    expect(c.size).toBe(0);
  });

  it("折叠后保留的是数组尾部的高优先级项", () => {
    const c = computeCollapsed(ITEMS, (kept) => kept <= 7);
    const collapsed = c;
    expect(collapsed.has("guard")).toBe(false);      // 最高优先级的可折叠项
    expect(collapsed.has("panel")).toBe(false);
    expect(collapsed.has("feedback")).toBe(true);
    expect(collapsed.has("diagnostics")).toBe(true);
  });
});

describe("partitionItems — 拆分", () => {
  it("按折叠集合拆成工具栏项与菜单项", () => {
    const { inBar, inMenu } = partitionItems(ITEMS, new Set(["feedback", "help"]));
    expect(inMenu.map((i) => i.id)).toEqual(["feedback", "help"]);
    expect(inBar.map((i) => i.id)).toEqual([
      "diagnostics", "update", "profile", "terminal",
      "newInstance", "panel", "guard", "settings", "search",
    ]);
  });

  it("空折叠集合 → 全在工具栏", () => {
    const { inBar, inMenu } = partitionItems(ITEMS, new Set());
    expect(inBar).toHaveLength(ITEMS.length);
    expect(inMenu).toHaveLength(0);
  });

  it("常驻项即使出现在折叠集合里也留在工具栏（防御）", () => {
    const { inBar, inMenu } = partitionItems(ITEMS, new Set(["settings", "feedback"]));
    expect(inBar.map((i) => i.id)).toContain("settings");
    expect(inMenu.map((i) => i.id)).toEqual(["feedback"]);
  });

  // ── 两套机制并存 ──

  it("固定降级项始终在菜单里，即使未被折叠、窗口很宽", () => {
    const { inBar, inMenu } = partitionItems(MIXED, new Set());
    expect(inMenu.map((i) => i.id)).toEqual(["theme", "hardRefresh"]);
    expect(inBar.map((i) => i.id)).toEqual(["newInstance", "extra", "settings"]);
  });

  it("菜单顺序：固定降级项在前，被折叠项在后", () => {
    const { inMenu } = partitionItems(MIXED, new Set(["newInstance"]));
    expect(inMenu.map((i) => i.id)).toEqual(["theme", "hardRefresh", "newInstance"]);
  });

  it("固定降级项不参与折叠计算（不算进可折叠数）", () => {
    // 只有 2 个可折叠项（newInstance / extra），fits(2) 为真 → 不该折叠
    const c = computeCollapsed(MIXED, (kept) => kept >= 2);
    expect(c.size).toBe(0);
  });

  it("折叠与固定降级同时生效时互不干扰", () => {
    const { inBar, inMenu } = partitionItems(MIXED, new Set(["newInstance", "extra"]));
    expect(inBar.map((i) => i.id)).toEqual(["settings"]);
    expect(inMenu.map((i) => i.id)).toEqual(["theme", "hardRefresh", "newInstance", "extra"]);
  });

  it("保持数组原顺序（不因拆分打乱）", () => {
    const { inBar } = partitionItems(ITEMS, new Set(["terminal"]));
    const ids = inBar.map((i) => i.id);
    const expected = ITEMS.filter((i) => i.id !== "terminal").map((i) => i.id);
    expect(ids).toEqual(expected);
  });
});
