import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertSessionStatus,
  removeClient,
  replaceAllSessionStatus,
  getSessionOpenElsewhere,
  getAllSessionStatuses,
  type SessionStatusEntry,
} from "./sessionStatusStore";

const e = (clientId: string, sessionId: string, state: "working" | "idle", workspace = "w1"): SessionStatusEntry =>
  ({ sessionId, state, clientId, workspace });

beforeEach(() => {
  replaceAllSessionStatus([]);
});

describe("sessionStatusStore — 跨 GUI 会话状态聚合", () => {
  it("upsert keys by client, re-report replaces within client", () => {
    upsertSessionStatus(e("A", "S1", "working"));
    upsertSessionStatus(e("A", "S1", "idle")); // idle→ 状态跳变，同 client 覆盖
    expect(getAllSessionStatuses()).toHaveLength(1);
    expect(getAllSessionStatuses()[0].state).toBe("idle");
  });

  it("getSessionOpenElsewhere filters by sessionId + workspace", () => {
    upsertSessionStatus(e("A", "S1", "working", "w1"));
    upsertSessionStatus(e("B", "S1", "idle", "w1"));
    upsertSessionStatus(e("C", "S1", "idle", "w2")); // 别的 workspace 同 id 不串
    const w1 = getSessionOpenElsewhere("S1", "w1");
    expect(w1).toHaveLength(2);
    expect(w1.some((x) => x.state === "working")).toBe(true);
    expect(getSessionOpenElsewhere("S1", "w2")).toHaveLength(1);
    // 别的 session 不受影响
    expect(getSessionOpenElsewhere("S2", "w1")).toHaveLength(0);
  });

  it("removeClient drops only that client's entry", () => {
    upsertSessionStatus(e("A", "S1", "working"));
    upsertSessionStatus(e("B", "S2", "idle"));
    removeClient("A");
    expect(getAllSessionStatuses()).toHaveLength(1);
    expect(getAllSessionStatuses()[0].clientId).toBe("B");
  });

  it("replaceAll resets the index", () => {
    upsertSessionStatus(e("A", "S1", "working"));
    replaceAllSessionStatus([e("B", "S2", "idle")]);
    expect(getAllSessionStatuses()).toHaveLength(1);
    expect(getAllSessionStatuses()[0].clientId).toBe("B");
  });
});
