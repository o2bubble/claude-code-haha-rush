// ── sessionMerge：程序消息（isMeta / 中断标记）的透传 ──
//
// 「程序替你说话」的消息有两类来源，都必须被渲染成"非用户发言"的样子，
// 否则看起来像程序在冒充用户（用户 2026-10-29 实际反馈过两次）：
//
//  ① **协议字段** `isMeta: true` —— 恢复中断回合时补的
//     "Continue from where you left off."（src/utils/conversationRecovery.ts）
//  ② **内容约定** `[Request interrupted by user]` —— 按 Esc 中断时写入，
//     ⚠️ **没有 isMeta 字段**（src/utils/messages.ts 的
//     createUserInterruptionMessage），只能按文本识别。
//     原生 TUI 也是这么判的（components/messages/UserTextMessage.tsx）。
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
  it("isMeta:true 透传到 ChatMessage，成因是 auto", () => {
    const out = mergeSessionMessages([user("Continue from where you left off.", { isMeta: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].isMeta).toBe(true);
    expect(out[0].metaKind).toBe("auto");
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

// ── ② 中断标记：没有 isMeta 字段，只能按内容识别 ──
//
// 这是用户 2026-10-29 第二次反馈的：截图里 `[Request interrupted by user]`
// 依然是蓝色用户气泡。根因是它**没有** isMeta —— 之前的实现只认字段。
describe("mergeSessionMessages — 中断标记（无 isMeta）", () => {
  it("`[Request interrupted by user]` 识别为 interrupt", () => {
    const out = mergeSessionMessages([user("[Request interrupted by user]")]);
    expect(out[0].isMeta).toBe(true);
    expect(out[0].metaKind).toBe("interrupt");
  });

  it("tool use 版本同样识别", () => {
    const out = mergeSessionMessages([user("[Request interrupted by user for tool use]")]);
    expect(out[0].isMeta).toBe(true);
    expect(out[0].metaKind).toBe("interrupt");
  });

  it("内容块数组形态（真实 jsonl 结构）也能识别", () => {
    const out = mergeSessionMessages([
      {
        uuid: "i1",
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
        timestamp: "2026-10-29T00:00:00.000Z",
      },
    ]);
    expect(out[0].metaKind).toBe("interrupt");
  });

  it("**只是包含**该文本不算 —— 用户可能引用它来提问（如本次对话）", () => {
    const out = mergeSessionMessages([
      user("[Request interrupted by user] 这是什么意思？"),
    ]);
    expect(out[0].isMeta).toBeUndefined();
  });

  it("工具输出里的同名文本不算（那是工具结果，不是用户发言）", () => {
    const out = mergeSessionMessages([
      {
        uuid: "t1",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "[Request interrupted by user]" }],
        },
        timestamp: "2026-10-29T00:00:00.000Z",
      },
    ]);
    // tool_result 不产生文本内容 → 该条被跳过，不会冒出一条假消息
    expect(out).toHaveLength(0);
  });

  it("isMeta 优先：带字段的仍算 auto，不被内容规则覆盖", () => {
    const out = mergeSessionMessages([
      user("[Request interrupted by user]", { isMeta: true }),
    ]);
    expect(out[0].metaKind).toBe("auto");
  });
});

// ── ③ 自动唤醒醒词：同样没有 isMeta，只能按设置里的醒词比文本 ──
//
// GUI 的 wakeStream() 走正常发送通道，后端把它当普通用户消息落盘。
// 不处理的话，重载历史后这条会变成蓝色用户气泡（用户 2026-10-29 截图里的第二条）。
describe("mergeSessionMessages — 自动唤醒醒词（无 isMeta）", () => {
  const WAKE = "消息流因未知原因卡死导致中断。请检查当前会话消息，如因本次中断导致还有未完成的内容，请继续。";

  it("命中默认醒词 → stall-wake", () => {
    const out = mergeSessionMessages([user(WAKE)], undefined, { stallWakePrompts: [WAKE] });
    expect(out[0].isMeta).toBe(true);
    expect(out[0].metaKind).toBe("stall-wake");
  });

  it("用户自定义醒词也能识别", () => {
    const custom = "继续，别停";
    const out = mergeSessionMessages([user(custom)], undefined, { stallWakePrompts: [WAKE, custom] });
    expect(out[0].metaKind).toBe("stall-wake");
  });

  it("未传醒词列表时按普通用户消息处理（保守，不误判）", () => {
    const out = mergeSessionMessages([user(WAKE)]);
    expect(out[0].isMeta).toBeUndefined();
  });

  it("只是相似但不相等的文本不算", () => {
    const out = mergeSessionMessages([user(WAKE + "（补充一句）")], undefined, { stallWakePrompts: [WAKE] });
    expect(out[0].isMeta).toBeUndefined();
  });

  it("首尾空白不影响判定（醒词常被复制粘贴）", () => {
    const out = mergeSessionMessages([user("  " + WAKE + "\n")], undefined, { stallWakePrompts: [WAKE] });
    expect(out[0].metaKind).toBe("stall-wake");
  });

  it("空醒词不会把正常消息误判成程序消息", () => {
    // 设置里没配自定义醒词时 `streamStallWakePrompt` 是 undefined，
    // runner 会传空串进列表 —— 不能因此把所有空消息都吞掉。
    const out = mergeSessionMessages([user("你好")], undefined, { stallWakePrompts: [""] });
    expect(out[0].isMeta).toBeUndefined();
  });
});

// ── ④ 自动续跑的续写：GUI 真发的那条，落盘后没有 isMeta ──
//
// 开启「自动续跑被中断的回合」后，GUI 会真发一条同文案（chatSession），
// 后端按普通 user 消息落盘。重载时若不识别，就会变成一个用户气泡。
describe("mergeSessionMessages — 自动续跑续写（无 isMeta）", () => {
  const PROMPT = "Continue from where you left off.";

  it("同文案识别为 resume", () => {
    const out = mergeSessionMessages([user(PROMPT)]);
    expect(out[0].isMeta).toBe(true);
    expect(out[0].metaKind).toBe("resume");
  });

  it("带 isMeta 的仍是 auto（后端合成的幻影消息，没真的跑过）", () => {
    const out = mergeSessionMessages([user(PROMPT, { isMeta: true })]);
    expect(out[0].metaKind).toBe("auto");
  });

  it("首尾空白不影响判定", () => {
    const out = mergeSessionMessages([user("  " + PROMPT + "\n")]);
    expect(out[0].metaKind).toBe("resume");
  });
});
