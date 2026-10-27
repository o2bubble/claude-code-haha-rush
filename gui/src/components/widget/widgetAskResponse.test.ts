// 挂件内回答 AskUserQuestion 的应答载荷 —— 跨窗口契约，两窗之间没有类型检查，
// 只有这里能锁住字段形状（写错的症状是"点了没反应"/"AI 收到空答案"）。

import { describe, it, expect } from "vitest";
import { buildAskAnswerPayload, buildAskSkipPayload } from "./widgetAskResponse";

const req = {
  request_id: "req-1",
  tool_input: {
    questions: [
      { question: "用哪个方案？", header: "方案", options: [], multiSelect: false },
    ],
    // 除 questions 外的字段也要原样带回
    some_other_field: 42,
  },
};

describe("buildAskAnswerPayload", () => {
  it("带回 requestId（主窗靠它做一次性校验，丢了响应会被丢弃）", () => {
    const p = buildAskAnswerPayload(req, { "用哪个方案？": "A" }, {});
    expect(p.requestId).toBe("req-1");
    expect(p.allowed).toBe(true);
    expect(p.always).toBe(false);
  });

  it("answers/annotations 合并进 updatedInput，且保留原有 tool_input 字段", () => {
    const p = buildAskAnswerPayload(req, { "用哪个方案？": "A" }, { "用哪个方案？": { notes: "理由" } });
    const input = p.updatedInput as Record<string, unknown>;
    expect(input.answers).toEqual({ "用哪个方案？": "A" });
    expect(input.annotations).toEqual({ "用哪个方案？": { notes: "理由" } });
    expect(input.some_other_field).toBe(42);
    expect(Array.isArray(input.questions)).toBe(true);
  });

  it("tool_input 缺失时不崩，answers 仍然带出", () => {
    const p = buildAskAnswerPayload({ request_id: "r" }, { q: "a" }, {});
    expect(p.updatedInput).toEqual({ answers: { q: "a" }, annotations: {} });
  });

  it("request 为 null 时不崩", () => {
    const p = buildAskAnswerPayload(null, {}, {});
    expect(p.requestId).toBeUndefined();
    expect(p.updatedInput).toEqual({ answers: {}, annotations: {} });
  });

  it("tool_input 是非对象（畸形数据）→ 当成空对象，不把数组/字符串摊进答案", () => {
    const p = buildAskAnswerPayload({ request_id: "r", tool_input: ["oops"] }, { q: "a" }, {});
    expect(p.updatedInput).toEqual({ answers: { q: "a" }, annotations: {} });
  });
});

describe("buildAskSkipPayload", () => {
  it("拒绝执行且不带 updatedInput", () => {
    const p = buildAskSkipPayload(req);
    expect(p).toEqual({ requestId: "req-1", allowed: false, always: false });
    expect(p.updatedInput).toBeUndefined();
  });
});
