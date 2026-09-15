// ── FloatingRenderer — chrome 渲染分支 ──
// store 单测（floatingChrome.test.ts）只覆盖数据层；这里验证**实际渲染出来的东西**：
// 标题栏是否真的不渲染、透明/投影是否真的去掉、resize 把手是否真的消失。
// 用 react-dom/server 静态渲染（node 环境，无需 jsdom）—— 断言的是 DOM 结构，
// 不是「代码里有没有分支」。

import { beforeEach, beforeAll, describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import FloatingRenderer from "./FloatingRenderer";
import { resetLayout, addFloatingPanel } from "../stores/layoutStore";
import { registerPanel } from "../stores/panelRegistry";
import type { TabGroup, FloatingChrome } from "../types/layout";

beforeAll(() => {
  registerPanel({
    id: "chrome-probe-panel",
    title: "Probe",
    icon: "plan",
    defaultView: "main",
    views: [{ id: "main", title: "Probe", render: () => React.createElement("span", null, "PROBE_CONTENT") }],
  });
});

beforeEach(() => {
  resetLayout();
});

function group(): TabGroup {
  return {
    type: "group", id: "g", tabStyle: "tabs",
    tabs: [{ id: "t1", panelId: "chrome-probe-panel", title: "Probe", icon: "plan" }],
    activeTabId: "t1",
  };
}

function render(chrome?: FloatingChrome): string {
  addFloatingPanel(group(), 10, 10, 400, 300, chrome);
  return renderToStaticMarkup(React.createElement(FloatingRenderer));
}

// 标记物：dock 手柄 ⠿ 与关闭按钮都只出现在标题栏；resize 把手各带一个 cursor 值
const DOCK_HANDLE = "\u283F";
const CLOSE_BTN = 'aria-label="关闭"';
const NO_CHROME = { titleBar: false, background: false, border: false, shadow: false, resizable: false } as const;

describe("FloatingRenderer — 缺省 = 传统浮窗", () => {
  it("不传 chrome 时标题栏 / 背景 / 投影 / 缩放把手全在", () => {
    const html = render();
    expect(html).toContain(DOCK_HANDLE);
    expect(html).toContain(CLOSE_BTN);
    expect(html).toContain("background-color:var(--bg-root)");
    expect(html).toContain("box-shadow");
    expect(html).toContain("border:1px solid var(--border-medium)");
    expect(html).toContain("n-resize");
    expect(html).toContain("data-float-drag");
  });

  it("传空对象 → 外观与缺省一致", () => {
    const html = render({});
    expect(html).toContain(DOCK_HANDLE);
    expect(html).toContain("background-color:var(--bg-root)");
    expect(html).toContain("n-resize");
  });
});

describe("FloatingRenderer — 无标题栏", () => {
  it("标题栏不渲染（无 dock 手柄、无关闭按钮、无拖拽区标记）", () => {
    const html = render({ titleBar: false });
    expect(html).not.toContain(DOCK_HANDLE);
    expect(html).not.toContain(CLOSE_BTN);
    expect(html).not.toContain("data-float-drag");
  });

  it("内容照常渲染", () => {
    const html = render({ titleBar: false });
    expect(html).toContain("PROBE_CONTENT");
  });

  it("只关标题栏，背景/投影/缩放仍保留（互不牵连）", () => {
    const html = render({ titleBar: false });
    expect(html).toContain("background-color:var(--bg-root)");
    expect(html).toContain("box-shadow");
    expect(html).toContain("n-resize");
  });
});

describe("FloatingRenderer — 透明 / 无边框 / 无投影", () => {
  it("background:false → 外层无背景色", () => {
    expect(render({ background: false })).not.toContain("background-color:var(--bg-root)");
  });

  it("border:false → 外层无边框（标题栏的下边框不受影响）", () => {
    const html = render({ border: false });
    expect(html).not.toContain("border:1px solid");
    expect(html).toContain("border-bottom:1px solid"); // 标题栏自带，仍应保留
  });

  it("shadow:false → 无投影", () => {
    expect(render({ shadow: false })).not.toContain("box-shadow");
  });
});

describe("FloatingRenderer — 不可缩放", () => {
  it("resizable:false → 8 个方向的把手全部消失", () => {
    const html = render({ resizable: false });
    for (const c of ["n-resize", "e-resize", "s-resize", "w-resize"]) {
      expect(html).not.toContain(c);
    }
  });
});

describe("FloatingRenderer — 典型透明覆盖层（全关）", () => {
  it("外壳全部消失，只剩内容", () => {
    const html = render(NO_CHROME);
    expect(html).not.toContain(DOCK_HANDLE);
    expect(html).not.toContain("background-color:var(--bg-root)");
    expect(html).not.toContain("box-shadow");
    expect(html).not.toContain("border:1px solid");
    expect(html).not.toContain("n-resize");
    expect(html).toContain("PROBE_CONTENT");
  });
});
