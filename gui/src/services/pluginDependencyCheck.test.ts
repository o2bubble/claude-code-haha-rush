// ── 插件依赖检查 ──
//
// 只测**纯判定** `decideDependencyReadiness`（不碰 IO）。
// 取数据那半（读 aiStatus / 查目录）留给集成时验证 —— 与 vitest 的动态 import
// mock 较劲不值得（见 pluginPanelBridge.test.ts 里我放弃那个用例的说明）。
//
// 判定的两类错误都会伤用户，两条都钉住：
//   · **误报未就绪** → 提示噪音，用户对提示脱敏
//   · **漏报** → 用户装了跑不起来的插件，只看到"插件坏了"

import { describe, it, expect } from "vitest";
import { decideDependencyReadiness, describeDependencyIssues } from "./pluginDependencyCheck";

describe("decideDependencyReadiness — standard 依赖", () => {
  it("standard 装了即就绪（包自带一切，无后续安装步骤）", () => {
    expect(decideDependencyReadiness(
      { pluginName: "foo", installType: "standard" },
      { aiStatus: undefined, anyRuntimeDirExists: false },
    )).toBeNull();
  });

  it("installType 缺失（老 manifest）按 standard 处理 → 就绪", () => {
    expect(decideDependencyReadiness(
      { pluginName: "foo" },
      { aiStatus: undefined, anyRuntimeDirExists: false },
    )).toBeNull();
  });
});

describe("decideDependencyReadiness — ai-guided 依赖", () => {
  const ng = { pluginName: "nodejs", installType: "ai-guided", runtimes: [{ path: "runtime" }] };

  it("aiStatus=ready → 就绪（最直接）", () => {
    expect(decideDependencyReadiness(ng, { aiStatus: "ready", anyRuntimeDirExists: false })).toBeNull();
  });

  it("aiStatus=error → 明确报「安装失败」（与「没装完」不同，用户可据此重试）", () => {
    const why = decideDependencyReadiness(ng, { aiStatus: "error", anyRuntimeDirExists: true });
    expect(why).toContain("失败");
  });

  it("🔴 aiStatus 缺失（GUI 重启后清空）+ runtime 目录在 → **就绪**", () => {
    // 这条最关键：没有它，每次重启后 nodejs 都被误判成未就绪 → 提示噪音
    expect(decideDependencyReadiness(ng, { aiStatus: undefined, anyRuntimeDirExists: true })).toBeNull();
  });

  it("aiStatus=not_ready + runtime 目录在 → 就绪（硬证据优先）", () => {
    expect(decideDependencyReadiness(ng, { aiStatus: "not_ready", anyRuntimeDirExists: true })).toBeNull();
  });

  it("无 aiStatus 且 runtime 目录不在 → 未就绪，且原因提到「运行时」", () => {
    const why = decideDependencyReadiness(ng, { aiStatus: undefined, anyRuntimeDirExists: false });
    expect(why).not.toBeNull();
    expect(why).toContain("运行时");
  });

  it("ai-guided 但没有 runtimes 声明（纯配置型，如 playwright-mcp）→ 只看 aiStatus", () => {
    const cfg = { pluginName: "playwright-mcp", installType: "ai-guided" };
    expect(decideDependencyReadiness(cfg, { aiStatus: "ready", anyRuntimeDirExists: false })).toBeNull();
    const why = decideDependencyReadiness(cfg, { aiStatus: undefined, anyRuntimeDirExists: false });
    expect(why).not.toBeNull();
    expect(why).toContain("配置");   // 用词区分于"运行时"（纯配置型不是缺运行时）
  });

  it("runtimes 为空数组等同于没有声明", () => {
    const cfg = { pluginName: "x", installType: "ai-guided", runtimes: [] };
    expect(decideDependencyReadiness(cfg, { aiStatus: "ready", anyRuntimeDirExists: false })).toBeNull();
    expect(decideDependencyReadiness(cfg, { aiStatus: undefined, anyRuntimeDirExists: true })).not.toBeNull();
  });
});

describe("describeDependencyIssues — 给用户看的文案", () => {
  it("无问题 → 空串", () => {
    expect(describeDependencyIssues({ missing: [], notReady: [], ok: true })).toBe("");
  });

  it("只缺依赖 → 提到「未安装」与依赖名", () => {
    const s = describeDependencyIssues({ missing: ["a", "b"], notReady: [], ok: false });
    expect(s).toContain("未安装");
    expect(s).toContain("a");
    expect(s).toContain("b");
  });

  it("只未就绪 → 带上原因", () => {
    const s = describeDependencyIssues({
      missing: [], notReady: [{ name: "nodejs", reason: "缺运行时" }], ok: false,
    });
    expect(s).toContain("nodejs");
    expect(s).toContain("缺运行时");
  });

  it("两类都有 → 都体现", () => {
    const s = describeDependencyIssues({
      missing: ["x"], notReady: [{ name: "y", reason: "r" }], ok: false,
    });
    expect(s).toContain("x");
    expect(s).toContain("y");
  });
});
