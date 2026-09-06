// ── pluginProcessBridge 纯函数测试 ──
// T3: processStatusMeta 归一化 + isProcessActive 判定。状态 store 经 listener 更新,
// 测试直接调纯函数 (不 mock Tauri listen)。

import { describe, it, expect } from "vitest";
import { processStatusMeta, isProcessActive } from "./pluginProcessBridge";

describe("processStatusMeta — 状态归一化", () => {
  it("maps each status to label+color", () => {
    expect(processStatusMeta("running")).toEqual({ label: "running", color: "success" });
    expect(processStatusMeta("starting")).toEqual({ label: "starting", color: "accent" });
    expect(processStatusMeta("error")).toEqual({ label: "error", color: "error" });
    expect(processStatusMeta("killed")).toEqual({ label: "killed", color: "muted" });
    expect(processStatusMeta("stopped")).toEqual({ label: "stopped", color: "muted" });
    expect(processStatusMeta("unknown-state")).toEqual({ label: "stopped", color: "muted" });
  });
});

describe("isProcessActive — 面板订阅判定", () => {
  it("true for running/starting, false for stopped/error/killed", () => {
    expect(isProcessActive({ processId: "p", status: "running" })).toBe(true);
    expect(isProcessActive({ processId: "p", status: "starting" })).toBe(true);
    expect(isProcessActive({ processId: "p", status: "stopped" })).toBe(false);
    expect(isProcessActive({ processId: "p", status: "error" })).toBe(false);
    expect(isProcessActive({ processId: "p", status: "killed" })).toBe(false);
  });
});
