import { describe, expect, it } from "vitest";
import { partitionSessions } from "./sessionFavorites";

const sessions = [
  { id: "s1" },
  { id: "s2" },
  { id: "s3" },
];

describe("partitionSessions", () => {
  it("keeps valid favorites in live order, rest in regular", () => {
    const p = partitionSessions(sessions, ["s3", "s1"]);
    expect(p.favSessions.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(p.regularSessions.map((s) => s.id)).toEqual(["s2"]);
    expect(p.staleFavIds).toEqual([]);
  });

  it("flags favorite ids absent from the live list as stale", () => {
    const p = partitionSessions(sessions, ["s1", "gone-a", "gone-b"]);
    expect(p.favSessions.map((s) => s.id)).toEqual(["s1"]);
    expect(p.staleFavIds).toEqual(["gone-a", "gone-b"]);
    expect(p.regularSessions.map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  it("stale favorites keep their original favorite order", () => {
    const p = partitionSessions([], ["z", "a", "m"]);
    expect(p.staleFavIds).toEqual(["z", "a", "m"]);
    expect(p.favSessions).toEqual([]);
    expect(p.regularSessions).toEqual([]);
  });

  it("empty favorites partition everything to regular", () => {
    const p = partitionSessions(sessions, []);
    expect(p.favSessions).toEqual([]);
    expect(p.staleFavIds).toEqual([]);
    expect(p.regularSessions.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("removes duplicates in favorites input", () => {
    const p = partitionSessions(sessions, ["s1", "s1"]);
    expect(p.favSessions.map((s) => s.id)).toEqual(["s1"]);
  });
});
