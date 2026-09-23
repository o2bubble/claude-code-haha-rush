// ── chatReduce — the pure chat-domain fold ──
// (state, wireMsg) → { nextState, effects }. Owns ChatState exclusively; every
// side effect is returned as a typed ChatEffect for the runner to apply.
// Faithful port of useChatBridge's ~24 handlers — behaviour is unchanged.

import type { ChatState, ChatMessage, ChatEffect, WireMessage, ReduceCtx } from "./types";
import type { ToolUse } from "../stores/chatStore";
import type { EffortLevelUI } from "../stores/chatStore";
import { extractPlanTasks, isPlanTool } from "./planExtract";
import { mergeSessionMessages } from "./sessionMerge";

const EFFORT_LEVELS: EffortLevelUI[] = ["low", "medium", "high", "max"];
function isEffortLevelUI(v: unknown): v is EffortLevelUI {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export interface ReduceResult {
  nextState: ChatState;
  effects: ChatEffect[];
}

/** Canonical initial chat state. Kept in sync with chatStore's default. */
export function emptyChatState(): ChatState {
  return {
    messages: [],
    streaming: false,
    compacting: false,
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
    thinkingModeEnabled: false,
    effort: null,
    modelCapabilities: null,
    // 最近一次流式活动的时间戳（null=尚无）；无响应提示据此计算卡顿秒数
    lastStreamEventAt: null,
    // 在途工具数（tool_use 开始 → tool_result 回来）。仅用于展示/诊断；
    // stall 决策**不再据此豁免**（2026-09-10 一刀切：静默 30s 一律弹条）。
    activeToolUses: 0,
    // 后端权威忙闲信号（status 广播携带 busy 布尔写入）。undefined = 后端尚无信号
    // （初始化/WS 半开），回落 streaming；true/false 后即用权威值。
    backendBusy: undefined,
  };
}

/**
 * 后端是否忙（权威信号）。`backendBusy === undefined`（后端尚无信号，初始化或
 * WS 半开）时回落乐观 streaming——保持旧行为；有了布尔后即用权威值，消除
 * interrupt 乐观清空/等子代理静默/error 卡 true 三类 streaming 误判。
 */
export function isBackendBusy(s: ChatState): boolean {
  return s.backendBusy === undefined ? s.streaming : s.backendBusy;
}

/**
 * 在途工具名（tool_use 已开始、tool_result 未回）。
 * 仅供 stall 决策的**自动中断分级宽限**使用（Bash/Task 给更长宽限, 避免真在
 * 干活时被过早杀掉）；不参与决策条弹出判定（弹条恒 30s, 见 streamStallDecision）。
 * 无工具在跑 → 空数组。
 */
export function activeToolNames(s: ChatState): string[] {
  return s.messages.at(-1)?.toolUses?.filter((t) => t.status === "running").map((t) => t.name) ?? [];
}

/**
 * 无响应提示：给定最近流式活动时间，算出当前已卡顿秒数。
 * 仅在 streaming 且超过阈值后返回 >0（UI 据此显示"已 N 秒无响应"）。
 * **不做工具豁免**（2026-09-10 一刀切）——工具在跑时后端可能零广播，但分级
 * 判断屡屡不准（真卡死也被豁免，用户被迫干等）。现在静默即计数，配合 30s
 * 决策条把选择权交给用户；确定性非卡死状态（等用户回答/压缩/子代理）由
 * ChatInputPanel 在调用状态机前拦掉。
 * @param thresholdMs 阈值（默认 30s，与决策条 ENTER_DECISION_SECS 一致）
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
      lastTool: (msg.last_tool as string | undefined) ?? undefined,
      startTime: (msg.start_time as number | undefined) ?? undefined,
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

  /** 按 tool_use_id 全局查找含该工具的 assistant 消息并修复——多轮 assistant
   *  消息时 updateLast 只改最后一条, tool_result 对应更早消息时卡片停在
   *  "运行中…"（用户实测: 命令输出都出来了还显示运行中）。找不到才回退 updateLast。 */
  const updateToolByUseId = (toolUseId: string, fn: (t: ToolUse) => ToolUse) => {
    const msgs = [...s.messages];
    let updated = false;
    for (const m of msgs) {
      if (m.role !== "assistant" || !m.toolUses) continue;
      const idx = m.toolUses.findIndex((tool) => tool.id === toolUseId);
      if (idx >= 0) {
        const tools = [...m.toolUses];
        tools[idx] = fn(tools[idx]!);
        m.toolUses = tools;
        updated = true;
        break;
      }
    }
    if (updated) {
      set({ messages: msgs });
    } else {
      updateLast((m) => {
        const tools = [...(m.toolUses || [])];
        const idx = tools.findIndex((tool) => tool.id === toolUseId);
        if (idx >= 0) tools[idx] = fn(tools[idx]!);
        return { ...m, toolUses: tools };
      });
    }
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
  // 活动（长 bash 工具不是卡死）；task_*（子代理运行/进度）同样——主回合等在
  // 子代理结果上时流静默 ≠ 卡死（实测长 Task 运行会被误弹「是否中断」甚至自动
  // 唤醒）；status/context_window 等周期性消息不算，防止掩盖真实卡停。
  const isSubAgentActivity =
    t === "task_started" || t === "task_progress" ||
    t === "task_completed" || t === "task_messages";
  if (msg.type === "stream_event" || t === "tool_progress" || isSubAgentActivity) {
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
        // 在途工具 +1（tool_result 回来时 -1）——供 activeToolNames 判定自动中断
        // 分级宽限（Bash/Task 给更长宽限），不再用于决策条豁免。
        set({ activeToolUses: (s.activeToolUses ?? 0) + 1 });
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
    case "result": {
      setStreaming(false);
      // 回合结束（含中断）→ 在途工具计数清零：abort 的 tool_result 永远不会来，
      // 不清会泄漏（此后 stall 永远 0, 真卡死不再提示）。豁免期一并失效。
      set({ activeToolUses: 0 });
      // 只认显式 busy===false 的 result 为权威 turn 结束——裸 result（局部 slash
      // 命令如 /mcp-refresh、/reload-plugins 结束时也发 result，但不占 global busy）
      // 若无条件清 backendBusy，会在主 turn 仍 busy 时误判空闲 → 用户消息直发撞
      // "A prompt is already being processed"（不进队列）。裸 result 不动 backendBusy，
      // 交给后续 status:ready(busy:false) / 带 busy 的 result 收口。
      const r = inner as { busy?: boolean };
      if (r.busy === false) set({ backendBusy: false });
      break;
    }
    case "error":
      // 必须复位全局 streaming：某些路径（上游中断/看门狗降级失败/断连）error 后
      // 没有 result 兜底，不复位会让 GUI 永远停在 streaming=true（状态栏"工作中"，
      // 用户只能手动中断+继续来"激活"——即"输出莫名卡死"）。result 仍会覆盖为 false。
      setStreaming(false);
      // 同时复位"切换中"：会话加载失败（文件没了/被删）走的就是 error 分支，
      // 不清的话 loading 会一直转（用户以为还在切、实际早就失败了）。
      set({ compacting: false, backendBusy: false, activeToolUses: 0, switchingTo: null });
      pushMessage({ id: uuid(), role: "assistant", content: `Error: ${inner.message || "Unknown error"}`, timestamp: now() });
      break;
    case "task_error":
      // 任务级错误（如 load_agent_transcript/kill_task 打在已结束的任务上）——
      // 绝不能动全局 streaming，也不进聊天气泡：否则主回合还在跑时 GUI 会被
      // 误标"就绪"，用户下一条消息撞 busy（"A prompt is already being processed"）。
      effects.push({ type: "subagent.error", taskId: inner.task_id, message: inner.message });
      break;
    case "tool_progress": {
      if (!inner.data) break;
      if (inner.data.type !== "bash_progress" && inner.data.type !== "powershell_progress") break;
      const output = inner.data.fullOutput || inner.data.output || "";
      // 按 id 更新该工具卡片（fullOutput 是累积值 → 整体替换，不拼接，故不会重复）。
      // 原先用 updateLast 写"最后一个工具"，并发工具时进度会写到别的卡片上。
      // updateToolByUseId 找不到时自身回落到 updateLast，不会丢更新。
      updateToolByUseId(inner.parent_tool_use_id || "", (tool) => ({
        ...tool,
        output,
        status: "running",
      }));
      // 后端送的是**滚动尾部窗口**（最近 5 行），不是增量 —— 去重交给
      // terminalStore.mergeTailWindow（按行找最长重叠）。这里按工具 id 寻址，
      // 避免并发工具时追加到别的条目（原先只追加到"最后一个"）。
      //
      // ⚠️ 用 parent_tool_use_id 而非 tool_use_id：后者是 `bash-progress-N`
      // 计数器（toolExecution.ts 每次 onProgress 自增），每个进度包都不同；
      // parentToolUseID 才是真实的 tool_use id，与 terminal.start 的 cb.id、
      // terminal.output 的 block.tool_use_id 同源。
      effects.push({
        type: "terminal.append",
        toolUseId: inner.parent_tool_use_id || "",
        text: inner.data.output || output,
      });
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
        const isSub = !!inner.parent_tool_use_id;
        const newTools = content
          .filter((b: any) => b.type === "tool_use")
          .filter((b: any) => !existingTools.some((tool) => tool.id === b.id))
          .map((b: any, i: number) => ({
            id: b.id,
            index: existingTools.length + i,
            name: b.name || "",
            input: b.input || {},
            status: "running" as const,
            ...(isSub ? { subagent: true } : {}),
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
      // backendBusy 权威源：**只认 status 事件携带的显式 busy 布尔**（后端 ideMode 广播）。
      // 缺省（子命令如 rewind/refresh 的裸 ready/thinking 不带 busy）不改 backendBusy ——
      // 它们只是局部命令完成，不代表主 turn 结束，清了会误判空闲直发撞 busy。
      // 仅真正持有 global busy 的 turn（compact/handleUserPrompt）广播才带 busy 布尔。
      const busy = (inner as { busy?: boolean }).busy;
      if (inner.status === "ready") {
        setStreaming(false);
        set({ compacting: false, ...(busy !== undefined ? { backendBusy: busy } : {}) });
      }
      if (inner.status === "thinking") set({ streaming: true, ...(busy !== undefined ? { backendBusy: busy } : {}) });
      // compacting: 压缩会话中(compacting→compact_boundary)。压缩期流无事件、lastStreamEventAt 停更，
      // 置此标志抑制"流卡死决策期"——压缩不是卡死。
      if (inner.status === "compacting") set({ streaming: true, lastStreamEventAt: now(), compacting: true, ...(busy !== undefined ? { backendBusy: busy } : {}) });
      // interrupt：中断瞬间。backendBusy 仍 true（turn 还没收尾，abort 后 finally 才 ready）。
      // 不碰 streaming（interrupt() 已乐观清）—— 仅维持权威 busy，防随后的 gate 误判空闲直发撞 busy。
      if (inner.status === "interrupting") { if (busy !== undefined) set({ backendBusy: busy }); }
      // WS 断开：回合已死（WS 是唯一通道），必须复位 streaming + 清 backendBusy
      //（后端无法响应，判空闲合理——否则流式中断连后 GUI 永远停在"工作中"）。
      if (inner.status === "disconnected") { setStreaming(false); set({ compacting: false, backendBusy: false }); }
      // WS 重连(connected)：清 streaming（半开连接兜底）但**不清 backendBusy**——重连
      // 成功 ≠ 后端空闲，后端可能还在跑上一 turn（等子代理/未收尾），清了会误判空闲直发
      // 撞 busy。backendBusy 交给后续 ready/thinking 广播决定。
      if (inner.status === "connected") { setStreaming(false); set({ compacting: false }); }
      break;
    }
    case "system": {
      if (inner.subtype === "compact_boundary") set({ streaming: false, compacting: false });
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
        compacting: false,
        sessionId: null,
        tasks: [],
        // 到这里切换才算真正完成（消息列表即将被替换）——
        // 见 chatStore.switchingTo 的注释：不能在 current_session 时清。
        switchingTo: null,
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
    case "task_messages": {
      // 推送式 transcript 增量（后端 broadcastTaskStateChanges 随状态/进度广播）
      effects.push({
        type: "subagent.transcript.append",
        taskId: inner.task_id,
        messages: (inner.messages || []).map((m: any) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
        total: inner.total,
      });
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
            // 在途工具 -1（与 content_block_start(tool_use) 的 +1 配对）
            set({ activeToolUses: Math.max(0, (s.activeToolUses ?? 0) - 1) });
            updateToolByUseId(block.tool_use_id, (tool) => {
              const resultContent =
                typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: any) => c.text || "").join("")
                    : "";
              const exitMatch = (resultContent || "").match(/exit(?:\s*code)?[:\s]*(\d+)/i);
              const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;
              const updated = { ...tool, status: "done" as const, output: resultContent };
              if (isBashLike(tool.name)) {
                if (resultContent) effects.push({ type: "terminal.output", toolUseId: block.tool_use_id, text: resultContent });
                effects.push({ type: "terminal.finish", toolUseId: block.tool_use_id, exitCode });
              }
              if (tool.name.toLowerCase().includes("exitplanmode") && resultContent) {
                const planText = (resultContent.match(/##\s*Approved Plan.*?\n([\s\S]*)/i) || [])[1]?.trim() || "";
                const sid = s.sessionId || "";
                const stitle = s.sessions.find((x) => x.id === sid)?.title || "";
                effects.push({ type: "plan.save", sessionId: sid, title: stitle, planText });
              }
              return updated;
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
    case "thinking_mode_changed": {
      if (typeof inner.enabled === "boolean") set({ thinkingModeEnabled: inner.enabled });
      if (isEffortLevelUI(inner.effort)) set({ effort: inner.effort });
      break;
    }
    case "effort_changed": {
      if (isEffortLevelUI(inner.value)) set({ effort: inner.value });
      break;
    }
    case "model_capabilities": {
      if (inner.capability) set({ modelCapabilities: inner.capability });
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
