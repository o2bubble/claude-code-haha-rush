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

  it("① 意图通路：先抑制自动加载、再收列表 → 只开目标会话", async () => {
    // 生产时序（App.handleIntentLaunch，**顺序是契约**）：
    //   ① setIntentTargeted(true)   ← 必须**早于**启动后端（慢机器上顺序会反转）
    //   ② 绑工作区 → 后端连上 → session_list 到达
    //   ③ launchIntentSession(target)
    // 若 ① 晚于 ②（原来是 `.then()` 不等），列表一到就自动开了"最近会话"，
    // 目标再叠上去 → 用户看到跳两次、且可能停在错的那个。
    const s = createChatSession();
    s.connect(8003);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    s.setIntentTargeted(true);        // ①（App 侧已改为 await 后再启后端）
    ws._msg({                          // ② 列表到达 —— 此时自动加载必须被抑制
      type: "session_list",
      sessions: [
        { sessionId: "latest", title: "最近", timestamp: 99 },
        { sessionId: "target", title: "目标", timestamp: 1 },
      ],
    });
    s.launchIntentSession("target");   // ③
    await new Promise((r) => setTimeout(r, 50));

    const resumedIds = ws.sent
      .filter((d) => d.includes("resume_session"))
      .map((d) => JSON.parse(d).session_id);
    expect(resumedIds).toContain("target");
    // 抑制生效：不得把"最近会话"也 resume 进来
    expect(resumedIds.filter((id) => id === "latest")).toHaveLength(0);
  });

  it("② 后端闪断重连后，意图目标会被**重发**（不因连接断开而丢失）", async () => {
    // 真正的症状：慢机器上 GUI 的 WS 常比后端先就绪 → 首连失败/闪断 →
    // 那条 resume_session 打在死连接上丢了 → 重连后**没人重发** →
    // 「进了工作区但没加载目标会话」（用户原话）。
    //
    // ⚠️ 断言必须**正向**（目标被 resume）。只断言"没跳最近"是抓不住的：
    // 抑制逻辑本身就能满足它，即使目标压根没发出去 —— 那种测试是假绿。
    const s = createChatSession();
    s.connect(8004);
    let ws = FakeWebSocket.instances[0];
    ws._open();
    s.launchIntentSession("target");

    // 闪断 → 重连（新连接）
    ws.close();
    s.connect(8004);
    ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws._open();

    const resumedIds = ws.sent
      .filter((d) => d.includes("resume_session"))
      .map((d) => JSON.parse(d).session_id);
    // 新连接上必须收到目标（否则就是"进了工作区没加载会话"）
    expect(resumedIds).toContain("target");

    // 且不得把"最近会话"顶上来
    expect(resumedIds.filter((id) => id === "latest")).toHaveLength(0);
  });
});

describe("ChatSession — awaitSessionListThenLoad（事件驱动，用户干预让位）", () => {
  // 用户 2026-10-21 实测的两条体验问题，各自一条回归：
  //   ① 列表出来后才延迟加载（App 侧 300ms 轮询 + useChatBridge 500ms 定时器）
  //   ② 等待期间手动切了会话，之后仍被切回目标
  const resumedIds = (ws: FakeWebSocket) =>
    ws.sent.filter((d) => d.includes("resume_session")).map((d) => JSON.parse(d).session_id);

  it("① 会话列表一到达就立刻加载目标（不等轮询/定时器）", async () => {
    const s = createChatSession();
    s.connect(8005);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p = s.awaitSessionListThenLoad("target", 60_000);
    // 注册时立即主动拉列表（不依赖 useChatBridge 的 500ms 定时器）
    expect(ws.sent.some((d) => d.includes("list_sessions"))).toBe(true);
    expect(resumedIds(ws)).toHaveLength(0);

    ws._msg({
      type: "session_list",
      sessions: [{ sessionId: "target", title: "目标", timestamp: 1 }],
    });

    await expect(p).resolves.toBe("loaded");
    expect(resumedIds(ws)).toContain("target");
  });

  it("② 等待期间用户手动切了会话 → 放弃目标，不把他切回去", async () => {
    const s = createChatSession();
    s.connect(8006);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p = s.awaitSessionListThenLoad("target", 60_000);
    // 用户在此期间自己点了别的会话（switchSession 内部就是这两步）
    s.preemptPendingTargetLoad();
    await expect(p).resolves.toBe("preempted");

    // 列表随后才到 —— 不得再把用户切回 target
    ws._msg({
      type: "session_list",
      sessions: [
        { sessionId: "target", title: "目标", timestamp: 1 },
        { sessionId: "user-pick", title: "用户选的", timestamp: 2 },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resumedIds(ws)).not.toContain("target");
  });

  it("③ 超时 → 放弃（不会无限期守着旧意图）", async () => {
    const s = createChatSession();
    s.connect(8007);
    FakeWebSocket.instances[0]._open();

    await expect(s.awaitSessionListThenLoad("target", 30)).resolves.toBe("timeout");
  });

  it("⑤ ensureRequested 只在目标真正发出时触发", async () => {
    // (a) 正常兑现
    const s1 = createChatSession();
    s1.connect(8009);
    const ws1 = FakeWebSocket.instances[0];
    ws1._open();
    const fired: string[] = [];
    const p1 = s1.awaitSessionListThenLoad("target", 60_000, () => fired.push("req"));
    expect(fired).toHaveLength(0);
    ws1._msg({ type: "session_list", sessions: [{ sessionId: "target", timestamp: 1 }] });
    await expect(p1).resolves.toBe("loaded");
    expect(fired).toEqual(["req"]);
  });

  it("⑤b 让位时不触发 ensureRequested（否则发起方误以为已送达）", async () => {
    const s2 = createChatSession();
    s2.connect(8010);
    const ws2 = FakeWebSocket.instances[0];
    ws2._open();
    const fired2: string[] = [];
    const p2 = s2.awaitSessionListThenLoad("target2", 60_000, () => fired2.push("req"));
    s2.preemptPendingTargetLoad(); // 列表尚未到达 → 用户先手选
    await expect(p2).resolves.toBe("preempted");
    expect(fired2).toHaveLength(0);
  });

  it("④ 列表已就绪 → 同步立即加载（无等待）", async () => {
    const s = createChatSession();
    s.connect(8008);
    const ws = FakeWebSocket.instances[0];
    ws._open();
    ws._msg({ type: "session_list", sessions: [{ sessionId: "latest", title: "L", timestamp: 1 }] });

    const outcome = await s.awaitSessionListThenLoad("target", 60_000);
    expect(outcome).toBe("loaded");
    expect(resumedIds(ws)).toContain("target");
    // 立即路径同样要有加载反馈 —— 会话加载在装了 SessionStart 插件的机器上
    // 要 5~6 秒，没有遮罩就是"ready 后等半天毫无反应"（2026-10-23 用户实测）。
    expect(getChatState().switchingTo).toBe("target");
    expect(getChatState().waitingForSessionList).toBe(false);
  });

  // 用户 2026-10-23：「空白期用户一脸茫然，不知道在干嘛」
  it("⑥ 等待期有可见提示，加载成功后收尾", async () => {
    const { getStatusMessages } = await import("../stores/statusMsgStore");

    const s = createChatSession();
    s.connect(8011);
    const ws = FakeWebSocket.instances[0];
    ws._open();

    const p = s.awaitSessionListThenLoad("target", 60_000);
    // 等待期间：遮罩可见 + 明确是"等列表"（不是"在切换"）
    expect(getChatState().switchingTo).toBe("target");
    expect(getChatState().waitingForSessionList).toBe(true);

    ws._msg({ type: "session_list", sessions: [{ sessionId: "target", timestamp: 1 }] });
    await expect(p).resolves.toBe("loaded");
    // 列表到了 → 进入"加载中"阶段
    expect(getChatState().waitingForSessionList).toBe(false);

    // 目标真正加载完 → 一条成功提示
    ws._msg({ type: "session_loaded", session_id: "target", messages: [] });
    expect(getStatusMessages().some((m) => m.text === "会话已加载")).toBe(true);
    // 遮罩由 reducer 收掉，不会一直转
    expect(getChatState().switchingTo).toBeNull();
  });

  it("⑥b 让位后不残留「等待」状态", async () => {
    const s = createChatSession();
    s.connect(8012);
    FakeWebSocket.instances[0]._open();

    const p = s.awaitSessionListThenLoad("target", 60_000);
    expect(getChatState().waitingForSessionList).toBe(true);

    s.preemptPendingTargetLoad();
    await expect(p).resolves.toBe("preempted");
    expect(getChatState().waitingForSessionList).toBe(false);
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
