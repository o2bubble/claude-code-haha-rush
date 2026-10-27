// 挂件标题栏文字 —— 多开实例时靠它区分「这个挂件是哪个工作区的哪个会话」。
// 纯函数，锁住截断与路径解析（Windows 反斜杠最容易写错）。

import { describe, it, expect } from "vitest";
import {
  formatWidgetTitle,
  widgetWorkspaceName,
  WIDGET_SESSION_MAX_CHARS,
  WIDGET_WORKSPACE_MAX_CHARS,
} from "./widgetTitle";

describe("widgetWorkspaceName", () => {
  it("Windows 反斜杠路径取最后一段", () => {
    expect(widgetWorkspaceName("C:\\Storage\\work\\docs")).toBe("docs");
  });

  it("POSIX 斜杠路径取最后一段", () => {
    expect(widgetWorkspaceName("/home/u/project")).toBe("project");
  });

  it("尾部斜杠不影响结果", () => {
    expect(widgetWorkspaceName("C:\\Storage\\work\\docs\\")).toBe("docs");
    expect(widgetWorkspaceName("/home/u/project/")).toBe("project");
  });

  it("空值 → 空串（不是 'undefined'）", () => {
    expect(widgetWorkspaceName(undefined)).toBe("");
    expect(widgetWorkspaceName(null)).toBe("");
    expect(widgetWorkspaceName("")).toBe("");
  });

  it("只有根路径时不返回空段", () => {
    expect(widgetWorkspaceName("C:\\")).toBe("C:");
    expect(widgetWorkspaceName("/")).toBe("/");
  });
});

describe("formatWidgetTitle", () => {
  it("工作区 + 会话 → 「工作区 · 会话」", () => {
    expect(formatWidgetTitle("C:\\Storage\\work\\docs", "修一下登录", "Claude Code"))
      .toBe("docs · 修一下登录");
  });

  it("只有工作区 → 只显示工作区", () => {
    expect(formatWidgetTitle("C:\\Storage\\work\\docs", undefined, "Claude Code")).toBe("docs");
  });

  it("只有会话 → 只显示会话", () => {
    expect(formatWidgetTitle(undefined, "修一下登录", "Claude Code")).toBe("修一下登录");
  });

  it("都没有 → fallback", () => {
    expect(formatWidgetTitle(undefined, undefined, "Claude Code")).toBe("Claude Code");
  });

  it("会话名超长按挂件宽度截断并加省略号", () => {
    const long = "这是一个非常非常长的会话标题需要被截断否则会把工作区名挤出去";
    const out = formatWidgetTitle("C:\\w\\docs", long, "Claude Code");
    const sessionPart = out.split(" · ")[1];
    expect(sessionPart.endsWith("…")).toBe(true);
    expect(sessionPart.length).toBe(WIDGET_SESSION_MAX_CHARS + 1); // +1 是省略号
    // 工作区部分必须完整保留 —— 截断会话正是为了不挤掉它
    expect(out.startsWith("docs · ")).toBe(true);
  });

  it("工作区名超长也截断", () => {
    const longWs = "a".repeat(WIDGET_WORKSPACE_MAX_CHARS + 10);
    const out = formatWidgetTitle(`C:\\w\\${longWs}`, undefined, "Claude Code");
    expect(out.length).toBe(WIDGET_WORKSPACE_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("空白会话名当作没有（不留「 · 」）", () => {
    expect(formatWidgetTitle("C:\\w\\docs", "   ", "Claude Code")).toBe("docs");
  });
});
