// ── 市场通用样式（插件市场两个面板共用）──
// 注意: SkillsPanel.tsx 用的是自己的本地副本, 不 import 本文件。
// 引用方只有 PluginMarketPanel.tsx / PluginMarketDetailPanel.tsx / pluginActionModel.tsx。

import type { CSSProperties } from "react";

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

// ── 卡片三段结构（名称 / 描述 / 元信息 + 操作行）──

/** 卡片容器：可点进详情 + hover 反馈 */
export const cardStyle: CSSProperties = {
  borderBottom: "1px solid var(--border-light)",
  backgroundColor: "var(--bg-root)",
  padding: "9px 10px 8px",
  cursor: "pointer",
  position: "relative",
};

/** 名称行：图标 + 名称 + 徽标组 */
export const cardRow1Style: CSSProperties = {
  display: "flex", alignItems: "center", gap: 7,
};

/** 分类图标底板（26×26） */
export const catIconStyle: CSSProperties = {
  width: 26, height: 26, borderRadius: 6, flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  backgroundColor: "var(--accent-subtle)", color: "var(--accent)",
};

/** 插件名（超长省略） */
export const cardNameStyle: CSSProperties = {
  fontWeight: 650, fontSize: "calc(var(--font-scale, 1) * 13px)",
  color: "var(--fg-primary)", flex: 1, minWidth: 0,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

/** 与名称左边缘对齐的缩进（图标 26 + gap 7） */
export const CARD_INDENT = 33;

/** 描述行：clamp 到 2 行 */
export const cardDescStyle: CSSProperties = {
  margin: `6px 0 0 ${CARD_INDENT}px`,
  fontSize: "calc(var(--font-scale, 1) * 11.5px)", color: "var(--fg-secondary)", lineHeight: 1.5,
  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

/** 元信息行：作者 · 版本 · 下载 + 依赖/标签小片 */
export const cardMetaStyle: CSSProperties = {
  margin: `5px 0 0 ${CARD_INDENT}px`,
  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
  fontSize: "calc(var(--font-scale, 1) * 10.5px)", color: "var(--fg-muted)",
};

/** 依赖 / 标签小片（等宽字体，弱化） */
export const metaChipStyle: CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 10,
  backgroundColor: "var(--bg-code)", borderRadius: 3,
  padding: "0 4px", color: "var(--fg-secondary)",
};

/** 操作行：主按钮 + ⋯ */
export const cardActStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  margin: `8px 0 0 ${CARD_INDENT}px`,
};

// ── 按钮（主 / 描边 / 幽灵 / 危险）──

export type BtnTone = "primary" | "outline" | "ghost" | "danger";

/** 主按钮实心 accent、次一级描边、ghost 无边框仅在 ⋯ 用 */
export function btnStyle(tone: BtnTone): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
    height: 26, padding: "0 12px", borderRadius: 4,
    fontSize: "calc(var(--font-scale, 1) * 11.5px)", fontFamily: "var(--font-sans)",
    fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
  };
  switch (tone) {
    case "primary":
      return { ...base, border: "1px solid var(--accent)", backgroundColor: "var(--accent)", color: "var(--fg-inverse)", fontWeight: 600 };
    case "outline":
      return { ...base, border: "1px solid var(--border-medium)", backgroundColor: "transparent", color: "var(--fg-secondary)" };
    case "ghost":
      return { ...base, border: "1px solid transparent", backgroundColor: "transparent", color: "var(--fg-muted)", padding: "0 7px" };
    case "danger":
      return { ...base, border: "1px solid var(--border-medium)", backgroundColor: "transparent", color: "var(--semantic-error)" };
  }
}

// ── 徽标 ──

export type BadgeTone = "accent" | "muted" | "warn" | "error" | "info";

export function badgeStyle(tone: BadgeTone, size = 9.5): CSSProperties {
  const color = {
    accent: "var(--accent)",
    muted: "var(--fg-muted)",
    warn: "var(--semantic-warning, #dca743)",
    error: "var(--semantic-error, #e5484d)",
    info: "var(--semantic-info, #2196f3)",
  }[tone];
  return {
    fontSize: size, fontWeight: 650, lineHeight: "15px",
    padding: "1px 6px", borderRadius: 8, flexShrink: 0, whiteSpace: "nowrap",
    color, border: `1px solid ${color}`,
    backgroundColor: tone === "accent" ? "var(--accent-subtle)" : "transparent",
  };
}
