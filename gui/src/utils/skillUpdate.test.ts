import { describe, it, expect } from "vitest";
import { skillUpdateState, countOutdated, packageUpdateState } from "./skillUpdate";

// ── 技能更新判定 ──
//
// 2026-10-26 用户反馈：「看不出哪些技能需要更新，面板也没有任何提示」。
// 根因是**根本没有更新检测** —— 本地装技能只复制文件、不记版本，
// 上游 SKILL.md 也大多没有 version 字段。
//
// 改成内容哈希比对（服务端算、客户端算、比字符串）。
// 这里锁住"什么情况算可更新"的判定，尤其别把"没装"误判成"可更新"。

describe("skillUpdateState", () => {
  it("本地没装 → not-installed（不是 outdated！）", () => {
    expect(skillUpdateState(undefined, "abc")).toBe("not-installed");
  });

  it("本地有、服务端没给哈希 → unknown（老服务端，不误报）", () => {
    expect(skillUpdateState("abc", undefined)).toBe("unknown");
  });

  it("哈希相同 → up-to-date", () => {
    expect(skillUpdateState("abc123", "abc123")).toBe("up-to-date");
  });

  it("哈希不同 → outdated", () => {
    expect(skillUpdateState("abc123", "def456")).toBe("outdated");
  });

  it("空字符串哈希按「没有」处理", () => {
    expect(skillUpdateState("", "abc")).toBe("not-installed");
    expect(skillUpdateState("abc", "")).toBe("unknown");
  });
});

describe("countOutdated", () => {
  const remote = { a: "A1", b: "B1", c: "C1" };

  it("只数「已装且内容不同」的", () => {
    const local = { a: "A1", b: "B0" }; // a 一致、b 过期、c 没装
    expect(countOutdated(["a", "b", "c"], local, remote)).toBe(1);
  });

  it("没装的技能不算过期（那是安装，不是更新）", () => {
    const local = { a: "A1" };
    expect(countOutdated(["a", "b", "c"], local, remote)).toBe(0);
  });

  it("全部过期 → 全数", () => {
    const local = { a: "x", b: "y", c: "z" };
    expect(countOutdated(["a", "b", "c"], local, remote)).toBe(3);
  });

  it("服务端没给哈希 → 0（无法判断就不提示）", () => {
    const local = { a: "x", b: "y" };
    expect(countOutdated(["a", "b"], local, undefined)).toBe(0);
  });

  it("服务端缺某个技能的哈希 → 跳过它，其余照算", () => {
    const local = { a: "x", b: "B0" };
    const partialRemote = { b: "B1" }; // 没有 a
    expect(countOutdated(["a", "b"], local, partialRemote)).toBe(1);
  });
});

describe("packageUpdateState（包级徽标）", () => {
  const remote = { a: "A1", b: "B1" };

  it("一个都没装 → not-installed", () => {
    expect(packageUpdateState(["a", "b"], {}, remote)).toBe("not-installed");
  });

  it("装了且全部一致 → up-to-date", () => {
    expect(packageUpdateState(["a", "b"], { a: "A1", b: "B1" }, remote)).toBe("up-to-date");
  });

  it("装了部分且一致 → up-to-date（没装的不算过期）", () => {
    expect(packageUpdateState(["a", "b"], { a: "A1" }, remote)).toBe("up-to-date");
  });

  it("任意一个过期 → outdated", () => {
    expect(packageUpdateState(["a", "b"], { a: "A1", b: "OLD" }, remote)).toBe("outdated");
  });

  it("装了但服务端没哈希 → unknown", () => {
    expect(packageUpdateState(["a"], { a: "A1" }, undefined)).toBe("unknown");
  });

  it("空包 → not-installed（不崩）", () => {
    expect(packageUpdateState([], {}, remote)).toBe("not-installed");
  });
});
