import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 实例自述上报的**去重**是这里最要紧的性质：
// 调用方挂在 CHAT_STATE_CHANGED 上，而那个事件在流式输出时**每秒触发多次** ——
// 不去重就会每个 token 走一次动态 import + IPC + 文件写，把流式渲染拖垮。
//
// ⚠️ 测「值没变就不上报」必须**用假时钟跨过最小间隔**：
// 真实调用里两道闸（值去重 + 最小间隔）是叠加的，不推进时间的话
// 光靠最小间隔也能让断言通过 —— 那样测不出值去重这一层
// （我第一次写这测试就踩了：去掉值去重后测试仍是绿的）。

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

async function freshModule() {
  vi.resetModules();
  const m = await import("./instanceRegistry");
  m.__resetInstanceRegistryCache();
  return m;
}

describe("reportInstanceState — 去重与整体覆盖语义", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("值没变时完全不发 IPC —— 即使跨过了最小间隔", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "s1");
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // 模拟流式输出：同一状态被反复上报，每次都推进时间（越过最小间隔）
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(2000);
      reportInstanceState("C:/ws/a", "s1");
    }
    expect(invokeMock).toHaveBeenCalledTimes(1); // 只有第一次发了
  });

  it("未传的字段沿用上次的值（只改会话不会冲掉工作区）", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "s1");
    invokeMock.mockClear();

    vi.advanceTimersByTime(2000);
    reportInstanceState(undefined, "s2");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("update_instance_record", {
      workspace: "C:/ws/a",
      sessionId: "s2",
      keepSession: true, // 默认保留（会话为空时才起作用）
    });
  });

  it("切工作区 → 会话传空但**保留旧值**（作为过渡，等新会话加载后覆盖）", async () => {
    // 为什么保留而不是清空：切工作区时新会话还没加载，此时若把自述写成空，
    // 而"新会话加载完成"那次上报又可能被节流/不再触发 —— 自述里就永远没有会话了，
    // 升级后恢复的实例自然"只绑工作区、不开会话"（2026-09-22 用户实测）。
    // 保留旧值的代价只是"新工作区 + 旧会话 id"的短暂过渡，新会话一到就覆盖。
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "s1");
    invokeMock.mockClear();

    vi.advanceTimersByTime(2000);
    reportInstanceState("C:/ws/b");
    expect(invokeMock).toHaveBeenCalledWith("update_instance_record", {
      workspace: "C:/ws/b",
      sessionId: "",
      keepSession: true, // ← Rust 侧读回旧会话，不清空
    });
  });

  it("切工作区**之后**新会话加载完成 → 覆盖成新会话", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "s-old");
    vi.advanceTimersByTime(2000);
    reportInstanceState("C:/ws/b"); // 过渡态
    invokeMock.mockClear();

    vi.advanceTimersByTime(2000);
    reportInstanceState("C:/ws/b", "s-new");
    expect(invokeMock).toHaveBeenCalledWith("update_instance_record", {
      workspace: "C:/ws/b",
      sessionId: "s-new",
      keepSession: true,
    });
  });

  it("值在变但过于频繁时跳过（最小间隔保护）", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "s1");
    invokeMock.mockClear();

    // 不推进时间：值不同但太快 → 跳过
    reportInstanceState("C:/ws/a", "s2");
    expect(invokeMock).not.toHaveBeenCalled();

    // 等够时间后同一个值应被写出去
    vi.advanceTimersByTime(2000);
    reportInstanceState("C:/ws/a", "s2");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// ── 会话为空时保留（2026-09-22 用户实测"恢复了实例但没加载会话"）──
//
// 背景：调用方挂在 CHAT_STATE_CHANGED 上，而该事件在流式输出时**每个 token 都触发**，
// 期间 `sessionId` 可能短暂为 null（会话刚切/新建中/还没加载完）。照直写空 →
// 自述里没有会话 → 升级后"只绑工作区、不开会话"。
describe("reportInstanceState — 会话为空时保留旧值", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("会话为空 + 默认（keepSession）→ 交给 Rust 侧保留（传 sessionId:\"\" + keepSession:true）", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "s1");
    vi.advanceTimersByTime(2000);
    invokeMock.mockClear();

    // 模拟流式期间 sessionId 变成 null
    reportInstanceState("C:/ws/a", "");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("update_instance_record", {
      workspace: "C:/ws/a",
      sessionId: "",
      keepSession: true, // ← 关键：让 Rust 侧读回旧会话，而不是清空
    });
  });

  it("明确 keepSession:false（用户新建会话）→ 照实写空", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "s1");
    vi.advanceTimersByTime(2000);
    invokeMock.mockClear();

    reportInstanceState("C:/ws/a", "", { keepSession: false });
    expect(invokeMock).toHaveBeenCalledWith("update_instance_record", {
      workspace: "C:/ws/a",
      sessionId: "",
      keepSession: false,
    });
  });

  it("**被最小间隔拦下的上报会补发** —— 否则回合结束后不再有事件，那次上报永久丢失", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", ""); // 第一次（无节流）
    invokeMock.mockClear();

    // 100ms 后值变了但太频繁 → 被拦下，应排入补发
    vi.advanceTimersByTime(100);
    reportInstanceState("C:/ws/a", "s-target");
    expect(invokeMock).not.toHaveBeenCalled(); // 确实被拦了

    // 等过最小间隔 → 补发（这条正是"会话加载完成"那次上报的兜底）
    vi.advanceTimersByTime(1500);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("update_instance_record", {
      workspace: "C:/ws/a",
      sessionId: "s-target",
      keepSession: true,
    });
  });

  it("补发只发**最新**值（期间多次变化不重复发）", async () => {
    const { reportInstanceState } = await freshModule();
    reportInstanceState("C:/ws/a", "");
    invokeMock.mockClear();

    vi.advanceTimersByTime(100);
    reportInstanceState("C:/ws/a", "s1");
    reportInstanceState("C:/ws/a", "s2");
    reportInstanceState("C:/ws/a", "s3");
    vi.advanceTimersByTime(1500);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ sessionId: "s3" });
  });
});
