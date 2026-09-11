import { describe, it, expect, beforeEach } from "vitest";
import { wsDiagAdd, wsDiagReset, getWsDiag } from "./wsDiag";

beforeEach(() => {
  wsDiagReset();
});

describe("wsDiag", () => {
  it("records events newest-first", () => {
    wsDiagAdd({ kind: "connect", port: 1000, ts: 1 });
    wsDiagAdd({ kind: "open", port: 1000, ts: 2 });
    wsDiagAdd({ kind: "close", port: 1000, code: 1006, ts: 3 });
    const evs = getWsDiag();
    expect(evs[0]).toMatchObject({ kind: "close", port: 1000, code: 1006 });
    expect(evs[2]).toMatchObject({ kind: "connect", port: 1000 });
  });

  it("caps at MAX events and drops oldest", () => {
    for (let i = 0; i < 20; i++) wsDiagAdd({ kind: "connect", port: i, ts: i });
    const evs = getWsDiag();
    expect(evs.length).toBe(12);
    expect(evs[0]).toMatchObject({ port: 19 }); // 最新在最前
    expect(evs[evs.length - 1]).toMatchObject({ port: 8 });
  });

  it("reset empties history", () => {
    wsDiagAdd({ kind: "connect", port: 1, ts: 1 });
    wsDiagReset();
    expect(getWsDiag()).toEqual([]);
  });
});