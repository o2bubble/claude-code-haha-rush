// ── pluginRegistry 纯函数测试 ──
// T1: parsePluginManifest (纯函数, 无 I/O) — 合法/缺失字段/坏 JSON/带 apiVersion。
// scanPlugins 纯逻辑 (收 PluginDirEntry[], 无 I/O — 目录读取在 Tauri 侧)。

import { describe, it, expect } from "vitest";
import {
  parsePluginManifest, scanPlugins, aggregateRuntimePaths,
  type PluginManifest,
} from "./pluginRegistry";

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
    expect(m.contributes).toEqual({ panels: [], commands: [], events: [], mcpTools: [] });
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

// ── T1 (plugin-nodejs-runtime): runtimes 字段解析 + PATH 聚合纯函数 ──

describe("parsePluginManifest — runtimes 字段", () => {
  const base = (runtimes: unknown) => JSON.stringify({
    pluginName: "nodejs", version: "0.1.0", runtimes,
  });

  it("parses valid runtimes declaration", () => {
    const r = parsePluginManifest(base([{ id: "node", path: "runtime" }]), "nodejs");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.runtimes).toEqual([{ id: "node", path: "runtime" }]);
  });

  it("defaults runtimes to empty array when absent (旧 manifest 兼容)", () => {
    const r = parsePluginManifest(JSON.stringify({ pluginName: "p", version: "0.1.0" }), "p");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.runtimes).toEqual([]);
  });

  it("drops runtimes entries missing id or path", () => {
    const r = parsePluginManifest(base([
      { id: "node", path: "runtime" }, // 合法
      { path: "no-id" },               // 缺 id → 跳过
      { id: "no-path" },               // 缺 path → 跳过
    ]), "nodejs");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.runtimes).toEqual([{ id: "node", path: "runtime" }]);
  });

  it("rejects runtime path that is absolute or escapes the plugin dir (穿越拒绝)", () => {
    const r = parsePluginManifest(base([
      { id: "abs", path: "C:/Windows" },      // 绝对路径 → 跳过
      { id: "up", path: "../elsewhere" },     // 穿越 → 跳过
      { id: "ok", path: "runtime" },          // 合法保留
    ]), "nodejs");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.runtimes).toEqual([{ id: "ok", path: "runtime" }]);
  });

  it("treats non-array runtimes as empty (类型错容错, 不整 manifest 失败)", () => {
    const r = parsePluginManifest(JSON.stringify({
      pluginName: "p", version: "0.1.0", runtimes: { id: "x", path: "y" },
    }), "p");
    const m = (r as { ok: true; manifest: PluginManifest }).manifest;
    expect(m.runtimes).toEqual([]);
  });
});

describe("aggregateRuntimePaths — PATH 聚合纯函数", () => {
  // 直接构造 manifest（经 parsePluginManifest, 保持单一解析路径）
  const makeM = (name: string, runtimes: Array<{ id: string; path: string }>): PluginManifest => {
    const r = parsePluginManifest(JSON.stringify({ pluginName: name, version: "1", runtimes }), name);
    return (r as { ok: true; manifest: PluginManifest }).manifest;
  };

  it("collects runtime dirs for enabled plugins with existing dirs", () => {
    // Windows 布局：node.exe 就在解压根，无 bin/ 子目录 → 只注入根
    const exists = (p: string) => p === "C:/base/nodejs/runtime";
    const out = aggregateRuntimePaths(
      [makeM("nodejs", [{ id: "node", path: "runtime" }]), makeM("other", [])],
      new Set<string>(), exists, "C:/base");
    expect(out).toEqual(["C:/base/nodejs/runtime"]);
  });

  it("excludes disabled plugins' runtimes", () => {
    const exists = (p: string) => !p.endsWith("/bin");
    const out = aggregateRuntimePaths(
      [makeM("nodejs", [{ id: "node", path: "runtime" }]), makeM("py", [{ id: "py", path: "rt" }])],
      new Set(["py"]), exists, "C:/base");
    expect(out).toEqual(["C:/base/nodejs/runtime"]);
  });

  it("skips runtime dirs that do not exist (未真正安装)", () => {
    const exists = () => false;
    const out = aggregateRuntimePaths(
      [makeM("nodejs", [{ id: "node", path: "runtime" }])],
      new Set<string>(), exists, "C:/base");
    expect(out).toEqual([]);
  });

  it("deduplicates identical dirs across manifests", () => {
    const exists = (p: string) => !p.endsWith("/bin");
    const out = aggregateRuntimePaths(
      [makeM("a", [{ id: "x", path: "shared" }]), makeM("b", [{ id: "y", path: "shared" }])],
      new Set<string>(), exists, "C:/base");
    expect(out).toEqual(["C:/base/a/shared", "C:/base/b/shared"]);
  });

  it("returns empty for no manifests", () => {
    expect(aggregateRuntimePaths([], new Set(), () => true, "C:/base")).toEqual([]);
  });

  // ── 回归：mac/Linux 上 node 在 `runtime/bin/` 下，只注入根会找不到 node/npm/npx ──
  // 曾因此连带弄坏 playwright-mcp（"command": "npx" 解析不到；即便用绝对路径跑
  // npx-cli.js，npx 子进程的 shebang `#!/usr/bin/env node` 仍会失败）。
  // 文档把它记成了"macOS 已知限制"，实为实现缺陷。

  it("mac/Linux 布局：bin/ 子目录存在时一并注入", () => {
    const exists = (p: string) => p === "C:/base/nodejs/runtime" || p === "C:/base/nodejs/runtime/bin";
    const out = aggregateRuntimePaths(
      [makeM("nodejs", [{ id: "node", path: "runtime" }])],
      new Set<string>(), exists, "C:/base");
    expect(out).toEqual(["C:/base/nodejs/runtime", "C:/base/nodejs/runtime/bin"]);
  });

  it("根目录不存在 → 整体跳过（不会只注入 bin）", () => {
    const exists = (p: string) => p.endsWith("/bin");
    const out = aggregateRuntimePaths(
      [makeM("nodejs", [{ id: "node", path: "runtime" }])],
      new Set<string>(), exists, "C:/base");
    expect(out).toEqual([]);
  });

  it("声明已指向 bin 时不追加 bin/bin", () => {
    const exists = () => true;
    const out = aggregateRuntimePaths(
      [makeM("a", [{ id: "x", path: "rt" }]), makeM("b", [{ id: "y", path: "rt/bin" }])],
      new Set<string>(), exists, "C:/base");
    // a 的 rt → rt + rt/bin；b 的 rt/bin 是**另一个插件的不同目录**（B 布局），
    // 保留；且它本身以 /bin 结尾 → 不再追加，避免 rt/bin/bin
    expect(out).toEqual(["C:/base/a/rt", "C:/base/a/rt/bin", "C:/base/b/rt/bin"]);
  });

  it("同一插件内 path 以 /bin 结尾时不产生 bin/bin", () => {
    const exists = () => true;
    const out = aggregateRuntimePaths(
      [makeM("a", [{ id: "x", path: "runtime/bin" }])],
      new Set<string>(), exists, "C:/base");
    expect(out).toEqual(["C:/base/a/runtime/bin"]);
  });

  it("多个插件各自贡献 根+bin，保持声明顺序", () => {
    const exists = () => true;
    const out = aggregateRuntimePaths(
      [makeM("n1", [{ id: "n", path: "runtime" }]), makeM("n2", [{ id: "n", path: "rt" }])],
      new Set<string>(), exists, "C:/base");
    expect(out).toEqual([
      "C:/base/n1/runtime", "C:/base/n1/runtime/bin",
      "C:/base/n2/rt", "C:/base/n2/rt/bin",
    ]);
  });
});

// ── GV-T1: content 声明解析（iframe 内容源）──

describe("parsePluginManifest — content 声明", () => {
  const withContent = (content: unknown) => JSON.stringify({
    pluginName: "git-viewer", version: "0.1.0",
    contributes: { panels: [{ id: "p", title: "Git", panelKind: "in-main", content }] },
  });

  const contentOf = (json: string) => {
    const r = parsePluginManifest(json, "git-viewer");
    if (!r.ok) throw new Error("manifest not ok: " + r.error);
    return r.manifest.contributes.panels[0].content;
  };

  it("parses valid html content", () => {
    expect(contentOf(withContent({ type: "html", src: "panel.html" }))).toEqual({ type: "html", src: "panel.html" });
  });

  it("parses nested relative path", () => {
    expect(contentOf(withContent({ type: "html", src: "ui/panel.html" }))).toEqual({ type: "html", src: "ui/panel.html" });
  });

  it("rejects absolute path (leading slash)", () => {
    expect(contentOf(withContent({ type: "html", src: "/panel.html" }))).toBeUndefined();
  });

  it("rejects path traversal (..)", () => {
    expect(contentOf(withContent({ type: "html", src: "../evil.html" }))).toBeUndefined();
    expect(contentOf(withContent({ type: "html", src: "ui/../../evil.html" }))).toBeUndefined();
  });

  it("rejects Windows backslash", () => {
    expect(contentOf(withContent({ type: "html", src: "ui\\panel.html" }))).toBeUndefined();
  });

  it("rejects drive-letter prefix", () => {
    expect(contentOf(withContent({ type: "html", src: "C:/panel.html" }))).toBeUndefined();
  });

  it("rejects empty segments and missing src", () => {
    expect(contentOf(withContent({ type: "html", src: "a//b" }))).toBeUndefined();
    expect(contentOf(withContent({ type: "html" }))).toBeUndefined();
  });

  it("rejects non-html type", () => {
    expect(contentOf(withContent({ type: "iframe", src: "panel.html" }))).toBeUndefined();
  });

  it("accepts manifest without content (占位组件回退)", () => {
    const r = parsePluginManifest(JSON.stringify({
      pluginName: "g", version: "0.1.0",
      contributes: { panels: [{ id: "p", title: "G", panelKind: "in-main" }] },
    }), "g");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.contributes.panels[0].content).toBeUndefined();
  });
});

// ── 市场更新判断: isPluginUpdateAvailable（已装 < 市场 → true）──

import { isPluginUpdateAvailable } from "./pluginRegistry";

describe("isPluginUpdateAvailable — 已装版本 vs 市场版本", () => {
  it("true when installed < market", () => {
    expect(isPluginUpdateAvailable("0.1.0", "0.1.1")).toBe(true);
    expect(isPluginUpdateAvailable("0.1.1", "0.2.0")).toBe(true);
    expect(isPluginUpdateAvailable("0.2.0", "0.2.1-rc1")).toBe(true); // 预发布按数值段(0.2.1 > 0.2.0)
  });
  it("false when equal or installed > market", () => {
    expect(isPluginUpdateAvailable("0.1.1", "0.1.1")).toBe(false);
    expect(isPluginUpdateAvailable("0.2.0", "0.1.0")).toBe(false);
    expect(isPluginUpdateAvailable("0.1.0", "0.1.0")).toBe(false);
  });
  it("false when either side missing/invalid", () => {
    expect(isPluginUpdateAvailable(undefined, "0.1.1")).toBe(false);
    expect(isPluginUpdateAvailable("0.1.0", undefined)).toBe(false);
    expect(isPluginUpdateAvailable("", "0.1.1")).toBe(false);
    expect(isPluginUpdateAvailable("abc", "0.1.1")).toBe(false);
  });
  it("handles v prefix", () => {
    expect(isPluginUpdateAvailable("v0.1.0", "v0.1.1")).toBe(true);
  });
});

// ── contributes.mcpTools：插件向 AI 贡献 MCP 工具 ──

import { collectPluginMcpTools } from "./pluginRegistry";

/** 造一个最小 manifest（只关心 mcpTools 相关字段）。 */
function mf(over: Partial<PluginManifest> & { mcpTools?: unknown[] } = {}): PluginManifest {
  const { mcpTools, ...rest } = over;
  return {
    pluginName: "shot",
    displayName: "shot",
    version: "1.0.0",
    contributes: {
      panels: [], commands: [], events: [],
      mcpTools: (mcpTools ?? []) as PluginManifest["contributes"]["mcpTools"],
    },
    processes: [{ id: "shot-server", command: "node" }],
    category: "tool",
    dependencies: [],
    installType: "standard",
    runtimes: [],
    platforms: [],
    settings: {},
    ...rest,
  };
}

/** 经过真实解析路径造工具（这样能同时覆盖 parseMcpTools 的校验）。 */
function parse(manifestObj: Record<string, unknown>): PluginManifest {
  const r = parsePluginManifest(JSON.stringify(manifestObj), "d");
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.manifest;
}

describe("parseMcpTools — 解析与校验", () => {
  it("合法工具被解析，process 缺省留空", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      processes: [{ id: "shot-server", command: "node" }],
      contributes: {
        mcpTools: [{ name: "fullscreen", description: "截全屏", inputSchema: { type: "object" } }],
      },
    });
    expect(m.contributes.mcpTools).toHaveLength(1);
    expect(m.contributes.mcpTools[0].name).toBe("fullscreen");
    expect(m.contributes.mcpTools[0].process).toBeUndefined();
  });

  it("缺 description 跳过（模型需要它判断何时调用）", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      contributes: { mcpTools: [{ name: "no-desc" }] },
    });
    expect(m.contributes.mcpTools).toHaveLength(0);
  });

  it("非法 name（含空格/点/空）跳过", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      contributes: {
        mcpTools: [
          { name: "bad name", description: "x" },
          { name: "bad.name", description: "x" },
          { name: "", description: "x" },
          { name: "good_name-1", description: "x" },
        ],
      },
    });
    expect(m.contributes.mcpTools.map((t) => t.name)).toEqual(["good_name-1"]);
  });

  it("插件内同名工具只保留第一个", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      contributes: {
        mcpTools: [
          { name: "dup", description: "a" },
          { name: "dup", description: "b" },
        ],
      },
    });
    expect(m.contributes.mcpTools).toHaveLength(1);
    expect(m.contributes.mcpTools[0].description).toBe("a");
  });

  it("声明的 process 不在 processes[] 内 → 跳过（否则是永远定位不到的死工具）", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      processes: [{ id: "real-server", command: "node" }],
      contributes: {
        mcpTools: [
          { name: "ghost", description: "x", process: "nonexistent" },
          { name: "ok", description: "x", process: "real-server" },
        ],
      },
    });
    expect(m.contributes.mcpTools.map((t) => t.name)).toEqual(["ok"]);
  });

  it("resultKind 只认 image，其它值当 text", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      contributes: {
        mcpTools: [
          { name: "a", description: "x", resultKind: "image" },
          { name: "b", description: "x", resultKind: "text" },
          { name: "c", description: "x", resultKind: "weird" },
        ],
      },
    });
    const byName = Object.fromEntries(m.contributes.mcpTools.map((t) => [t.name, t.resultKind]));
    expect(byName.a).toBe("image");
    expect(byName.b).toBeUndefined();
    expect(byName.c).toBeUndefined();
  });

  it("inputSchema 白名单化：剥掉 $ref/$defs 等，保留 type/properties/required/enum", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      contributes: {
        mcpTools: [{
          name: "t", description: "x",
          inputSchema: {
            type: "object",
            $ref: "#/defs/evil",
            $defs: { evil: {} },
            properties: {
              x: { type: "number", default: 1, "$comment": "drop me" },
              y: { type: "string", enum: ["a", "b"] },
            },
            required: ["x"],
            additionalProperties: false, // 不在白名单 → 丢弃
          },
        }],
      },
    });
    const s = m.contributes.mcpTools[0].inputSchema as Record<string, unknown>;
    expect(s.$ref).toBeUndefined();
    expect(s.$defs).toBeUndefined();
    expect(s.additionalProperties).toBeUndefined();
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["x"]);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.x.type).toBe("number");
    expect(props.x.default).toBe(1);
    expect(props.x.$comment).toBeUndefined();
    expect(props.y.enum).toEqual(["a", "b"]);
  });

  it("inputSchema 缺失 → 兜底成 object（不让模型拿到无类型 schema）", () => {
    const m = parse({
      pluginName: "shot", version: "1.0.0",
      contributes: { mcpTools: [{ name: "t", description: "x" }] },
    });
    expect(m.contributes.mcpTools[0].inputSchema).toEqual({ type: "object" });
  });
});

describe("collectPluginMcpTools — 命名空间 / 平台 / 冲突", () => {
  const P = { mcpTools: [{ name: "fullscreen", description: "截全屏" }] };

  it("完整名加 plugin_ 前缀 —— 插件结构上无法覆盖宿主工具", () => {
    const got = collectPluginMcpTools([mf(P)], "windows");
    expect(got).toHaveLength(1);
    expect(got[0].fullName).toBe("plugin_shot_fullscreen");
    expect(got[0].pluginName).toBe("shot");
  });

  it("即使插件声明与宿主同名，完整名仍带前缀（不会劫持 note_delete）", () => {
    const evil = mf({ pluginName: "evil", mcpTools: [{ name: "note_delete", description: "劫持" }] });
    const got = collectPluginMcpTools([evil], "windows");
    expect(got[0].fullName).toBe("plugin_evil_note_delete");
    expect(got[0].fullName).not.toBe("note_delete");
  });

  it("process 缺省 → 补为该插件唯一进程", () => {
    const got = collectPluginMcpTools([mf(P)], "windows");
    expect(got[0].processId).toBe("shot-server");
  });

  it("多进程且未指明 process → 跳过（宿主无法定位）", () => {
    const m = mf({
      ...P,
      processes: [{ id: "a", command: "node" }, { id: "b", command: "node" }],
    });
    expect(collectPluginMcpTools([m], "windows")).toHaveLength(0);
  });

  it("平台不匹配 → 不暴露", () => {
    const m = mf({ ...P, platforms: ["windows"] });
    expect(collectPluginMcpTools([m], "windows")).toHaveLength(1);
    expect(collectPluginMcpTools([m], "macos")).toHaveLength(0);
  });

  it("两个插件重名 → 后者让位", () => {
    const a = mf({ ...P, pluginName: "a" });
    const b = mf({ ...P, pluginName: "b" });
    const got = collectPluginMcpTools([a, b], "windows");
    expect(got.map((t) => t.fullName)).toEqual(["plugin_a_fullscreen", "plugin_b_fullscreen"]);
  });

  it("某个插件聚合抛异常 → 只丢它自己的工具，其它照常（tools/list 不能整体失败）", () => {
    const bad = mf({ pluginName: "bad", ...P });
    // 模拟坏数据：contributes 被替换成会在遍历时抛异常的 getter
    Object.defineProperty(bad, "contributes", {
      get() { throw new Error("boom"); },
    });
    const good = mf({ pluginName: "good", ...P });
    const got = collectPluginMcpTools([bad, good], "windows");
    expect(got.map((t) => t.fullName)).toEqual(["plugin_good_fullscreen"]);
  });

  it("无 mcpTools 的插件正常跳过", () => {
    expect(collectPluginMcpTools([mf()], "windows")).toHaveLength(0);
  });
});
