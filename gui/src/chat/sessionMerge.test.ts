// ── sessionMerge：程序合成消息（isMeta）的透传 ──
//
// 后端 `session_loaded` 里带 `isMeta: true` 的消息是**程序合成**的
// （恢复中断回合时补的 "Continue from where you left off."，见
// src/utils/conversationRecovery.ts）。它必须被渲染成"非用户发言"的样子，
// 所以这个标记不能在这一层丢掉 —— 丢了就成了普通用户气泡，看起来像
// 程序在替用户说话（用户 2026-10-29 实际反馈过）。
//
// 只测这条透传；合并/去重逻辑已有其他测试覆盖。

import { describe, it, expect } from "vitest";
import { mergeSessionMessages } from "./sessionMerge";

const user = (text: string, extra: Record<string, unknown> = {}) => ({
  uuid: `u-${text}`,
  type: "user",
  message: { role: "user", content: text },
  timestamp: "2026-10-29T00:00:00.000Z",
  ...extra,
});

describe("mergeSessionMessages — isMeta", () => {
  it("isMeta:true 透传到 ChatMessage", () => {
    const out = mergeSessionMessages([user("Continue from where you left off.", { isMeta: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].isMeta).toBe(true);
    expect(out[0].role).toBe("user");
  });

  it("普通用户消息不带 isMeta", () => {
    const out = mergeSessionMessages([user("你好")]);
    expect(out[0].isMeta).toBeUndefined();
  });

  it("isMeta:false 归一成 undefined（不把 false 一路带进 UI）", () => {
    const out = mergeSessionMessages([user("你好", { isMeta: false })]);
    expect(out[0].isMeta).toBeUndefined();
  });

  it("非布尔值当作没有（后端字段异常时不误判）", () => {
    const out = mergeSessionMessages([
      user("a", { isMeta: "true" }),
      user("b", { isMeta: 1 }),
      user("c", { isMeta: null }),
    ]);
    expect(out.map((m) => m.isMeta)).toEqual([undefined, undefined, undefined]);
  });

  it("assistant 消息带 isMeta 也不影响（只有 user 才有合成消息的场景）", () => {
    const out = mergeSessionMessages([
      {
        uuid: "a1",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
        timestamp: "2026-10-29T00:00:00.000Z",
      },
    ]);
    expect(out[0].isMeta).toBeUndefined();
  });
});
