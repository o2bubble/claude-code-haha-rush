// ── Sub-Agent Panel — list of in-process teammates + expandable transcript ──
// Transcript 由后端推送增量(task_messages)实时追加; load_agent_transcript 仅作
// 展开首拉与断线重连兜底(降频)。

import { memo, useEffect, useRef, useState, useCallback, useLayoutEffect } from "react";
import { useEvent } from "../../services/useService";
import { Events, type SubAgentsChangedPayload } from "../../services/events";
import { getSubAgentState, setExpandedAgent, type SubAgentInfo, type SubAgentMessage } from "../../stores/subAgentStore";
import { loadAgentTranscript, killTask } from "./useChatBridge";
import { t } from "../../i18n";
import { showCtxMenu } from "../ContextMenu";
import { getChatState } from "../../stores/chatStore";

const PAGE_SIZE = 20;
/** 兜底轮询间隔(仅断线重连后首拉用; 正常路径靠后端推送) */
const FALLBACK_POLL_MS = 10000;

// ── Status helpers ──

const STATUS_DOT: Record<string, string> = {
  running: "var(--semantic-warning)",
  completed: "var(--semantic-success)",
  failed: "var(--semantic-error)",
  killed: "var(--fg-muted)",
};

const getStatusLabel = (status: string): string => {
  const map: Record<string, string> = {
    running: "subAgent.statusRunning",
    completed: "subAgent.statusDone",
    failed: "subAgent.statusFailed",
    killed: "subAgent.statusKilled",
  };
  return t(map[status] || status);
};

/** token 计数格式化: 1234 → "1.2k", 1560000 → "1.6M" */
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 耗时格式化: <60s "42s"; <1h "5m03s"; 否则 "1h02m" */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// ── Message rendering (T2: 对齐主聊天区工具卡风格) ──

interface ParsedBlock {
  kind: "text" | "tool" | "tool_result" | "thinking" | "other";
  text?: string;
  toolName?: string;
  inputSummary?: string;
  isError?: boolean;
}

function parseBlocks(content: unknown): ParsedBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [{ kind: "text", text: String(content ?? "") }];
  return content.map((b: any): ParsedBlock => {
    if (typeof b === "string") return { kind: "text", text: b };
    if (b.type === "tool_use") {
      const input = b.input ?? {};
      // 摘要: 常见输入字段优先(路径/命令/问题描述)
      const inputSummary =
        (typeof input.file_path === "string" && input.file_path) ||
        (typeof input.command === "string" && input.command) ||
        (typeof input.pattern === "string" && input.pattern) ||
        (typeof input.query === "string" && input.query) ||
        (typeof input.description === "string" && input.description) ||
        (typeof input.prompt === "string" && String(input.prompt).slice(0, 80)) ||
        undefined;
      return { kind: "tool", toolName: b.name || "?", inputSummary };
    }
    if (b.type === "tool_result") {
      const inner = Array.isArray(b.content)
        ? b.content.map((c: any) => c?.text || "").join("")
        : typeof b.content === "string"
          ? b.content
          : "";
      return { kind: "tool_result", text: inner, isError: !!b.is_error };
    }
    if (b.type === "thinking") return { kind: "thinking", text: b.thinking };
    if (b.text) return { kind: "text", text: b.text };
    return { kind: "other", text: b.type ? `[${b.type}]` : "" };
  });
}

/** 单个消息气泡: user/assistant 风格区分 + tool_use 渲染为折叠小卡片 */
function MessageBubble({ msg }: { msg: SubAgentMessage }) {
  const isUser = msg.role === "user";
  const blocks = parseBlocks(msg.content);
  const ts = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <div style={{
      padding: "4px 10px",
      borderBottom: "1px solid var(--border-light)",
      backgroundColor: isUser ? "var(--bg-hover)" : "transparent",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{
          fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 10px)",
          color: isUser ? "var(--semantic-info)" : "var(--accent)",
        }}>
          {isUser ? t("subAgent.user") : t("subAgent.agent")}
        </span>
        {ts && <span style={{ fontSize: "calc(var(--font-scale, 1) * 9px)", color: "var(--fg-muted)" }}>{ts}</span>}
      </div>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: ParsedBlock }) {
  const base: React.CSSProperties = {
    fontSize: "calc(var(--font-scale, 1) * 11px)",
    lineHeight: 1.45,
    wordBreak: "break-word",
    color: "var(--fg-primary)",
    whiteSpace: "pre-wrap",
  };

  if (block.kind === "tool") {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        margin: "2px 0", padding: "3px 8px",
        border: "1px solid var(--border-light)", borderRadius: 5,
        backgroundColor: "var(--bg-surface)", overflow: "hidden",
      }}>
        <span style={{ fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--accent)", flexShrink: 0, fontWeight: 600 }}>
          ⚙ {block.toolName}
        </span>
        {block.inputSummary && (
          <span style={{
            fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {block.inputSummary}
          </span>
        )}
      </div>
    );
  }

  if (block.kind === "tool_result") {
    const text = (block.text || "").trim();
    if (!text) return null;
    return (
      <div style={{
        ...base,
        fontSize: "calc(var(--font-scale, 1) * 10px)",
        color: block.isError ? "var(--semantic-error)" : "var(--fg-muted)",
        padding: "2px 8px", margin: "1px 0",
        borderLeft: `2px solid ${block.isError ? "var(--semantic-error)" : "var(--border-medium)"}`,
        maxHeight: 60, overflow: "hidden",
      }}>
        {text.slice(0, 400)}{text.length > 400 ? "…" : ""}
      </div>
    );
  }

  if (block.kind === "thinking") {
    const text = (block.text || "").trim();
    if (!text) return null;
    return (
      <div style={{
        ...base,
        fontSize: "calc(var(--font-scale, 1) * 10px)",
        color: "var(--fg-muted)", fontStyle: "italic",
        padding: "1px 8px", margin: "1px 0",
      }}>
        {text.length > 200 ? `${text.slice(0, 200)}…` : text}
      </div>
    );
  }

  // text / other
  const text = (block.text || "").trim();
  if (!text) return null;
  return <div style={{ ...base, padding: "1px 2px" }}>{text}</div>;
}

// ══════════════════════════════════════════════════

function SubAgentPanelImpl() {
  const payload = useEvent<SubAgentsChangedPayload>(Events.SUB_AGENTS_CHANGED);
  // 运行中 agent 的耗时计时: 每秒 tick 一次驱动重渲染(仅在有 running 时)
  const [, setTick] = useState(0);
  const hasRunning = (payload?.state ?? getSubAgentState()).agents.some(a => a.status === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);
  const state = payload?.state ?? getSubAgentState();
  const { agents, expandedAgentId, transcripts } = state;

  const expanded = agents.find(a => a.taskId === expandedAgentId);
  const transcript = expandedAgentId ? transcripts[expandedAgentId] : null;

  const handleToggle = (taskId: string) => {
    if (expandedAgentId === taskId) {
      setExpandedAgent(null);
    } else {
      setExpandedAgent(taskId);
      loadAgentTranscript(taskId);
    }
  };

  // 兜底轮询: 仅当 WS 断开(chat 未连接)时低频拉取——正常路径靠后端 task_messages 推送。
  // 运行中 agent 结束后做一次延迟补拉(磁盘 flush 时序)。
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef(expanded?.status);
  useEffect(() => {
    prevStatusRef.current = expanded?.status;
    if (expanded && expanded.status === "running") {
      pollRef.current = setInterval(() => {
        // WS 已连接 → 后端推送负责, 轮询空转浪费; 断线才兜底
        if (getChatState().connected) return;
        loadAgentTranscript(expanded.taskId);
      }, FALLBACK_POLL_MS);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        if (prevStatusRef.current === "running" && expandedAgentId) {
          const taskId = expandedAgentId;
          loadAgentTranscript(taskId);
          setTimeout(() => loadAgentTranscript(taskId), 1500);
        }
      }
    };
  }, [expanded?.taskId, expanded?.status]);

  // 右键菜单: kill 任务 / 复制任务 id / 复制 agentId
  const handleRowContextMenu = useCallback((e: React.MouseEvent, agent: SubAgentInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const items: Array<{ label: string; action: () => void; separator?: boolean }> = [];
    if (agent.status === "running") {
      items.push({
        label: t("subAgent.kill"),
        action: () => killTask(agent.taskId),
      });
    }
    items.push(
      { label: t("subAgent.copyTaskId"), action: () => { navigator.clipboard.writeText(agent.taskId).catch(() => {}); } },
      { label: t("subAgent.copyAgentId"), action: () => { navigator.clipboard.writeText(agent.agentId).catch(() => {}); } },
    );
    showCtxMenu(e.clientX, e.clientY, items);
  }, []);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", overflow: "hidden",
      fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 12px)",
    }}>
      {/* ═══ Header ═══ */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 10px", borderBottom: "1px solid var(--border-light)",
        fontWeight: 600, color: "var(--fg-primary)", flexShrink: 0,
      }}>
        <span>{t("subAgent.title")}</span>
        {agents.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>
            {t("subAgent.runningTotal", { running: agents.filter(a => a.status === "running").length, total: agents.length })}
          </span>
        )}
      </div>

      {/* ═══ Agent list ═══ */}
      <div style={{ flex: expanded ? "0 0 auto" : "1 1 auto", maxHeight: expanded ? "55%" : "none", overflow: "auto", borderBottom: expanded ? "1px solid var(--border-light)" : "none" }}>
        {agents.length === 0 && (
          <div style={{
            padding: 20, color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 12px)", textAlign: "center",
          }}>
            {t("subAgent.empty")}
          </div>
        )}
        {agents.map((agent) => {
          const isExpanded = agent.taskId === expandedAgentId;
          const displayName = agent.teamName && agent.teamName !== "local"
            ? `${agent.agentName}@${agent.teamName}`
            : agent.agentName;
          return (
            <div
              key={agent.taskId}
              onClick={() => handleToggle(agent.taskId)}
              onContextMenu={(e) => handleRowContextMenu(e, agent)}
              style={{
                padding: "4px 10px", cursor: "pointer",
                borderBottom: "1px solid var(--border-light)",
                backgroundColor: isExpanded ? "rgba(0,122,204,0.04)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  backgroundColor: STATUS_DOT[agent.status] || "var(--fg-muted)",
                  flexShrink: 0,
                  animation: agent.status === "running" ? "spin 1.2s linear infinite" : undefined,
                }}/>
                <span style={{
                  flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", color: "var(--fg-primary)", fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 12px)",
                }}>
                  {displayName}
                </span>
                <span style={{ fontSize: 10, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
                  {agent.toolCount > 0 && `${fmtCount(agent.toolCount)}t`}
                  {agent.tokenCount > 0 && ` · ${fmtCount(agent.tokenCount)}tk`}
                  {agent.status === "running" && agent.startTime && (
                    <> · {fmtDuration(Date.now() - agent.startTime)}</>
                  )}
                </span>
                <span style={{
                  fontSize: 9, color: STATUS_DOT[agent.status],
                  flexShrink: 0,
                }}>
                  {getStatusLabel(agent.status)}
                </span>
                <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>
                  {isExpanded ? "▲" : "▼"}
                </span>
              </div>
              {(agent.status === "running" && agent.lastTool) || agent.description ? (
                <div style={{
                  fontSize: 10, color: "var(--fg-muted)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  marginTop: 2, paddingLeft: 16,
                }}>
                  {agent.status === "running" && agent.lastTool ? (
                    <span style={{ color: "var(--accent)" }}>{agent.lastTool}</span>
                  ) : null}
                  {agent.status === "running" && agent.lastTool && agent.description ? " — " : null}
                  {agent.description || ""}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* ═══ Expanded transcript ═══ */}
      {expanded && (
        <TranscriptView
          expanded={expanded}
          transcript={transcript}
          onAgentChange={expanded.taskId}
        />
      )}
    </div>
  );
}
export const SubAgentPanel = memo(SubAgentPanelImpl);

// ── Transcript sub-component with pagination ──

function TranscriptView({
  expanded,
  transcript,
  onAgentChange,
}: {
  expanded: SubAgentInfo;
  transcript: { loading: boolean; loaded: boolean; messages: SubAgentMessage[]; error?: string } | null;
  onAgentChange: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const prevScrollHeightRef = useRef(0);
  const wasAtBottomRef = useRef(true);
  const prevTaskIdRef = useRef(onAgentChange);

  const messages = transcript?.messages ?? [];

  // Reset displayCount when switching to a different agent
  useEffect(() => {
    if (prevTaskIdRef.current !== onAgentChange) {
      setDisplayCount(PAGE_SIZE);
      prevTaskIdRef.current = onAgentChange;
    }
  }, [onAgentChange]);

  // Auto-expand + scroll when new messages arrive and user is at bottom
  const msgsLen = messages.length;
  useEffect(() => {
    if (wasAtBottomRef.current && displayCount < msgsLen) {
      setDisplayCount(msgsLen);
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "instant" });
      });
    }
  }, [msgsLen]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;

    if (el.scrollTop < 60 && displayCount < messages.length) {
      prevScrollHeightRef.current = el.scrollHeight;
      setDisplayCount((c) => Math.min(c + PAGE_SIZE, messages.length));
    }
  }, [displayCount, messages.length]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || prevScrollHeightRef.current === 0) return;
    const heightDiff = el.scrollHeight - prevScrollHeightRef.current;
    if (heightDiff > 0) {
      el.scrollTop = el.scrollTop + heightDiff;
    }
    prevScrollHeightRef.current = 0;
  }, [displayCount]);

  const visibleMessages = messages.slice(Math.max(0, messages.length - displayCount));
  const hasMore = displayCount < messages.length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Transcript header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 10px", borderBottom: "1px solid var(--border-light)",
        fontWeight: 600, color: "var(--fg-primary)", fontSize: "calc(var(--font-scale, 1) * 11px)", flexShrink: 0,
        backgroundColor: "var(--bg-surface)",
      }}>
        <span>
          {expanded.agentName}@{expanded.teamName}
          <span style={{ color: STATUS_DOT[expanded.status], marginLeft: 8 }}>
            ● {getStatusLabel(expanded.status)}
          </span>
          {expanded.status === "running" && expanded.startTime && (
            <span style={{ color: "var(--fg-muted)", marginLeft: 8, fontWeight: 400 }}>
              {fmtDuration(Date.now() - expanded.startTime)}
            </span>
          )}
        </span>
        <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>
          {expanded.toolCount > 0 && `${fmtCount(expanded.toolCount)}t`}
          {expanded.toolCount > 0 && expanded.tokenCount > 0 && " · "}
          {expanded.tokenCount > 0 && `${fmtCount(expanded.tokenCount)}tk`}
        </span>
      </div>

      {/* Message list */}
      <div ref={containerRef} onScroll={handleScroll} style={{ flex: 1, overflow: "auto" }}>
        {transcript?.loading && (
          <div style={{ padding: 16, color: "var(--fg-muted)", textAlign: "center", fontSize: 11 }}>
            {t("subAgent.loadingTranscript")}
          </div>
        )}
        {transcript?.loaded && messages.length === 0 && (
          <div style={{ padding: 16, color: transcript.error ? "var(--semantic-error)" : "var(--fg-muted)", textAlign: "center", fontSize: 11 }}>
            {transcript.error || t("subAgent.noMessages")}
          </div>
        )}
        {!transcript?.loading && !transcript?.loaded && (
          <div style={{ padding: 16, color: "var(--fg-muted)", textAlign: "center", fontSize: 11 }}>
            {t("subAgent.clickToExpand")}
          </div>
        )}

        {hasMore && (
          <div style={{ textAlign: "center", padding: "6px 0" }}>
            <button
              onClick={() => {
                const el = containerRef.current;
                if (el) prevScrollHeightRef.current = el.scrollHeight;
                setDisplayCount((c) => Math.min(c + PAGE_SIZE, messages.length));
              }}
              style={{
                border: "1px solid var(--border-medium)", borderRadius: 4,
                padding: "3px 12px", backgroundColor: "var(--bg-root)",
                cursor: "pointer", fontSize: 10,
                fontFamily: "var(--font-sans)", color: "var(--fg-secondary)",
              }}
            >
              {t("subAgent.loadEarlier", { count: messages.length - displayCount })}
            </button>
          </div>
        )}

        {visibleMessages.map((msg, i) => (
          <MessageBubble key={`m${messages.length - visibleMessages.length + i}`} msg={msg}/>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
