// ── pluginRegistry 纯函数测试 ──
// T1: parsePluginManifest (纯函数, 无 I/O) — 合法/缺失字段/坏 JSON/带 apiVersion。
// scanPlugins 纯逻辑 (收 PluginDirEntry[], 无 I/O — 目录读取在 Tauri 侧)。

import { describe, it, expect } from "vitest";
import { parsePluginManifest, scanPlugins, type PluginManifest } from "./pluginRegistry";

const VALID_JSON = JSON.stringify({
  pluginName: "realtime-quotes",
  displayName: "实时行情",
  version: "0.1.0",
  apiVersion: "1.0",
  description: "抓取实时行情并展示在独立面板",
  icon: "_default",
  contributes: {
    panels: [
      {
        id: "realtime-quotes",
        title: "实时行情",
        panelKind: "in-main",
        views: [{ id: "main", title: "主视图", entry: "assets/main.html", process: "realtime-quotes" }],
        userManaged: true,
      },
    ],
    commands: [{ id: "quotes.refresh", title: "刷新行情", onInvoke: "refresh" }],
    events: ["chat.message.sent", "panel.switched"],
  },
  processes: [
    { id: "realtime-quotes", command: "node", args: ["process/fetch.js"], env: { SOURCE: "ws://..." }, portProtocol: "stdout:PLUGIN_PORT", startOn: "workspace_bound" },
  ],
});

describe("parsePluginManifest — 合法 manifest", () => {
  it("parses a full valid manifest", () => {
    const r = parsePluginManifest(VALID_JSON, "demo");
    expect(r.ok).toBe(true);
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.pluginName).toBe("realtime-quotes");
    expect(m.displayName).toBe("实时行情");
    expect(m.version).toBe("0.1.0");
    expect(m.apiVersion).toBe("1.0");
    expect(m.contributes.panels).toHaveLength(1);
    expect(m.contributes.panels[0].panelKind).toBe("in-main");
    expect(m.contributes.panels[0].views[0].entry).toBe("assets/main.html");
    expect(m.contributes.commands).toHaveLength(1);
    expect(m.contributes.events).toHaveLength(2);
    expect(m.processes).toHaveLength(1);
    expect(m.processes[0].portProtocol).toBe("stdout:PLUGIN_PORT");
    expect(m.processes[0].startOn).toBe("workspace_bound");
  });

  it("accepts a manifest without optional sections (contributes/processes/icons)", () => {
    const minimal = JSON.stringify({ pluginName: "min", version: "0.0.1" });
    const r = parsePluginManifest(minimal, "min");
    expect(r.ok).toBe(true);
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.pluginName).toBe("min");
    expect(m.contributes).toEqual({ panels: [], commands: [], events: [] });
    expect(m.processes).toEqual([]);
  });
});

describe("parsePluginManifest — 容错", () => {
  it("rejects malformed JSON (broken json) without throwing", () => {
    const r = parsePluginManifest("{ not json", "demo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON");
  });

  it("rejects missing required pluginName", () => {
    const r = parsePluginManifest(JSON.stringify({ version: "0.1.0" }), "demo");
    expect(r.ok).toBe(false);
  });

  it("rejects missing required version", () => {
    const r = parsePluginManifest(JSON.stringify({ pluginName: "demo" }), "demo");
    expect(r.ok).toBe(false);
  });

  it("rejects non-object JSON", () => {
    const r = parsePluginManifest(JSON.stringify([1, 2, 3]), "demo");
    expect(r.ok).toBe(false);
  });

  it("normalizes missing displayName to pluginName", () => {
    const r = parsePluginManifest(JSON.stringify({ pluginName: "x", version: "0.0.1" }), "x");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.displayName).toBe("x");
  });

  it("rejects bad panelKind (not in-main/floating)", () => {
    const bad = JSON.stringify({ pluginName: "p", version: "0.0.1", contributes: { panels: [{ id: "p1", title: "x", panelKind: "unknown" }] } });
    const r = parsePluginManifest(bad, "p");
    expect(r.ok).toBe(false);
  });

  it("rejects non-array contributes.panels (object instead of array)", () => {
    const bad = JSON.stringify({ pluginName: "p", version: "0.0.1", contributes: { panels: { id: "x" } } });
    const r = parsePluginManifest(bad, "p");
    expect(r.ok).toBe(false);
  });

  it("skips process missing required command/id (not registering with empty string)", () => {
    const bad = JSON.stringify({
      pluginName: "p", version: "0.0.1",
      processes: [
        { id: "proc", command: "node" },          // 合法
        { id: "no-cmd" },                          // 缺 command → 跳过
        { command: "node2" },                      // 缺 id → 跳过
      ],
    });
    const r = parsePluginManifest(bad, "p");
    expect(r.ok).toBe(true);
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.processes).toHaveLength(1);
    expect(m.processes[0].id).toBe("proc");
  });

  it("filters out env values that are not strings (spawn-safe)", () => {
    const bad = JSON.stringify({
      pluginName: "p", version: "0.0.1",
      processes: [{ id: "proc", command: "node", env: { GOOD: "x", NUM: 123, ARR: [1, 2] } }],
    });
    const r = parsePluginManifest(bad, "p");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.processes[0].env).toEqual({ GOOD: "x" });
  });

  it("filters non-string entries from contributes.events", () => {
    const bad = JSON.stringify({
      pluginName: "p", version: "0.0.1",
      contributes: { events: ["chat.message.sent", 123, null, "panel.switched"] },
    });
    const r = parsePluginManifest(bad, "p");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.contributes.events).toEqual(["chat.message.sent", "panel.switched"]);
  });
});

describe("scanPlugins — 条目容错（纯逻辑，无 I/O）", () => {
  it("collects valid plugins, skips broken entries", () => {
    const names = scanPlugins([
      { name: "good", manifestJson: VALID_JSON },
      { name: "bad-json", manifestJson: "{ not json" },
      { name: "no-manifest" },
      { name: "hidden-bad", manifestJson: JSON.stringify({ pluginName: "x" }) }, // 缺 version → 跳过
    ]).map((m) => m.pluginName);
    expect(names).toContain("realtime-quotes");
    expect(names).not.toContain("bad-json"); // 坏 JSON 跳过
    expect(names).not.toContain("no-manifest"); // 缺 manifestJson 跳过
    expect(names).not.toContain("hidden-bad"); // 缺 version 跳过
  });

  it("returns empty for empty entries", () => {
    expect(scanPlugins([])).toEqual([]);
  });
});
