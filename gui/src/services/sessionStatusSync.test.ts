// ── 跨 GUI 会话状态同步 ──
//
// 用户 2026-10-23 实测：从会话列表「在新窗口打开」后，新窗口里**其他会话没有圆点**。
// 根因是快照查询依赖 Rust 端"当前已绑定工作区"（settings state），而前端
// `void BackendService.bind()` 是 fire-and-forget —— 快照请求可能先到，
// 此时 Rust 还停在启动时的全局 workDir（新窗口多半是另一个工作区）：
//   · 查到的是**别的工作区**的状态 → 存进来也匹配不上 → 没有圆点
//   · 而其他窗口此刻都是 idle，不会再发变更事件 → 永远学不到
//
// 契约（本文件锁住）：
//   ① 快照必须**带着本实例的工作区**去查（不能依赖 Rust 端尚未完成的绑定）
//   ② 即使后端/竞态返回了别的工作区的条目，也不能落进 store

import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("./windowBus", () => ({
  windowBus: { on: vi.fn(() => () => {}) },
}));

async function freshModule() {
  vi.resetModules();
  return import("./sessionStatusSync");
}

/** 等快照那次 invoke 及随后的 store 写入都落地。
 *  ⚠️ 单靠 `setTimeout(0)` 不够：tauriInvoke 里有动态 import + await 链，
 *  少于两轮宏任务时 store 可能还没被写入 —— 那样"断言为空"会**假通过**。 */
async function settleSnapshot() {
  await vi.waitFor(() => {
    expect(invokeMock.mock.calls.some((c) => c[0] === "get_session_statuses")).toBe(true);
  });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("startSessionStatusSync — 快照必须绑定到本实例的工作区", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  it("① 快照请求带上 workDir（不依赖 Rust 端尚未完成的绑定）", async () => {
    const { startSessionStatusSync } = await freshModule();
    startSessionStatusSync("C:/ws/mine");
    await settleSnapshot();

    const call = invokeMock.mock.calls.find((c) => c[0] === "get_session_statuses");
    expect(call, "应当请求过 get_session_statuses").toBeTruthy();
    expect(call?.[1]).toEqual({ workspace: "C:/ws/mine" });
  });

  it("② 别的工作区的条目不得落进 store", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_session_statuses") {
        return Promise.resolve([
          // 竞态下 Rust 可能返回启动时那个工作区的条目
          { session_id: "S-other", client_id: "gui-A", workspace: "C:/ws/other", state: "idle" },
        ]);
      }
      return Promise.resolve(undefined);
    });

    const { startSessionStatusSync } = await freshModule();
    // ⚠️ 必须在 resetModules 之后拿 store —— 否则读到的是旧模块实例，断言永远为空
    const { getSessionOpenElsewhere, getAllSessionStatuses } = await import("../stores/sessionStatusStore");
    startSessionStatusSync("C:/ws/mine");
    await settleSnapshot();

    expect(getAllSessionStatuses()).toHaveLength(0);
    expect(getSessionOpenElsewhere("S-other", "C:/ws/mine")).toHaveLength(0);
  });

  it("③ 本工作区的条目正常收录（别把功能一起关掉）", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_session_statuses") {
        return Promise.resolve([
          { session_id: "S1", client_id: "gui-B", workspace: "C:/ws/mine", state: "working" },
        ]);
      }
      return Promise.resolve(undefined);
    });

    const { startSessionStatusSync } = await freshModule();
    const { getSessionOpenElsewhere } = await import("../stores/sessionStatusStore");
    startSessionStatusSync("C:/ws/mine");
    await settleSnapshot();

    const hit = getSessionOpenElsewhere("S1", "C:/ws/mine");
    expect(hit).toHaveLength(1);
    expect(hit[0].state).toBe("working");
  });
});
