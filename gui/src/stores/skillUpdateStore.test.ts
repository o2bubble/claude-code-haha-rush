import { describe, it, expect, beforeEach, vi } from "vitest";

// ── skillUpdateStore：跨标签共享的更新状态 ──
//
// 2026-10-26 用户反馈两个问题，这里各锁一条：
//   ① 「更新后徽标还在」—— 装完没重算哈希
//   ② 「首次进入面板应该请求一次」—— 拉取逻辑原本在「市场」标签页内部，
//      默认停在「已安装」时那个组件没挂载 → 永远不请求

// mock 掉 Tauri + 网络（store 里是动态 import 的）
const listPackages = vi.fn();
const invoke = vi.fn();

vi.mock("../services/skillMarketplace", () => ({
  skillMarketplace: {
    listPackages: (...a: unknown[]) => listPackages(...a),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { skillUpdateStore } from "./skillUpdateStore";

const pkg = (slug: string, hashes: Record<string, string>, exclude?: string[]) => ({
  slug, name: slug, description: "", author: "x", version: "1.0.0",
  tags: [], download_count: 0, skill_count: Object.keys(hashes).length,
  skill_hashes: hashes,
  hash_exclude: exclude,
});

beforeEach(() => {
  skillUpdateStore.reset();
  listPackages.mockReset();
  invoke.mockReset();
});

describe("load()", () => {
  it("拉取市场列表 + 算本地哈希 → 状态正确", async () => {
    listPackages.mockResolvedValue([
      pkg("p1", { a: "AAA", b: "BBB" }),
    ]);
    invoke.mockResolvedValue({ a: "AAA", b: "OLD" }); // a 一致、b 过期

    await skillUpdateStore.load();

    expect(skillUpdateStore.get()).toEqual({ a: "up-to-date", b: "outdated" });
    expect(skillUpdateStore.getPackages()).toHaveLength(1);
  });

  it("只把「线上有哈希」的技能名传给本地计算（别全扫）", async () => {
    listPackages.mockResolvedValue([
      pkg("p1", { a: "AAA" }, ["templates"]),
      pkg("p2", { c: "CCC" }),
    ]);
    invoke.mockResolvedValue({});

    await skillUpdateStore.load();

    const args = invoke.mock.calls[0];
    expect(args[0]).toBe("local_skill_hashes");
    // 只算 a、c —— 本地装了别的技能也不管
    expect(new Set(args[1].skills)).toEqual(new Set(["a", "c"]));
    // 排除名单要带上（否则哈希对不上）
    expect(args[1].exclude).toContain("templates");
  });

  it("并发调用只发一次请求（切页签不重复拉）", async () => {
    listPackages.mockResolvedValue([pkg("p1", { a: "A" })]);
    invoke.mockResolvedValue({ a: "A" });

    await Promise.all([
      skillUpdateStore.load(),
      skillUpdateStore.load(),
      skillUpdateStore.load(),
    ]);

    expect(listPackages).toHaveBeenCalledTimes(1);
  });

  it("请求失败 → 记录错误，不崩", async () => {
    listPackages.mockRejectedValue(new Error("网络炸了"));

    await skillUpdateStore.load();

    expect(skillUpdateStore.getError()).toContain("网络炸了");
    expect(skillUpdateStore.isLoading()).toBe(false);
  });

  it("本地哈希算不出来 → 保留旧状态，不当成「全都没装」", async () => {
    // 先成功算一次
    listPackages.mockResolvedValue([pkg("p1", { a: "AAA" })]);
    invoke.mockResolvedValue({ a: "OLD" });
    await skillUpdateStore.load();
    expect(skillUpdateStore.get().a).toBe("outdated");

    // 再算失败 —— 状态不该变成 not-installed / 空
    invoke.mockRejectedValue(new Error("磁盘错误"));
    await skillUpdateStore.load();

    expect(skillUpdateStore.get().a).toBe("outdated");
    expect(skillUpdateStore.get().a).not.toBe("not-installed");
  });

  it("首次就失败 → 空状态（没有旧值可保留）", async () => {
    listPackages.mockResolvedValue([pkg("p1", { a: "AAA" })]);
    invoke.mockRejectedValue(new Error("磁盘错误"));

    await skillUpdateStore.load();

    expect(skillUpdateStore.get()).toEqual({});
  });
});

describe("refreshLocal()（装完更新后重算）", () => {
  it("更新后状态从 outdated 变 up-to-date —— 徽标消失", async () => {
    // 第一次：本地是旧内容
    listPackages.mockResolvedValue([pkg("p1", { a: "NEW" })]);
    invoke.mockResolvedValue({ a: "OLD" });
    await skillUpdateStore.load();
    expect(skillUpdateStore.get().a).toBe("outdated");

    // 用户点了更新 → 本地变成新内容
    invoke.mockResolvedValue({ a: "NEW" });
    await skillUpdateStore.refreshLocal();

    expect(skillUpdateStore.get().a).toBe("up-to-date");
  });

  it("refreshLocal 不重新拉线上列表（只重算本地）", async () => {
    listPackages.mockResolvedValue([pkg("p1", { a: "NEW" })]);
    invoke.mockResolvedValue({ a: "OLD" });
    await skillUpdateStore.load();
    expect(listPackages).toHaveBeenCalledTimes(1);

    await skillUpdateStore.refreshLocal();
    expect(listPackages).toHaveBeenCalledTimes(1); // 仍然只拉过一次
  });

  it("还没 load 过就 refreshLocal → 什么都不做（不崩）", async () => {
    await expect(skillUpdateStore.refreshLocal()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("订阅广播", () => {
  it("状态变化会通知订阅者", async () => {
    const fn = vi.fn();
    const unsub = skillUpdateStore.subscribe(fn);

    listPackages.mockResolvedValue([pkg("p1", { a: "A" })]);
    invoke.mockResolvedValue({ a: "A" });
    await skillUpdateStore.load();

    expect(fn).toHaveBeenCalled();
    unsub();
  });
});
