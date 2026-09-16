// ── pluginCommandBridge 纯逻辑测试 ──
// T4: 命令执行(双写) + 事件转发(订阅 Events → 转发 plugin.<name>.event.<event>)。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { windowBus } from "./windowBus";
import { Events } from "./events";
import {
  executePluginCommand,
  startPluginEventForwarding,
  stopPluginEventForwarding,
} from "./pluginCommandBridge";
import { setActiveManifests, clearActiveManifests, pluginCommandId, pluginCommandTopic, pluginEventTopic, type PluginManifest } from "./pluginRegistry";
import { crossWindowBus } from "./crossWindowBus";

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    pluginName: "demo",
    displayName: "demo",
    version: "1.0.0",
    apiVersion: "1.0",
    contributes: {
      panels: [],
      commands: [{ id: "refresh", title: "刷新", onInvoke: "refresh" }],
      events: ["chat.stateChanged"],
      mcpTools: [],
    },
    processes: [],
    category: "tool",
    dependencies: [],
    installType: "standard",
    runtimes: [],
    platforms: [],
    settings: {},
    ...overrides,
  };
}

describe("plugin 工具函数", () => {
  it("pluginCommandId 前缀防撞", () => {
    expect(pluginCommandId("demo", "refresh")).toBe("plugin:demo:refresh");
  });

  it("pluginCommandTopic / pluginEventTopic", () => {
    expect(pluginCommandTopic("demo", "refresh")).toBe("plugin.demo.command.refresh");
    expect(pluginEventTopic("demo", "chat.message.sent")).toBe("plugin.demo.event.chat.message.sent");
  });
});

describe("executePluginCommand — 双写", () => {
  it("eventBus 收到命令；crossWindowBus 收到同一 topic", () => {
    const emitted = vi.fn();
    const busHandler = vi.fn();
    windowBus.onRaw(pluginCommandTopic("demo", "refresh"), emitted);
    const unsub = crossWindowBus.subscribe(pluginCommandTopic("demo", "refresh"), busHandler);

    executePluginCommand("demo", "refresh", "refresh", { repo: "x" });

    expect(emitted).toHaveBeenCalledWith({
      command: "refresh",
      plugin: "demo",
      onInvoke: "refresh",
      args: { repo: "x" },
    });
    expect(busHandler).toHaveBeenCalledWith(
      { command: "refresh", plugin: "demo", onInvoke: "refresh", args: { repo: "x" } },
      expect.objectContaining({ origin: "app" }),
    );
    unsub();
  });

  it("无 args 且无 onInvoke 时均为 null", () => {
    const emitted = vi.fn();
    windowBus.onRaw(pluginCommandTopic("demo", "refresh"), emitted);
    executePluginCommand("demo", "refresh");
    expect(emitted).toHaveBeenCalledWith({ command: "refresh", plugin: "demo", onInvoke: null, args: null });
  });
});

describe("startPluginEventForwarding — 事件转发", () => {
  beforeEach(() => {
    clearActiveManifests();
    stopPluginEventForwarding();
    crossWindowBus._reset();
  });

  afterEach(() => {
    clearActiveManifests();
    stopPluginEventForwarding();
    crossWindowBus._reset();
  });

  it("订阅声明的 Events 值并转发", () => {
    setActiveManifests([
      makeManifest({ contributes: { panels: [], commands: [], events: ["chat.stateChanged"], mcpTools: [] } }),
    ]);
    startPluginEventForwarding();

    const received = vi.fn();
    const unsub = crossWindowBus.subscribe(pluginEventTopic("demo", "chat.stateChanged"), received);

    windowBus.emit(Events.CHAT_STATE_CHANGED, { state: { ok: true } });

    expect(received).toHaveBeenCalledWith(
      { state: { ok: true } },
      expect.objectContaining({ origin: "app" }),
    );
    unsub();
  });

  it("忽略不在 Events 枚举值的事件", () => {
    setActiveManifests([
      makeManifest({ contributes: { panels: [], commands: [], events: ["nonexistent.event"], mcpTools: [] } }),
    ]);
    startPluginEventForwarding();

    const received = vi.fn();
    crossWindowBus.subscribe("plugin.demo.event.nonexistent.event", received);
    windowBus.emit(Events.CHAT_STATE_CHANGED, { state: {} });
    expect(received).not.toHaveBeenCalled();
  });

  it("stop 后不再转发", () => {
    setActiveManifests([makeManifest({ contributes: { panels: [], commands: [], events: ["chat.stateChanged"], mcpTools: [] } })]);
    startPluginEventForwarding();
    stopPluginEventForwarding();

    const received = vi.fn();
    const unsub = crossWindowBus.subscribe(pluginEventTopic("demo", "chat.stateChanged"), received);
    windowBus.emit(Events.CHAT_STATE_CHANGED, { state: {} });
    expect(received).not.toHaveBeenCalled();
    unsub();
  });
});
