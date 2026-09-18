// ── panelRegistry 的契约测试 ──
//
// 这里钉的是一个**踩过的坑**（2026-09-18）：
//
//   命令面板的「面板」组原先读**静态**的 `ALL_PANEL_DEFS`，而插件面板是经
//   `rerenderPanel()` 注册进**运行时 Map** 的 → 插件面板「在下拉里能开，
//   在命令面板搜不到」。修法：数据源改用 `getAllPanels()`。
//
// 本文件钉两层：
//   ① 行为契约：运行时注册的面板（插件走这条）能被 getAllPanels() 拿到，
//      且经 buildPanelItems 后能进命令面板（= 修复的效果）
//   ② 防回归：useCommandPalette 的数据源必须仍是 getAllPanels()（源码断言 ——
//      "接线正确性"没有别的测法；这条 bug 本质就是接错线）

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  registerPanel,
  rerenderPanel,
  unregisterPanel,
  getAllPanels,
  getPanel,
} from "./panelRegistry";
import { buildPanelItems } from "../utils/commandPaletteItems";
import type { PanelDefinition } from "./panelRegistry";

/** 造一个最小可用的面板定义 */
function mkPanel(id: string, title: string, userManaged = true): PanelDefinition {
  return {
    id,
    title,
    icon: "grid3x3",
    defaultView: "main",
    views: [{ id: "main", title, render: () => null }],
    userManaged,
  };
}

/** 每个用例用独立 id —— 注册表是模块级单例，registerPanel 有 dup 保护 */
let seq = 0;
const uid = (base: string) => `${base}-t${++seq}`;

describe("panelRegistry — 运行时注册表", () => {
  it("registerPanel 后 getAllPanels() 能拿到（插件面板走这条路）", () => {
    const id = uid("plugin:demo:panel");
    registerPanel(mkPanel(id, "插件面板"));
    expect(getAllPanels().map((p) => p.id)).toContain(id);
    expect(getPanel(id)?.title).toBe("插件面板");
  });

  it("🔴 修复的效果：运行时注册的面板能进命令面板的 item 列表", () => {
    const id = uid("plugin:demo:manual");
    registerPanel(mkPanel(id, "功能手册"));
    // 这正是 useCommandPalette 里的那行表达式（数据源 = 运行时注册表）
    const items = buildPanelItems(getAllPanels(), () => false);
    const item = items.find((i) => i.id === `panel-${id}`);
    expect(item).toBeDefined();
    expect(item?.label).toBe("功能手册");
  });

  it("rerenderPanel 覆盖同名定义（插件重装新版本：文件更新但定义要跟着换）", () => {
    const id = uid("plugin:demo:panel");
    registerPanel(mkPanel(id, "旧标题"));
    rerenderPanel(mkPanel(id, "新标题"));
    expect(getPanel(id)?.title).toBe("新标题");
    expect(getAllPanels().filter((p) => p.id === id)).toHaveLength(1);   // 不产生重复条目
  });

  it("unregisterPanel 后 getAllPanels() 不再包含（插件禁用/卸载）", () => {
    const id = uid("plugin:demo:panel");
    registerPanel(mkPanel(id, "临时面板"));
    expect(getAllPanels().some((p) => p.id === id)).toBe(true);
    unregisterPanel(id);
    expect(getAllPanels().some((p) => p.id === id)).toBe(false);
  });

  it("dup 保护：同名重复 registerPanel 被忽略（不覆盖已注册的定义）", () => {
    const id = uid("plugin:demo:panel");
    registerPanel(mkPanel(id, "第一次"));
    registerPanel(mkPanel(id, "第二次"));   // 预期 console.warn 并被忽略
    expect(getPanel(id)?.title).toBe("第一次");
  });

  it("系统面板（userManaged:false）在注册表里，但被命令面板过滤掉", () => {
    const id = uid("plugin:demo:sys");
    registerPanel(mkPanel(id, "系统面板", false));
    expect(getAllPanels().some((p) => p.id === id)).toBe(true);   // 注册表里有
    const items = buildPanelItems(getAllPanels(), () => false);
    expect(items.some((i) => i.id === `panel-${id}`)).toBe(false); // 命令面板里没有
  });
});

describe("防回归 — 命令面板的数据源接线", () => {
  it("useCommandPalette 必须用 getAllPanels()，不能用静态 ALL_PANEL_DEFS", () => {
    const src = readFileSync(
      path.join(import.meta.dirname, "../components/useCommandPalette.ts"),
      "utf8",
    );
    // 必须：数据源是运行时注册表
    expect(src).toMatch(/buildPanelItems\(\s*getAllPanels\(\)/);
    // 禁止：把静态列表当数据源（插件面板不在里面 → 搜不到）
    expect(src).not.toMatch(/buildPanelItems\(\s*ALL_PANEL_DEFS/);
  });
});
