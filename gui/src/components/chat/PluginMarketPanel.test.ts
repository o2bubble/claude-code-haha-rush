import { describe, it, expect } from "vitest";
import { buildLocalPkgs } from "./PluginMarketPanel";
import type { PackageSummary } from "../../services/skillMarketplace";

// 「本地插件」分区（市场面板）的数据构造 —— 2026-09-21 用户实测反馈驱动：
// 装了 rss-reader（本地开发、没发布市场）却在面板上**完全找不到**，
// 既看不到也没法禁用/卸载。根因是「已安装」分区的数据源是**市场包列表**。
//
// 这里锁住构造规则，尤其 slug/name 的分工（写错会让禁用/卸载作用到错的插件）。

const marketPkg = (name: string): PackageSummary => ({
  slug: name, name, description: "", author: "x", version: "1.0.0",
  tags: [], download_count: 1, skill_count: 0, type: "plugin",
});

const entry = (name: string, manifest: object | string | null) => ({
  name,
  manifestJson: manifest === null ? undefined : typeof manifest === "string" ? manifest : JSON.stringify(manifest),
});

describe("buildLocalPkgs — 本地插件伪包构造", () => {
  it("只挑市场里没有的（市场插件不重复出现）", () => {
    const installed = new Map([
      ["screenshot", entry("screenshot", { version: "0.3.1" })],   // 市场有
      ["rss-reader", entry("rss-reader", { version: "0.1.0" })],   // 本地
    ]);
    const out = buildLocalPkgs(installed, [marketPkg("screenshot")]);
    expect(out.map((p) => p.slug)).toEqual(["rss-reader"]);
  });

  it("slug = 目录名（禁用/卸载要用），name = displayName（给人看）", () => {
    const installed = new Map([
      ["rss-reader", entry("rss-reader", { displayName: "RSS 订阅", version: "0.1.0" })],
    ]);
    const out = buildLocalPkgs(installed, []);
    expect(out).toHaveLength(1);
    // ⚠️ 这两行是这次改动最容易写反的地方：PkgCard 用 slug 回退匹配 installedMap，
    // 用 name 渲染标题。写反 → 卡片显示目录名（丑）或禁用/卸载失效（更糟）。
    expect(out[0].slug).toBe("rss-reader");
    expect(out[0].name).toBe("RSS 订阅");
  });

  it("无 displayName 时退回目录名（不留空标题）", () => {
    const installed = new Map([["plain-plugin", entry("plain-plugin", { version: "2.0.0" })]]);
    expect(buildLocalPkgs(installed, [])[0].name).toBe("plain-plugin");
  });

  it("version 用**本地**版本 —— 否则会误报「可更新」", () => {
    const installed = new Map([["p", entry("p", { version: "0.5.0" })]]);
    const out = buildLocalPkgs(installed, []);
    expect(out[0].version).toBe("0.5.0");
    expect(out[0].local).toBe(true);
  });

  it("坏 manifest 不跳过 —— 至少让用户看得见、能禁用/卸载", () => {
    const installed = new Map([["broken", entry("broken", "{ 这不是 JSON")]]);
    const out = buildLocalPkgs(installed, []);
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe("broken");
    expect(out[0].name).toBe("broken");   // 退回目录名
    expect(out[0].version).toBe("?");     // 版本未知但不崩
  });

  it("manifest 缺失（undefined）同样不崩", () => {
    const installed = new Map([["nomanifest", entry("nomanifest", null)]]);
    const out = buildLocalPkgs(installed, []);
    expect(out).toHaveLength(1);
    expect(out[0].local).toBe(true);
  });

  it("按显示名排序（列表顺序稳定，不随 Map 插入序抖动）", () => {
    const installed = new Map([
      ["zeta", entry("zeta", { displayName: "AAA", version: "1" })],
      ["alpha", entry("alpha", { displayName: "ZZZ", version: "1" })],
    ]);
    expect(buildLocalPkgs(installed, []).map((p) => p.name)).toEqual(["AAA", "ZZZ"]);
  });

  it("市场包用 slug 命中时也算「市场已有」（不重复列出）", () => {
    const installed = new Map([["foo", entry("foo", { version: "1" })]]);
    const pkg = { ...marketPkg("bar"), slug: "foo" }; // name≠slug 的市场包
    expect(buildLocalPkgs(installed, [pkg])).toEqual([]);
  });

  it("依赖照常带出（本地插件也有依赖，卡片要能显示）", () => {
    const installed = new Map([["rss", entry("rss", { version: "1", dependencies: ["nodejs"] })]]);
    expect(buildLocalPkgs(installed, [])[0].dependencies).toEqual(["nodejs"]);
  });
});
