// ── 活跃 tab(activeTabId) 持久化 — 切换面板后必须随布局一起保存并恢复 ──

import { beforeEach, describe, it, expect } from "vitest";
import {
  resetLayout, applyLayoutPreset, setActiveTab, serializeLayout, deserializeLayout,
  restoreLayout, findGroup, getTree,
} from "./layoutStore";

beforeEach(() => {
  resetLayout();
});

describe("active tab persistence", () => {
  it("setActiveTab change survives serialize → deserialize → restore", () => {
    applyLayoutPreset("dense");
    setActiveTab("sidebar-left", "tab-files");
    const saved = serializeLayout() as any;
    resetLayout();
    // 回到默认后再恢复 —— 模拟重启
    expect(findGroup(getTree(), "sidebar-left")?.activeTabId).not.toBe("tab-files");
    restoreLayout(saved);
    expect(findGroup(getTree(), "sidebar-left")?.activeTabId).toBe("tab-files");
  });

  it("restore keeps every group's activeTabId", () => {
    applyLayoutPreset("dense");
    setActiveTab("sidebar-left", "tab-skills");
    setActiveTab("editor-area", "tab-editor");
    setActiveTab("bottom-panel", "tab-terminal");
    const saved = serializeLayout() as any;
    restoreLayout(saved);
    expect(findGroup(getTree(), "sidebar-left")?.activeTabId).toBe("tab-skills");
    expect(findGroup(getTree(), "editor-area")?.activeTabId).toBe("tab-editor");
    expect(findGroup(getTree(), "bottom-panel")?.activeTabId).toBe("tab-terminal");
  });

  it("serialized data carries activeTabId (would go red if serialization drops it)", () => {
    applyLayoutPreset("dense");
    setActiveTab("sidebar-left", "tab-subagents");
    const data = serializeLayout() as any;
    const sidebar = (function walk(n: any): any {
      if (n.type === "group") return n.id === "sidebar-left" ? n : null;
      for (const c of n.children || []) { const r = walk(c); if (r) return r; }
      return null;
    })(data.tree);
    expect(sidebar.activeTabId).toBe("tab-subagents");
  });
});
