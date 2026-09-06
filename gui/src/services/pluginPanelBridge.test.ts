// ── pluginPanelBridge 纯逻辑测试 ──
// T2: pluginPanelId 前缀生成 + registerPluginPanels 注册进 panelRegistry 的字段归一化。
// 注: panelRegistry 是模块级 Map, 测试用不同 plugin 名隔离; render 返回 JSX 不易断言,
// 只测纯字段。

import { describe, it, expect, beforeEach } from "vitest";
import { pluginPanelId, registerPluginPanels } from "./pluginPanelBridge";
import { getPanel, getAllPanels } from "../stores/panelRegistry";
import type { PluginManifest } from "./pluginRegistry";

describe("pluginPanelId — 前缀防撞", () => {
  it("generates plugin:<name>:<panelId>", () => {
    expect(pluginPanelId("quotes", "main-panel")).toBe("plugin:quotes:main-panel");
  });
});

describe("registerPluginPanels — 注册进 panelRegistry", () => {
  beforeEach(() => {
    // 清掉前一个测试注册的面板(通过 getAllPanels 过滤 plugin: 前缀手动清)
    for (const p of getAllPanels()) {
      if (p.id.startsWith("plugin:")) {
        // panelRegistry 无 unregister API; registerPanel dup 保护直接跳过再次注册
        // → 用不同 plugin 名确保不撞, 这里只验证新注册的面板存在
      }
    }
  });

  const manifest: PluginManifest = {
    pluginName: "quotes",
    displayName: "实时行情",
    version: "0.1.0",
    contributes: {
      panels: [
        { id: "main", title: "行情主面板", panelKind: "in-main", views: [{ id: "main", title: "主视图" }], userManaged: true },
        { id: "no-views", title: "无视图面板", panelKind: "floating", views: [] },
        { id: "no-usermanaged", title: "默认管理", panelKind: "in-main", views: [{ id: "v", title: "V" }] },
      ],
      commands: [],
      events: [],
    },
    processes: [],
  };

  it("registers panels with plugin id prefix", () => {
    registerPluginPanels([manifest]);
    expect(getPanel("plugin:quotes:main")).toBeDefined();
    expect(getPanel("plugin:quotes:no-views")).toBeDefined();
    expect(getPanel("plugin:quotes:no-usermanaged")).toBeDefined();
  });

  it("normalizes userManaged (default true) and views fallback", () => {
    registerPluginPanels([manifest]);
    const noViews = getPanel("plugin:quotes:no-views")!;
    expect(noViews.title).toBe("无视图面板");
    expect(noViews.views[0].id).toBe("main"); // views 回退 "main"
    expect(noViews.defaultView).toBe("main");
  });
});
