import React, { memo, useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
import { EmptyState } from "../SharedStates";
import { diagnosticsService, type CheckStatus, type DiagnosticCheck, type DiagnosticCategory, type DiagnosticsReport } from "../../services/diagnosticsService";
import { deriveServerProfile, serverProfileUrls } from "../../utils/serverProfile";
import { getSettings, saveSettings } from "../../stores/settingsStore";
import { isMacPlatform } from "../../utils/platform";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { BackendService } from "../../services/backendService";
import { getWsDiag } from "../../services/wsDiag";
import { getChatState } from "../../stores/chatStore";
import { classifyBackendPort, classifyBackendStatus, classifyWsConnected } from "../../utils/diagnosticsBackend";

// ── Styles ──

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
  na: "–",
};

const STATUS_COLOR: Record<CheckStatus, React.CSSProperties> = {
  pass: { backgroundColor: "var(--semantic-success-subtle, #e8f5e9)", color: "var(--semantic-success)" },
  warn: { backgroundColor: "var(--semantic-warning-subtle, #fff3e0)", color: "var(--semantic-warning)" },
  fail: { backgroundColor: "var(--semantic-error-subtle, #fdecea)", color: "var(--semantic-error)" },
  na: { backgroundColor: "var(--border-light)", color: "var(--fg-muted)" },
};

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
  body: { flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 14 } as React.CSSProperties,
  footer: {
    padding: "8px 14px", borderTop: "1px solid var(--border-light)",
    display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0,
  } as React.CSSProperties,
  categoryTitle: {
    fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 12.5px)",
    color: "var(--fg-secondary)", paddingBottom: 6, borderBottom: "1px solid var(--border-light)",
  } as React.CSSProperties,
  groupTitle: {
    fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 11.5px)",
    color: "var(--fg-secondary)", padding: "8px 0 2px",
  } as React.CSSProperties,
  checkRow: {
    display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0",
  } as React.CSSProperties,
  badge: {
    fontSize: "calc(var(--font-scale, 1) * 10px)", padding: "1px 6px", borderRadius: 10,
    fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0, marginTop: 1, minWidth: 16, textAlign: "center",
  } as React.CSSProperties,
  checkText: { flex: 1, minWidth: 0 } as React.CSSProperties,
  checkTitle: { fontWeight: 500, fontSize: "calc(var(--font-scale, 1) * 12px)" } as React.CSSProperties,
  checkDetail: {
    fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)",
    wordBreak: "break-all", marginTop: 2,
  } as React.CSSProperties,
  btn: (primary: boolean): React.CSSProperties => ({
    padding: "5px 14px", borderRadius: 5, border: primary ? "none" : "1px solid var(--border-medium)",
    backgroundColor: primary ? "var(--accent)" : "transparent",
    color: primary ? "var(--fg-inverse)" : "var(--fg-primary)",
    fontSize: "calc(var(--font-scale, 1) * 11.5px)", cursor: "pointer",
    fontFamily: "inherit",
  }),
  spinner: { width: 14, height: 14, border: "2px solid var(--border-light)", borderTop: "2px solid var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 } as React.CSSProperties,
  errorText: { color: "var(--semantic-error)", fontSize: "calc(var(--font-scale, 1) * 11px)" } as React.CSSProperties,
};

function statusLabel(s: CheckStatus): string {
  return STATUS_LABEL[s];
}

/** 分类标题 — 优先 i18n（按分类 id），未知 id 回退 Rust 提供的标题 */
function categoryTitle(cat: DiagnosticCategory): string {
  const key = `diagnostics.category.${cat.id}`;
  const s = t(key);
  return s === key ? cat.title : s;
}

/** 检查项标题 — 优先 i18n（按检查项 id），未知 id 回退 Rust 提供的标题 */
function checkTitle(c: DiagnosticCheck): string {
  const key = `diagnostics.check.${c.id}`;
  const s = t(key);
  return s === key ? c.title : s;
}

/** 小节标题 — 优先 i18n（按 group id），未知 id 回退原始 group 字符串 */
function groupTitle(g: string): string {
  const key = `diagnostics.group.${g}`;
  const s = t(key);
  return s === key ? g : s;
}

/** 复制报告：一行一条「状态 类别 · 检查项 — 明细」 */
function formatReport(report: DiagnosticsReport): string {
  const lines: string[] = [];
  for (const cat of report.categories) {
    for (const c of cat.checks) {
      lines.push(`[${statusLabel(c.status)}] ${categoryTitle(cat)} · ${checkTitle(c)} — ${c.detail}`);
    }
  }
  return lines.join("\n");
}

/** 按分类 id 合并（替换同 id 分类，其余保留）— 云切换重跑网络等场景不能追加出重复分类 */
function mergeCategories(report: DiagnosticsReport, cats: DiagnosticCategory[]): DiagnosticsReport {
  const kept = report.categories.filter((c) => !cats.some((nc) => nc.id === c.id));
  return { ...report, categories: [...kept, ...cats] };
}

/** 「后端服务」分类 — 数据来自运行时前端状态（后端生命周期 + WS 连接） */
function buildBackendCategory(): DiagnosticCategory {
  const s = BackendService.getState();
  const chat = getChatState();
  const status = classifyBackendStatus(s.status, s.port, s.error);
  const port = classifyBackendPort(s.port, s.status);
  const ws = classifyWsConnected(chat.connected);
  // WS 最近连接事件摘要 — 复现「backend 已启动但 WS 未连接」时区分连错端口/被拒/断开
  const evs = getWsDiag()
    .slice(0, 4)
    .map((e) => `${e.kind}@${e.port}${e.kind === "close" ? (e.code ? `[${e.code}]` : "") : ""}`)
    .join(" ");
  return {
    id: "backend",
    title: t("diagnostics.backendService"),
    checks: [
      { id: "backend_status", status: status.status, title: t("diagnostics.backendProcess"), detail: status.detail },
      { id: "backend_port", status: port.status, title: t("diagnostics.backendPort"), detail: port.detail },
      { id: "ws_connection", status: ws.status, title: t("diagnostics.wsConnection"), detail: evs ? `${ws.detail} · ${evs}` : ws.detail },
    ],
  };
}

// ── Component ──

export const DiagnosticPanel: React.FC = memo(function DiagnosticPanel() {
  const [loading, setLoading] = useState(true); // env 分类在途
  const [networkLoading, setNetworkLoading] = useState(false);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const runEnv = useCallback(async () => {
    const r = await diagnosticsService.run();
    // 后端服务分类来自前端运行时状态，随环境检查一起展示
    setReport({ timestamp: Date.now(), categories: [buildBackendCategory(), ...r.categories] });
  }, []);

  const runWorkspace = useCallback(async () => {
    const w = await diagnosticsService.runWorkspace();
    setReport((prev) => (prev ? mergeCategories(prev, w.categories) : w));
  }, []);

  const runNetwork = useCallback(async () => {
    setNetworkLoading(true);
    try {
      const n = await diagnosticsService.runNetwork();
      setReport((prev) => (prev ? mergeCategories(prev, n.categories) : n));
    } finally {
      setNetworkLoading(false);
    }
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      await runEnv();
      await runWorkspace();
      await runNetwork();
    } catch (e: any) {
      setErrorMsg(e?.toString() ?? String(e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [runEnv, runWorkspace, runNetwork]);

  useEffect(() => {
    run();
  }, [run]);

  // 网络分类分析 — 决定「切换到云服务器」按钮是否展示
  const networkCat = report?.categories.find((c) => c.id === "network");
  const updateCheck = networkCat?.checks.find((c) => c.id === "update_server");
  const cloudCheck = networkCat?.checks.find((c) => c.id === "cloud_server");
  const onCloud = deriveServerProfile(
    getSettings().skillRegistryUrl,
    getSettings().updateServerUrl,
  ) === "public";
  const showCloudSwitch = !!networkCat && !networkLoading
    && updateCheck?.status === "fail" && cloudCheck?.status === "pass" && !onCloud;

  const switchToCloud = useCallback(async () => {
    try {
      await saveSettings(serverProfileUrls("public"), "global");
      addStatusMessage(t("diagnostics.cloudSwitched"), "info");
      await runNetwork();
    } catch {
      addStatusMessage(t("diagnostics.cloudSwitchFailed"), "error");
    }
  }, [runNetwork]);

  const copyReport = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatReport(report));
      addStatusMessage(t("diagnostics.copied"), "success");
    } catch {
      addStatusMessage(t("diagnostics.copyFailed"), "error");
    }
  }, [report]);

  // ── 修复动作 ──
  const [fixing, setFixing] = useState<string | null>(null);

  const backendCat = report?.categories.find((c) => c.id === "backend");
  const backendFail = !!backendCat?.checks.some((c) => c.status === "fail");
  const envCat = report?.categories.find((c) => c.id === "env");
  const envFail = !!envCat?.checks.some((c) => c.status === "fail" || c.status === "warn");

  const fixBackend = useCallback(async () => {
    setFixing("backend");
    try {
      const msg = await diagnosticsService.fixRestartIdeBackend();
      addStatusMessage(msg, "success");
      // fix_restart_ide_backend 是 fire-and-forget：杀进程+异步重启后立即返回，
      // 前端 BackendService._state 不会自动刷新——再读 buildBackendCategory() 只会拿到
      // 旧状态（"运行中@旧端口"或旧 error），看起来像"没重启成功"。这里走 BackendService.start()
      // 重新 poll get_ide_port 并更新 state（内部 quick-poll 失败会 fallback 到
      // restart_ide_backend + 完整轮询），再刷新面板才能真正反映新端口。
      await BackendService.start();
      setReport((prev) => (prev ? { ...prev, categories: [buildBackendCategory(), ...prev.categories.filter((c) => c.id !== "backend")] } : prev));
    } catch (e) {
      addStatusMessage(String(e), "error");
    } finally {
      setFixing(null);
    }
  }, []);

  /**
   * macOS 专用：修复 `.app` 内关键二进制的可执行位。
   *
   * 场景：自动更新解压时丢了 +x → `claude` 不可执行 → 引擎起不来。报错只显示
   * "Permission denied" 而不说是哪个文件，用户很难自查，所以给一键修复。
   * 系统级安装（属主 root）会弹一次管理员密码框。
   */
  const fixExecBits = useCallback(async () => {
    setFixing("mac_exec_bits");
    try {
      const fixes = await diagnosticsService.fixMacExecBits();
      for (const f of fixes) {
        addStatusMessage(`${f.name}: ${f.action}`, "success");
      }
      if (fixes.some((f) => f.action.startsWith("已修"))) {
        addStatusMessage(t("diagnostics.execBitsRestartHint"), "info");
      }
      await runEnv();
    } catch (e) {
      const msg = String(e);
      addStatusMessage(
        /授权被取消|canceled|cancelled|User canceled/i.test(msg)
          ? t("diagnostics.execBitsDenied")
          : msg,
        "error",
      );
    } finally {
      setFixing(null);
    }
  }, [runEnv]);

  const fixEnv = useCallback(async () => {
    setFixing("env");
    try {
      // 全量修复: 环境变量 + Profile 激活
      const fixes = await diagnosticsService.fixEnvironmentVars();
      for (const f of fixes) {
        addStatusMessage(`${f.name}: ${f.action}`, "success");
      }
      const pfixes = await diagnosticsService.fixProfiles();
      for (const f of pfixes) {
        addStatusMessage(`${f.name}: ${f.action}`, "success");
      }
      // 有实际改动时提示重启：注册表/标记变更对已运行进程不生效
      const changed = [...fixes, ...pfixes].some((f) => f.action !== "无需操作" && f.name !== "(无)");
      if (changed) {
        addStatusMessage(t("diagnostics.restartHint"), "info");
      }
      await runEnv();
    } catch (e) {
      const msg = String(e);
      // 提权修复被 UAC 跳转/拒绝 → 给友好提示
      addStatusMessage(
        /授权被取消|UAC|拒绝|elevat/i.test(msg)
          ? t("diagnostics.envFixElevationDenied")
          : msg,
        "error",
      );
    } finally {
      setFixing(null);
    }
  }, [runEnv]);

  return (
    <div style={S.container}>
      <div style={S.header}>
        <span>{t("diagnostics.title")}</span>
        {(loading || networkLoading) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={S.spinner} />
            <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", fontWeight: 400 }}>
              {t("diagnostics.checking")}
            </span>
          </div>
        )}
      </div>

      <div style={S.body}>
        {errorMsg && (
          <EmptyState text={errorMsg} action={{ label: t("diagnostics.reCheck"), onClick: run }} />
        )}
        {!errorMsg && !report && loading && (
          <EmptyState text={t("diagnostics.checking")} />
        )}
        {!errorMsg && report && report.categories.length === 0 && (
          <EmptyState text={t("diagnostics.noChecks")} />
        )}
        {report && report.categories.map((cat: DiagnosticCategory) => {
          const fixable =
            cat.id === "backend" && backendFail ? { label: t("diagnostics.restartBackend"), onClick: fixBackend }
            : cat.id === "env" && envFail ? { label: t("diagnostics.fixEnvVars"), onClick: fixEnv }
            : null;
          return (
          <div key={cat.id}>
            <div style={{ ...S.categoryTitle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span>{categoryTitle(cat)}</span>
              {fixable && (
                <button
                  type="button"
                  style={{ ...S.btn(true), padding: "3px 10px", fontSize: "calc(var(--font-scale, 1) * 10.5px)" }}
                  onClick={fixable.onClick}
                  disabled={fixing !== null}
                >
                  {fixing === cat.id ? t("diagnostics.fixing") : fixable.label}
                </button>
              )}
            </div>
            {cat.checks.map((c, i) => {
              const prev = i > 0 ? cat.checks[i - 1] : undefined;
              const showGroup = !!c.group && c.group !== prev?.group;
              return (
                <React.Fragment key={c.id}>
                  {showGroup && <div style={S.groupTitle}>{groupTitle(c.group!)}</div>}
                  <div style={S.checkRow}>
                    <span style={{ ...S.badge, ...STATUS_COLOR[c.status] }}>{statusLabel(c.status)}</span>
                    <div style={S.checkText}>
                      <div style={S.checkTitle}>{checkTitle(c)}</div>
                      <div style={S.checkDetail}>{c.detail}</div>
                    </div>
                    {/* 权限缺失给行内「修复」——它不是环境变量问题，不归 fixEnv 管 */}
                    {c.id === "mac_exec_bits" && c.status === "fail" && isMacPlatform() && (
                      <button
                        type="button"
                        style={{ ...S.btn(true), padding: "2px 9px", fontSize: "calc(var(--font-scale, 1) * 10.5px)", flexShrink: 0 }}
                        onClick={fixExecBits}
                        disabled={fixing !== null}
                      >
                        {fixing === "mac_exec_bits" ? t("diagnostics.fixing") : t("diagnostics.fixExecBits")}
                      </button>
                    )}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
          );
        })}
      </div>

      <div style={S.footer}>
        {report && !loading && !networkLoading && (
          <>
            <button type="button" style={S.btn(false)} onClick={run}>
              {t("diagnostics.reCheck")}
            </button>
            <button type="button" style={S.btn(true)} onClick={copyReport}>
              {t("diagnostics.copyReport")}
            </button>
            {showCloudSwitch && (
              <button type="button" style={S.btn(true)} onClick={switchToCloud}>
                {t("diagnostics.switchCloud")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});
