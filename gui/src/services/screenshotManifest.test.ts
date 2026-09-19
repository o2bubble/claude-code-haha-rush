// 临时验证：真实 screenshot plugin.json 经解析 + 聚合后的形状
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePluginManifest, collectPluginMcpTools, type PluginManifest } from "./pluginRegistry";

const PLUGIN_JSON = resolve(__dirname, "../../../plugins/screenshot/plugin.json");

describe("screenshot plugin.json 的 mcpTools", () => {
  const raw = readFileSync(PLUGIN_JSON, "utf8");

  it("解析成功且两个工具都在", () => {
    const r = parsePluginManifest(raw, "screenshot");
    expect(r.ok).toBe(true);
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.contributes.mcpTools.map((t) => t.name)).toEqual(["fullscreen", "region"]);
    expect(m.contributes.mcpTools.every((t) => t.resultKind === "image")).toBe(true);
    expect(m.contributes.mcpTools.every((t) => t.process === "screenshot-server")).toBe(true);
    expect(m.platforms).toEqual(["windows", "macos"]);
  });

  it("聚合后完整名带命名空间", () => {
    const r = parsePluginManifest(raw, "screenshot");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    const got = collectPluginMcpTools([m], "windows");
    expect(got.map((t) => t.fullName)).toEqual([
      "plugin_screenshot_fullscreen",
      "plugin_screenshot_region",
    ]);
    expect(got[0].processId).toBe("screenshot-server");
  });

  it("嵌套的 region schema 保留（properties/required 不被白名单误伤）", () => {
    const r = parsePluginManifest(raw, "screenshot");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    const region = m.contributes.mcpTools.find((t) => t.name === "region")!;
    const s = region.inputSchema as any;
    expect(s.required).toEqual(["region"]);
    expect(s.properties.region.required).toEqual(["x", "y", "w", "h"]);
    expect(s.properties.region.properties.w.type).toBe("number");
    expect(s.properties.monitor.type).toBe("number");
  });

  it("linux 平台不暴露（server.cjs 只实现 win/mac）", () => {
    const r = parsePluginManifest(raw, "screenshot");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(collectPluginMcpTools([m], "linux")).toHaveLength(0);
  });
});
