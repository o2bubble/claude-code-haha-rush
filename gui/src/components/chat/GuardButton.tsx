// ── 无人值守守护: Toolbar 按钮 + 风险确认 + 状态角标 ──
import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import {
  getGuardStatus, subscribeGuard, guardStart, guardStop,
  type GuardUiStatus,
} from "../../services/guardBridge";
import { t } from "../../i18n";

const RISKS: string[] = [
  "guard.risk.selfAssessment",
  "guard.risk.noLimit",
  "guard.risk.permission",
  "guard.risk.format",
  "guard.risk.autonomy",
];

export function GuardButton() {
  const [status, setStatus] = useState<GuardUiStatus>(getGuardStatus());
  const [confirming, setConfirming] = useState(false);

  useEffect(() => subscribeGuard(() => setStatus(getGuardStatus())), []);

  const active = status !== "off";
  const dotColor = status === "asking" ? "#3b82f6" : status === "paused" ? "var(--semantic-error)" : status === "watching" ? "#eab308" : "transparent";

  const btnStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: active ? "var(--accent)" : "var(--fg-secondary)",
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    padding: 4,
    borderRadius: 6,
  };

  return (
    <>
      <button
        type="button"
        title={active ? `${t("guard.title")} · ${t(`guard.status.${status}`)}` : t("guard.title")}
        aria-label={t("guard.title")}
        style={btnStyle}
        onClick={() => {
          if (active) {
            void guardStop();
          } else {
            setConfirming(true);
          }
        }}
      >
        <Shield size={15} style={{ pointerEvents: "none" }} />
        {active && (
          <span
            style={{
              position: "absolute",
              top: 1,
              right: 1,
              width: 7,
              height: 7,
              borderRadius: "50%",
              backgroundColor: dotColor,
              border: "1.5px solid var(--bg-root)",
              pointerEvents: "none",
            }}
          />
        )}
      </button>

      <GuardConfirmDialog open={confirming} onClose={() => setConfirming(false)} />
    </>
  );
}

/**
 * 无人值守的确认框（**居中模态**）—— 受控组件，两处共用一个实现：
 *   1. 工具栏按钮点击（GuardButton 内部）
 *   2. 工具栏折叠后从应用菜单进入（Toolbar 直接渲染）
 *
 * 抽出来的理由：菜单项只能给 icon+onClick，装不下确认框这类交互 ——
 * 但把确认框的「选项」拆成菜单项又会让菜单膨胀。中间浮层是两全的做法。
 */
export function GuardConfirmDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-root)",
          border: "1px solid var(--border-medium)",
          borderRadius: 12,
          padding: 16,
          width: 420,
          fontFamily: "var(--font-sans)",
          color: "var(--fg-primary)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          {t("guard.confirmTitle")}
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, lineHeight: 1.7, color: "var(--fg-secondary)" }}>
          {RISKS.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "1px solid var(--border-medium)",
              background: "transparent",
              color: "var(--fg-secondary)",
              borderRadius: 6,
              padding: "5px 14px",
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("guard.cancel")}
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              void guardStart();
            }}
            style={{
              border: "none",
              background: "var(--semantic-error)",
              color: "#fff",
              borderRadius: 6,
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("guard.enter")}
          </button>
        </div>
      </div>
    </div>
  );
}