// ── linkOpen — 链接打开裁决纯函数 ──
// 给定 href + 事件修饰，裁决外部链接应如何处理（内置窗口/系统浏览器/菜单/忽略）。
// 这是全功能唯一的决策接缝，点击委托与右键菜单共用。

import { describe, it, expect } from "vitest";
import { resolveLinkAction, isExternalHttpUrl, isNavigableHref } from "./linkOpen";

const plain: Parameters<typeof resolveLinkAction>[1] = { ctrl: false, meta: false, middle: false, right: false };
const ctrl: Parameters<typeof resolveLinkAction>[1] = { ctrl: true, meta: false, middle: false, right: false };
const meta: Parameters<typeof resolveLinkAction>[1] = { ctrl: false, meta: true, middle: false, right: false };
const middle: Parameters<typeof resolveLinkAction>[1] = { ctrl: false, meta: false, middle: true, right: false };
const right: Parameters<typeof resolveLinkAction>[1] = { ctrl: false, meta: false, middle: false, right: true };

describe("isExternalHttpUrl", () => {
  it("recognizes http/https absolute URLs", () => {
    expect(isExternalHttpUrl("http://example.com")).toBe(true);
    expect(isExternalHttpUrl("https://example.com/x?y=1#z")).toBe(true);
    expect(isExternalHttpUrl("HTTP://EXAMPLE.COM")).toBe(true);
  });
  it("rejects non-http schemes and malformed inputs", () => {
    expect(isExternalHttpUrl("mailto:a@b.c")).toBe(false);
    expect(isExternalHttpUrl("file:///C:/x")).toBe(false);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalHttpUrl("www.example.com")).toBe(false);
    expect(isExternalHttpUrl("/relative/path")).toBe(false);
  });
});

describe("isNavigableHref — 点击会触发顶层导航的 href", () => {
  it("http(s) and paths are navigable (must preventDefault)", () => {
    expect(isNavigableHref("https://example.com")).toBe(true);
    expect(isNavigableHref("/absolute/path")).toBe(true);
    expect(isNavigableHref("relative/path")).toBe(true);
    expect(isNavigableHref("../up/x")).toBe(true);
  });
  it("safe non-navigation schemes and empties are not navigable", () => {
    expect(isNavigableHref("mailto:a@b.c")).toBe(false);
    expect(isNavigableHref("tel:123")).toBe(false);
    expect(isNavigableHref("data:text/plain,hi")).toBe(false);
    expect(isNavigableHref("#section")).toBe(false);
    expect(isNavigableHref("")).toBe(false);
    expect(isNavigableHref(null)).toBe(false);
    expect(isNavigableHref(undefined)).toBe(false);
  });
});

describe("resolveLinkAction — 核心路径 (http(s) 左键 → 内置窗口)", () => {
  it("plain left-click on https URL → open_window", () => {
    expect(resolveLinkAction("https://example.com", plain)).toEqual({ kind: "open_window", url: "https://example.com" });
  });
  it("plain left-click on http URL → open_window", () => {
    expect(resolveLinkAction("http://example.com", plain)).toEqual({ kind: "open_window", url: "http://example.com" });
  });
  it("trims surrounding whitespace before judging", () => {
    expect(resolveLinkAction("  https://example.com  ", plain).kind).toBe("open_window");
  });
});

describe("resolveLinkAction — 忽略 (非外部链接不动)", () => {
  it("mailto: → ignore", () => {
    expect(resolveLinkAction("mailto:a@b.c", plain)).toEqual({ kind: "ignore" });
  });
  it("relative path → ignore", () => {
    expect(resolveLinkAction("/docs/guide", plain)).toEqual({ kind: "ignore" });
    expect(resolveLinkAction("docs/guide", plain)).toEqual({ kind: "ignore" });
  });
  it("local file path → ignore", () => {
    expect(resolveLinkAction("file:///C:/x.txt", plain)).toEqual({ kind: "ignore" });
    expect(resolveLinkAction("C:\\x\\y.txt", plain)).toEqual({ kind: "ignore" });
  });
  it("null/empty href → ignore", () => {
    expect(resolveLinkAction(null, plain)).toEqual({ kind: "ignore" });
    expect(resolveLinkAction(undefined, plain)).toEqual({ kind: "ignore" });
    expect(resolveLinkAction("", plain)).toEqual({ kind: "ignore" });
  });
});

describe("resolveLinkAction — 逃生口 (Ctrl/Cmd/中键 → 系统浏览器)", () => {
  it("ctrl+click on http URL → open_browser", () => {
    expect(resolveLinkAction("https://example.com", ctrl)).toEqual({ kind: "open_browser", url: "https://example.com" });
  });
  it("meta(Cmd)+click on http URL → open_browser", () => {
    expect(resolveLinkAction("https://example.com", meta)).toEqual({ kind: "open_browser", url: "https://example.com" });
  });
  it("middle-click on http URL → open_browser", () => {
    expect(resolveLinkAction("https://example.com", middle)).toEqual({ kind: "open_browser", url: "https://example.com" });
  });
  it("ctrl+click on non-http → ignore (non-http wins over modifier)", () => {
    expect(resolveLinkAction("mailto:a@b.c", ctrl)).toEqual({ kind: "ignore" });
  });
});

describe("resolveLinkAction — 右键菜单", () => {
  it("right-click on http URL → context_menu", () => {
    expect(resolveLinkAction("https://example.com", right)).toEqual({ kind: "context_menu", url: "https://example.com" });
  });
  it("right-click on non-http → ignore", () => {
    expect(resolveLinkAction("relative/path", right)).toEqual({ kind: "ignore" });
  });
});
