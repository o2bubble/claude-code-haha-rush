// ── ChatSession runner tests ──
// Exercises the runner against a fake WebSocket: dispatch → fold → effect
// landing, message queue flush, leaf-mode fallback, and the resume_session
// one-shot guard. Each test uses a fresh createChatSession() instance.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createChatSession } from "./chatSession";
import { emptyChatState } from "./chatReduce";
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
