// ── 存储清理 ──
//
// 规格：.scratch/cleanup-tool/PRD.md
//
// 三段式：扫描 → 清单 → 清理。
//
// 这个界面的主要职责不是"把功能做出来"，而是**让用户敢按下去**：
//  · 每一项都写清"删了会怎样"
//  · 灰掉的项明说为什么不能删
//  · 编辑快照要二次确认
//  · 措辞用"清理/释放空间"，不用"删除"

import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { getSettings } from "../../stores/settingsStore";
import {
  CATEGORY_ORDER,
  buildDeleteRequest,
  dedupeWorkspaces,
  formatBytes,
  initialSelection,
  isCategorySelectable,
  needsConfirm,
  summarizeBlocked,
  summarizeCategory,
  hasForceableItems,
  summarizeRun,
  type CleanupCategory,
  type CleanupItem,
  type RunReport,
  type ScanResult,
} from "../../utils/cleanupLogic";

type Phase = "idle" | "scanning" | "ready" | "running" | "done";

/** 动态导入 Tauri 的 invoke —— 该面板只在真机里用得上，
 *  浏览器里跑 Vite dev 时没有 `__TAURI__`，导入失败也不该炸整个面板。 */
async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const S = {
  root: {
    display: "flex", flexDirection: "column", height: "100%",
    fontFamily: "var(--font-sans)", color: "var(--fg-primary)",
    backgroundColor: "var(--bg-root)",
    fontSize: "calc(var(--font-scale, 1) * 12px)",
  } as React.CSSProperties,
  header: {
    padding: "10px 14px", borderBottom: "1px solid var(--border-light)",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    flexShrink: 0,
  } as React.CSSProperties,
  title: { fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 13px)" },
  body: { flex: 1, overflowY: "auto", padding: "10px 14px" } as React.CSSProperties,
  footer: {
    padding: "10px 14px", borderTop: "1px solid var(--border-light)",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 10, flexShrink: 0,
  } as React.CSSProperties,
  btn: {
    padding: "5px 14px", borderRadius: 6, border: "1px solid var(--border-medium)",
    background: "var(--bg-surface)", color: "var(--fg-primary)",
    cursor: "pointer", fontFamily: "var(--font-sans)",
    fontSize: "calc(var(--font-scale, 1) * 12px)",
  } as React.CSSProperties,
  btnPrimary: {
    padding: "5px 16px", borderRadius: 6, border: "none",
    background: "var(--accent)", color: "var(--fg-inverse)",
    cursor: "pointer", fontWeight: 600, fontFamily: "var(--font-sans)",
    fontSize: "calc(var(--font-scale, 1) * 12px)",
  } as React.CSSProperties,
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" } as React.CSSProperties,
  card: {
    border: "1px solid var(--border-light)", borderRadius: 8,
    padding: "10px 12px", marginBottom: 8,
  } as React.CSSProperties,
  row: { display: "flex", alignItems: "flex-start", gap: 8 } as React.CSSProperties,
  catHead: {
    display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
  } as React.CSSProperties,
  meta: { color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 11px)" } as React.CSSProperties,
  detail: {
    marginTop: 6, paddingLeft: 24, borderLeft: "1px dashed var(--border-light)",
    color: "var(--fg-secondary)", fontSize: "calc(var(--font-scale, 1) * 11px)",
  } as React.CSSProperties,
  detailRow: {
    display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0",
    wordBreak: "break-all",
  } as React.CSSProperties,
  warn: {
    marginBottom: 10, padding: "8px 10px", borderRadius: 6,
    border: "1px solid var(--border-medium)", color: "var(--fg-secondary)",
    lineHeight: 1.6,
  } as React.CSSProperties,
};

/** 类别名 —— 文案决定用户敢不敢按，这里统一管理。 */
function categoryLabel(c: CleanupCategory): string {
  return t(`cleanup.cat.${c}`);
}

/** 类别下的一句话说明：删了会怎样。 */
function categoryHint(c: CleanupCategory): string {
  return t(`cleanup.hint.${c}`);
}

/** 具体种类的本地化名。 */
function kindLabel(kind: string): string {
  const key = `cleanup.kind.${kind}`;
  const s = t(key);
  // i18n 缺 key 时会原样返回 key，此时退回 kind 本身
  return s === key ? kind : s;
}

/** 保护原因文案。 */
function blockedLabel(reason: string | null): string {
  if (!reason) return "";
  const key = `cleanup.blocked.${reason}`;
  const s = t(key);
  return s === key ? reason : s;
}

export const CleanupPanel = memo(function CleanupPanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [selection, setSelection] = useState<Set<CleanupCategory>>(initialSelection);
  const [expanded, setExpanded] = useState<Set<CleanupCategory>>(new Set());
  const [report, setReport] = useState<RunReport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 强制包含被跳过的项（规格：默认关闭）。
   *
   * 存在的理由：其他窗口正在用的工作区会被默认跳过，但如果那个窗口是**残留**
   * 的实例记录（PID 复用过、进程其实早没了），没有开关就等于永远清不掉。
   * 只影响 `active-workspace` 这类可绕过的保护；`.git` 是 protected，永不包含。 */
  const [force, setForce] = useState(false);

  const items = scan?.items ?? [];
  const blockedStats = useMemo(() => summarizeBlocked(items), [items]);
  const canForce = useMemo(() => hasForceableItems(items), [items]);

  /** 启动页那份工作区列表 + 最近记录（去重）。 */
  const workspaces = useMemo(() => {
    const st = getSettings();
    const ws = st.workspaces ?? [];
    const recent = st.recentWorkspaces ?? [];
    return dedupeWorkspaces([...ws, ...recent]);
  }, []);

  /** `keepReport`：清理完成后的自动重扫要保留结果块 —— 否则用户永远看不到
   *  「成功 X 项 / 失败 Y 项」，失败项更是无从得知。 */
  const runScan = useCallback(async (opts?: { keepReport?: boolean }) => {
    setPhase("scanning");
    setError(null);
    if (!opts?.keepReport) setReport(null);
    try {
      const res = await invokeTauri<ScanResult>("cleanup_scan", { workspaces });
      setScan(res);
      setPhase("ready");
      if (res.items.length === 0) {
        addStatusMessage(t("cleanup.nothingFound"), "info");
      }
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }, [workspaces]);

  // 打开即扫 —— 「扫描」本身就没什么可配的，让用户多点一次没意义。
  useEffect(() => {
    void runScan();
  }, [runScan]);

  // 注意 `runScan` 在 `payload` 变化时不该重建 —— 它只依赖 `workspaces`，
  // 上面的 useCallback 依赖数组已保证这点。

  const toggleCategory = useCallback(
    (c: CleanupCategory) => {
      if (!isCategorySelectable(c, items, force)) return;
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(c)) next.delete(c);
        else next.add(c);
        return next;
      });
    },
    [items, force],
  );

  const toggleExpand = useCallback((c: CleanupCategory) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);

  const payload = useMemo(
    () => buildDeleteRequest(selection, items, force),
    [selection, items, force],
  );
  const payloadBytes = useMemo(
    () => payload.reduce((acc, i) => acc + i.sizeBytes, 0),
    [payload],
  );

  const doRun = useCallback(async () => {
    setConfirmOpen(false);
    setPhase("running");
    setError(null);
    try {
      const res = await invokeTauri<RunReport>("cleanup_run", { items: payload });
      setReport(res);
      setPhase("done");
      const s = summarizeRun(res);
      addStatusMessage(
        t("cleanup.freed", { size: formatBytes(s.freedBytes) }),
        s.failCount > 0 ? "warn" : "info",
      );
      // 清理后重新扫一遍 —— 清单要反映真实状态（尤其是失败项还在），
      // 但**保留结果块**，否则用户看不到刚才发生了什么。
      void runScan({ keepReport: true });
    } catch (e) {
      setError(String(e));
      setPhase("ready");
    }
  }, [payload, runScan]);

  const onCleanClick = useCallback(() => {
    if (payload.length === 0) return;
    // 规格：只有编辑快照需要二次确认
    if (needsConfirm(selection)) {
      setConfirmOpen(true);
      return;
    }
    void doRun();
  }, [payload.length, selection, doRun]);

  const busy = phase === "scanning" || phase === "running";

  return (
    <div style={S.root}>
      <div style={S.header}>
        <div style={S.title}>{t("cleanup.title")}</div>
        <button
          type="button"
          style={{ ...S.btn, ...(busy ? S.btnDisabled : null) }}
          disabled={busy}
          onClick={() => void runScan()}
        >
          {phase === "scanning" ? t("cleanup.scanning") : t("cleanup.rescan")}
        </button>
      </div>

      <div style={S.body}>
        <div style={S.warn}>{t("cleanup.intro")}</div>

        {phase === "scanning" && (
          <div style={S.meta}>{t("cleanup.scanningHint", { count: workspaces.length })}</div>
        )}

        {error && (
          <div style={{ ...S.card, color: "var(--semantic-error)" }}>{error}</div>
        )}

        {!busy && scan && scan.items.length === 0 && (
          <div style={S.meta}>{t("cleanup.nothingFound")}</div>
        )}

        {/* 跳过项说明 + 强制开关。
            其他窗口正在用的工作区默认跳过；但如果那是残留的实例记录
            （PID 复用过、进程早没了），没有开关就永远清不掉。 */}
        {blockedStats.total > 0 && (
          <div style={{ ...S.warn, display: "flex", alignItems: "flex-start", gap: 8 }}>
            <div style={{ flex: 1 }}>
              {t("cleanup.blockedSummary", { count: blockedStats.total })}
              {blockedStats.protected > 0 && (
                <div style={{ marginTop: 2 }}>
                  {t("cleanup.blockedProtected", { count: blockedStats.protected })}
                </div>
              )}
            </div>
            {canForce && (
              <label
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  cursor: "pointer", whiteSpace: "nowrap", color: "var(--fg-secondary)",
                }}
                title={t("cleanup.forceHint")}
              >
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                {t("cleanup.forceLabel")}
              </label>
            )}
          </div>
        )}

        {CATEGORY_ORDER.map((cat) => {
          const { bytes, files, entries } = summarizeCategory(cat, items, force);
          if (entries.length === 0) return null;
          const selectable = isCategorySelectable(cat, items, force);
          const checked = selection.has(cat) && selectable;
          const isOpen = expanded.has(cat);
          return (
            <div key={cat} style={{ ...S.card, opacity: selectable ? 1 : 0.65 }}>
              {/* 整行可点，但 **input 自己不挂 onClick** —— 否则点勾选框会
                  同时触发 input 和这一行的 handler，两次 toggle 互相抵消
                  （实测：勾了没反应）。input 交给浏览器原生行为，
                  由 onChange 同步状态，点击事件 stopPropagation 到行。 */}
              <div style={S.catHead} onClick={() => toggleCategory(cat)}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!selectable}
                  onChange={() => toggleCategory(cat)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: selectable ? "pointer" : "not-allowed", marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{categoryLabel(cat)}</div>
                  <div style={S.meta}>{categoryHint(cat)}</div>
                </div>
                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <div>{formatBytes(bytes)}</div>
                  <div style={S.meta}>
                    {t("cleanup.fileCount", { count: files })}
                  </div>
                </div>
              </div>

              <div
                style={{ ...S.meta, marginTop: 6, cursor: "pointer" }}
                onClick={() => toggleExpand(cat)}
              >
                {isOpen ? t("cleanup.hideDetail") : t("cleanup.showDetail", { count: entries.length })}
              </div>

              {isOpen && (
                <div style={S.detail}>
                  {entries.map((e) => (
                    <div key={e.id} style={S.detailRow}>
                      <span style={{ flex: 1 }}>
                        <span style={{ fontWeight: 600 }}>{kindLabel(e.kind)}</span>
                        <br />
                        <span style={{ color: "var(--fg-muted)" }}>{e.path}</span>
                        {!e.deletable && e.blockedReason && (
                          <div style={{ color: "var(--semantic-warning)", marginTop: 2 }}>
                            {blockedLabel(e.blockedReason)}
                          </div>
                        )}
                      </span>
                      <span style={{ whiteSpace: "nowrap", color: "var(--fg-muted)" }}>
                        {e.timedOut ? t("cleanup.sizeUnknown") : formatBytes(e.sizeBytes)}
                        {" · "}
                        {formatBytesShortCount(e.fileCount)}
                        {e.lastModifiedMs != null && (
                          <>
                            <br />
                            {formatDate(e.lastModifiedMs)}
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {report && (
          <div style={{ ...S.card, borderColor: "var(--border-medium)" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("cleanup.resultTitle")}</div>
            <div>
              {t("cleanup.resultSummary", {
                ok: summarizeRun(report).okCount,
                fail: summarizeRun(report).failCount,
                size: formatBytes(report.freedBytes),
              })}
            </div>
            {summarizeRun(report).failures.map((f) => (
              <div key={f.id} style={{ ...S.meta, marginTop: 4, wordBreak: "break-all" }}>
                ✕ {f.path}
                <br />
                <span style={{ color: "var(--semantic-error)" }}>{f.error}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={S.footer}>
        <div style={S.meta}>
          {payload.length > 0
            ? t("cleanup.selectedSummary", {
                count: payload.length,
                size: formatBytes(payloadBytes),
              })
            : t("cleanup.nothingSelected")}
        </div>
        <button
          type="button"
          style={{ ...S.btnPrimary, ...(busy || payload.length === 0 ? S.btnDisabled : null) }}
          disabled={busy || payload.length === 0}
          onClick={onCleanClick}
        >
          {phase === "running" ? t("cleanup.running") : t("cleanup.clean")}
        </button>
      </div>

      {confirmOpen && (
        <ConfirmOverlay
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void doRun()}
        />
      )}
    </div>
  );
});

/** 编辑快照的二次确认。
 *
 * 不是"更危险"，而是**不可恢复且不易察觉**：删完界面上看不出任何变化，
 * 直到某天想撤销一次历史编辑才发现回不去。 */
function ConfirmOverlay({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      style={{
        position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: 420, padding: "16px 18px", borderRadius: 10,
          backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-medium)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
          fontFamily: "var(--font-sans)",
          fontSize: "calc(var(--font-scale, 1) * 12px)",
          color: "var(--fg-primary)", lineHeight: 1.7,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          {t("cleanup.confirmTitle")}
        </div>
        <div style={{ color: "var(--fg-secondary)" }}>{t("cleanup.confirmBody")}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" style={S.btn} onClick={onCancel}>
            {t("cleanup.cancel")}
          </button>
          <button type="button" style={S.btnPrimary} onClick={onConfirm}>
            {t("cleanup.confirmOk")}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytesShortCount(n: number): string {
  return t("cleanup.fileCount", { count: n });
}

function formatDate(ms: number): string {
  try {
    const d = new Date(ms);
    const pad = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch {
    return "";
  }
}
