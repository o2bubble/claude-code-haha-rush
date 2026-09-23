// ── chatReduce — protocol-faithful unit tests ──
// Feeds raw wire messages (option A: the protocol IS the interface) and
// asserts nextState + effects. Deterministic via injected now/uuid.

import { describe, it, expect } from "vitest";
import { chatReduce, emptyChatState, computeStreamStall, isBackendBusy, activeToolNames } from "./chatReduce";
import type { ChatState, ReduceCtx } from "./types";

const ctx: ReduceCtx = { now: () => 1234567890, uuid: () => "gen-id" };

function reduce(msg: any, state: ChatState = emptyChatState(), reduceCtx: ReduceCtx = ctx) {
  return chatReduce(state, msg, reduceCtx);
}

describe("chatReduce — streaming FSM", () => {
  it("message_start opens a streaming assistant message", () => {
    const r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(r.nextState.streaming).toBe(true);
    expect(r.nextState.messages).toHaveLength(1);
    expect(r.nextState.messages[0]).toMatchObject({ id: "m1", role: "assistant", content: "", streaming: true, thinking: "", toolUses: [] });
    expect(r.effects).toEqual([]);
  });

  it("message_start with duplicate id is deduped", () => {
    const base = emptyChatState();
    base.messages = [{ id: "m1", role: "assistant", content: "x", timestamp: 1 }];
    const r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }, base);
    expect(r.nextState.messages).toHaveLength(1);
    expect(r.nextState.streaming).toBe(true);
  });

  it("content_block_start appends a bash tool and emits terminal.start", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } }, r.nextState);
    expect(r.nextState.messages[0].toolUses).toEqual([
      { id: "t1", index: 0, name: "Bash", input: {}, status: "running" },
    ]);
    expect(r.effects).toEqual([{ type: "terminal.start", toolUseId: "t1", command: "Bash" }]);
  });

  it("content_block_delta appends text / thinking", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Hel" } } }, r.nextState);
    r = reduce({ type: "stream_event", event: { type: "content_block_delta", delta: { thinking: " hmm" } } }, r.nextState);
    const m = r.nextState.messages[0];
    expect(m.content).toBe("Hel");
    expect(m.thinking).toBe(" hmm");
  });

  it("content_block_delta accumulates and parses partial_json", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "TodoWrite" } } }, r.nextState);
    r = reduce({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { partial_json: '{"todos":[' } } }, r.nextState);
    r = reduce({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { partial_json: '{"content":"a"}]}' } } }, r.nextState);
    expect(r.nextState.messages[0].toolUses![0].input).toEqual({ todos: [{ content: "a" }] });
    expect(r.nextState.messages[0].toolUses![0].inputRaw).toBe('{"todos":[{"content":"a"}]}');
  });

  it("content_block_stop marks tool done + emits terminal.update", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } }, r.nextState);
    expect(r.effects).toEqual([{ type: "terminal.start", toolUseId: "t1", command: "Bash" }]);
    r = reduce({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { partial_json: '{"command":"ls"}' } } }, r.nextState);
    r = reduce({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, r.nextState);
    expect(r.nextState.messages[0].toolUses![0].status).toBe("done");
    expect(r.effects).toEqual([{ type: "terminal.update", toolUseId: "t1", command: "ls" }]);
  });

  it("content_block_stop TodoWrite emits plan.update", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "TodoWrite" } } }, r.nextState);
    r = reduce({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, r.nextState);
    expect(r.effects).toEqual([]);
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "TodoWrite" } } }, r.nextState);
    r = reduce({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { partial_json: '{"todos":[{"content":"a","activeForm":"b","status":"pending"}]}' } } }, r.nextState);
    r = reduce({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }, r.nextState);
    expect(r.effects).toEqual([
      { type: "plan.update", tasks: [{ content: "a", activeForm: "b", status: "pending" }] },
    ]);
  });

  it("message_stop only clears the message spinner, NOT global streaming (ready-misreport regression)", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(r.nextState.streaming).toBe(true);
    r = reduce({ type: "stream_event", event: { type: "message_stop" } }, r.nextState);
    expect(r.nextState.streaming).toBe(true);
    expect(r.nextState.messages[0].streaming).toBe(false);
  });

  it("result resets global + message streaming", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "result", busy: false }, r.nextState);
    expect(r.nextState.streaming).toBe(false);
    expect(r.nextState.messages[0].streaming).toBe(false);
    expect(r.nextState.backendBusy).toBe(false); // 带 busy:false 的 result = 权威 turn 结束
  });

  it("bare result (no busy field) does NOT clear backendBusy (local slash-command result regression)", () => {
    // 局部命令(/mcp-refresh 等)结束也发裸 result, 但不占 global busy。若裸 result
    // 清 backendBusy, 主 turn 仍 busy 时 gate 误判空闲 → 消息直发撞
    // "A prompt is already being processed"(不进队列)。
    let r = reduce({ type: "status", status: "thinking", busy: true });
    expect(r.nextState.backendBusy).toBe(true);
    r = reduce({ type: "result" }, r.nextState); // 裸 result(局部命令结束)
    expect(r.nextState.streaming).toBe(false);   // 乐观 UI 复位仍发生
    expect(r.nextState.backendBusy).toBe(true);  // 权威 busy 不被裸 result 清掉
    r = reduce({ type: "result", busy: false }, r.nextState); // 真 turn 结束才收口
    expect(r.nextState.backendBusy).toBe(false);
  });

  it("status ready resets, thinking/compacting starts (with busy field)", () => {
    let r = reduce({ type: "status", status: "thinking", busy: true }, { ...emptyChatState(), streaming: false });
    expect(r.nextState.streaming).toBe(true);
    expect(r.nextState.backendBusy).toBe(true);
    r = reduce({ type: "status", status: "compacting", busy: true }, r.nextState);
    expect(r.nextState.streaming).toBe(true);
    expect(r.nextState.backendBusy).toBe(true);
    r = reduce({ type: "status", status: "ready", busy: false }, r.nextState);
    expect(r.nextState.streaming).toBe(false);
    expect(r.nextState.backendBusy).toBe(false);
  });

  it("bare status (no busy field) does NOT change backendBusy (sub-command ready ≠ turn end)", () => {
    // 子命令如 rewind/plugin_refresh 广播裸 ready（不带 busy）——只是局部命令完成，
    // 若清 busy 会误判主 turn 空闲直发撞 busy。必须保持 backendBusy 现值。
    let r = reduce({ type: "status", status: "thinking", busy: true });
    expect(r.nextState.backendBusy).toBe(true);
    r = reduce({ type: "status", status: "ready" }, r.nextState); // 裸 ready
    expect(r.nextState.backendBusy).toBe(true); // 未被清（主 turn 仍忙）
    expect(r.nextState.streaming).toBe(false);  // 但 streaming 复位
    r = reduce({ type: "status", status: "thinking" }, { ...r.nextState }); // 裸 thinking
    expect(r.nextState.backendBusy).toBe(true); // 保持
    expect(r.nextState.streaming).toBe(true);
  });

  it("system slash_commands sets the command list; compact_boundary resets streaming", () => {
    let r = reduce({ type: "system", subtype: "slash_commands", commands: [{ cmd: "help", desc: "x", type: "local" }] });
    expect(r.nextState.slashCommands).toEqual([{ cmd: "help", desc: "x", type: "local" }]);
    r = reduce({ type: "system", subtype: "compact_boundary" }, { ...r.nextState, streaming: true });
    expect(r.nextState.streaming).toBe(false);
  });

  it("session_created / current_session set the session id", () => {
    let r = reduce({ type: "session_created", session_id: "s1" });
    expect(r.nextState.sessionId).toBe("s1");
    r = reduce({ type: "current_session", session_id: "s2" }, { ...emptyChatState(), sessionId: "old" });
    expect(r.nextState.sessionId).toBe("s2");
  });

  it("session_renamed emits command.listSessions", () => {
    const r = reduce({ type: "session_renamed" });
    expect(r.effects).toEqual([{ type: "command.listSessions" }]);
  });
});

describe("chatReduce — tool progress + terminal", () => {
  function baseWithTool(): ChatState {
    const s = emptyChatState();
    s.messages = [
      { id: "m1", role: "assistant", content: "", timestamp: 1, toolUses: [{ id: "t1", index: 0, name: "Bash", input: {}, status: "running" }] },
    ];
    return s;
  }

  it("tool_progress updates last tool output + emits addressed terminal.append", () => {
    // 真实 id 在 parent_tool_use_id（tool_use_id 是每包自增的 bash-progress-N）
    const r = reduce(
      { type: "tool_progress", tool_use_id: "bash-progress-0", parent_tool_use_id: "t1", data: { type: "bash_progress", output: "delta", fullOutput: "full" } },
      baseWithTool(),
    );
    expect(r.nextState.messages[0].toolUses![0].output).toBe("full");
    expect(r.effects).toEqual([{ type: "terminal.append", toolUseId: "t1", text: "delta" }]);
  });

  it("non-bash tool_progress is ignored", () => {
    const r = reduce({ type: "tool_progress", data: { type: "other", output: "x" } }, baseWithTool());
    expect(r.effects).toEqual([]);
  });

  it("user tool_result finishes bash tool", () => {
    const r = reduce(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hello\nexit code: 3" }] } },
      baseWithTool(),
    );
    expect(r.nextState.messages[0].toolUses![0]).toMatchObject({ status: "done", output: "hello\nexit code: 3" });
    expect(r.effects).toEqual([
      { type: "terminal.output", toolUseId: "t1", text: "hello\nexit code: 3" },
      { type: "terminal.finish", toolUseId: "t1", exitCode: 3 },
    ]);
  });

  it("user ExitPlanMode emits plan.save", () => {
    const s = baseWithTool();
    s.messages[0].toolUses = [{ id: "t1", index: 0, name: "ExitPlanMode", input: {}, status: "running" }];
    s.sessionId = "s1";
    s.sessions = [{ id: "s1", title: "My Session", timestamp: 1 }];
    const r = reduce(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "## Approved Plan\n- [ ] do it" }] } },
      s,
    );
    expect(r.effects).toEqual([
      { type: "plan.save", sessionId: "s1", title: "My Session", planText: "- [ ] do it" },
    ]);
  });
});

describe("chatReduce — assistant messages", () => {
  it("plain-text assistant adds a message", () => {
    const r = reduce({ type: "assistant", message: { id: "m2", content: "/help output" } });
    expect(r.nextState.messages).toEqual([{ id: "m2", role: "assistant", content: "/help output", timestamp: 1234567890 }]);
  });

  it("array assistant adds new tool_uses (dedup by id) + plan effect", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "a", activeForm: "b", status: "pending" }] } },
            { type: "tool_use", id: "t2", name: "Bash", input: {} },
          ],
        },
      },
      r.nextState,
    );
    expect(r.nextState.messages[0].toolUses).toEqual([
      { id: "t1", index: 0, name: "TodoWrite", input: { todos: [{ content: "a", activeForm: "b", status: "pending" }] }, status: "running" },
      { id: "t2", index: 1, name: "Bash", input: {}, status: "running" },
    ]);
    expect(r.effects).toEqual([
      { type: "plan.update", tasks: [{ content: "a", activeForm: "b", status: "pending" }] },
    ]);
  });

  it("tags tool_uses from a subagent (parent_tool_use_id set)", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce(
      {
        type: "assistant",
        parent_tool_use_id: "task-tool-1",
        message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: {} }] },
      },
      r.nextState,
    );
    expect(r.nextState.messages[0].toolUses).toEqual([
      { id: "s1", index: 0, name: "Bash", input: {}, status: "running", subagent: true },
    ]);
  });

  it("does not tag main-agent tool_uses (parent_tool_use_id null)", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      },
      r.nextState,
    );
    expect(r.nextState.messages[0].toolUses).toEqual([
      { id: "t1", index: 0, name: "Bash", input: {}, status: "running" },
    ]);
  });
});

describe("chatReduce — sessions", () => {
  it("session_list sets sessions + emits resumeSession for latest", () => {
    const r = reduce({
      type: "session_list",
      sessions: [
        { sessionId: "old", title: "Old", timestamp: 100 },
        { sessionId: "new", title: "New", timestamp: 200 },
      ],
    });
    expect(r.nextState.sessions).toEqual([
      { id: "old", title: "Old", timestamp: 100, isActive: false },
      { id: "new", title: "New", timestamp: 200, isActive: false },
    ]);
    expect(r.effects).toEqual([{ type: "command.resumeSession", sessionId: "new" }]);
  });

  it("session_list 带 total → 存 sessionTotal（会话文件夹孤儿清理的完整性信号）", () => {
    const r = reduce({
      type: "session_list",
      sessions: [{ sessionId: "a", title: "A", timestamp: 1 }],
      total: 60,
    });
    expect(r.nextState.sessionTotal).toBe(60);
    expect(r.nextState.sessionsLoaded).toBe(true);
  });

  it("session_list 无 total（旧后端）→ 回退为返回数", () => {
    const r = reduce({
      type: "session_list",
      sessions: [{ sessionId: "a", title: "A", timestamp: 1 }],
    });
    expect(r.nextState.sessionTotal).toBe(1);
  });

  it("session_loaded resets + merges + restores plan", () => {
    const s = emptyChatState();
    s.messages = [{ id: "old", role: "user", content: "x", timestamp: 1 }];
    s.permissionMode = "acceptEdits";
    const r = reduce(
      {
        type: "session_loaded",
        session_id: "s1",
        messages: [
          { uuid: "u1", type: "user", message: { content: "hi" }, timestamp: "2026-01-01T00:00:00Z" },
          { uuid: "u2", type: "assistant", message: { content: [{ type: "thinking", thinking: "think" }] }, timestamp: "2026-01-01T00:00:01Z" },
          {
            uuid: "u3",
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "answer" },
                { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "a", activeForm: "b", status: "pending" }] } },
              ],
            },
            timestamp: "2026-01-01T00:00:02Z",
          },
        ],
      },
      s,
    );
    expect(r.effects).toEqual([
      { type: "terminal.clear" },
      { type: "plan.clear" },
      { type: "subagent.clear" },
      { type: "plan.update", tasks: [{ content: "a", activeForm: "b", status: "pending" }] },
    ]);
    expect(r.nextState.sessionId).toBe("s1");
    expect(r.nextState.messages).toHaveLength(2);
    expect(r.nextState.messages[1]).toMatchObject({ role: "assistant", content: "answer", thinking: "think" });
    expect(r.nextState.messages[1].toolUses).toEqual([
      { id: "t1", index: 0, name: "TodoWrite", input: { todos: [{ content: "a", activeForm: "b", status: "pending" }] }, status: "done" },
    ]);
    expect(r.nextState.permissionMode).toBe("acceptEdits"); // preserved
    expect(r.nextState.streaming).toBe(false);
  });
});

describe("chatReduce — tasks, subagents, permission, misc", () => {
  it("tasks_updated maps fields", () => {
    const r = reduce({ type: "tasks_updated", tasks: [{ task_id: "k1", prompt: "do it", status: "running", tool_count: 2, token_count: 3 }] });
    expect(r.nextState.tasks).toEqual([{ id: "k1", description: "do it", status: "running", toolCount: 2, tokenCount: 3 }]);
  });

  it("task lifecycle emits subagent.upsert", () => {
    const r = reduce({ type: "task_started", task_id: "k1", agent_type: "explorer", description: "scan" });
    expect(r.effects).toEqual([
      { type: "subagent.upsert", agent: { taskId: "k1", agentName: "explorer", teamName: "local", agentId: "explorer@local", color: undefined, description: "scan", status: "running", toolCount: 0, tokenCount: 0 } },
    ]);
  });

  it("agent_transcript emits subagent.transcript", () => {
    const r = reduce({ type: "agent_transcript", task_id: "k1", messages: [{ role: "assistant", content: "x" }] });
    expect(r.effects).toEqual([
      { type: "subagent.transcript", taskId: "k1", messages: [{ role: "assistant", content: "x", timestamp: undefined }], error: undefined },
    ]);
  });

  it("permission_mode_changed resends saved non-default mode on 'default' broadcast (race)", () => {
    const r = reduce({ type: "permission_mode_changed", mode: "default" }, emptyChatState(), { savedPermissionMode: "acceptEdits" });
    expect(r.effects).toEqual([{ type: "command.resendPermissionMode", mode: "acceptEdits" }]);
    expect(r.nextState.permissionMode).toBe("acceptEdits");
  });

  it("permission_mode_changed sets non-default mode directly", () => {
    const r = reduce({ type: "permission_mode_changed", mode: "plan" }, emptyChatState(), { savedPermissionMode: "acceptEdits" });
    expect(r.effects).toEqual([]);
    expect(r.nextState.permissionMode).toBe("plan");
  });

  it("file_edit emits emit.fileChanged", () => {
    const r = reduce({ type: "file_edit", path: "C:/x.ts" });
    expect(r.effects).toEqual([{ type: "emit.fileChanged", path: "C:/x.ts" }]);
  });

  it("control_request AskUserQuestion blocks input", () => {
    const r = reduce({ type: "control_request", request_id: "r1", request: { tool_name: "AskUserQuestion", input: {} } });
    expect(r.nextState.pendingControlRequest).toMatchObject({ request_id: "r1", tool_name: "AskUserQuestion" });
    expect(r.nextState.inputBlockedReason).toBe("Please answer the question above");
  });

  it("context_window updates token fields", () => {
    const r = reduce({
      type: "context_window",
      remaining_percentage: 42,
      context_window_size: 1000,
      used_tokens: 10,
      session_input_tokens: 100,
      session_output_tokens: 5,
      session_cache_read_tokens: 60,
      session_cache_creation_tokens: 7,
      model: "m",
    });
    expect(r.nextState).toMatchObject({
      contextPercent: 42,
      contextWindowSize: 1000,
      usedTokens: 10,
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 60,
      cacheCreationTokens: 7,
      model: "m",
    });
  });

  it("session_loaded does not flicker context usage to 0 before the refill", () => {
    // 后端在会话边界(切换/恢复/compact/重连)发 session_loaded(重置消息列表),
    // 紧接着发 context_window(权威用量)。中间态若把用量清零, 输入面板会闪一下
    // 「ctx 0/x」再跳回真实值。usage 字段应只由 context_window 负责。
    const base = emptyChatState();
    base.contextPercent = 42;
    base.contextWindowSize = 200000;
    base.usedTokens = 50000;
    base.outputTokens = 3000;
    base.model = "claude-sonnet-4";

    const afterLoad = reduce(
      { type: "session_loaded", session_id: "s1", messages: [{ id: "m1", type: "assistant", message: { role: "assistant", content: "hi" } }] },
      base,
    ).nextState;

    // BUG: session_loaded 把用量清零 → 下一次渲染闪成 ctx 0/200k
    expect(afterLoad.usedTokens).toBe(50000);
    expect(afterLoad.contextWindowSize).toBe(200000);
    expect(afterLoad.contextPercent).toBe(42);
    expect(afterLoad.model).toBe("claude-sonnet-4");

    // context_window 照常更新为权威值
    const afterCtx = reduce(
      { type: "context_window", remaining_percentage: 30, context_window_size: 200000, used_tokens: 140000, session_input_tokens: 0, session_output_tokens: 0, session_cache_read_tokens: 0, session_cache_creation_tokens: 0, model: "claude-sonnet-4" },
      afterLoad,
    ).nextState;
    expect(afterCtx.usedTokens).toBe(140000);
    expect(afterCtx.contextPercent).toBe(30);
  });

  it("context_window with unknown usage (remaining null) keeps last-known window display", () => {
    // 后端在会话刚开始/compact 后拿不到当前用量时发 remaining_percentage=null,
    // 此时窗口显示应保持旧值(不闪成 0/隐藏), 但会话累计照常更新
    const base = emptyChatState();
    base.contextPercent = 42;
    base.contextWindowSize = 200000;
    base.usedTokens = 50000;

    const r = reduce(
      { type: "context_window", remaining_percentage: null, context_window_size: 200000, used_tokens: 0, session_input_tokens: 100, session_output_tokens: 5, session_cache_read_tokens: 0, session_cache_creation_tokens: 0, model: "m" },
      base,
    ).nextState;
    expect(r.usedTokens).toBe(50000);
    expect(r.contextPercent).toBe(42);
    expect(r.contextWindowSize).toBe(200000);
    expect(r.inputTokens).toBe(100);
  });

  it("error adds an error message", () => {
    const r = reduce({ type: "error", message: "boom" });
    expect(r.nextState.messages[0].content).toBe("Error: boom");
  });

  it("error DURING streaming resets global streaming (GUI must not stick)", () => {
    // 流式中后端发 error（某些路径 error 后无 result 兜底）→ GUI 不能永远停在
    // streaming=true（状态栏"工作中"，看起来卡死，只能手动中断复活）
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(r.nextState.streaming).toBe(true);
    r = reduce({ type: "stream_event", event: { type: "error", message: "boom" } }, r.nextState);
    expect(r.nextState.streaming).toBe(false);
    expect(r.nextState.backendBusy).toBe(false); // error 后必须判后端空闲（防假 busy 卡消息）
    expect(r.nextState.messages[r.nextState.messages.length - 1].content).toBe("Error: boom");
  });

  it("bare error DURING streaming also resets streaming", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "error", message: "boom" }, r.nextState);
    expect(r.nextState.streaming).toBe(false);
  });

  it("task_error does NOT reset streaming nor add a chat bubble (busy-desync regression)", () => {
    // 根因: load_agent_transcript/kill_task 打在已结束任务上时, 后端曾走全局
    // error 通道 → GUI 复位 streaming 显示"就绪", 但主回合仍 busy → 用户下一条
    // 消息撞 "A prompt is already being processed"。task_error 必须只发 store 效果。
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(r.nextState.streaming).toBe(true);
    // backendBusy 权威 busy 也不能被任务级错误污染（主回合可能仍在跑）
    const busyBefore = r.nextState.backendBusy;
    r = reduce({ type: "task_error", scope: "load_agent_transcript", task_id: "t1", message: "Task not found: t1" }, r.nextState);
    expect(r.nextState.streaming).toBe(true);
    expect(r.nextState.backendBusy).toBe(busyBefore); // 未变
    expect(r.nextState.messages).toHaveLength(1); // 只有 message_start 那条, 无 Error 气泡
    expect(r.effects).toEqual([
      { type: "subagent.error", taskId: "t1", message: "Task not found: t1" },
    ]);
  });

  it("status disconnected DURING streaming resets streaming (WS drop must not stick)", () => {
    // 流式中 WS 断开 → onclose → status:disconnected。此时回合已死（WS 是唯一通道），
    // 必须复位 streaming，否则重连后 GUI 永远停在"工作中"——只能手动中断+继续复活。
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(r.nextState.streaming).toBe(true);
    r = reduce({ type: "status", status: "disconnected" }, r.nextState);
    expect(r.nextState.streaming).toBe(false);
    expect(r.nextState.backendBusy).toBe(false); // WS 断开 → 回合死，判后端空闲
    expect(r.nextState.connected).toBeUndefined; // 不断言无关字段
  });

  it("status connected resets streaming but NOT backendBusy (reconnect ≠ idle)", () => {
    // 半开连接：服务器把 client 从集合剔除但没发 close → GUI 收不到 disconnected；
    // 重连 onopen 发 connected 必须兜底复位 streaming，否则永远卡死。
    // 但 backendBusy 不能清——重连成功 ≠ 后端空闲（后端可能还在跑上一 turn/等子代理），
    // 清了会误判空闲直发撞 busy。backendBusy 交给后续 ready/thinking 决定。
    let r = reduce({ type: "status", status: "thinking", busy: true });
    expect(r.nextState.backendBusy).toBe(true);
    r = reduce({ type: "status", status: "connected" }, r.nextState);
    expect(r.nextState.streaming).toBe(false);
    expect(r.nextState.backendBusy).toBe(true); // 保持（未被清）
    r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    r = reduce({ type: "status", status: "connected" }, r.nextState);
    expect(r.nextState.backendBusy).toBeUndefined; // message_start 不设 backendBusy，connected 也不清 → 保持 undefined
  });

  it("unknown message types are no-ops", () => {
    const base = emptyChatState();
    const r = reduce({ type: "totally_unknown", payload: 1 }, base);
    expect(r.nextState).toBe(base);
    expect(r.effects).toEqual([]);
  });

  it("activeToolUses: +1 on tool_use start, -1 on tool_result, cleared on result/error", () => {
    // 非 bash 工具执行期后端零广播 → stall 计时靠在途计数豁免(工具在跑≠卡死)
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(r.nextState.activeToolUses).toBe(0);
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Write" } } }, r.nextState);
    expect(r.nextState.activeToolUses).toBe(1);
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "Read" } } }, r.nextState);
    expect(r.nextState.activeToolUses).toBe(2);
    r = reduce({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }, r.nextState);
    expect(r.nextState.activeToolUses).toBe(1);
    r = reduce({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } }, r.nextState);
    expect(r.nextState.activeToolUses).toBe(0);
    // 泄漏防护: abort 后 tool_result 永远不来 → 回合结束(result/error)清零
    r = reduce({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t3", name: "Task" } } }, r.nextState);
    expect(r.nextState.activeToolUses).toBe(1);
    r = reduce({ type: "result", busy: false }, r.nextState);
    expect(r.nextState.activeToolUses).toBe(0);
  });
});

describe("computeStreamStall — 无响应提示", () => {
  const base = emptyChatState();
  const now = 1_000_000;

  it("not streaming → 0 (never hint when idle)", () => {
    expect(computeStreamStall(base.lastStreamEventAt, now, false)).toBe(0);
  });
  it("no lastStreamEventAt → 0 (no activity tracked yet)", () => {
    expect(computeStreamStall(null, now, true)).toBe(0);
  });
  it("within threshold → 0 (healthy, no hint)", () => {
    expect(computeStreamStall(now - 29_000, now, true)).toBe(0);
  });
  it("past threshold → elapsed seconds (hint shown)", () => {
    expect(computeStreamStall(now - 45_000, now, true)).toBe(45);
    expect(computeStreamStall(now - 120_000, now, true)).toBe(120);
  });
  it("工具在跑也不再豁免 — 静默照常计时 (2026-09-10 一刀切)", () => {
    // 此前按工具分级豁免（Bash 600s / 快速工具 60s），但分级判断屡屡不准：
    // 连续工具调用不断续期，真卡死也一直沉默（实测状态栏"已 165s"而决策条不弹）。
    // 现在不论有无在途工具，静默即计数 —— 选择权交给用户。
    expect(computeStreamStall(now - 168_000, now, true, 30_000)).toBe(168);
    expect(computeStreamStall(now - 90_000, now, true, 30_000)).toBe(90);
  });
  it("activeToolNames 收集在途工具名（供自动中断分级宽限）", () => {
    const st = { ...emptyChatState(), messages: [{ id: "m1", role: "assistant" as const, content: "", timestamp: 0, streaming: true,
      toolUses: [
        { id: "t1", index: 0, name: "Bash", input: {}, status: "running" as const },
        { id: "t2", index: 1, name: "Edit", input: {}, status: "done" as const },
        { id: "t3", index: 2, name: "Task", input: {}, status: "running" as const },
      ] }] };
    expect(activeToolNames(st as any)).toEqual(["Bash", "Task"]);
    expect(activeToolNames(emptyChatState() as any)).toEqual([]);
  });
  it("stream_event updates lastStreamEventAt", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }, base, { now: () => 111 });
    expect(r.nextState.lastStreamEventAt).toBe(111);
    r = reduce({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { text: "hi" } } }, r.nextState, { now: () => 222 });
    expect(r.nextState.lastStreamEventAt).toBe(222);
  });
  it("non-stream messages do NOT advance lastStreamEventAt (periodic noise can't mask a stall)", () => {
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }, base, { now: () => 111 });
    r = reduce({ type: "status", status: "ready" }, r.nextState, { now: () => 999 });
    expect(r.nextState.lastStreamEventAt).toBe(111);
  });
  it("task_progress/task_messages DO advance lastStreamEventAt (sub-agent running ≠ stall)", () => {
    // 子代理运行中主回合流静默 — 后端推 task_progress/task_messages 说明子代理还在干。
    // 实测这期间会误弹「是否中断」甚至 120s 自动唤醒。必须算活动。
    let r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }, base, { now: () => 111 });
    r = reduce({ type: "task_progress", task_id: "t1", tool_uses: 1 }, r.nextState, { now: () => 222 });
    expect(r.nextState.lastStreamEventAt).toBe(222);
    r = reduce({ type: "task_messages", task_id: "t1", messages: [{ role: "assistant", content: "x" }] }, r.nextState, { now: () => 333 });
    expect(r.nextState.lastStreamEventAt).toBe(333);
  });
});

describe("isBackendBusy — authoritative busy with streaming fallback", () => {
  it("undefined (no backend signal) falls back to streaming", () => {
    expect(isBackendBusy({ ...emptyChatState(), streaming: true, backendBusy: undefined })).toBe(true);
    expect(isBackendBusy({ ...emptyChatState(), streaming: false, backendBusy: undefined })).toBe(false);
  });
  it("explicit true/false wins over streaming (authoritative)", () => {
    // interrupt 后: streaming 被乐观清 false, 但后端仍 busy → 必须判 busy
    expect(isBackendBusy({ ...emptyChatState(), streaming: false, backendBusy: true })).toBe(true);
    // error 后: streaming 可能残留 true, 但后端已空闲 → 判空闲
    expect(isBackendBusy({ ...emptyChatState(), streaming: true, backendBusy: false })).toBe(false);
  });
});

// ── 切换会话的"进行中"标记（switchingTo）──
//
// 用户点会话后，后端要读会话文件 + 跑 SessionStart hooks（装了记忆类插件时可达
// 数秒），期间消息区还是旧会话内容。界面上要给提示，否则"点了没反应"很迷惑。
// 这两个用例锁住**清除时机** —— 那是这个状态最容易写错的地方。
describe("chatReduce — switchingTo（会话切换中标记）", () => {
  it("session_loaded 时清除（此时消息列表才真正被替换）", () => {
    const base = { ...emptyChatState(), switchingTo: "target-sess" };
    const r = reduce({ type: "session_loaded", session_id: "target-sess", messages: [] }, base);
    expect(r.nextState.switchingTo).toBeNull();
  });

  it("error 时也清除（加载失败不能一直转圈）", () => {
    const base = { ...emptyChatState(), switchingTo: "gone-sess" };
    const r = reduce({ type: "error", message: "Session not found: gone-sess" }, base);
    expect(r.nextState.switchingTo).toBeNull();
  });

  it("current_session **不**清除 —— 那条只换 id，消息还是旧的", () => {
    // 这条是刻意的：后端在 resume 早期就会发 current_session（列表项据此高亮），
    // 但 session_loaded 还没到 —— 提前清会让 loading 在内容没换时就消失。
    const base = { ...emptyChatState(), switchingTo: "target-sess" };
    const r = reduce({ type: "current_session", session_id: "target-sess" }, base);
    expect(r.nextState.switchingTo).toBe("target-sess");
  });

  it("普通消息不清除（切换期间可能穿插其它事件）", () => {
    const base = { ...emptyChatState(), switchingTo: "target-sess" };
    const r = reduce({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }, base);
    expect(r.nextState.switchingTo).toBe("target-sess");
  });
});
