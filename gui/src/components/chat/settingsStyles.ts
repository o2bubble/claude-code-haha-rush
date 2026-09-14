// ── 设置面板共享样式 ──
//
// 从 SettingsPanel.tsx 抽出：shorcuts 等子页面需要复用同一套样式，
// 而若从 SettingsPanel 导出会造成循环引用（SettingsPanel 要 import 子页面）。

import type React from "react";

export const S = {
  container: { display: "flex", height: "100%", fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 12px)" } as React.CSSProperties,
  sidebar: { width: 110, borderRight: "1px solid var(--border-light)", backgroundColor: "var(--bg-surface)", flexShrink: 0, paddingTop: 4 } as React.CSSProperties,
  content: { flex: 1, display: "flex", flexDirection: "column", overflow: "auto" } as React.CSSProperties,
  navBtn: (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", padding: "7px 12px", cursor: "pointer",
    fontSize: "calc(var(--font-scale, 1) * 12px)", color: active ? "var(--accent)" : "var(--fg-primary)",
    backgroundColor: active ? "var(--bg-active)" : "transparent",
    borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
    fontWeight: active ? 600 : 400,
  }),
  header: { padding: "8px 12px", borderBottom: "1px solid var(--border-light)", fontWeight: 600, color: "var(--fg-primary)", fontSize: "calc(var(--font-scale, 1) * 13px)" } as React.CSSProperties,
  form: { padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 } as React.CSSProperties,
  label: { display: "block", marginBottom: 4, color: "var(--fg-secondary)", fontWeight: 500, fontSize: "calc(var(--font-scale, 1) * 11px)" } as React.CSSProperties,
  select: { border: "1px solid var(--border-medium)", borderRadius: 4, padding: "4px 8px", fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "inherit", background: "var(--bg-root)" } as React.CSSProperties,
  input: { border: "1px solid var(--border-medium)", borderRadius: 4, padding: "4px 8px", fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "inherit" } as React.CSSProperties,
  row: { display: "flex", gap: 6 } as React.CSSProperties,
  // 分组卡片：把「一组相关设置」圈起来，用于一页里存在多个独立来源/主题时
  // （典型：插件页 —— 每个插件的设置各成一组）。单主题的扁平页不必用。
  card: {
    border: "1px solid var(--border-light)", borderRadius: 8,
    backgroundColor: "var(--bg-surface)", padding: "12px 14px",
    display: "flex", flexDirection: "column", gap: 10,
  } as React.CSSProperties,
  cardTitle: { display: "flex", alignItems: "baseline", gap: 8 } as React.CSSProperties,
  cardTitleText: { fontWeight: 600, color: "var(--fg-primary)", fontSize: "calc(var(--font-scale, 1) * 13px)" } as React.CSSProperties,
  cardTitleMeta: { color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 10px)" } as React.CSSProperties,
  saveBar: { padding: "10px 16px", borderTop: "1px solid var(--border-light)", display: "flex", alignItems: "center", gap: 8 } as React.CSSProperties,
  saveBtn: (color: string): React.CSSProperties => ({
    padding: "5px 16px", border: "none", borderRadius: 4,
    backgroundColor: color, color: "var(--fg-inverse)", cursor: "pointer",
    fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "inherit", fontWeight: 500,
  }),
  // 「去设置」定位高亮：短暂背景闪烁，负 margin 抵消 padding 避免布局跳动
  fieldFlash: (active: boolean): React.CSSProperties => ({
    backgroundColor: active ? "var(--accent-subtle)" : "transparent",
    borderRadius: 4,
    padding: active ? "4px 6px" : "0",
    margin: active ? "-4px -6px" : "0",
    transition: "background-color 0.3s ease",
  }),
};
