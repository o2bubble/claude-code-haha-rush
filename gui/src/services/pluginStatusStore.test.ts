import { describe, it, expect, beforeEach } from "vitest";
import {
  setPluginAiStatus, getPluginAiStatus, clearPluginAiStatuses,
} from "./pluginStatusStore";

beforeEach(() => clearPluginAiStatuses());

describe("pluginStatusStore — AI 上报的插件环境状态", () => {
  it("set + get round-trips with timestamp and detail", () => {
    setPluginAiStatus("nodejs", "ready", { version: "v22.14.0", verify: "node --version" });
    const s = getPluginAiStatus("nodejs");
    expect(s?.status).toBe("ready");
    expect(s?.detail?.version).toBe("v22.14.0");
    expect(typeof s?.reportedAt).toBe("number");
  });

  it("get returns undefined when never reported", () => {
    expect(getPluginAiStatus("never")).toBeUndefined();
  });

  it("later report overwrites earlier one", () => {
    setPluginAiStatus("nodejs", "not_ready", { reason: "downloading" });
    setPluginAiStatus("nodejs", "ready");
    expect(getPluginAiStatus("nodejs")?.status).toBe("ready");
  });

  it("rejects unknown status values", () => {
    expect(() => setPluginAiStatus("x", "banana" as never)).toThrow(/invalid status/);
  });

  it("rejects empty plugin name", () => {
    expect(() => setPluginAiStatus("", "ready")).toThrow(/name is required/);
  });

  it("clear empties all statuses (GUI 重启语义)", () => {
    setPluginAiStatus("a", "ready");
    clearPluginAiStatuses();
    expect(getPluginAiStatus("a")).toBeUndefined();
  });
});
