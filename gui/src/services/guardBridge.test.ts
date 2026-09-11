import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGuardStatus, guardActive, guardStart, guardStop, handleGuardAction,
  registerGuardChatApi, ACCEPT_TEXT, RESUME_TEXT, shouldReportTurnEnded,
  findLastReportableAssistant, isSuppressExpired,
} from "./guardBridge";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../stores/statusMsgStore", () => ({
  addStatusMessage: vi.fn(),
}));

// chatStore streaming/backendBusy 状态可控
let mockStreaming = false;
let mockBackendBusy: boolean | undefined = undefined;
vi.mock("../stores/chatStore", () => ({
  getChatState: () => ({ streaming: mockStreaming, backendBusy: mockBackendBusy, messages: [] }),
}));

const mockSend = vi.fn();
const mockRelease = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue({});
  mockStreaming = false;
  mockBackendBusy = undefined;
  registerGuardChatApi({ sendMessage: mockSend, releaseQueue: mockRelease });
  void guardStop(); // 回初始态(最终态 off)
});

afterEach(() => {
  vi.useRealTimers();
});

describe("guard status", () => {
  it("starts off and inactive", () => {
    expect(getGuardStatus()).toBe("off");
    expect(guardActive()).toBe(false);
  });
});

describe("handleGuardAction", () => {
  it("sendAccept sets asking and sends acceptance text", () => {
    handleGuardAction({ type: "sendAccept" });
    expect(getGuardStatus()).toBe("asking");
    expect(mockSend).toHaveBeenCalledWith(ACCEPT_TEXT);
    expect(ACCEPT_TEXT).toContain("DONE|完成");
  });

  it("sendResume sets watching and carries gaps", () => {
    handleGuardAction({ type: "sendResume", gaps: "文档没写完" });
    expect(getGuardStatus()).toBe("watching");
    expect(mockSend).toHaveBeenCalledWith(RESUME_TEXT("文档没写完"));
    expect(RESUME_TEXT("x")).toContain("x");
  });

  it("releaseNext releases the queue when idle", () => {
    handleGuardAction({ type: "releaseNext" });
    expect(getGuardStatus()).toBe("watching");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("releaseNext is skipped while agent is streaming (no message loss)", () => {
    mockStreaming = true;
    handleGuardAction({ type: "releaseNext" });
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("releaseNext is skipped when backendBusy=true even if streaming is false (interrupt desync)", () => {
    // interrupt() 乐观清 streaming→false 但后端 turn 未收尾 (backendBusy=true)。
    // 若只用 streaming 判"空闲"→ 放行 sendDrain 撞后端 busy 丢弃队首。
    // 改用 backendBusy 后: 仍忙 → 不放行。
    mockStreaming = false;
    mockBackendBusy = true;
    handleGuardAction({ type: "releaseNext" });
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("exit returns off", () => {
    handleGuardAction({ type: "sendAccept" });
    handleGuardAction({ type: "exit" });
    expect(getGuardStatus()).toBe("off");
    expect(guardActive()).toBe(false);
  });
});

describe("guardStart/Stop", () => {
  it("start enters watching optimistically", async () => {
    await guardStart();
    expect(getGuardStatus()).toBe("watching");
    expect(guardActive()).toBe(true);
  });
});

describe("readiness watcher decision", () => {
  it("reports on streaming true→false flip when dispatch is quiet", () => {
    expect(shouldReportTurnEnded(true, false, 3000, 0)).toBe(true);
  });

  it("does not report when streaming never flipped", () => {
    expect(shouldReportTurnEnded(false, false, 3000, 0)).toBe(false);
    expect(shouldReportTurnEnded(true, true, 3000, 0)).toBe(false);
    expect(shouldReportTurnEnded(undefined, false, 3000, 0)).toBe(false);
  });

  it("does not report within the 2s dedup window after dispatch report", () => {
    expect(shouldReportTurnEnded(true, false, 2000, 0)).toBe(false);
    expect(shouldReportTurnEnded(true, false, 3000, 1500)).toBe(false);
  });

  it("does not report when suppressed (interrupt optimistic flip is not a turn end)", () => {
    // interrupt() 乐观置 streaming=false 而后端 turn 仍 busy:
    // watcher 误报 → 验收 force 直发撞 busy("A prompt is already being processed")
    expect(shouldReportTurnEnded(true, false, 3000, 0, true)).toBe(false);
  });

  it("suppression only gates the false flip, not the working report", () => {
    // 抑制只影响上报判定; streaming 翻回 true(新回合)由 watcher 解除抑制
    expect(shouldReportTurnEnded(false, true, 3000, 0, true)).toBe(false); // 翻转判定本就不报
    expect(shouldReportTurnEnded(true, true, 3000, 0, true)).toBe(false);
  });

  it("suppress expiry unlocks the report (interrupt no-op fallback)", () => {
    // interrupt no-op(后端本就空闲) → 权威信号永不来 → 3s 过期后解除抑制,
    // watcher 恢复正常补报(此刻后端必然空闲, 不会撞 busy)
    expect(isSuppressExpired(true, 1000, 1000 + 2999)).toBe(false);
    expect(isSuppressExpired(true, 1000, 1000 + 3001)).toBe(true);
    expect(isSuppressExpired(false, 1000, 1000 + 3001)).toBe(false);
    // 过期后 shouldReportTurnEnded 不再被抑制
    expect(shouldReportTurnEnded(true, false, 5000, 0, false)).toBe(true);
  });
});

describe("findLastReportableAssistant", () => {
  it("returns the last assistant message when normal", () => {
    const msgs = [
      { id: "a1", role: "user", content: "hi" },
      { id: "a2", role: "assistant", content: "DONE|完成" },
    ];
    expect(findLastReportableAssistant(msgs)).toMatchObject({ id: "a2" });
  });

  it("skips trailing Error: assistant text and falls back to the previous one", () => {
    const msgs = [
      { id: "a1", role: "assistant", content: "任务完成，等待验收" },
      { id: "a2", role: "assistant", content: "Error: A prompt is already being processed. Interrupt it first." },
    ];
    expect(findLastReportableAssistant(msgs)).toMatchObject({ id: "a1" });
  });

  it("returns undefined when every assistant message is an Error", () => {
    const msgs = [
      { id: "a1", role: "assistant", content: "Error: boom" },
      { id: "a2", role: "assistant", content: "Error: A prompt is already being processed" },
    ];
    expect(findLastReportableAssistant(msgs)).toBeUndefined();
  });

  it("returns undefined for empty or assistant-less messages", () => {
    expect(findLastReportableAssistant([])).toBeUndefined();
    expect(findLastReportableAssistant([{ id: "u1", role: "user", content: "x" }])).toBeUndefined();
  });
});