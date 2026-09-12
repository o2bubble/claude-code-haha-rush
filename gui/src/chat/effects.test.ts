// ── applyStoreEffects — side-effect landing tests ──
// Applies a ChatEffect list against the real stores (isolated via _reset) and
// asserts the neighbouring stores actually changed. Command effects are
// returned untouched for the runner.

import { describe, it, expect, beforeEach } from "vitest";
import { applyStoreEffects } from "./effects";
import { _reset as resetTerminal, getEntries } from "../stores/terminalStore";
import { _reset as resetPlan, getPlanTasks } from "../stores/planStore";
import { _reset as resetSubAgent, getSubAgentState } from "../stores/subAgentStore";
import type { ChatEffect } from "./types";

beforeEach(() => {
  resetTerminal();
  resetPlan();
  resetSubAgent();
});

describe("applyStoreEffects — terminal", () => {
  it("start → update → append → finish lands a terminal entry", () => {
    applyStoreEffects([
      { type: "terminal.start", toolUseId: "t1", command: "Bash" },
      { type: "terminal.update", toolUseId: "t1", command: "ls -la" },
      { type: "terminal.append", toolUseId: "t1", text: "file.txt" },
      { type: "terminal.finish", toolUseId: "t1", exitCode: 0 },
    ]);
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolUseId: "t1", command: "ls -la", output: "file.txt", exitCode: 0 });
  });

  it("terminal.output sets the tool output", () => {
    applyStoreEffects([{ type: "terminal.start", toolUseId: "t1", command: "Bash" }]);
    applyStoreEffects([{ type: "terminal.output", toolUseId: "t1", text: "result" }]);
    expect(getEntries()[0].output).toBe("result");
  });

  it("terminal.clear empties the store", () => {
    applyStoreEffects([{ type: "terminal.start", toolUseId: "t1", command: "Bash" }]);
    applyStoreEffects([{ type: "terminal.clear" }]);
    expect(getEntries()).toHaveLength(0);
  });
});

describe("applyStoreEffects — plan", () => {
  it("plan.update sets tasks", () => {
    applyStoreEffects([{ type: "plan.update", tasks: [{ content: "a", activeForm: "b", status: "pending" }] }]);
    expect(getPlanTasks()).toEqual([{ content: "a", activeForm: "b", status: "pending" }]);
  });

  it("plan.clear empties tasks", () => {
    applyStoreEffects([{ type: "plan.update", tasks: [{ content: "a", activeForm: "b", status: "pending" }] }]);
    applyStoreEffects([{ type: "plan.clear" }]);
    expect(getPlanTasks()).toEqual([]);
  });

  it("plan.save is a no-op outside Tauri (guarded by isTauri)", () => {
    expect(() => {
      applyStoreEffects([{ type: "plan.save", sessionId: "s1", title: "T", planText: "x" }]);
    }).not.toThrow();
  });
});

describe("applyStoreEffects — subagents", () => {
  it("subagent.upsert adds an agent", () => {
    applyStoreEffects([{ type: "subagent.upsert", agent: { taskId: "k1", agentName: "explorer", teamName: "local", agentId: "explorer@local", description: "", status: "running", toolCount: 0, tokenCount: 0 } }]);
    expect(getSubAgentState().agents).toHaveLength(1);
    expect(getSubAgentState().agents[0].taskId).toBe("k1");
  });

  it("subagent.transcript stores the transcript", () => {
    applyStoreEffects([{ type: "subagent.transcript", taskId: "k1", messages: [{ role: "assistant", content: "x" }] }]);
    expect(getSubAgentState().transcripts["k1"].messages).toEqual([{ role: "assistant", content: "x" }]);
  });

  it("subagent.clear empties everything", () => {
    applyStoreEffects([{ type: "subagent.upsert", agent: { taskId: "k1", agentName: "a", teamName: "local", agentId: "a@local", description: "", status: "running", toolCount: 0, tokenCount: 0 } }]);
    applyStoreEffects([{ type: "subagent.clear" }]);
    expect(getSubAgentState().agents).toHaveLength(0);
  });
});

describe("applyStoreEffects — command pass-through", () => {
  it("returns command effects untouched for the runner", () => {
    const cmd: ChatEffect[] = [
      { type: "command.resumeSession", sessionId: "s1" },
      { type: "command.listSessions" },
      { type: "command.resendPermissionMode", mode: "plan" },
    ];
    const returned = applyStoreEffects(cmd);
    expect(returned).toEqual(cmd);
  });

  it("command effects are not applied to stores", () => {
    applyStoreEffects([{ type: "command.resumeSession", sessionId: "s1" }]);
    expect(getEntries()).toHaveLength(0);
    expect(getPlanTasks()).toEqual([]);
  });
});
