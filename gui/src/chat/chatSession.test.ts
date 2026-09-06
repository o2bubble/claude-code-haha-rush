// ── ChatSession runner tests ──
// Exercises the runner against a fake WebSocket: dispatch → fold → effect
// landing, message queue flush, leaf-mode fallback, and the resume_session
// one-shot guard. Each test uses a fresh createChatSession() instance.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createChatSession } from "./chatSession";
import { emptyChatState, isBackendBusy } from "./chatReduce";
import { getChatState, replaceState } from "../stores/chatStore";
import { _reset as resetTerminal, getEntries } from "../stores/terminalStore";
import { dataBus } from "../services/dataBus";

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

  it("leaf mode publishes cmd.* to the dataBus when there is no socket", () => {
    const s = createChatSession();
    const received: any[] = [];
    const unsub = dataBus.subscribe("cmd.interrupt", (payload, meta) => {
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
