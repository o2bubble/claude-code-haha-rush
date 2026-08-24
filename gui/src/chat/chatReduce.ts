// ── chatReduce — the pure chat-domain fold ──
// (state, wireMsg) → { nextState, effects }. Owns ChatState exclusively; every
// side effect is returned as a typed ChatEffect for the runner to apply.
// Faithful port of useChatBridge's ~24 handlers — behaviour is unchanged.

import type { ChatState, ChatMessage, ChatEffect, WireMessage, ReduceCtx } from "./types";
import { extractPlanTasks, isPlanTool } from "./planExtract";
import { mergeSessionMessages } from "./sessionMerge";

export interface ReduceResult {
  nextState: ChatState;
  effects: ChatEffect[];
}

/** Canonical initial chat state. Kept in sync with chatStore's default. */
export function emptyChatState(): ChatState {
  return {
    messages: [],
    streaming: false,
    connected: false,
    sessionId: null,
    sessions: [],
    tasks: [],
    permissionMode: "default",
    pendingControlRequest: null,
    inputBlockedReason: null,
    slashCommands: [],
    activeSkillDialog: null,
    sessionsLoaded: false,
    sessionTotal: null,
    contextPercent: 0,
    contextWindowSize: 0,
    usedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: "",
    // 最近一次流式活动的时间戳（null=尚无）；无响应提示据此计算卡顿秒数
    lastStreamEventAt: null,
  };
}

/**
 * 无响应提示：给定最近流式活动时间，算出当前已卡顿秒数。
 * 仅在 streaming 且超过阈值后返回 >0（UI 据此显示"已 N 秒无响应"）。
 * @param thresholdMs 阈值（默认 30s，与后端 stall 检测一致）
 */
export function computeStreamStall(
  lastStreamEventAt: number | null | undefined,
  now: number,
  streaming: boolean,
  thresholdMs = 30_000,
): number {
  if (!streaming || typeof lastStreamEventAt !== "number") return 0;
  const elapsed = now - lastStreamEventAt;
  return elapsed > thresholdMs ? Math.floor(elapsed / 1000) : 0;
}

function isBashLike(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("bash") || n.includes("powershell");
}

function buildSubAgentInfo(msg: any, status: string): ChatEffect {
  const base = msg.identity
    ? {
        taskId: msg.task_id,
        agentName: msg.identity.agent_name,
        teamName: msg.identity.team_name,
        agentId: msg.identity.agent_id,
        color: msg.identity.color as string | undefined,
      }
    : {
        taskId: msg.task_id,
        agentName: msg.agent_type || "agent",
        teamName: "local",
        agentId: `${msg.agent_type || "agent"}@local`,
        color: undefined as string | undefined,
      };
  return {
    type: "subagent.upsert",
    agent: {
      ...base,
      description: msg.description || "",
      status: status as any,
      toolCount: msg.tool_uses ?? 0,
      tokenCount: msg.total_tokens ?? 0,
    },
  };
}

export function chatReduce(state: ChatState, msg: WireMessage, ctx: ReduceCtx = {}): ReduceResult {
  const effects: ChatEffect[] = [];
  const now = ctx.now ?? Date.now;
  const uuid = ctx.uuid ?? (() => crypto.randomUUID());
  let s = state;
  const set = (patch: Partial<ChatState>) => {
    s = { ...s, ...patch };
  };
  const updateLast = (fn: (m: ChatMessage) => ChatMessage) => {
    const msgs = [...s.messages];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        msgs[i] = fn(msgs[i]);
        break;
      }
    }
    set({ messages: msgs });
  };
  const pushMessage = (m: ChatMessage) => {
    if (m.id && s.messages.some((x) => x.id === m.id)) return;
    set({ messages: [...s.messages, m] });
  };
  const setStreaming = (v: boolean) => {
    set({ streaming: v });
    updateLast((m) => ({ ...m, streaming: v }));
  };

  // Single unwrap for stream_event; everything else is the raw wire message.
  const inner = msg.type === "stream_event" ? (msg.event || {}) : msg;
  const t = inner.type;

  // 流式活动推进 lastStreamEventAt（无响应提示的数据源）。tool_progress 也算
  // 活动（长 bash 工具不是卡死）；status/context_window 等周期性消息不算，
  // 防止掩盖真实卡停。
  if (msg.type === "stream_event" || t === "tool_progress") {
    set({ lastStreamEventAt: now() });
  }

  switch (t) {
    case "message_start": {
      const id = inner.message?.id || uuid();
      set({ streaming: true });
      pushMessage({ id, role: "assistant", content: "", timestamp: now(), streaming: true, thinking: "", toolUses: [] });
      break;
    }
    case "content_block_start": {
      const cb = inner.content_block;
      if (cb?.type === "tool_use") {
        const name = cb.name || "";
        updateLast((m) => ({
          ...m,
          toolUses: [
            ...(m.toolUses || []),
            {
              id: cb.id || uuid(),
              index: typeof inner.index === "number" ? inner.index : (m.toolUses?.length ?? 0),
              name,
              input: {},
              status: "running" as const,
            },
          ],
        }));
        if (isBashLike(name)) {
          effects.push({ type: "terminal.start", toolUseId: cb.id || uuid(), command: name });
        }
      }
      break;
    }
    case "content_block_delta": {
      const d = inner.delta;
      if (!d) break;
      if (typeof d.text === "string") {
        updateLast((m) => ({ ...m, content: m.content + d.text }));
      } else if (typeof d.thinking === "string") {
        updateLast((m) => ({ ...m, thinking: (m.thinking || "") + d.thinking }));
      } else if (d.partial_json) {
        updateLast((m) => {
          const tools = [...(m.toolUses || [])];
          const idx = tools.findIndex((tool) => tool.index === inner.index);
          if (idx >= 0) {
            const tool = tools[idx];
            const buf = (tool.inputRaw || "") + d.partial_json;
            tools[idx] = { ...tool, inputRaw: buf };
            try {
              tools[idx] = { ...tools[idx], input: JSON.parse(buf) };
            } catch {}
          }
          return { ...m, toolUses: tools };
        });
      }
      break;
    }
    case "content_block_stop": {
      updateLast((m) => {
        const tools = [...(m.toolUses || [])];
        const idx = tools.findIndex((tool) => tool.index === inner.index);
        if (idx >= 0) {
          const tool = tools[idx];
          tools[idx] = { ...tool, status: "done" };
          if (isBashLike(tool.name)) {
            const cmd = tool.input?.command || tool.name;
            effects.push({ type: "terminal.update", toolUseId: tool.id, command: typeof cmd === "string" ? cmd : tool.name });
          }
          if (isPlanTool(tool.name)) {
            const todos = extractPlanTasks(tool.input);
            if (todos) effects.push({ type: "plan.update", tasks: todos });
          }
        }
        return { ...m, toolUses: tools };
      });
      break;
    }
    case "message_delta":
      break;
    case "message_stop":
      // Fires at the end of EACH API request in a turn (a tool turn has
      // multiple requests). Must NOT reset the global turn-streaming state —
      // otherwise the status bar shows "ready" between tool steps. Only clears
      // this message's spinner; the global flag is reset by `result` / status
      // 'ready' (the authoritative turn-end signals).
      updateLast((m) => ({ ...m, streaming: false }));
      break;
    case "result":
      setStreaming(false);
      break;
    case "error":
      // 必须复位全局 streaming：某些路径（上游中断/看门狗降级失败/断连）error 后
      // 没有 result 兜底，不复位会让 GUI 永远停在 streaming=true（状态栏"工作中"，
      // 用户只能手动中断+继续来"激活"——即"输出莫名卡死"）。result 仍会覆盖为 false。
      setStreaming(false);
      pushMessage({ id: uuid(), role: "assistant", content: `Error: ${inner.message || "Unknown error"}`, timestamp: now() });
      break;
    case "tool_progress": {
      if (!inner.data) break;
      if (inner.data.type !== "bash_progress" && inner.data.type !== "powershell_progress") break;
      const output = inner.data.fullOutput || inner.data.output || "";
      updateLast((m) => {
        const tools = [...(m.toolUses || [])];
        if (tools.length === 0) return m;
        const last = tools[tools.length - 1];
        tools[tools.length - 1] = { ...last, output, status: "running" };
        return { ...m, toolUses: tools };
      });
      // fullOutput is cumulative — append only the delta so the terminal entry
      // doesn't duplicate previously-appended output on each chunk.
      effects.push({ type: "terminal.append", text: inner.data.output || output });
      break;
    }
    case "assistant": {
      const content = inner.message?.content;
      if (!Array.isArray(content)) {
        if (typeof content === "string" && content.trim()) {
          pushMessage({ id: inner.message?.id || uuid(), role: "assistant", content, timestamp: now() });
        }
        break;
      }
      updateLast((m) => {
        const existingTools = m.toolUses || [];
        const newTools = content
          .filter((b: any) => b.type === "tool_use")
          .filter((b: any) => !existingTools.some((tool) => tool.id === b.id))
          .map((b: any, i: number) => ({
            id: b.id,
            index: existingTools.length + i,
            name: b.name || "",
            input: b.input || {},
            status: "running" as const,
          }));
        for (const b of content) {
          if (b.type !== "tool_use") continue;
          if (isPlanTool(b.name || "")) {
            const todos = extractPlanTasks(b.input);
            if (todos) effects.push({ type: "plan.update", tasks: todos });
          }
        }
        if (newTools.length === 0) return m;
        return { ...m, toolUses: [...existingTools, ...newTools] };
      });
      break;
    }
    case "control_request": {
      const r = inner.request || {};
      const toolName = r.tool_name || "";
      const patch: Partial<ChatState> = {
        pendingControlRequest: {
          request_id: inner.request_id,
          tool_name: toolName,
          tool_input: r.input || {},
          description: toolName,
        },
      };
      if (toolName === "AskUserQuestion") {
        patch.inputBlockedReason = "Please answer the question above";
      }
      set(patch);
      break;
    }
    case "status": {
      if (inner.status === "ready") setStreaming(false);
      if (inner.status === "thinking") set({ streaming: true });
      if (inner.status === "compacting") set({ streaming: true });
      // WS 断开/重连：回合已死（WS 是唯一通道），必须复位 streaming。
      // 否则流式中断连后 GUI 永远停在"工作中"（"输出莫名卡死"，只能手动中断+继续复活）。
      // connected 兜底覆盖"半开连接"（服务器剔除 client 但没发 close，onclose 不触发）的场景。
      if (inner.status === "disconnected" || inner.status === "connected") setStreaming(false);
      break;
    }
    case "system": {
      if (inner.subtype === "compact_boundary") set({ streaming: false });
      if (inner.subtype === "slash_commands" && inner.commands) set({ slashCommands: inner.commands });
      break;
    }
    case "context_window": {
      // 会话累计 token 独立于窗口用量，总是可信（后端即使窗口用量未知也会带真实累计值）
      const patch: Partial<ChatState> = {};
      if (inner.session_input_tokens != null) patch.inputTokens = inner.session_input_tokens;
      if (inner.session_output_tokens != null) patch.outputTokens = inner.session_output_tokens;
      if (inner.session_cache_read_tokens != null) patch.cacheReadTokens = inner.session_cache_read_tokens;
      if (inner.session_cache_creation_tokens != null) patch.cacheCreationTokens = inner.session_cache_creation_tokens;
      if (inner.model) patch.model = inner.model;
      // 窗口用量(usedTokens/contextPercent/contextWindowSize)只在后端给了真实
      // remaining_percentage 时才更新。remaining=null 表示后端此刻拿不到当前用量
      // (会话刚开始/compact 后消息无 usage)，此时 `?? 0` 会把显示闪成 0/隐藏。
      if (inner.remaining_percentage != null) {
        patch.contextPercent = inner.remaining_percentage;
        patch.contextWindowSize = inner.context_window_size ?? 0;
        patch.usedTokens = inner.used_tokens ?? 0;
      }
      set(patch);
      break;
    }
    case "session_list":
    case "sessions_updated": {
      const sessions: ChatState["sessions"] = (inner.sessions || []).map((x: any) => ({
        id: x.sessionId || x.id || x.session_id || "",
        title: x.title || x.name || "Untitled",
        timestamp: x.timestamp || now(),
        isActive: x.is_active || x.isActive || x.active || false,
      }));
      set({
        sessions,
        sessionsLoaded: true,
        // total 缺失（旧后端）时保持 null；全量返回后 total === sessions.length，
        // 前端据此判断「列表完整」才允许会话文件夹孤儿清理。
        sessionTotal: typeof inner.total === "number" ? inner.total : sessions.length,
      });
      if (sessions.length > 0) {
        const latest = sessions.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
        effects.push({ type: "command.resumeSession", sessionId: latest.id });
      }
      break;
    }
    case "session_renamed":
      effects.push({ type: "command.listSessions" });
      break;
    case "session_loaded": {
      effects.push({ type: "terminal.clear" }, { type: "plan.clear" }, { type: "subagent.clear" });
      // 注意：这里不重置 contextPercent/contextWindowSize/usedTokens/outputTokens/model。
      // 会话边界的权威用量由后端紧随其后的 context_window 事件提供；若在此清零，
      // 输入面板会先闪成「ctx 0/x」再跳回真实值（用户反馈的「先归零再变正常」）。
      // 消息列表替换照旧。
      let ns: ChatState = {
        ...s,
        messages: [],
        streaming: false,
        sessionId: null,
        tasks: [],
      };
      if (inner.session_id) ns.sessionId = inner.session_id;
      if (Array.isArray(inner.messages)) {
        const merged = mergeSessionMessages(inner.messages, uuid);
        ns.messages = merged;
        ns.streaming = false;
        outer: for (let i = merged.length - 1; i >= 0; i--) {
          for (const tool of merged[i].toolUses || []) {
            if (isPlanTool(tool.name)) {
              const todos = extractPlanTasks(tool.input);
              if (todos) {
                effects.push({ type: "plan.update", tasks: todos });
                break outer;
              }
            }
          }
        }
      }
      s = ns;
      break;
    }
    case "current_session":
    case "session_created":
      if (inner.session_id) set({ sessionId: inner.session_id });
      break;
    case "tasks_updated": {
      const tasks = (inner.tasks || []).map((x: any) => ({
        id: x.id || x.task_id || "",
        description: x.description || x.prompt || "",
        status: x.status || "running",
        toolCount: x.tool_count || x.toolCount || 0,
        tokenCount: x.token_count || x.tokenCount || 0,
      }));
      set({ tasks });
      break;
    }
    case "task_started":
    case "task_progress":
    case "task_completed": {
      const status =
        t === "task_completed" ? inner.status || "completed" : "running";
      effects.push(buildSubAgentInfo(inner, status));
      break;
    }
    case "agent_transcript":
      effects.push({
        type: "subagent.transcript",
        taskId: inner.task_id,
        messages: (inner.messages || []).map((m: any) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
        error: inner.error,
      });
      break;
    case "user": {
      const content = inner.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            updateLast((m) => {
              const tools = [...(m.toolUses || [])];
              const idx = tools.findIndex((tool) => tool.id === block.tool_use_id);
              if (idx >= 0) {
                const resultContent =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content.map((c: any) => c.text || "").join("")
                      : "";
                const exitMatch = (resultContent || "").match(/exit(?:\s*code)?[:\s]*(\d+)/i);
                const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;
                tools[idx] = { ...tools[idx], status: "done", output: resultContent };
                if (isBashLike(tools[idx].name)) {
                  if (resultContent) effects.push({ type: "terminal.output", toolUseId: block.tool_use_id, text: resultContent });
                  effects.push({ type: "terminal.finish", toolUseId: block.tool_use_id, exitCode });
                }
                if (tools[idx].name.toLowerCase().includes("exitplanmode") && resultContent) {
                  const planText = (resultContent.match(/##\s*Approved Plan.*?\n([\s\S]*)/i) || [])[1]?.trim() || "";
                  const sid = s.sessionId || "";
                  const stitle = s.sessions.find((x) => x.id === sid)?.title || "";
                  effects.push({ type: "plan.save", sessionId: sid, title: stitle, planText });
                }
              }
              return { ...m, toolUses: tools };
            });
          }
        }
      }
      break;
    }
    case "permission_mode_changed": {
      if (inner.mode) {
        const savedMode = ctx.savedPermissionMode;
        if (inner.mode === "default" && savedMode && savedMode !== "default") {
          effects.push({ type: "command.resendPermissionMode", mode: savedMode });
          set({ permissionMode: savedMode });
          break;
        }
        set({ permissionMode: inner.mode });
      }
      break;
    }
    case "file_edit":
      if (inner.path) effects.push({ type: "emit.fileChanged", path: inner.path });
      break;
    default:
      break;
  }
  return { nextState: s, effects };
}
