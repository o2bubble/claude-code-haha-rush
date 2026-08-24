import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGuardStatus, guardActive, guardStart, guardStop, handleGuardAction,
  registerGuardChatApi, ACCEPT_TEXT, RESUME_TEXT, shouldReportTurnEnded,
  findLastReportableAssistant,
} from "./guardBridge";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../stores/statusMsgStore", () => ({
  addStatusMessage: vi.fn(),
}));

// chatStore streaming 状态可控
let mockStreaming = false;
vi.mock("../stores/chatStore", () => ({
  getChatState: () => ({ streaming: mockStreaming, messages: [] }),
}));

const mockSend = vi.fn();
const mockRelease = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue({});
  mockStreaming = false;
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