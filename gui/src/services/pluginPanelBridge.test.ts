// ── pluginPanelBridge 纯逻辑测试 ──
// T2: pluginPanelId 前缀生成 + registerPluginPanels 注册进 panelRegistry 的字段归一化。
// 注: panelRegistry 是模块级 Map, 测试用不同 plugin 名隔离; render 返回 JSX 不易断言,
// 只测纯字段。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPluginPanels, pluginIframeBase, isPluginFrameOrigin, pluginThemeValue, encodePanelParams, decodePanelParams } from "./pluginPanelBridge";
import { pluginPanelId, type PluginManifest } from "./pluginRegistry";
import { getPanel, getAllPanels } from "../stores/panelRegistry";

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
    category: "tool",
    dependencies: [],
    installType: "standard",
    runtimes: [],
    platforms: [],
    settings: {},
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

// ── GV-T1 平台协议 URL（2026-09-09 用户实测: plugins:// 在 Windows 被沙箱拦截）──

describe("pluginIframeBase — 平台正确的协议 URL", () => {
  it("windows → http://plugins.localhost/... (WebView2 沙箱拦 plugins://)", () => {
    expect(pluginIframeBase("git-viewer", "panel.html", "windows"))
      .toBe("http://plugins.localhost/git-viewer/panel.html");
  });
  it("mac/linux → plugins://localhost/...", () => {
    expect(pluginIframeBase("git-viewer", "panel.html", "macos"))
      .toBe("plugins://localhost/git-viewer/panel.html");
    expect(pluginIframeBase("git-viewer", "panel.html", "linux"))
      .toBe("plugins://localhost/git-viewer/panel.html");
  });
  it("null (platform 未就绪) → 非 windows 形式", () => {
    expect(pluginIframeBase("g", "p.html", null)).toBe("plugins://localhost/g/p.html");
  });
});

describe("isPluginFrameOrigin — postMessage 来源校验", () => {
  it("accepts both platform origin forms", () => {
    expect(isPluginFrameOrigin("plugins://localhost")).toBe(true);
    expect(isPluginFrameOrigin("http://plugins.localhost")).toBe(true);
    expect(isPluginFrameOrigin("https://plugins.localhost")).toBe(true);
  });
  it("rejects foreign origins", () => {
    expect(isPluginFrameOrigin("https://evil.com")).toBe(false);
    expect(isPluginFrameOrigin("http://malicious.localhost")).toBe(false);
    expect(isPluginFrameOrigin("http://plugins.localhost.evil.com")).toBe(false);
    expect(isPluginFrameOrigin("")).toBe(false);
  });
});

// ── GV 主题跟随: pluginThemeValue 归一化（dark/dark-a/dark-b → dark, 其余 light）──

describe("pluginThemeValue — 主题简化为插件可见值", () => {
  afterEach(() => {
    // 还原 document（测试无 jsdom, 只有手动 stub 注册; 删掉避免污染）
    vi.unstubAllGlobals();
  });

  const stubTheme = (t: string) => {
    vi.stubGlobal("document", { documentElement: { dataset: { theme: t } } });
  };

  it("dark variants → dark", () => {
    stubTheme("dark"); expect(pluginThemeValue()).toBe("dark");
    stubTheme("dark-a"); expect(pluginThemeValue()).toBe("dark");
    stubTheme("dark-b"); expect(pluginThemeValue()).toBe("dark");
  });
  it("light/undefined → light", () => {
    stubTheme("light"); expect(pluginThemeValue()).toBe("light");
    stubTheme("whatever"); expect(pluginThemeValue()).toBe("light");
  });
  it("no document (非 DOM) → light 兜底", () => {
    expect(pluginThemeValue()).toBe("light");
  });
});

// ── 面板参数编码（base64url）— 2026-09-10 修复: 普通 base64 的 `+` 被 URLSearchParams
//    解成空格 → 参数静默丢失（diff 浮窗显示默认文案, 用户实测）──

describe("encodePanelParams / decodePanelParams — base64url 往返", () => {
  const cases: Array<Record<string, unknown>> = [
    { file: "gui/src/App.tsx", title: "gui/src/App.tsx" },
    { file: "中文/路径~!@#$%^&*().js", title: "含特殊字符 ✔" },
    { ref: "a40b5c3", title: "fix(签名): 绑定 zip +++---///===" },
  ];

  it("roundtrip survives (含 + 字符: 原实现在 URL 中丢失)", () => {
    for (const c of cases) {
      const b64 = encodePanelParams(c);
      // 模拟 URL query 传输（URLSearchParams 会把普通 base64 的 + 解成空格）
      const viaUrl = new URLSearchParams(`params=${b64}`).get("params");
      expect(decodePanelParams(viaUrl!)).toEqual(c);
    }
  });

  it("output is URL-safe (无 + / = 字符)", () => {
    for (const c of cases) {
      const b64 = encodePanelParams(c);
      expect(b64).not.toMatch(/[+/=]/);
    }
  });
});
