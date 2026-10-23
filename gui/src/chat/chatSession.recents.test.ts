// 「最近」MRU 的记录接线（chatSession.dispatch → saveSettings）。
//
// 单独成文件的原因：这里需要 mock settingsStore，而 chatSession.test.ts 用的是
// 真实 settingsStore（会话切换还依赖它的 permissionMode 等）。混在一起容易误伤。
//
// 锁住的契约：sessionId 变化 = 打开了一个会话 → 记进工作区作用域的 MRU；
// 同一会话重复下发不重复写盘。

import { describe, it, expect, beforeEach, vi } from "vitest";

const settingsMock = vi.hoisted(() => {
  const state: Record<string, any> = {
    recentSessions: [] as Array<{ id: string; openedAt: number }>,
    recentSessionMax: 25,
    permissionMode: "default",
  };
  return {
    state,
    getSettings: () => state,
    updateSettings: vi.fn(),
    saveSettings: vi.fn(async (patch: Record<string, any>, _scope?: string) => {
      Object.assign(state, patch);
    }),
  };
});

vi.mock("../stores/settingsStore", () => settingsMock);

import { createChatSession } from "./chatSession";
import { emptyChatState } from "./chatReduce";
import { replaceState } from "../stores/chatStore";

class FakeWebSocket {
  static OPEN = 1;
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
  settingsMock.state.recentSessions = [];
  settingsMock.state.recentSessionMax = 25;
  settingsMock.updateSettings.mockClear();
  settingsMock.saveSettings.mockClear();
});

function openSession() {
  const s = createChatSession();
  s.connect(9001);
  const ws = FakeWebSocket.instances[0];
  ws._open();
  return { s, ws };
}

describe("「最近」MRU —— dispatch 里的记录时机", () => {
  it("sessionId 变化 → 写入工作区作用域的 MRU", () => {
    const { ws } = openSession();
    ws._msg({ type: "session_loaded", session_id: "s1", messages: [] });

    expect(settingsMock.saveSettings).toHaveBeenCalledTimes(1);
    const [patch, scope] = settingsMock.saveSettings.mock.calls[0];
    expect(scope).toBe("workspace");
    expect(patch.recentSessions).toHaveLength(1);
    expect(patch.recentSessions[0].id).toBe("s1");
    expect(typeof patch.recentSessions[0].openedAt).toBe("number");
  });

  it("同一会话重复下发 → 不重复写盘", () => {
    const { ws } = openSession();
    ws._msg({ type: "session_loaded", session_id: "s1", messages: [] });
    ws._msg({ type: "current_session", session_id: "s1" });
    ws._msg({ type: "session_loaded", session_id: "s1", messages: [] });

    expect(settingsMock.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("切到另一会话 → 置顶且保留历史", () => {
    const { ws } = openSession();
    ws._msg({ type: "session_loaded", session_id: "s1", messages: [] });
    ws._msg({ type: "session_loaded", session_id: "s2", messages: [] });

    expect((settingsMock.state.recentSessions as Array<{ id: string }>).map((e) => e.id)).toEqual(["s2", "s1"]);
  });

  it("尊重设置里的上限（超出的旧记录被淘汰）", () => {
    settingsMock.state.recentSessionMax = 2;
    settingsMock.state.recentSessions = [
      { id: "old1", openedAt: 1 },
      { id: "old2", openedAt: 2 },
    ];
    const { ws } = openSession();
    ws._msg({ type: "session_loaded", session_id: "fresh", messages: [] });

    expect((settingsMock.state.recentSessions as Array<{ id: string }>).map((e) => e.id)).toEqual(["fresh", "old1"]);
  });

  it("上限被写成非法值时钳到默认（25）而不是崩", () => {
    settingsMock.state.recentSessionMax = NaN;
    const { ws } = openSession();
    ws._msg({ type: "session_loaded", session_id: "s1", messages: [] });
    const [patch] = settingsMock.saveSettings.mock.calls[0];
    expect(patch.recentSessions).toHaveLength(1);
  });
});
