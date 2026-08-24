import { useState } from "react";
import { PanelLeft, PanelRight, PanelBottom } from "lucide-react";
import { t } from "../../../i18n";

/* ── PanelToggleDemo: interactive toggle of the three side panels ── */

type PanelKey = "left" | "right" | "bottom";

export function PanelToggleDemo() {
  const [open, setOpen] = useState<Record<PanelKey, boolean>>({ left: true, right: true, bottom: true });

  const toggle = (k: PanelKey) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div style={{
      border: "1px solid var(--border-light)", borderRadius: 8, padding: 14,
      background: "var(--bg-surface)", userSelect: "none",
    }}>
      {/* Mini layout */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `${open.left ? 74 : 0}px 1fr ${open.right ? 74 : 0}px`,
        gridTemplateRows: `1fr ${open.bottom ? 40 : 0}px`,
        gap: 4, height: 140, marginBottom: 12,
        transition: "all 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
        <div style={{
          background: "var(--accent-subtle)", borderRadius: 4,
          overflow: "hidden", transition: "all 0.35s",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 9, color: "var(--accent)", fontWeight: 600,
        }}>
          {open.left && "左侧面板"}
        </div>
        <div style={{
          background: "var(--bg-hover)", borderRadius: 4,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, color: "var(--fg-muted)",
        }}>
          中心区域
        </div>
        <div style={{
          background: "var(--accent-subtle)", borderRadius: 4,
          overflow: "hidden", transition: "all 0.35s",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 9, color: "var(--accent)", fontWeight: 600,
        }}>
          {open.right && "右侧面板"}
        </div>
        <div style={{
          background: "var(--semantic-success-subtle, #e8f5e9)", borderRadius: 4,
          gridColumn: "1 / -1", overflow: "hidden", transition: "all 0.35s",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 9, color: "var(--semantic-success)", fontWeight: 600,
        }}>
          {open.bottom && "底部面板（终端）"}
        </div>
      </div>

      {/* Toggle buttons */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button onClick={() => toggle("left")} style={{ ...btnStyle, ...(open.left ? btnOn : {}) }}>
          <PanelLeft size={14} /> 左侧
        </button>
        <button onClick={() => toggle("right")} style={{ ...btnStyle, ...(open.right ? btnOn : {}) }}>
          <PanelRight size={14} /> 右侧
        </button>
        <button onClick={() => toggle("bottom")} style={{ ...btnStyle, ...(open.bottom ? btnOn : {}) }}>
          <PanelBottom size={14} /> 底部
        </button>
      </div>

      <div style={{
        fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", marginTop: 10,
        textAlign: "center", lineHeight: 1.5,
      }}>
        点击按钮，看看三个面板如何开合 — 工具栏上对应按钮就是干这个的
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "5px 12px", borderRadius: 6,
  border: "1px solid var(--border-medium)",
  background: "var(--bg-root)", color: "var(--fg-secondary)",
  cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 11px)",
  fontFamily: "inherit",
};
const btnOn: React.CSSProperties = {
  background: "var(--accent-subtle)", color: "var(--accent)",
  border: "1px solid var(--accent)",
};
