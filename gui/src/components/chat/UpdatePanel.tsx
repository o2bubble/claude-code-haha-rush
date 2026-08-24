import React, { memo, useState, useCallback } from "react";
import { t } from "../../i18n";
import { EmptyState } from "../SharedStates";
import { updateService, setUpdateAvailability, type ComponentStatus, type UpdateCheckResult } from "../../services/updateService";
import { addStatusMessage } from "../../stores/statusMsgStore";

// ── Component display names ──

const COMPONENT_LABELS: Record<string, string> = {
  gui: "update.component.gui",
  claude: "update.component.claude",
  bun: "update.component.bun",
  tools: "update.component.tools",
  python: "update.component.python",
  git: "update.component.git",
  extensions: "update.component.extensions",
  updater: "update.component.updater",
};

const COMPONENT_ORDER = ["gui", "claude", "bun", "tools", "python", "git", "extensions", "updater"];

/** Label for a component — i18n if known, else fall back to the raw name so a
 *  newly-published component still renders even before labels exist. */
function componentLabel(name: string): string {
  const key = COMPONENT_LABELS[name];
  return key ? t(key) : name;
}

/** Split components into real updates (installed + sha changed), opt-in
 *  installs (never installed — NOT counted as updates), and up-to-date. */
function groupComponents(components: ComponentStatus[]) {
  const order = (a: ComponentStatus, b: ComponentStatus) => {
    const ia = COMPONENT_ORDER.indexOf(a.name);
    const ib = COMPONENT_ORDER.indexOf(b.name);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  };
  const updates: ComponentStatus[] = [];
  const optIn: ComponentStatus[] = [];
  const upToDate: ComponentStatus[] = [];
  for (const c of components) {
    if (c.needs_update && c.installed) updates.push(c);
    else if (c.needs_update && !c.installed) optIn.push(c);
    else upToDate.push(c);
  }
  return { updates: updates.sort(order), optIn: optIn.sort(order), upToDate: upToDate.sort(order) };
}

// ── Styles ──

const S = {
  container: {
    display: "flex", flexDirection: "column", height: "100%",
    fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 12px)",
    color: "var(--fg-primary)", backgroundColor: "var(--bg-root)",
  } as React.CSSProperties,
  header: {
    padding: "10px 14px", borderBottom: "1px solid var(--border-light)",
    fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 13px)",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    flexShrink: 0,
  } as React.CSSProperties,
  body: { flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 } as React.CSSProperties,
  footer: {
    padding: "8px 14px", borderTop: "1px solid var(--border-light)",
    display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0,
  } as React.CSSProperties,
  versionRow: { display: "flex", alignItems: "center", gap: 8, fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)" } as React.CSSProperties,
  releaseNotes: {
    padding: "8px 10px", backgroundColor: "var(--bg-surface)", borderRadius: 6,
    fontSize: "calc(var(--font-scale, 1) * 11.5px)", color: "var(--fg-secondary)",
    maxHeight: 100, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
    // flex column default-shrinks children — a long component list would squash
    // the notes to a sliver; never shrink it, let the body scroll instead.
    flexShrink: 0,
  } as React.CSSProperties,
  compRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "6px 0", borderBottom: "1px solid var(--border-light)",
    gap: 8,
  } as React.CSSProperties,
  compLeft: { display: "flex", alignItems: "center", gap: 8, flex: 1 } as React.CSSProperties,
  compName: { fontWeight: 500, fontSize: "calc(var(--font-scale, 1) * 12px)", minWidth: 0 } as React.CSSProperties,
  compSize: { fontSize: "calc(var(--font-scale, 1) * 10.5px)", color: "var(--fg-muted)", flexShrink: 0 } as React.CSSProperties,
  badge: (updating: boolean): React.CSSProperties => ({
    fontSize: "calc(var(--font-scale, 1) * 10px)", padding: "1px 6px", borderRadius: 10,
    fontWeight: 500, whiteSpace: "nowrap",
    backgroundColor: updating ? "var(--accent)" : "var(--semantic-success-subtle, #e8f5e9)",
    color: updating ? "var(--fg-inverse)" : "var(--semantic-success)",
  }),
  btn: (primary: boolean): React.CSSProperties => ({
    padding: "5px 14px", borderRadius: 5, border: primary ? "none" : "1px solid var(--border-medium)",
    backgroundColor: primary ? "var(--accent)" : "transparent",
    color: primary ? "var(--fg-inverse)" : "var(--fg-primary)",
    fontSize: "calc(var(--font-scale, 1) * 11.5px)", cursor: "pointer",
    fontFamily: "inherit",
  }),
  checkbox: { width: 14, height: 14, cursor: "pointer", accentColor: "var(--accent)", flexShrink: 0 } as React.CSSProperties,
  progressBar: {
    height: 3, backgroundColor: "var(--border-light)", borderRadius: 2,
    marginTop: 3, overflow: "hidden",
  } as React.CSSProperties,
  progressFill: (pct: number): React.CSSProperties => ({
    height: "100%", width: `${pct}%`, backgroundColor: "var(--accent)",
    transition: "width 0.3s ease",
  }),
  spinner: { width: 14, height: 14, border: "2px solid var(--border-light)", borderTop: "2px solid var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 } as React.CSSProperties,
  errorText: { color: "var(--semantic-error)", fontSize: "calc(var(--font-scale, 1) * 11px)" } as React.CSSProperties,
  optHeader: { fontSize: "calc(var(--font-scale, 1) * 11px)", fontWeight: 600, color: "var(--fg-muted)", marginTop: 10 } as React.CSSProperties,
  optHint: { fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", marginBottom: 2 } as React.CSSProperties,
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── Component ──

export const UpdatePanel: React.FC = memo(function UpdatePanel() {
  const [state, setState] = useState<"idle" | "checking" | "available" | "downloading" | "needsRestart" | "upToDate" | "error">("idle");
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorMsg, setErrorMsg] = useState("");
  /** Staging path + Update.exe path returned by prepareGuiUpdate — reused by the
   *  restart button so it does NOT re-download the GUI zip. */
  const [updaterPath, setUpdaterPath] = useState<string | null>(null);

  const handleCheck = useCallback(async () => {
    setState("checking");
    setErrorMsg("");
    try {
      const r = await updateService.checkForUpdates();
      const { updates } = groupComponents(r.components);
      // 红点/"有更新"状态只认已安装组件的真更新；未安装组件是可选安装，
      // 不亮红点、不自动勾选、不进入"有更新"。
      setUpdateAvailability(updates.length > 0, r.version);
      setResult(r);
      if (updates.length === 0) {
        setState("upToDate");
        addStatusMessage(t("update.upToDate"), "success");
      } else {
        setSelected(new Set(updates.map((c) => c.name)));
        setState("available");
      }
    } catch (e: any) {
      setErrorMsg(e?.toString() ?? String(e));
      setState("error");
    }
  }, []);

  const toggleComponent = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /** One component row — shared by the update section and the optional-install
   *  section. Never-installed components render the "未安装" badge but are not
   *  auto-checked (they live in the optIn group). */
  const renderRow = (comp: ComponentStatus) => {
    const name = comp.name;
    const isSelected = selected.has(name);
    const isDownloading = downloading.has(name);
    const compError = errors[name];
    return (
      <div key={name}>
        <div style={S.compRow}>
          <div style={S.compLeft}>
            <input
              type="checkbox"
              checked={isSelected}
              disabled={isDownloading || state === "downloading"}
              onChange={() => toggleComponent(name)}
              style={S.checkbox}
            />
            <span style={S.compName}>{componentLabel(name)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {comp.size ? <span style={S.compSize}>{formatSize(comp.size)}</span> : null}
            {isDownloading ? (
              <span style={S.badge(true)}>{t("update.installStatus.updating")}</span>
            ) : comp.installed ? (
              <span style={S.badge(false)}>{t("update.installStatus.updateAvailable")}</span>
            ) : (
              <span style={{ ...S.badge(false), backgroundColor: "var(--semantic-warning-subtle, #fff3e0)", color: "var(--semantic-warning)" }}>
                {t("update.installStatus.notInstalled")}
              </span>
            )}
          </div>
        </div>
        {isDownloading && (
          <div style={S.progressBar}>
            <div style={S.progressFill(60)} />
          </div>
        )}
        {comp.post_install_description && (
          <div style={{ paddingLeft: 22, paddingBottom: 2, fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", display: "flex", alignItems: "center", gap: 4 }}>
            <span>⚡</span> {comp.post_install_description}
          </div>
        )}
        {compError && (
          <div style={{ ...S.errorText, paddingLeft: 22, paddingBottom: 4 }}>
            {compError}
          </div>
        )}
      </div>
    );
  };

  const handleUpdateSelected = useCallback(async () => {
    if (!result) return;
    const comps = COMPONENT_ORDER.filter((n) => selected.has(n));
    if (comps.length === 0) return;

    setState("downloading");
    setErrors({});

    // Separate GUI from others (GUI goes last, uses Update.exe)
    const nonGui = comps.filter((n) => n !== "gui");
    const hasGui = comps.includes("gui");

    // Download non-GUI components sequentially
    for (const name of nonGui) {
      setDownloading((prev) => new Set(prev).add(name));
      try {
        const compStatus = result.components.find((c) => c.name === name);
        await updateService.downloadAndInstall(name, result.version, compStatus?.post_install_json, compStatus?.remote_sha256, compStatus?.size);
        addStatusMessage(`${componentLabel(name)} ${t("update.installStatus.updated")}`, "success");
      } catch (e: any) {
        setErrors((prev) => ({ ...prev, [name]: e?.toString() ?? String(e) }));
      } finally {
        setDownloading((prev) => { const n = new Set(prev); n.delete(name); return n; });
      }
    }

    // Check if any non-GUI download failed
    const nonGuiFailed = nonGui.filter((n) => errors[n]);
    if (nonGuiFailed.length === nonGui.length && nonGui.length > 0) {
      addStatusMessage(t("update.error.installFailed"), "error");
      setState("error");
      // Don't proceed to GUI if everything failed
    }

    // Handle GUI update
    if (hasGui) {
      try {
        setDownloading((prev) => new Set(prev).add("gui"));
        const guiComp = result.components.find((c) => c.name === "gui");
        const stagedPath = await updateService.prepareGuiUpdate(result.version, guiComp?.remote_sha256, guiComp?.size);
        setUpdaterPath(stagedPath);
        setDownloading((prev) => { const n = new Set(prev); n.delete("gui"); return n; });
        setState("needsRestart");
      } catch (e: any) {
        setErrors((prev) => ({ ...prev, gui: e?.toString() ?? String(e) }));
        setDownloading((prev) => { const n = new Set(prev); n.delete("gui"); return n; });
      }
    } else if (nonGui.some((n) => !errors[n])) {
      // Non-GUI updates completed, check again to refresh status.
      // Clear the toolbar badge once every selected component is up to date.
      const allDone = nonGui.length > 0 && nonGui.every((n) => !errors[n]);
      if (allDone) setUpdateAvailability(false, "");
      addStatusMessage(t("update.upToDate"), "success");
      setState("idle");
    }
  }, [result, selected, errors]);

  const handleRestart = useCallback(async () => {
    try {
      // The staging (downloaded zip + Update.exe path) already exists from
      // handleUpdateSelected — reuse it instead of re-downloading the GUI zip.
      let path = updaterPath;
      if (!path) {
        const guiComp = result!.components.find((c) => c.name === "gui");
        path = await updateService.prepareGuiUpdate(result!.version, guiComp?.remote_sha256, guiComp?.size);
      }
      await updateService.launchUpdater(path);
    } catch (e: any) {
      setErrorMsg(e?.toString() ?? String(e));
      setState("error");
    }
  }, [result, updaterPath]);

  const handleSkipAll = useCallback(() => {
    addStatusMessage(t("update.installStatus.skipped"), "info");
    setState("idle");
  }, []);

  const selectedSize = result
    ? COMPONENT_ORDER.filter((n) => selected.has(n))
        .reduce((sum, n) => sum + (result.components.find((c) => c.name === n)?.size ?? 0), 0)
    : 0;

  const { updates, optIn, upToDate } = result
    ? groupComponents(result.components)
    : { updates: [] as ComponentStatus[], optIn: [] as ComponentStatus[], upToDate: [] as ComponentStatus[] };

  return (
    <div style={S.container}>
      <div style={S.header}>
        <span>{t("update.title")}</span>
        {state === "downloading" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={S.spinner} />
            <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", fontWeight: 400 }}>
              {downloading.size > 0 ? `${downloading.size} ${t("update.installStatus.updating")}` : t("update.installStatus.updating")}
            </span>
          </div>
        )}
      </div>

      <div style={S.body}>
        {/* State: idle */}
        {state === "idle" && (
          <EmptyState
            text={t("update.actions.checkForUpdates")}
            action={{
              label: t("update.actions.checkForUpdates"),
              onClick: handleCheck,
            }}
          />
        )}

        {/* State: checking */}
        {state === "checking" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 10 }}>
            <div style={{ ...S.spinner, width: 24, height: 24 }} />
            <span style={{ color: "var(--fg-muted)" }}>{t("update.checking")}</span>
          </div>
        )}

        {/* State: up to date (no real updates; optional-install section below) */}
        {state === "upToDate" && (
          <>
            <EmptyState
              text={t("update.upToDate")}
              action={{
                label: t("update.actions.checkForUpdates"),
                onClick: handleCheck,
              }}
            />
            {optIn.length > 0 && (
              <>
                <div style={S.optHeader}>{t("update.optionalInstall")}</div>
                <div style={S.optHint}>{t("update.optionalInstallHint")}</div>
                {optIn.map((comp) => renderRow(comp))}
              </>
            )}
          </>
        )}

        {/* State: error */}
        {state === "error" && (
          <EmptyState
            text={errorMsg || t("update.error.checkFailed")}
            action={{
              label: t("update.error.retry"),
              onClick: handleCheck,
            }}
          />
        )}

        {/* State: available */}
        {(state === "available" || state === "downloading") && result && (
          <>
            <div style={S.versionRow}>
              <span>{t("update.currentVersion")}: {t("update.latestVersion")}</span>
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>{result.version}</span>
              <span style={{ color: "var(--fg-muted)" }}>({result.published_at?.slice(0, 10)})</span>
            </div>

            {result.release_notes && (
              <div style={{ ...S.releaseNotes, fontSize: "calc(var(--font-scale, 1) * 11px)", fontWeight: 500, color: "var(--fg-secondary)" }}>
                {t("update.releaseNotes")}
              </div>
            )}
            {result.release_notes && (
              // Normalize literal \n (possible double-escape somewhere in the
              // wire chain) to real newlines, then render one line per entry so
              // bullets always break regardless of the source encoding.
              <div style={{ ...S.releaseNotes, maxHeight: 220, minHeight: 150 }}>
                {result.release_notes.replace(/\\n/g, "\n").split(/\r?\n/).map((line, i) => (
                  <div key={i} style={{ minHeight: 16 }}>{line || "\u00A0"}</div>
                ))}
              </div>
            )}

            <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", fontWeight: 600, color: "var(--fg-secondary)", marginTop: 4 }}>
              {t("update.selectComponents")}
            </div>

            {/* 真更新区 — 已安装且需更新的组件, 自动勾选 */}
            {updates.map((comp) => renderRow(comp))}

            {/* 已是最新的组件 — 置灰显示 */}
            {upToDate.map((comp) => (
              <div key={comp.name} style={{ ...S.compRow, opacity: 0.5 }}>
                <div style={S.compLeft}>
                  <input type="checkbox" checked={false} disabled style={S.checkbox} />
                  <span style={S.compName}>{componentLabel(comp.name)}</span>
                </div>
                <span style={S.badge(false)}>{t("update.installStatus.installed")}</span>
              </div>
            ))}

            {/* 可选安装区 — 未安装组件, 不自动勾选、不亮红点 */}
            {optIn.length > 0 && (
              <>
                <div style={S.optHeader}>{t("update.optionalInstall")}</div>
                <div style={S.optHint}>{t("update.optionalInstallHint")}</div>
                {optIn.map((comp) => renderRow(comp))}
              </>
            )}
          </>
        )}

        {/* State: needs restart */}
        {state === "needsRestart" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 12 }}>
            <div style={{ fontSize: "calc(var(--font-scale, 1) * 20px)" }}>🔄</div>
            <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", fontWeight: 600 }}>{t("update.restartRequired")}</div>
            {errors.gui && <div style={S.errorText}>{errors.gui}</div>}
          </div>
        )}
      </div>

      <div style={S.footer}>
        {state === "available" && (
          <>
            <button type="button" style={S.btn(false)} onClick={handleSkipAll}>
              {t("update.actions.skipAll")}
            </button>
            <span style={{
              fontSize: "calc(var(--font-scale, 1) * 10.5px)", color: "var(--fg-muted)",
              display: "flex", alignItems: "center",
            }}>
              {selected.size > 0 ? `${selected.size} ${t("update.selectComponents")}, ${formatSize(selectedSize)}` : ""}
            </span>
            <button
              type="button"
              style={{ ...S.btn(true), opacity: selected.size === 0 ? 0.4 : 1 }}
              disabled={selected.size === 0}
              onClick={handleUpdateSelected}
            >
              {t("update.actions.updateSelected")}
            </button>
          </>
        )}
        {state === "downloading" && (
          <button type="button" style={{ ...S.btn(false), opacity: 0.4 }} disabled>
            {t("update.installStatus.updating")}...
          </button>
        )}
        {state === "upToDate" && optIn.length > 0 && selected.size > 0 && (
          <>
            <span style={{
              fontSize: "calc(var(--font-scale, 1) * 10.5px)", color: "var(--fg-muted)",
              display: "flex", alignItems: "center",
            }}>
              {`${selected.size} ${t("update.selectComponents")}, ${formatSize(selectedSize)}`}
            </span>
            <button type="button" style={S.btn(true)} onClick={handleUpdateSelected}>
              {t("update.actions.installSelected")}
            </button>
          </>
        )}
        {state === "needsRestart" && (
          <>
            <button type="button" style={S.btn(false)} onClick={handleSkipAll}>
              {t("update.actions.skipAll")}
            </button>
            <button type="button" style={S.btn(true)} onClick={handleRestart}>
              {t("update.actions.restart")}
            </button>
          </>
        )}
      </div>
    </div>
  );
});
