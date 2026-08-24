// ── Sub-Agent Panel — list of in-process teammates + expandable transcript ──

import { memo, useEffect, useRef, useState, useCallback, useLayoutEffect } from "react";
import { useEvent } from "../../services/useService";
import { Events, type SubAgentsChangedPayload } from "../../services/events";
import { getSubAgentState, setExpandedAgent, type SubAgentInfo, type SubAgentMessage } from "../../stores/subAgentStore";
import { loadAgentTranscript } from "./useChatBridge";
import { t } from "../../i18n";

const PAGE_SIZE = 20;

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

// ── Message renderer ──

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b.text) return b.text;
      if (b.type === "tool_use") return t("subAgent.toolUse", { name: b.name || "?" });
      if (b.type === "tool_result") return t("subAgent.toolResult");
      if (b.type === "thinking") return b.thinking?.slice(0, 80) || t("subAgent.thinking");
      return b.type ? `[${b.type}]` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function MessageBubble({ msg }: { msg: SubAgentMessage }) {
  const isUser = msg.role === "user";
  const text = extractText(msg.content);

  return (
    <div style={{
      padding: "3px 10px",
      fontSize: "calc(var(--font-scale, 1) * 11px)",
      lineHeight: 1.4,
      color: isUser ? "var(--semantic-info)" : "var(--fg-primary)",
      borderBottom: "1px solid var(--border-light)",
    }}>
      <span style={{ fontWeight: 600, marginRight: 6, fontSize: 10 }}>
        {isUser ? t("subAgent.user") : t("subAgent.agent")}
      </span>
      <span style={{ wordBreak: "break-word" }}>
        {text ? text.slice(0, 300) : t("subAgent.roleMessage", { role: msg.role })}
      </span>
    </div>
  );
}

// ══════════════════════════════════════════════════

function SubAgentPanelImpl() {
  const payload = useEvent<SubAgentsChangedPayload>(Events.SUB_AGENTS_CHANGED);
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

  // Poll for transcript updates while a running agent is expanded
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef(expanded?.status);
  useEffect(() => {
    prevStatusRef.current = expanded?.status;
    if (expanded && expanded.status === "running") {
      // Start polling: refresh transcript every 2s while agent is running
      pollRef.current = setInterval(() => {
        loadAgentTranscript(expanded.taskId);
      }, 2000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        // Agent just stopped running — do delayed final refresh
        // (file might not be fully flushed when status changes)
        if (prevStatusRef.current === "running" && expandedAgentId) {
          const taskId = expandedAgentId;
          loadAgentTranscript(taskId);
          setTimeout(() => loadAgentTranscript(taskId), 1500);
        }
      }
    };
  }, [expanded?.taskId, expanded?.status]);

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
                }}/>
                <span style={{
                  flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap", color: "var(--fg-primary)", fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 12px)",
                }}>
                  {displayName}
                </span>
                <span style={{ fontSize: 10, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
                  {agent.toolCount > 0 && `${agent.toolCount}t`}
                  {agent.tokenCount > 0 && ` · ${agent.tokenCount}tk`}
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
              {agent.description && (
                <div style={{
                  fontSize: 10, color: "var(--fg-muted)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  marginTop: 2, paddingLeft: 16,
                }}>
                  {agent.description}
                </div>
              )}
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
        </span>
        <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>
          {expanded.toolCount}t · {expanded.tokenCount}tk
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
          <MessageBubble key={i} msg={msg}/>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
