// ── 插件自动更新的候选判定 ──
//
// 只测**纯判定** `pickUpdateCandidates`（不碰 IO / 网络 / 签名）。
// 签名校验、下载、重扫属于集成路径，靠真机验证。
//
// 这里钉住的每一条都是"判错了会伤用户"的：
//   · 误更新 ai-guided → 冲掉 AI 按文档调好的安装状态，且没有运行时可回滚
//   · 误更新平台不支持的 → 装了也跑不起来
//   · 版本比较写反 → 把用户手动装的更新版本"降级"掉
//   · 市场里没有的包被当成候选 → 下载 404

import { describe, it, expect } from "vitest";
import { pickUpdateCandidates, type InstalledPluginInfo } from "./pluginAutoUpdate";

const inst = (
  name: string,
  version: string,
  extra: Partial<InstalledPluginInfo> = {},
): InstalledPluginInfo => ({
  name,
  version,
  installType: "standard",
  platforms: [],
  ...extra,
});

describe("pickUpdateCandidates", () => {
  it("市场版本更高 → 成为候选", () => {
    const out = pickUpdateCandidates(
      [inst("git-viewer", "0.1.0")],
      [{ slug: "git-viewer", version: "0.2.0" }],
      "windows",
    );
    expect(out).toEqual([
      { slug: "git-viewer", fromVersion: "0.1.0", toVersion: "0.2.0" },
    ]);
  });

  it("版本相同 / 本地更新 → 都不动", () => {
    const out = pickUpdateCandidates(
      [inst("a", "0.2.0"), inst("b", "0.3.0")],
      [{ slug: "a", version: "0.2.0" }, { slug: "b", version: "0.2.9" }],
      "windows",
    );
    expect(out).toEqual([]);
  });

  it("本地版本号带前缀（v1.0.0）也能正确比较", () => {
    const out = pickUpdateCandidates(
      [inst("a", "v1.0.0")],
      [{ slug: "a", version: "1.0.1" }],
      "windows",
    );
    expect(out.map((c) => c.slug)).toEqual(["a"]);
  });

  it("AI 指导类（本地 manifest 标的）永不自动更新", () => {
    const out = pickUpdateCandidates(
      [inst("guided", "0.1.0", { installType: "ai-guided" })],
      [{ slug: "guided", version: "0.9.0" }],
      "windows",
    );
    expect(out).toEqual([]);
  });

  it("市场侧刚改成 ai-guided（本地 manifest 还是旧的）也跳过", () => {
    const out = pickUpdateCandidates(
      [inst("x", "0.1.0", { installType: "standard" })],
      [{ slug: "x", version: "0.2.0", installType: "ai-guided" }],
      "windows",
    );
    expect(out).toEqual([]);
  });

  it("平台不支持的不更新（装了也跑不起来）", () => {
    const out = pickUpdateCandidates(
      [inst("mac-only", "0.1.0", { platforms: ["macos"] })],
      [{ slug: "mac-only", version: "0.2.0" }],
      "windows",
    );
    expect(out).toEqual([]);
  });

  it("未声明 platforms = 全平台（兼容旧 manifest）", () => {
    const out = pickUpdateCandidates(
      [inst("any", "0.1.0", { platforms: [] })],
      [{ slug: "any", version: "0.2.0" }],
      "windows",
    );
    expect(out.map((c) => c.slug)).toEqual(["any"]);
  });

  it("市场里没有的包不产生候选", () => {
    const out = pickUpdateCandidates(
      [inst("local-only", "0.1.0")],
      [{ slug: "other", version: "9.9.9" }],
      "windows",
    );
    expect(out).toEqual([]);
  });

  it("多个候选保持已装顺序（安装是串行的，顺序要可预期）", () => {
    const out = pickUpdateCandidates(
      [inst("c", "0.1.0"), inst("a", "0.1.0"), inst("b", "0.1.0")],
      [
        { slug: "a", version: "0.2.0" },
        { slug: "b", version: "0.2.0" },
        { slug: "c", version: "0.2.0" },
      ],
      "windows",
    );
    expect(out.map((c) => c.slug)).toEqual(["c", "a", "b"]);
  });
});
