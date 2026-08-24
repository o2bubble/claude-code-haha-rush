// ── 消息区搜索纯函数 ──

import { describe, it, expect } from "vitest";
import { searchMessages, cycleMatch } from "./messageSearch";

const msgs = [
  { content: "你好，请重构 auth 模块。" },
  { content: "Build succeeded. 构建通过。" },
  { content: "auth 模块重构完成，auth 测试已通过。" },
  { content: "" },
];

describe("searchMessages", () => {
  it("空 query 返回空", () => {
    expect(searchMessages(msgs, "   ")).toEqual([]);
  });

  it("大小写不敏感匹配", () => {
    const r = searchMessages([{ content: "Hello Auth" }], "auth");
    expect(r.length).toBe(1);
    expect(r[0].index).toBe(0);
  });

  it("一条消息多个命中各成一条结果", () => {
    const r = searchMessages([{ content: "auth auth auth" }], "auth");
    expect(r.length).toBe(3);
    expect(r.every((x) => x.index === 0)).toBe(true);
  });

  it("跨消息命中并带上下文片段", () => {
    const r = searchMessages(msgs, "auth");
    // msg0 "…auth 模块" 1 次 + msg2 "auth 模块…auth 测试" 2 次 = 3
    expect(r.length).toBe(3);
    expect(r.filter((x) => x.index === 2).length).toBe(2);
    expect(r[0].snippet).toContain("auth");
  });

  it("无命中返回空", () => {
    expect(searchMessages(msgs, "不存在的词xyz")).toEqual([]);
  });
});

describe("cycleMatch", () => {
  it("下一个循环", () => {
    expect(cycleMatch(0, 3, 1)).toBe(1);
    expect(cycleMatch(2, 3, 1)).toBe(0);
  });
  it("上一个循环", () => {
    expect(cycleMatch(0, 3, -1)).toBe(2);
    expect(cycleMatch(2, 3, -1)).toBe(1);
  });
  it("零结果安全", () => {
    expect(cycleMatch(0, 0, 1)).toBe(0);
  });
});
