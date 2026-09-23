import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Hub 向叶子窗口镜像聊天状态时的**增量基线** ──
//
// 2026-09-22 用户实测：挂件（leaf）里 AI 回复出现**词内重复**（「你好你好」「需要需要」
// 「memsearchsearch」），而主窗正常 —— 因为主窗的 messages 是后端直给的权威源，
// 不走这条镜像。
//
// 根因：同一个内容被**两条路各发一次**
//   · `chat.message` —— 整条消息（含完整 content）→ 叶子 addMessage（按 id 去重）
//   · `chat.delta.text` —— 增量 → 叶子 updateLastAssistant（**纯追加、不去重**）
// 新消息首帧若已带内容，而增量基线还停在上一条消息的长度上，delta 就会算成**整段**
// → 追加一次 → 重复。
//
// 这里锁住"发完整条之后基线要跟着走"这条不变量。

const publish = vi.fn();
vi.mock("./crossWindowBus", () => ({
  crossWindowBus: {
    publish: (...a: unknown[]) => publish(...a),
    flush: vi.fn(),
    subscribe: vi.fn(),
    setBridgeOut: vi.fn(),
    getAllSticky: () => ({}),
  },
}));

/** 捕获 hub 注册的 CHAT_STATE_CHANGED 处理器。 */
let chatHandler: ((d: { state: unknown }) => void) | null = null;
vi.mock("./windowBus", () => ({
  windowBus: {
    on: vi.fn((evt: string, h: (d: { state: unknown }) => void) => {
      if (evt === "chat.state.changed") chatHandler = h;
      return () => {};
    }),
    emit: vi.fn(),
  },
}));
// Events 是常量表，hub 会用到很多键 —— 用 Proxy 兜底，只把 CHAT_STATE_CHANGED
// 映射成测试里可识别的名字，其余给个唯一字符串即可（这些分支本用例不驱动）。
vi.mock("./events", () => ({
  Events: new Proxy({}, {
    get: (_t, k) => (k === "CHAT_STATE_CHANGED" ? "chat.state.changed" : `evt.${String(k)}`),
  }),
}));
vi.mock("../stores/settingsStore", () => ({ getSettings: () => ({}) }));
vi.mock("../stores/desktopStore", () => ({ syncDesktopsFromBus: vi.fn(), getActiveDesktopId: () => "" }));

/** 造一条 assistant 消息。 */
const asst = (id: string, content: string, thinking = "") => ({
  id, role: "assistant", content, thinking, timestamp: 1,
});

/** 驱动一帧状态（hub 只关心 messages / streaming / sessionId）。 */
function frame(state: Record<string, unknown>) {
  chatHandler!({ state: { messages: [], streaming: false, sessionId: "s1", ...state } });
}

/** 取出所有 chat.delta.text 的文本。 */
function deltas(): string[] {
  return publish.mock.calls
    .filter((c) => c[0] === "chat.delta.text")
    .map((c) => (c[1] as { text: string }).text);
}

async function startHub() {
  vi.resetModules();
  chatHandler = null;
  const { startCrossWindowBusHub } = await import("./crossWindowBusHub");
  startCrossWindowBusHub();
  expect(chatHandler, "hub 应注册 CHAT_STATE_CHANGED 处理器").toBeTruthy();
}

describe("hub 镜像 — 增量基线（防叶子端重复追加）", () => {
  beforeEach(() => {
    publish.mockClear();
  });

  it("**新 assistant 消息首帧已带内容** → 不发 delta（那条已整条发过）", async () => {
    await startHub();
    publish.mockClear();

    // 新消息第一次出现，content 已经是 "你好"
    frame({ messages: [asst("m1", "你好")], streaming: true });

    // 整条发出去了……
    expect(publish.mock.calls.some((c) => c[0] === "chat.message")).toBe(true);
    // ……就不该再把同一段当增量发（否则叶子 addMessage + 追加 = 「你好你好」）
    expect(deltas()).toEqual([]);
  });

  it("后续 token 只发**新增部分**", async () => {
    await startHub();
    publish.mockClear();

    frame({ messages: [asst("m1", "你好")], streaming: true });   // 首帧
    frame({ messages: [asst("m1", "你好，世界")], streaming: true }); // 长出来了

    expect(deltas()).toEqual(["，世界"]);
  });

  it("回归：上一条消息很长、新消息首帧较短时**不重复**（旧实现在此处会整段重发）", async () => {
    await startHub();
    publish.mockClear();

    // 上一条 assistant 内容很长 → 旧基线会是一个大数字
    frame({ messages: [asst("m1", "x".repeat(100))], streaming: false });
    // 新消息首帧带内容
    frame({
      messages: [asst("m1", "x".repeat(100)), asst("m2", "短")],
      streaming: true,
    });

    // 关键：不能因为 slice(100) 得到 "" 就以为没事 —— 也不能反过来把"短"整段再发
    expect(deltas()).toEqual([]);
  });

  it("user 消息不影响 assistant 的基线（换人不重置）", async () => {
    await startHub();
    publish.mockClear();

    frame({ messages: [asst("m1", "abc")], streaming: false });
    frame({ messages: [asst("m1", "abc"), { id: "u1", role: "user", content: "问", timestamp: 2 }], streaming: true });
    // user 消息整条发出，但不该产生 delta（delta 只跟 assistant）
    expect(deltas()).toEqual([]);
    // 之后 assistant 继续长 → 仍从 abc 之后算增量
    frame({
      messages: [
        asst("m1", "abc"),
        { id: "u1", role: "user", content: "问", timestamp: 2 },
        asst("m2", "答"),
      ],
      streaming: true,
    });
    expect(deltas()).toEqual([]); // 新消息首帧已整条发过
  });
});
