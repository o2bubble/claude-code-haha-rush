import { describe, it, expect, vi, beforeEach } from "vitest";

// 「隐藏任务栏图标」的真正难点在**下发**，不在改样式：
// 设置存在全局文件里，A 实例改完，B/C 只在 reloadSettings 后拿到新值 ——
// 若不把新值应用到各自的窗口，用户就会看到"第一次生效了，别的窗口又回来了"
// （2026-10-28 用户反馈）。这里锁住"每次都按最新设置同步"这个性质。

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

async function freshModule() {
  vi.resetModules();
  const m = await import("./taskbarVisibility");
  m.__resetTaskbarVisibilityCache();
  return m;
}

describe("taskbarVisibility — 下发到窗口", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  it("打开开关 → 通知 Rust 隐藏", async () => {
    const { applyTaskbarVisibility } = await freshModule();
    await applyTaskbarVisibility(true);
    expect(invokeMock).toHaveBeenCalledWith("set_main_window_taskbar", { hidden: true });
  });

  it("关掉开关 → 通知 Rust 恢复", async () => {
    const { applyTaskbarVisibility } = await freshModule();
    await applyTaskbarVisibility(false);
    expect(invokeMock).toHaveBeenCalledWith("set_main_window_taskbar", { hidden: false });
  });

  it("值没变就不发 IPC（SETTINGS_CHANGED 触发得非常频繁）", async () => {
    const { applyTaskbarVisibility } = await freshModule();
    await applyTaskbarVisibility(true);
    invokeMock.mockClear();
    for (let i = 0; i < 20; i++) await applyTaskbarVisibility(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("值变了要发（其他实例改了设置，本实例必须跟上）", async () => {
    const { applyTaskbarVisibility } = await freshModule();
    await applyTaskbarVisibility(false);
    invokeMock.mockClear();
    await applyTaskbarVisibility(true);
    expect(invokeMock).toHaveBeenCalledWith("set_main_window_taskbar", { hidden: true });
  });

  it("首次调用即便值是 false 也要发 —— 纠正启动早期可能错过的状态", async () => {
    const { applyTaskbarVisibility } = await freshModule();
    await applyTaskbarVisibility(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("IPC 失败后允许重试（不能因为失败就把值记成已下发）", async () => {
    const { applyTaskbarVisibility } = await freshModule();
    invokeMock.mockRejectedValueOnce(new Error("窗口还没建好"));
    await applyTaskbarVisibility(true);
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);

    await applyTaskbarVisibility(true);
    expect(invokeMock).toHaveBeenCalledWith("set_main_window_taskbar", { hidden: true });
  });
});

describe("syncTaskbarFromSettings — 从设置对象同步", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  it("undefined 视为关（与 Rust 侧缺省一致）", async () => {
    const { syncTaskbarFromSettings } = await freshModule();
    syncTaskbarFromSettings(undefined);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_main_window_taskbar", { hidden: false }),
    );
  });

  it("true → 隐藏", async () => {
    const { syncTaskbarFromSettings } = await freshModule();
    syncTaskbarFromSettings(true);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_main_window_taskbar", { hidden: true }),
    );
  });
});
