// ── crossWindowBus 来源标记 + 命名空间通配测试 ──
// T0: publish 带 origin（区分内置 vs 插件来源）→ subscribe 的 meta 收到；
//     订阅支持 `plugin.<name>.*` 命名空间通配（FloatingApp subs 已加 plugin.*）。
//
// ⚠️ crossWindowBus 是模块级单例，跨 test 会互相污染（_stickyCache/_subscribers）——
// 用不同 topic 隔离场景，避免 beforeEach 重置遗漏。

import { describe, it, expect } from "vitest";
import { crossWindowBus } from "./crossWindowBus";

describe("crossWindowBus — origin 来源标记", () => {
  it("publish with origin passes it to subscriber meta", () => {
    let gotMeta: any = null;
    const unsub = crossWindowBus.subscribe("cmd.test.origin", (payload, meta) => {
      gotMeta = meta;
      expect(payload).toBe("hello");
    });
    crossWindowBus.publish("cmd.test.origin", "hello", { origin: "plugin-demo" });
    expect(gotMeta).not.toBeNull();
    expect(gotMeta.origin).toBe("plugin-demo");
    unsub();
  });

  it("publish without origin leaves meta.origin undefined (app events)", () => {
    let gotMeta: any = null;
    const unsub = crossWindowBus.subscribe("cmd.test.noorigin", (payload, meta) => {
      gotMeta = meta;
    });
    crossWindowBus.publish("cmd.test.noorigin", "x");
    expect(gotMeta).not.toBeNull();
    expect(gotMeta.origin).toBeUndefined();
    unsub();
  });
});

describe("crossWindowBus — plugin 命名空间通配", () => {
  it("subscribe(\"plugin.*\") receives plugin.<name>.<topic>", () => {
    let got: any = null;
    const unsub = crossWindowBus.subscribe("plugin.*", (payload) => {
      got = payload;
    });
    crossWindowBus.publish("plugin.demo.quotes", { price: 42 });
    expect(got).toEqual({ price: 42 });
    unsub();
  });

  it("subscription patterns with specific prefix keep working (chat.*)", () => {
    let got: any = null;
    const unsub = crossWindowBus.subscribe("chat.*", (payload) => {
      got = payload;
    });
    crossWindowBus.publish("chat.delta.test", { text: "hi" });
    expect(got).toEqual({ text: "hi" });
    unsub();
  });
});
