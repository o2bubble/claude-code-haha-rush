import { describe, it, expect } from "vitest";
import { formatWindowTitle, DEFAULT_WINDOW_TITLE } from "./windowTitle";

// 多实例时任务栏靠窗口标题区分（见 windowTitle.ts 的注释）。
// 这里锁住组装规则 —— 尤其「工作区在前」这条：Windows 任务栏从**尾部截断**，
// 工作区名才是区分实例的第一要素，不能被长会话名挤出去。

const FALLBACK = DEFAULT_WINDOW_TITLE;

describe("formatWindowTitle", () => {
  it("工作区 + 会话 → 工作区在前、会话在后", () => {
    expect(formatWindowTitle("C:\\Storage\\claude-code-haha-dev", "粘贴路径识别", FALLBACK))
      .toBe("claude-code-haha-dev · 粘贴路径识别");
  });

  it("只有工作区 → 只显示工作区名", () => {
    expect(formatWindowTitle("C:\\Storage\\proj", undefined, FALLBACK)).toBe("proj");
  });

  it("都没有 → 退回应用默认名", () => {
    expect(formatWindowTitle(undefined, undefined, FALLBACK)).toBe(FALLBACK);
    expect(formatWindowTitle("", "", FALLBACK)).toBe(FALLBACK);
  });

  it("只有会话名（未绑工作区）→ 默认名 · 会话名", () => {
    // 未绑工作区是启动早期的短暂状态，保留会话信息比裸默认名有用
    expect(formatWindowTitle(undefined, "新会话", FALLBACK)).toBe(`${FALLBACK} · 新会话`);
  });

  it("工作区路径取最后一段（含正反斜杠与尾斜杠）", () => {
    expect(formatWindowTitle("C:/Storage/work/proj", undefined, FALLBACK)).toBe("proj");
    expect(formatWindowTitle("C:\\Storage\\work\\proj\\", undefined, FALLBACK)).toBe("proj");
  });

  it("会话名首尾空白被裁剪；纯空白视为无会话名", () => {
    expect(formatWindowTitle("C:\\p", "  会话  ", FALLBACK)).toBe("p · 会话");
    expect(formatWindowTitle("C:\\p", "   ", FALLBACK)).toBe("p");
  });

  it("超长会话名被截断（不挤掉工作区名）", () => {
    const long = "很长的会话标题".repeat(20);
    const out = formatWindowTitle("C:\\p", long, FALLBACK);
    expect(out.startsWith("p · ")).toBe(true);
    expect(out.length).toBeLessThan(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("恰好等于上限时不截断（边界）", () => {
    const exact = "x".repeat(50);
    const out = formatWindowTitle("p", exact, FALLBACK);
    expect(out).toBe(`p · ${exact}`);
    expect(out.endsWith("…")).toBe(false);
  });
});

describe("formatWindowTitle — 顺序可配置（设置 → 通用 的「窗口标题顺序」）", () => {
  it("workspace-first（缺省）→ 工作区在前", () => {
    expect(formatWindowTitle("C:\\Storage\\proj", "会话名", FALLBACK)).toBe("proj · 会话名");
    expect(formatWindowTitle("C:\\Storage\\proj", "会话名", FALLBACK, "workspace-first"))
      .toBe("proj · 会话名");
  });

  it("session-first → 会话在前", () => {
    expect(formatWindowTitle("C:\\Storage\\proj", "会话名", FALLBACK, "session-first"))
      .toBe("会话名 · proj");
  });

  it("顺序只影响「两者都有」时的拼接（单项与空态不受影响）", () => {
    // 只有一项时不该因顺序产生差异 —— 否则「切顺序」会让标题莫名变形
    expect(formatWindowTitle("C:\\p", undefined, FALLBACK, "session-first")).toBe("p");
    expect(formatWindowTitle(undefined, "会话", FALLBACK, "session-first")).toBe(`${FALLBACK} · 会话`);
    expect(formatWindowTitle(undefined, undefined, FALLBACK, "session-first")).toBe(FALLBACK);
  });

  it("session-first 时长会话名同样被截断（不挤掉工作区名）", () => {
    const out = formatWindowTitle("p", "很长的会话标题".repeat(20), FALLBACK, "session-first");
    expect(out.startsWith("很长的")).toBe(true);
    expect(out.endsWith("· p")).toBe(true);
    expect(out.length).toBeLessThan(80);
  });
});
