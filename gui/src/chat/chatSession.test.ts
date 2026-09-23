// ── ChatSession runner tests ──
// Exercises the runner against a fake WebSocket: dispatch → fold → effect
// landing, message queue flush, leaf-mode fallback, and the resume_session
// one-shot guard. Each test uses a fresh createChatSession() instance.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createChatSession } from "./chatSession";
import { emptyChatState, isBackendBusy } from "./chatReduce";
import { getChatState, replaceState } from "../stores/chatStore";
import { _reset as resetTerminal, getEntries } from "../stores/terminalStore";
import { crossWindowBus } from "../services/crossWindowBus";

const mocks = vi.hoisted(() => ({
  BackendService: {
    getState: vi.fn(),
    start: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("../services/backendService", () => mocks);

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  _open() {
    this.readyState = 1;
    this.onopen?.();
  }
  _msg(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

beforeEach(() => {
  (globalThis as any).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  replaceState(emptyChatState());
  resetTerminal();
});

describe("ChatSession — dispatch + effect landing", () => {
  it("applies a streamed message and lands terminal effects on real stores", () => {
    const s = createChatSession();
    s.connect(8000);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    ws._msg({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(getChatState().streaming).toBe(true);
    expect(getChatState().messages).toHaveLength(1);

    ws._msg({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } });
    expect(getEntries()).toHaveLength(1);
    expect(getEntries()[0]).toMatchObject({ toolUseId: "t1", command: "Bash" });
  });
});

describe("ChatSession — transport", () => {
  it("queues messages until the socket opens, then flushes", () => {
    const s = createChatSession();
    s.connect(8001);
    const ws = FakeWebSocket.instances[0];
    s.send("list_sessions");
    expect(ws.sent).toHaveLength(0);
    ws._open();
    expect(ws.sent.some((d) => d.includes('"type":"list_sessions"'))).toBe(true);
  });

  it("leaf mode publishes cmd.* to the crossWindowBus when there is no socket", () => {
    const s = createChatSession();
    const received: any[] = [];
    const unsub = crossWindowBus.subscribe("cmd.interrupt", (payload, meta) => {
      received.push({ payload, topic: meta?.topic });
    });
    s.send("interrupt");
    expect(received).toEqual([{ payload: {}, topic: "cmd.interrupt" }]);
    unsub();
  });
});

describe("ChatSession — send guard (not-ready)", () => {
  it("drops a user send when connected/sessionsLoaded are not ready (no bubble, no socket)", () => {
    const s = createChatSession();
    s.connect(8100);
    const ws = FakeWebSocket.instances[0];
    // 初始 emptyChatState(): connected=false, sessionsLoaded=false → 未就绪
    s.sendMessage("你好");
    expect(getChatState().messages).toHaveLength(0);
    expect(ws.sent).toHaveLength(0);
  });

  it("allows a user send once ready (connected && sessionsLoaded)", () => {
    replaceState({ ...emptyChatState(), connected: true, sessionsLoaded: true });
    const s = createChatSession();
    s.connect(8101);
    const ws = FakeWebSocket.instances[0];
    ws._open();
    s.sendMessage("你好");
    expect(getChatState().messages).toHaveLength(1);
    expect(ws.sent.some((d) => d.includes('"type":"user"'))).toBe(true);
  });
});

describe("ChatSession — onclose re-detect guard", () => {
  beforeEach(() => {
    mocks.BackendService.getState.mockReset();
    mocks.BackendService.start.mockClear();
  });

  it("does NOT re-kick BackendService.start() when a start/restart is already in flight", () => {
    mocks.BackendService.getState.mockReturnValue({
      status: "starting", port: 9001, workDir: "W",
    });
    const s = createChatSession();
    s.connect(9001);
    const ws = FakeWebSocket.instances[0];
    ws._open();
    ws.close(); // backend died mid-restart → onclose
    expect(mocks.BackendService.start).not.toHaveBeenCalled();
  });

  it("re-kicks BackendService.start() on unexpected death (status running)", () => {
    mocks.BackendService.getState.mockReturnValue({
      status: "running", port: 9002, workDir: "W",
    });
    const s = createChatSession();
    s.connect(9002);
    const ws = FakeWebSocket.instances[0];
    ws._open();
    ws.close();
    expect(mocks.BackendService.start).toHaveBeenCalledTimes(1);
  });
});

describe("ChatSession — session auto-resume", () => {
  it("resumes the latest session once per connection", async () => {
    const s = createChatSession();
    s.connect(8002);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    ws._msg({
      type: "session_list",
      sessions: [
        { sessionId: "a", title: "A", timestamp: 1 },
        { sessionId: "b", title: "B", timestamp: 2 },
      ],
    });
    // resume 是异步（先确认本实例是否为第一个 GUI 实例再发送），等待微任务落地
    await vi.waitFor(() => {
      expect(ws.sent.filter((d) => d.includes("resume_session"))).toHaveLength(1);
    });
    expect(ws.sent.some((d) => d.includes('"session_id":"b"'))).toBe(true);

    // A second session_list must NOT re-resume (one-shot guard)
    ws._msg({ type: "session_list", sessions: [{ sessionId: "a", title: "A", timestamp: 1 }] });
    await vi.waitFor(() => {
      expect(ws.sent.filter((d) => d.includes("resume_session"))).toHaveLength(1);
    });
  });
});

describe("ChatSession — backendBusy gate (authoritative busy beats optimistic streaming)", () => {
  it("interrupt 后 streaming 被乐观清 false 但 backendBusy 仍 true → sendMessage 入队不直发", () => {
    // 复现 bug: interrupt() 立即清 streaming，但后端 turn 未收尾 (busy=true)。
    // 若 gate 用 streaming 判"空闲"→ force 直发撞后端 "A prompt is already being processed"。
    // 改用 backendBusy 后: 仍忙 → 入队，不直发。
    replaceState({ ...emptyChatState(), connected: true, sessionsLoaded: true, streaming: false, backendBusy: true });
    expect(getChatState().backendBusy).toBe(true);
    const s = createChatSession();
    s.connect(8200);
    const ws = FakeWebSocket.instances[0];
    ws._open();
    s.sendMessage("醒词");
    expect(getChatState().messages).toHaveLength(0); // 未直发 → 无用户气泡
    expect(ws.sent.some((d) => d.includes('"type":"user"'))).toBe(false); // 未撞 busy
  });

  it("status:ready 送达 → backendBusy:false → 后续 sendMessage 直发", () => {
    replaceState({ ...emptyChatState(), connected: true, sessionsLoaded: true, backendBusy: true });
    const s = createChatSession();
    s.connect(8201);
    const ws = FakeWebSocket.instances[0];
    ws._open();
    // 后端 turn 收尾 → ready 广播, reducer 把 backendBusy 清 false
    ws._msg({ type: "status", status: "ready", busy: false });
    s.sendMessage("你好");
    expect(getChatState().messages).toHaveLength(1);
    expect(ws.sent.some((d) => d.includes('"type":"user"'))).toBe(true);
  });

  it("backendBusy undefined (初始化) 回落 streaming 旧行为", () => {
    // 后端尚无信号 → isBackendBusy 回落 streaming。streaming=true 时应入队不直发。
    // 不走 connect/onopen（其广播 status:connected 会清 streaming，干扰回落语义）。
    replaceState({ ...emptyChatState(), connected: true, sessionsLoaded: true, streaming: true, backendBusy: undefined });
    const s = createChatSession();
    s.sendMessage("你好");
    expect(getChatState().messages).toHaveLength(0); // 入队(无 activeSession) → 无用户气泡
  });
});

// ── 旁问（翻译按钮走的 /btw 通道）──
//
// 请求-响应式的独立通道：发 side_question（带 context_id），回 side_question_result。
// 用 context_id 把响应配回发起的那次调用 —— 所以要能并发（同时翻译多段），
// 且响应**绝不能进会话状态机**（它不是消息、不是状态变更）。
describe("ChatSession — 旁问（askSideQuestion）", () => {
  it("发出 side_question 并带上 question 与 context_id", async () => {
    const s = createChatSession();
    s.connect(8000);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p = s.askSideQuestion("translate this");
    const sent = ws.sent.map((d) => JSON.parse(d)).find((m) => m.type === "side_question");
    expect(sent).toBeTruthy();
    expect(sent.question).toBe("translate this");
    expect(typeof sent.context_id).toBe("string");
    expect(sent.context_id.length).toBeGreaterThan(0);

    // 收尾（否则 Promise 悬着，测试会留 pending 定时器）
    ws._msg({ type: "side_question_result", context_id: sent.context_id, response: "译文" });
    await expect(p).resolves.toEqual({ response: "译文", error: undefined });
  });

  it("按 context_id 匹配 —— 并发两个请求各拿各的结果", async () => {
    const s = createChatSession();
    s.connect(8000);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p1 = s.askSideQuestion("first");
    const p2 = s.askSideQuestion("second");
    const sent = ws.sent.map((d) => JSON.parse(d)).filter((m) => m.type === "side_question");
    expect(sent).toHaveLength(2);
    const [c1, c2] = [sent[0].context_id, sent[1].context_id];
    expect(c1).not.toBe(c2);

    // 故意**反序**回：先回第二个，验证不是靠到达顺序匹配
    ws._msg({ type: "side_question_result", context_id: c2, response: "B" });
    ws._msg({ type: "side_question_result", context_id: c1, response: "A" });
    await expect(p1).resolves.toEqual({ response: "A", error: undefined });
    await expect(p2).resolves.toEqual({ response: "B", error: undefined });
  });

  it("错误结果照常 resolve（带 error 字段）", async () => {
    const s = createChatSession();
    s.connect(8000);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p = s.askSideQuestion("q");
    const sent = ws.sent.map((d) => JSON.parse(d)).find((m) => m.type === "side_question");
    ws._msg({ type: "side_question_result", context_id: sent.context_id, error: "boom" });
    await expect(p).resolves.toEqual({ response: undefined, error: "boom" });
  });

  it("结果**不进会话状态机**（state 对象引用不变 = reducer 没跑）", async () => {
    // 这条断言方式很关键：一开始我写的是"消息数不变"，但红验证（去掉 dispatch 的
    // return）发现它**照样通过** —— chatReduce 对未知类型静默忽略，多跑一趟也看不出。
    // 改断言 **state 对象引用**：dispatch 只要走到 reducer 就一定 replaceState（换新对象），
    // 所以引用不变才能证明"真的在 reducer 之前被拦住了"。
    const s = createChatSession();
    s.connect(8000);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p = s.askSideQuestion("q");
    const sent = ws.sent.map((d) => JSON.parse(d)).find((m) => m.type === "side_question");
    const stateBefore = getChatState();
    ws._msg({ type: "side_question_result", context_id: sent.context_id, response: "译文" });
    await p;

    expect(getChatState()).toBe(stateBefore); // 同一对象 → 没进 reducer
  });

  it("不认识的 context_id 不会崩、也不误伤在等的请求", async () => {
    const s = createChatSession();
    s.connect(8000);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p = s.askSideQuestion("q");
    const sent = ws.sent.map((d) => JSON.parse(d)).find((m) => m.type === "side_question");
    // 乱入一条不匹配的
    ws._msg({ type: "side_question_result", context_id: "not-mine", response: "X" });
    // 真正的响应仍然能配上
    ws._msg({ type: "side_question_result", context_id: sent.context_id, response: "mine" });
    await expect(p).resolves.toEqual({ response: "mine", error: undefined });
  });
});
