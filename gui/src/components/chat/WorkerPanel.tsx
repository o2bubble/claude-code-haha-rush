import React, { useState, useEffect, useCallback } from "react";
import { useBackend, BackendService } from "../../services/backendService";
import { useMcpStatus } from "../../services/mcpBridge";
import { usePluginProcesses, processStatusMeta, isProcessActive } from "../../services/pluginProcessBridge";
import { useEventHandler, useEvent } from "../../services/useService";
import { Events, type ChatStateChangedPayload } from "../../services/events";
import type { BackgroundTask } from "../../stores/chatStore";
import { getChatState } from "../../stores/chatStore";
import { killTask } from "./useChatBridge";
import { t } from "../../i18n";

// value 存 i18n key，渲染时经 t() 取当前语言
const statusLabel: Record<string, string> = {
  stopped: "worker.statusStopped", starting: "worker.statusStarting", running: "worker.statusRunning", error: "worker.statusError",
};
const statusColor: Record<string, string> = {
  stopped: "var(--fg-muted)", starting: "var(--accent)", running: "var(--semantic-success)", error: "var(--semantic-error)",
};

const taskStatusIcon: Record<string, string> = {
  running: "⏳", done: "✅", error: "❌", killed: "⛔",
};

const taskStatusColor: Record<string, string> = {
  running: "var(--accent)", done: "var(--semantic-success)", error: "var(--semantic-error)", killed: "var(--fg-muted)",
};

const header: React.CSSProperties = {
  padding: "8px 10px", borderBottom: "1px solid var(--border-light)",
  fontWeight: 600, color: "var(--fg-primary)", fontSize: 12,
  fontFamily: "var(--font-sans)",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: "var(--fg-muted)", padding: "6px 10px 2px",
  fontFamily: "var(--font-sans)", textTransform: "uppercase" as const,
};

/** GUI server 存活状态：轮询 get_gui_server_status（只读不拉起），重启后立即刷新。 */
function useGuiServerStatus() {
  const [st, setSt] = useState<{ connected: boolean; port: number; rev: number }>({ connected: false, port: 8766, rev: 0 });
  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = await invoke<any>("get_gui_server_status");
      setSt((p) => ({ connected: !!r?.connected, port: r?.port ?? 8766, rev: p.rev + 1 }));
    } catch { /* server 查询失败 = 视为未连 */ }
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);
  return { ...st, refresh };
}

export function WorkerPanel() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const tasks: BackgroundTask[] = payload?.state?.tasks ?? getChatState().tasks;
  const backend = useBackend();
  const mcp = useMcpStatus();
  const guiServer = useGuiServerStatus();
  const pluginProcesses = usePluginProcesses();

  const runningTasks = tasks.filter((t) => t.status === "running");
  const doneTasks = tasks.filter((t) => t.status !== "running");

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      fontFamily: "var(--font-sans)", fontSize: 11, overflow: "auto",
    }}>
      <div style={header}>{t("worker.title")}</div>

      {/* Backend status */}
      <div style={sectionLabel}>{t("worker.ideBackend")}</div>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
        borderBottom: "1px solid var(--border-light)",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          backgroundColor: statusColor[backend.status],
          flexShrink: 0,
        }} />
        <span style={{ flex: 1, color: statusColor[backend.status], fontWeight: 500 }}>
          {statusLabel[backend.status] ? t(statusLabel[backend.status]) : backend.status}
        </span>
        {backend.port && (
          <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>{t("worker.port")} {backend.port}</span>
        )}
        <button
          onClick={() => BackendService.restart()}
          title={t("worker.restartBackend")}
          style={{
            border: "1px solid var(--border-medium)", borderRadius: 3, fontSize: 10,
            backgroundColor: "var(--bg-root)", cursor: "pointer", padding: "2px 6px",
            fontFamily: "inherit",
          }}
        >
          ↻
        </button>
      </div>

      {backend.error && (
        <div style={{
          padding: "4px 10px", color: "var(--semantic-error)", fontSize: 10,
          borderBottom: "1px solid var(--border-light)",
        }}>
          {backend.error}
        </div>
      )}

      {backend.workDir && (
        <div style={{
          padding: "3px 10px", color: "var(--fg-muted)", fontSize: 10,
          borderBottom: "1px solid var(--border-light)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {t("worker.cwd")}: {backend.workDir}
        </div>
      )}

      {/* MCP Server */}
      <div style={sectionLabel}>{t("worker.mcpServer")}</div>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
        borderBottom: "1px solid var(--border-light)",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          backgroundColor: statusColor[mcp.status],
          flexShrink: 0,
        }} />
        <span style={{ flex: 1, color: statusColor[mcp.status], fontWeight: 500 }}>
          {statusLabel[mcp.status] ? t(statusLabel[mcp.status]) : mcp.status}
        </span>
        {mcp.port > 0 && (
          <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>{t("worker.port")} {mcp.port}</span>
        )}
      </div>

      {mcp.error && (
        <div style={{
          padding: "4px 10px", color: "var(--semantic-error)", fontSize: 10,
          borderBottom: "1px solid var(--border-light)",
        }}>
          {mcp.error}
        </div>
      )}

      {/* GUI Server (daemon) */}
      <div style={sectionLabel}>{t("worker.guiServer")}</div>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
        borderBottom: "1px solid var(--border-light)",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          backgroundColor: guiServer.connected ? "var(--semantic-success)" : "var(--fg-muted)",
          flexShrink: 0,
        }} />
        <span style={{ flex: 1, color: guiServer.connected ? "var(--semantic-success)" : "var(--fg-muted)", fontWeight: 500 }}>
          {guiServer.connected ? t("worker.statusRunning") : t("worker.statusStopped")}
        </span>
        <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>{t("worker.port")} {guiServer.port}</span>
        <button
          onClick={() => { void (async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("restart_gui_server");
            } finally { guiServer.refresh(); }
          })(); }}
          title={t("worker.restartGuiServer")}
          style={{
            border: "1px solid var(--border-medium)", borderRadius: 3, fontSize: 10,
            backgroundColor: "var(--bg-root)", cursor: "pointer", padding: "2px 6px",
            fontFamily: "inherit",
          }}
        >
          ↻
        </button>
      </div>

      {/* Plugin processes (T3) — 状态点+id+端口+kill/重启 */}
      {pluginProcesses.length > 0 && (
        <>
          <div style={sectionLabel}>{t("worker.pluginProcesses", { count: pluginProcesses.length })}</div>
          {pluginProcesses.map((p) => {
            const meta = processStatusMeta(p.status);
            return (
              <div key={p.processId} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
                borderBottom: "1px solid var(--border-light)",
              }}>
                <span title={t("worker.pluginProcessTitle", { name: p.processId })}
                  style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: statusColor[meta.color === "success" ? "running" : meta.color === "accent" ? "starting" : meta.color === "error" ? "error" : "stopped"], flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-primary)", fontWeight: 500 }}>
                  {p.processId}
                </span>
                <span style={{ color: "var(--fg-muted)", fontSize: 10, whiteSpace: "nowrap" }}>{t(`worker.pluginStatus${meta.label[0].toUpperCase()}${meta.label.slice(1)}`)}</span>
                {p.port ? (
                  <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>{t("worker.port")} {p.port}</span>
                ) : null}
                {isProcessActive(p) ? (
                  <button
                    onClick={() => { void (async () => {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("kill_plugin_process_cmd", { processId: p.processId });
                    })(); }}
                    title={t("worker.pluginKill")}
                    style={{ border: "1px solid var(--border-medium)", borderRadius: 3, fontSize: 10, backgroundColor: "var(--bg-root)", cursor: "pointer", padding: "2px 6px", fontFamily: "inherit" }}
                  >
                    ✕
                  </button>
                ) : (
                  <button
                    onClick={() => { void (async () => {
                      const { invoke } = await import("@tauri-apps/api/core");
                      await invoke("restart_plugin_process_cmd", { processId: p.processId, command: "", args: [], env: {} });
                    })(); }}
                    title={t("worker.pluginRestart")}
                    style={{ border: "1px solid var(--border-medium)", borderRadius: 3, fontSize: 10, backgroundColor: "var(--bg-root)", cursor: "pointer", padding: "2px 6px", fontFamily: "inherit" }}
                  >
                    ↻
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* Active tasks */}
      {runningTasks.length > 0 && (
        <>
          <div style={sectionLabel}>
            {t("tasks.title")} ({runningTasks.length} {t("tasks.running", { count: runningTasks.length })})
          </div>
          {runningTasks.map((task) => (
            <div key={task.id} style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderBottom: "1px solid var(--border-light)",
            }}>
              <span style={{ fontSize: 13 }}>{taskStatusIcon[task.status]}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: taskStatusColor[task.status] }}>
                {task.description || `${t("tasks.taskPrefix")} ${task.id.slice(0, 8)}`}
              </span>
              <span style={{ color: "var(--fg-muted)", fontSize: 10, whiteSpace: "nowrap" }}>
                {task.toolCount > 0 && t("tasks.tools", { count: task.toolCount })}
                {task.tokenCount > 0 && ` · ${t("tasks.tokens", { count: task.tokenCount })}`}
              </span>
              <button
                onClick={() => killTask(task.id)}
                title={t("tasks.killTask")}
                style={{
                  border: "none", background: "none", cursor: "pointer",
                  color: "var(--semantic-error)", fontSize: 11, padding: "0 4px",
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </>
      )}

      {/* Completed tasks */}
      {doneTasks.length > 0 && (
        <>
          <div style={sectionLabel}>{t("worker.completed")} ({doneTasks.length})</div>
          {doneTasks.slice(0, 20).map((task) => (
            <div key={task.id} style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "3px 10px", borderBottom: "1px solid var(--border-light)",
              opacity: 0.7,
            }}>
              <span style={{ fontSize: 13 }}>{taskStatusIcon[task.status]}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: taskStatusColor[task.status] }}>
                {task.description || `${t("tasks.taskPrefix")} ${task.id.slice(0, 8)}`}
              </span>
            </div>
          ))}
        </>
      )}

      {tasks.length === 0 && (
        <div style={{ padding: 16, color: "var(--fg-muted)", textAlign: "center", fontSize: 12 }}>
          {t("worker.noTasks")}
        </div>
      )}
    </div>
  );
}
