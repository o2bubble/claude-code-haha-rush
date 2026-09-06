// ── 市场通用样式（SkillsPanel MarketplaceTab 与 PluginMarketPanel 共用）──
// 消掉两面板各自的样式常量复制（pkgCard/pkgHeader/installBtn/empty/retry）。

import type { CSSProperties } from "react";

export const pkgCardStyle: CSSProperties = {
  borderBottom: "1px solid var(--border-light)",
  backgroundColor: "var(--bg-root)",
};

export const pkgHeaderStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  padding: "8px 12px", cursor: "pointer",
};

export const installBtnStyle: CSSProperties = {
  border: "1px solid var(--accent)", borderRadius: 3,
  padding: "2px 8px", cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "var(--font-sans)",
  backgroundColor: "transparent", color: "var(--accent)",
  flexShrink: 0,
};

export const emptyStyle: CSSProperties = {
  padding: "20px 12px", textAlign: "center",
  fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-muted)", fontFamily: "var(--font-sans)",
};

export const retryBtnStyle: CSSProperties = {
  marginTop: 8, border: "1px solid var(--accent)", borderRadius: 3,
  padding: "2px 12px", cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "var(--font-sans)",
  backgroundColor: "transparent", color: "var(--accent)",
};
