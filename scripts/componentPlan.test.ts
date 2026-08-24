// scripts/componentPlan.test.ts — 构建规划器的平台矩阵单测
// Prior art: guard.rs cfg(test) 裁决器 + guardBridge.test.ts 纯函数断言风格。
// 只测规划器外部行为（platform/selected/prevRelease → ComponentPlan[]），
// 不测执行器工具调用（那是真机集成验证）。

import { describe, it, expect } from "vitest";
import { planComponents, type PlanInput } from "./componentPlan";

function input(over: Partial<PlanInput>): PlanInput {
  return { platform: "windows", selected: null, prevRelease: null, ...over };
}
const allZips = { zipExists: () => true };
const noZips = { zipExists: () => false };

const actionOf = (plans: ReturnType<typeof planComponents>, name: string) =>
  plans.find((p) => p.name === name)!;

describe("全量构建（selected=null）", () => {
  it("windows: 全部组件 build", () => {
    const plans = planComponents(input({ platform: "windows" }));
    for (const p of plans) expect(p.action, p.name).toBe("build");
    // 产物形态
    expect(actionOf(plans, "gui").artifact).toBe("exe");
    expect(actionOf(plans, "claude").artifact).toBe("exe");
    expect(actionOf(plans, "extensions").artifact).toBe("dir");
    expect(actionOf(plans, "updater").artifact).toBe("exe");
  });

  it("macos: 决策表 — bun/tools/python/gui/claude/extensions build（自包含）, git system, updater skip", () => {
    const plans = planComponents(input({ platform: "macos" }));
    expect(actionOf(plans, "gui").action).toBe("build");
    expect(actionOf(plans, "gui").artifact).toBe("app");
    expect(actionOf(plans, "claude").action).toBe("build");
    expect(actionOf(plans, "claude").artifact).toBe("binary");
    expect(actionOf(plans, "extensions").action).toBe("build");
    expect(actionOf(plans, "extensions").artifact).toBe("dir");
    expect(actionOf(plans, "python").action).toBe("build");
    expect(actionOf(plans, "python").artifact).toBe("dir");
    expect(actionOf(plans, "bun").action).toBe("build");
    expect(actionOf(plans, "bun").artifact).toBe("binary");
    expect(actionOf(plans, "tools").action).toBe("build");
    expect(actionOf(plans, "tools").artifact).toBe("dir");
    expect(actionOf(plans, "git").action).toBe("system");
    expect(actionOf(plans, "git").artifact).toBe("none");
    expect(actionOf(plans, "updater").action).toBe("skip");
    expect(actionOf(plans, "updater").artifact).toBe("none");
  });

  it("macos: system 组件带 requiresMacTools（brew 包名）", () => {
    const plans = planComponents(input({ platform: "macos" }));
    expect(actionOf(plans, "git").requiresMacTools).toEqual(["git"]);
    // build/skip 组件不带（bun/tools/python 自包含非 brew，也不带）
    expect(actionOf(plans, "bun").requiresMacTools).toBeUndefined();
    expect(actionOf(plans, "tools").requiresMacTools).toBeUndefined();
    expect(actionOf(plans, "python").requiresMacTools).toBeUndefined();
    expect(actionOf(plans, "gui").requiresMacTools).toBeUndefined();
    expect(actionOf(plans, "updater").requiresMacTools).toBeUndefined();
  });

  it("windows: 不产生 requiresMacTools", () => {
    const plans = planComponents(input({ platform: "windows" }));
    for (const p of plans) expect(p.requiresMacTools, p.name).toBeUndefined();
  });
});

describe("选择性构建（--components）", () => {
  it("未选中的 build 组件且上一版本有 zip → reuse", () => {
    const plans = planComponents(input({
      platform: "macos",
      selected: new Set(["gui"]),
      prevRelease: allZips,
    }));
    expect(actionOf(plans, "gui").action).toBe("build");
    expect(actionOf(plans, "claude").action).toBe("reuse");
    expect(actionOf(plans, "extensions").action).toBe("reuse");
    expect(actionOf(plans, "bun").action).toBe("reuse");
    expect(actionOf(plans, "python").action).toBe("reuse");
    // system/skip 不受影响
    expect(actionOf(plans, "git").action).toBe("system");
    expect(actionOf(plans, "updater").action).toBe("skip");
  });

  it("未选中的 build 组件且无上一版本 → 保持 build", () => {
    const plans = planComponents(input({
      platform: "windows",
      selected: new Set(["gui"]),
      prevRelease: noZips,
    }));
    expect(actionOf(plans, "gui").action).toBe("build");
    expect(actionOf(plans, "claude").action).toBe("build");
    expect(actionOf(plans, "extensions").action).toBe("build");
  });

  it("macos: 显式选中 updater 仍为 skip、git 仍为 system（平台语义优先）", () => {
    const plans = planComponents(input({
      platform: "macos",
      selected: new Set(["updater", "git"]),
      prevRelease: allZips,
    }));
    expect(actionOf(plans, "updater").action).toBe("skip");
    expect(actionOf(plans, "git").action).toBe("system");
  });

  it("windows: 未选中组件上一版本有 zip → reuse", () => {
    const plans = planComponents(input({
      platform: "windows",
      selected: new Set(["gui"]),
      prevRelease: allZips,
    }));
    expect(actionOf(plans, "gui").action).toBe("build");
    expect(actionOf(plans, "claude").action).toBe("reuse");
    expect(actionOf(plans, "bun").action).toBe("reuse");
    expect(actionOf(plans, "updater").action).toBe("reuse");
  });
});

describe("prevRelease 边界", () => {
  it("prevRelease=null 时无 reuse 回退", () => {
    for (const platform of ["windows", "macos"] as const) {
      const plans = planComponents(input({
        platform,
        selected: new Set(["gui"]),
        prevRelease: null,
      }));
      expect(plans.every((p) => p.action !== "reuse"), platform).toBe(true);
    }
  });
});
