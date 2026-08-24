import React from "react";
import type { BackgroundTask } from "../../stores/chatStore";
import { getChatState } from "../../stores/chatStore";
import { killTask } from "./useChatBridge";
import { t } from "../../i18n";
import { useEvent } from "../../services/useService";
import { Events, type ChatStateChangedPayload } from "../../services/events";

const statusIcon: Record<string, string> = {
  running: "⏳",
  done: "✅",
  error: "❌",
  killed: "⛔",
};

const statusColor: Record<string, string> = {
  running: "var(--accent)",
  done: "var(--semantic-success)",
  error: "var(--semantic-error)",
  killed: "var(--fg-muted)",
};

export function TasksPanel() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const tasks = payload?.state?.tasks ?? getChatState().tasks;

  if (tasks.length === 0) return null;

  const runningCount = tasks.filter((t) => t.status === "running").length;

  return (
    <div
      style={{
        borderTop: "1px solid var(--border-medium)",
        backgroundColor: "var(--bg-surface)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 10px",
          fontWeight: 600,
          color: "var(--fg-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        <span>
          {t("tasks.title")}{runningCount > 0 ? ` (${t("tasks.running", { count: runningCount })})` : ""}
        </span>
      </div>
      {tasks.map((task) => (
        <div
          key={task.id}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "4px 10px",
            gap: 6,
            borderBottom: "1px solid var(--border-light)",
          }}
        >
          <span style={{ fontSize: 14 }}>{statusIcon[task.status]}</span>
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: statusColor[task.status],
            }}
          >
            {task.description || `${t("tasks.taskPrefix")} ${task.id.slice(0, 8)}`}
          </span>
          <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>
            {task.toolCount > 0 && t("tasks.tools", { count: task.toolCount })}
            {task.tokenCount > 0 && ` · ${t("tasks.tokens", { count: task.tokenCount })}`}
          </span>
          {task.status === "running" && (
            <button
              onClick={() => killTask(task.id)}
              title={t("tasks.killTask")}
              style={{
                border: "none",
                background: "none",
                cursor: "pointer",
                color: "var(--semantic-error)",
                fontSize: 11,
                padding: "0 4px",
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
