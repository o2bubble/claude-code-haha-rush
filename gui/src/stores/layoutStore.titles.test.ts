// ── layoutStore — 布局恢复时的标题刷新 ──
// 旧版本(i18n 全量覆盖 7c567b0 之前)把面板标题硬编码英文存进 layoutTree。
// restoreLayout 通过 refreshTitles 从 panel registry 覆盖单 tab 标题,但复合 tab
// 的 children 曾被遗漏 → 客户合并面板组的 bar 上一直显示英文。回归测试锁定两者。

import { beforeEach, describe, it, expect } from "vitest";
import { resetLayout, restoreLayout, getTree } from "./layoutStore";
import { registerPanel, getPanel } from "./panelRegistry";

beforeEach(() => {
  resetLayout();
  // 模拟真实 registry：i18n 化后的中文标题
  if (!getPanel("sessions")) registerPanel({ id: "sessions", title: "会话", icon: "sessions", defaultView: "list", views: [{ id: "list", title: "会话", render: () => null }] });
  if (!getPanel("files")) registerPanel({ id: "files", title: "文件", icon: "files", defaultView: "browse", views: [{ id: "browse", title: "文件", render: () => null }] });
});

describe("refreshTitles — 客户旧英文标题布局", () => {
  it("普通 tab：英文持久化标题在 restore 后被 registry 中文覆盖", () => {
    const legacy = {
      tree: {
        type: "group", id: "g",
        tabs: [
          { id: "t-sessions", panelId: "sessions", title: "Sessions" },
          { id: "t-files", panelId: "files", title: "Files" },
        ],
        activeTabId: "t-sessions",
      },
      floatingPanels: [], tauriWindows: [],
    };
    restoreLayout(legacy);
    const tabs = (getTree() as any).tabs;
    expect(tabs.find((t: any) => t.panelId === "sessions").title).toBe("会话");
    expect(tabs.find((t: any) => t.panelId === "files").title).toBe("文件");
  });

  it("复合 tab：children 的英文标题在 restore 后也被 registry 中文覆盖", () => {
    const legacy = {
      tree: {
        type: "group", id: "g",
        tabs: [{
          id: "cmp", panelId: "", title: "Sessions",
          children: [
            { id: "c1", panelId: "sessions", title: "Sessions" },
            { id: "c2", panelId: "files", title: "Files" },
          ],
          activeChildId: "c2",
        }],
        activeTabId: "cmp",
      },
      floatingPanels: [], tauriWindows: [],
    };
    restoreLayout(legacy);
    const cmp = (getTree() as any).tabs[0];
    expect(cmp.title).toBe("文件"); // 顶层标题跟随活跃子面板(activeChildId=c2 → Files)
    expect(cmp.children.find((c: any) => c.panelId === "sessions").title).toBe("会话");
    expect(cmp.children.find((c: any) => c.panelId === "files").title).toBe("文件");
  });
});
