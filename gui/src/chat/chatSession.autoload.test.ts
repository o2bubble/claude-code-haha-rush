// ── 自动加载最近会话：**工作区切换**场景 ──
//
// 用户实测（2026-10-26）：「明明没有其他相同工作区的实例，进入工作区还是不会
// 自动加载」。
//
// 契约：`is_first_instance` 是**按工作区**判定的（Rust 侧每次 bind_workspace
// 重算）。前端 `checkFirstInstance()` 却把它缓存成模块级常量 —— 第一个工作区
// 里若有别的实例（false），之后切到任何工作区都永远 false，再也不会自动加载。
//
// 每个用例都 `vi.resetModules()` 后重新 import，避免模块级缓存串味。

import { describe, it, expect, beforeEach, vi } from "vitest";

/** 可控的 Tauri invoke：`is_first_instance` 的返回值由测试指定。 */
const tauri = vi.hoisted(() => ({
  /** 当前工作区的判定结果（模拟 Rust 每次 bind 重算） */
  firstInstanceForCurrentWorkspace: true,
  calls: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    tauri.calls.push(cmd);
    if (cmd === "is_first_instance") return tauri.firstInstanceForCurrentWorkspace;
    return undefined;
  }),
}));

const settingsMock = vi.hoisted(() => {
  const state: Record<string, any> = {
    recentSessions: [],
    recentSessionMax: 25,
    permissionMode: "default",
    autoLoadLatestSession: true,
  };
  return {
    state,
    getSettings: () => state,
    updateSettings: vi.fn(),
    saveSettings: vi.fn(async (patch: Record<string, any>) => {
      Object.assign(state, patch);
    }),
  };
});

vi.mock("../stores/settingsStore", () => settingsMock);

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

const list = (id: string) => ({
  type: "session_list",
  sessions: [{ sessionId: id, title: id, timestamp: 1000 }],
});
const resumed = (ws: FakeWebSocket) =>
  ws.sent.filter((d) => d.includes("resume_session"));

/** 每个用例重新加载 chatSession（连同它的模块级 `_isFirstInstance` 缓存）。 */
async function freshSession() {
  vi.resetModules();
  const { createChatSession } = await import("./chatSession");
  const { emptyChatState } = await import("./chatReduce");
  const { replaceState } = await import("../stores/chatStore");
  replaceState(emptyChatState());
  return createChatSession();
}

beforeEach(() => {
  (globalThis as any).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  tauri.firstInstanceForCurrentWorkspace = true;
  tauri.calls.length = 0;
});

// ⚠️ 显式放宽超时：每个用例都要 `vi.resetModules()` 再**动态 import** 整个
// chatSession 模块图。单独跑 0.5s，但全量并行（89 个测试文件）时模块解析竞争
// 会让它涨到 5s 以上 —— 默认 5s 超时会偶发误报成"测试挂了"，其实只是慢。
const SLOW_MODULE_RELOAD = 20_000;

describe("自动加载最近会话 —— 工作区切换", () => {
  it("单工作区 + 首个实例 → 正常自动加载", async () => {
    const s = await freshSession();
    s.connect(9001);
    const ws = FakeWebSocket.instances[0];
    ws._open();
    ws._msg(list("s1"));

    await vi.waitFor(() => {
      expect(resumed(ws)).toHaveLength(1);
    });
    expect(resumed(ws)[0]).toContain('"session_id":"s1"');
  }, SLOW_MODULE_RELOAD);

  it("首个实例判定是**按工作区**的：切到没有其他实例的工作区仍应自动加载", async () => {
    const s = await freshSession();

    // ── 工作区 A：已有一个同工作区实例 → 本实例不是首个，跳过自动加载（正确）
    tauri.firstInstanceForCurrentWorkspace = false;
    s.connect(9001);
    const wsA = FakeWebSocket.instances[0];
    wsA._open();
    wsA._msg(list("a1"));
    await vi.waitFor(() => {
      expect(tauri.calls).toContain("is_first_instance");
    });
    expect(resumed(wsA)).toHaveLength(0);

    // ── 用户切换工作区 B：B 里没有别的实例 → Rust 重算为 true
    tauri.firstInstanceForCurrentWorkspace = true;
    s.connect(9002);
    const wsB = FakeWebSocket.instances[1];
    wsB._open();
    wsB._msg(list("b1"));

    await vi.waitFor(() => {
      expect(resumed(wsB)).toHaveLength(1);
    });
    expect(resumed(wsB)[0]).toContain('"session_id":"b1"');
  }, SLOW_MODULE_RELOAD);
});
