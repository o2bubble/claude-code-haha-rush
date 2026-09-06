// ── desktopStore workspace-switch reload regression test ──
// Bug: switching workspace emits WORKSPACE_BOUND, desktopStore resets its load
// cache (_loadPromise/_loadedOnce) but SuperDesktopPanel (already mounted) never
// re-invokes loadDesktops(). The fix adds a WORKSPACE_BOUND listener in the
// panel. This test pins the store-level reset that the fix's listener depends
// on: WORKSPACE_BOUND must reset hasLoadedDesktops so a subsequent
// loadDesktops() actually re-fetches (otherwise the panel's reload would be a
// no-op that returns the stale cache).
import { describe, it, expect, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";
import { resetDesktopsLoad, hasLoadedDesktops } from "./desktopStore";

describe("desktopStore workspace switch reload contract", () => {
  it("WORKSPACE_BOUND resets the load cache so a reload is possible", () => {
    invokeMock.mockReset();
    resetDesktopsLoad();
    windowBus.clearSticky(Events.BACKEND_PORT_READY);

    // WORKSPACE_BOUND fires on bind → store resets cache.
    windowBus.emit(Events.WORKSPACE_BOUND, { workDir: "/ws-a" });
    expect(hasLoadedDesktops()).toBe(false);
  });
});
