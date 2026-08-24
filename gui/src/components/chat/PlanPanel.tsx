// ── Plan Panel — current tasks + history timeline ──
// Subscribes via EventBus (useEvent hook) — no custom subscribe

import { memo, useEffect, useRef, useState } from "react";
import { getPlanTasks, type PlanTask } from "../../stores/planStore";
import {
  getRecords, loadMorePlans, hasMore, resetPagination,
  type PlanRecord,
} from "../../stores/planHistoryStore";
import { t } from "../../i18n";
import { EmptyState } from "../SharedStates";
import { useEvent } from "../../services/useService";
import { Events, type PlanUpdatedPayload, type PlanHistoryChangedPayload } from "../../services/events";

// ── Status icon (matches VS Code plan-panel.js) ──

function StatusIcon({ status }: { status: PlanTask["status"] }) {
  const s = 12;
  if (status === "completed") {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="var(--semantic-success)">
        <path d="M13.8 4.2l-7.3 7.3-4.3-4.3 1.4-1.4 2.9 2.9 5.9-5.9 1.4 1.4z"/>
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="var(--semantic-warning)">
        <circle cx="8" cy="8" r="4"/>
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="var(--fg-muted)" strokeWidth="1.5">
      <circle cx="8" cy="8" r="4"/>
    </svg>
  );
}

// ── Helpers ──

function planTitle(rec: PlanRecord): string {
  const m = rec.plan_text.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const firstLine = rec.plan_text.split("\n").find(l => l.trim());
  return firstLine ? firstLine.trim().slice(0, 60) : `Plan ${rec.created_at.slice(0, 16)}`;
}

function dateLabel(iso: string): string {
  return iso.slice(0, 10);
}

// ══════════════════════════════════════════════════

function _PlanPanel() {
  // Subscribe to plan data via EventBus (sticky events replay latest on mount)
  const planPayload = useEvent<PlanUpdatedPayload>(Events.PLAN_UPDATED);
  const historyPayload = useEvent<PlanHistoryChangedPayload>(Events.PLAN_HISTORY_CHANGED);

  const currentTasks = planPayload?.tasks || [];
  const allRecords = historyPayload?.records || getRecords();

  const done = currentTasks.filter(t => t.status === "completed").length;
  const total = currentTasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Initial history load
  useEffect(() => {
    resetPagination();
    loadMorePlans();
    return () => { resetPagination(); };
  }, []);

  // IntersectionObserver for lazy history
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && hasMore()) loadMorePlans();
    }, { rootMargin: "100px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [allRecords.length]);

  // Group history by date
  const dateGroups: [string, PlanRecord[]][] = [];
  let lastDate = "";
  for (const rec of allRecords) {
    const d = dateLabel(rec.created_at);
    if (d !== lastDate) {
      dateGroups.push([d, []]);
      lastDate = d;
    }
    dateGroups[dateGroups.length - 1][1].push(rec);
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", overflow: "auto",
      fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 12px)",
    }}>
      {/* ═══ Current plan section ═══ */}
      {total > 0 && (
        <div style={{ flexShrink: 0 }}>
          {/* Progress bar */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-light)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontWeight: 600, color: "var(--fg-primary)" }}>{t("plan.title")}</span>
              <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>{done}/{total}</span>
            </div>
            <div style={{ height: 4, backgroundColor: "var(--border-light)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{
                height: "100%", width: `${pct}%`,
                backgroundColor: pct === 100 ? "var(--semantic-success)" : "var(--accent)",
                borderRadius: 2, transition: "width 0.3s",
              }}/>
            </div>
          </div>

          {/* Task list (matches VS Code plan-panel.js) */}
          {currentTasks.map((task, i) => {
            const isActive = task.status === "in_progress";
            return (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 8,
                padding: "3px 12px",
                backgroundColor: isActive ? "rgba(0,122,204,0.06)" : "transparent",
                borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              }}>
                <span style={{ flexShrink: 0, marginTop: 2 }}>
                  <StatusIcon status={task.status}/>
                </span>
                <span style={{
                  color: task.status === "completed" ? "var(--fg-muted)" : "var(--fg-primary)",
                  textDecoration: task.status === "completed" ? "line-through" : "none",
                  lineHeight: 1.4, wordBreak: "break-word",
                }}>
                  {isActive ? (task.activeForm || task.content) : task.content}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ History section ═══ */}
      {dateGroups.length > 0 && (
        <>
          <div style={{
            padding: total > 0 ? "12px 12px 4px" : "8px 12px 4px",
            color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 11px)", fontWeight: 600,
            borderBottom: "1px solid var(--border-light)",
          }}>
            {t("plan.history")}
          </div>

          {dateGroups.map(([date, records]) => (
            <div key={date}>
              {/* Date divider */}
              <div style={{
                display: "flex", alignItems: "center",
                padding: "10px 12px 6px", gap: 10,
              }}>
                <div style={{ flex: 1, height: 1, backgroundColor: "var(--border-light)" }}/>
                <span style={{ color: "var(--fg-muted)", fontSize: 10, whiteSpace: "nowrap" }}>{date}</span>
                <div style={{ flex: 1, height: 1, backgroundColor: "var(--border-light)" }}/>
              </div>

              {/* Plan records */}
              {records.map((rec) => {
                const tasks: PlanTask[] = (() => {
                  try { return JSON.parse(rec.tasks_json); } catch { return []; }
                })();
                const planDone = tasks.filter(t => t.status === "completed").length;
                const planTotal = tasks.length;
                const isExpanded = expandedId === rec.id;

                return (
                  <div key={rec.id} style={{ marginBottom: 2 }}>
                    {/* Session label */}
                    <div style={{
                      padding: "4px 12px", fontSize: "calc(var(--font-scale, 1) * 11px)",
                      color: "var(--semantic-info)", fontWeight: 600,
                    }}>
                      {rec.session_title || t("plan.sessionPrefix", { id: rec.session_id.slice(0, 8) })}
                    </div>

                    {/* Plan entry — click to expand */}
                    <div
                      onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                      style={{
                        padding: "3px 12px 3px 20px", cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 8,
                        backgroundColor: isExpanded ? "rgba(0,122,204,0.04)" : "transparent",
                      }}
                    >
                      <span style={{ fontSize: 10, color: "var(--fg-muted)", flexShrink: 0 }}>
                        {isExpanded ? "▼" : "▶"}
                      </span>
                      <span style={{
                        flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap", color: "var(--fg-primary)",
                      }}>
                        {planTitle(rec)}
                      </span>
                      {planTotal > 0 && (
                        <span style={{
                          fontSize: 10,
                          color: planDone === planTotal ? "var(--semantic-success)" : "var(--fg-muted)",
                          flexShrink: 0,
                        }}>
                          {planDone}/{planTotal}
                        </span>
                      )}
                    </div>

                    {/* Expanded task list */}
                    {isExpanded && planTotal > 0 && (
                      <div style={{
                        marginLeft: 28, marginRight: 12, marginBottom: 6,
                        border: "1px solid var(--border-light)", borderRadius: 4, overflow: "hidden",
                      }}>
                        {tasks.map((task, j) => {
                          const isActive = task.status === "in_progress";
                          return (
                            <div key={j} style={{
                              display: "flex", alignItems: "flex-start", gap: 6,
                              padding: "2px 10px",
                              backgroundColor: isActive ? "rgba(0,122,204,0.06)" : "transparent",
                              borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                            }}>
                              <span style={{ flexShrink: 0, marginTop: 2 }}>
                                <StatusIcon status={task.status}/>
                              </span>
                              <span style={{
                                color: task.status === "completed" ? "var(--fg-muted)" : "var(--fg-secondary)",
                                textDecoration: task.status === "completed" ? "line-through" : "none",
                                fontSize: "calc(var(--font-scale, 1) * 11px)", lineHeight: 1.4, wordBreak: "break-word",
                              }}>
                                {task.content}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Scroll sentinel */}
          <div ref={sentinelRef} style={{ height: 1 }}/>
        </>
      )}

      {/* Empty state */}
      {total === 0 && allRecords.length === 0 && (
        <EmptyState text={t("plan.empty")} />
      )}
    </div>
  );
}
export default memo(_PlanPanel);
