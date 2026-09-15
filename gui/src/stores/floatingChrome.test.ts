// ── 浮窗外壳配置（FloatingChrome）──
// 核心不变量：**缺省 = 传统浮窗**（标题栏 + 不透明 + 可缩放）。
// 老持久化数据没有 chrome 字段，加载后必须仍是传统形态 —— 这条最要紧，
// 破了会让所有存量用户的浮窗一夜之间掉标题栏。

import { beforeEach, describe, it, expect } from "vitest";
import { resetLayout, serializeLayout, deserializeLayout, addFloatingPanel, getFloatingPanels, updateFloatingChrome } from "./layoutStore";
import { resolveChrome } from "../components/FloatingRenderer";
import type { TabGroup } from "../types/layout";

function group(): TabGroup {
  return {
    type: "group", id: "g", tabStyle: "tabs",
    tabs: [{ id: "t1", panelId: "plan", title: "Plan" }],
    activeTabId: "t1",
  };
}

beforeEach(() => {
  resetLayout();
});

describe("resolveChrome — 默认值语义", () => {
  it("undefined → 全 true（现有浮窗行为不变）", () => {
    expect(resolveChrome(undefined)).toEqual({
      titleBar: true, background: true, border: true, shadow: true, resizable: true,
    });
  });

  it("空对象 → 同 undefined", () => {
    expect(resolveChrome({})).toEqual(resolveChrome(undefined));
  });

  it("显式 false 生效，未指定的字段保持 true", () => {
    const c = resolveChrome({ titleBar: false, background: false });
    expect(c.titleBar).toBe(false);
    expect(c.background).toBe(false);
    expect(c.border).toBe(true);
    expect(c.shadow).toBe(true);
    expect(c.resizable).toBe(true);
  });

  it("无标题栏透明浮层的典型配置", () => {
    const c = resolveChrome({ titleBar: false, background: false, border: false, shadow: false, resizable: false });
    expect(c).toEqual({ titleBar: false, background: false, border: false, shadow: false, resizable: false });
  });
});

describe("FloatingWindow.chrome — 存取与持久化", () => {
  it("不传 chrome → 字段为 undefined（存量行为）", () => {
    addFloatingPanel(group(), 0, 0, 400, 300);
    expect(getFloatingPanels()[0].chrome).toBeUndefined();
  });

  it("chrome 随序列化 round-trip 保留", () => {
    addFloatingPanel(group(), 0, 0, 400, 300, { titleBar: false, background: false });
    const restored = deserializeLayout(serializeLayout() as never);
    expect(restored.floatingPanels[0].chrome).toEqual({ titleBar: false, background: false });
  });

  it("老持久化数据（无 chrome 字段）→ undefined，仍按传统浮窗渲染", () => {
    const legacy = {
      tree: { type: "group", id: "g", tabs: [], activeTabId: null },
      floatingPanels: [{
        type: "floating", id: "fp1", x: 0, y: 0, width: 400, height: 300, zIndex: 1000,
        group: { type: "group", id: "g1", tabs: [], activeTabId: null },
      }],
    };
    const restored = deserializeLayout(legacy as never);
    expect(restored.floatingPanels[0].chrome).toBeUndefined();
    expect(resolveChrome(restored.floatingPanels[0].chrome).titleBar).toBe(true);
  });
});

describe("updateFloatingChrome — 让 open-panel 幂等", () => {
  it("更新已开浮窗的外壳", () => {
    const id = addFloatingPanel(group(), 0, 0, 400, 300);
    expect(getFloatingPanels()[0].chrome).toBeUndefined();
    updateFloatingChrome(id, { titleBar: false, background: false });
    expect(getFloatingPanels()[0].chrome).toEqual({ titleBar: false, background: false });
  });

  it("传 undefined → 恢复传统浮窗（字段删除，非留空对象）", () => {
    const id = addFloatingPanel(group(), 0, 0, 400, 300, { titleBar: false });
    updateFloatingChrome(id, undefined);
    expect(getFloatingPanels()[0].chrome).toBeUndefined();
    expect(resolveChrome(getFloatingPanels()[0].chrome).titleBar).toBe(true);
  });

  it("不存在的 id → 无操作不抛错", () => {
    expect(() => updateFloatingChrome("nope", { titleBar: false })).not.toThrow();
  });

  it("更新后的外壳能过序列化 round-trip", () => {
    const id = addFloatingPanel(group(), 0, 0, 400, 300);
    updateFloatingChrome(id, { background: false, shadow: false });
    const restored = deserializeLayout(serializeLayout() as never);
    expect(restored.floatingPanels[0].chrome).toEqual({ background: false, shadow: false });
  });
});
