import { describe, expect, it, beforeEach } from "vitest";
import { setTranscript, setTranscriptLoading, getSubAgentState, _reset } from "./subAgentStore";

describe("subAgentStore transcript refresh", () => {
  beforeEach(() => _reset());

  it("setTranscriptLoading keeps existing messages — polling refresh must not clear them", () => {
    setTranscript("t1", [{ role: "user", content: "first" }, { role: "assistant", content: "second" }]);
    setTranscriptLoading("t1");
    const s = getSubAgentState();
    // Bug: clearing messages on every poll re-mounts the list empty, resetting the
    // scroll position to the top on each 2s refresh while a sub-agent is running.
    expect(s.transcripts["t1"].messages.length).toBe(2);
    expect(s.transcripts["t1"].loading).toBe(true);
    expect(s.transcripts["t1"].loaded).toBe(false);
  });

  it("setTranscriptLoading on a fresh agent still starts empty", () => {
    setTranscriptLoading("new-agent");
    const s = getSubAgentState();
    expect(s.transcripts["new-agent"].messages).toEqual([]);
    expect(s.transcripts["new-agent"].loading).toBe(true);
  });
});
