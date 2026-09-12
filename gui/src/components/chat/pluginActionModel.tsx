// ── 插件操作模型（市场列表卡片与详情页共用的唯一判定 + 按钮组件）──
// 抽成独立模块, 避免详情面板 import PluginMarketPanel 时把整个市场面板
// (含 skillMarketplace 等) 拖进依赖图。
// 详细规则见 docs/plugin-panel-design-spec.md §4。

import React from "react";
import { Download, Ban, Play, Trash2, Sparkles, MoreHorizontal, Loader2, Package, Wrench, BookOpen, Layers, Zap } from "lucide-react";
import { t as i18nT } from "../../i18n";
import { showCtxMenu, type ContextMenuItem } from "../ContextMenu";
import { btnStyle } from "./marketplaceStyles";

/** 决定按钮组的插件状态 */
export interface PluginCardState {
  installed: boolean;
  disabled: boolean;
  needsUpdate: boolean;
  /** 官方签名验证通过（未受信任只能 AI 安装） */
  trusted: boolean;
  /** ai-guided 无运行时, 只能 AI 按文档装/卸 */
  aiGuided: boolean;
}

/** 可执行动作的落点（由各面板注入具体实现） */
export interface PluginActions {
  install: () => void;
  toggle: () => void;
  uninstall: () => void;
  aiInstall: () => void;
  aiUninstall: () => void;
}

export type PluginActionKey = "install" | "update" | "toggle" | "uninstall" | "ai" | "aiun";

interface ActionDef {
  key: PluginActionKey;
  label: string;
  icon: React.ReactNode;
  run: (pk: PluginActions) => void;
  /** 破坏性操作 → 菜单内红色 */
  danger?: boolean;
}

/** 未受信任 → 不给「安装」直装入口（安全门）; ai-guided → 无禁用/卸载（无运行时, 无状态可禁） */
function directAllowed(s: PluginCardState): boolean { return !s.aiGuided && s.trusted; }
function toggleAllowed(s: PluginCardState): boolean { return !s.aiGuided; }

/**
 * 可用动作集合（顺序即按钮/菜单顺序）。
 * 逐条镜像改版前的判定, 不增不减。
 */
export function availableActions(s: PluginCardState): ActionDef[] {
  const L: ActionDef[] = [];
  if (s.installed) {
    if (s.needsUpdate) {
      L.push({
        key: "update", label: i18nT("pluginMarket.update"), icon: <Download size={13} />,
        // 未受信任的更新必须走 AI(带安全审查) —— 直接 install 会绕过未受信任管控
        run: (pk) => (s.aiGuided || !s.trusted ? pk.aiInstall() : pk.install()),
      });
    }
    if (toggleAllowed(s)) {
      L.push(s.disabled
        ? { key: "toggle", label: i18nT("pluginMarket.enable"), icon: <Play size={13} />, run: (pk) => pk.toggle() }
        : { key: "toggle", label: i18nT("pluginMarket.disable"), icon: <Ban size={13} />, run: (pk) => pk.toggle() });
      L.push({ key: "uninstall", label: i18nT("pluginMarket.uninstall"), icon: <Trash2 size={13} />, run: (pk) => pk.uninstall(), danger: true });
    }
    L.push({ key: "aiun", label: i18nT("pluginMarket.aiUninstall"), icon: <Sparkles size={13} />, run: (pk) => pk.aiUninstall() });
  } else {
    if (directAllowed(s)) L.push({ key: "install", label: i18nT("pluginMarket.install"), icon: <Download size={13} />, run: (pk) => pk.install() });
    L.push({ key: "ai", label: i18nT("pluginMarket.aiInstall"), icon: <Sparkles size={13} />, run: (pk) => pk.aiInstall() });
  }
  return L;
}

/** 主按钮键 — 唯一决策点。null = 没有正事可做（只剩 ⋯）
 *  注意: 已装·可更新一律用 `update`（文案「更新」）；它内部再决定走直装还是 AI,
 *  否则未受信任时主按钮会错误显示成「AI 安装」。 */
export function primaryActionKey(s: PluginCardState): PluginActionKey | null {
  if (!s.installed) return directAllowed(s) ? "install" : "ai";
  if (s.needsUpdate) return "update";
  if (s.disabled) return "toggle";
  return toggleAllowed(s) ? "toggle" : null;
}

/** 主按钮 + ⋯ 溢出菜单（列表与详情共用）。
 *  主按钮实心 = 高频决定性动作；「已装·启用·最新」的禁用降为描边（无正事可做）。
 *  无主按钮时 ⋯ 自动加描边 —— 否则它是卡片唯一控件却几乎不可见。 */
export function PluginActionButtons({ st, busy, pk }: { st: PluginCardState; busy?: boolean; pk: PluginActions }) {
  const all = availableActions(st);
  const pkKey = primaryActionKey(st);
  const primary = all.find((a) => a.key === pkKey) ?? null;
  const overflow = all.filter((a) => a.key !== pkKey);

  const openMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: ContextMenuItem[] = [];
    overflow.forEach((a) => {
      // AI 卸载与直接操作区隔（仅在它不是首项时才插分隔线）
      if (a.key === "aiun" && items.length > 0) items.push({ separator: true });
      items.push({ label: a.label, icon: a.icon, danger: a.danger, action: () => a.run(pk) });
    });
    showCtxMenu(r.right - 4, r.bottom + 4, items);
  };

  if (busy) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "calc(var(--font-scale, 1) * 11.5px)", color: "var(--accent)", fontWeight: 600 }}>
        <Loader2 size={12} style={{ animation: "app-spin 0.8s linear infinite" }} />
        {i18nT("pluginMarket.installing")}
      </span>
    );
  }

  return (
    <>
      {primary ? (
        <button
          type="button"
          style={btnStyle(primary.key === "toggle" && !st.disabled ? "outline" : "primary")}
          onClick={() => primary.run(pk)}
          title={primary.label}
        >
          {primary.key === "toggle" && !st.disabled ? null : primary.icon}
          {primary.label}
        </button>
      ) : null}
      <span style={{ flex: 1 }} />
      {overflow.length > 0 && (
        <button
          type="button"
          style={btnStyle(primary ? "ghost" : "outline")}
          onClick={openMenu}
          title={i18nT("pluginMarket.moreActions")}
          aria-label={i18nT("pluginMarket.moreActions")}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    </>
  );
}

/** 插件分类 → 图标。完整 marketplace 数据带 category，详情页只有 tags/name，
 *  两条入口共用同一份映射，避免图标风格在两处漂移（见 spec §5）。 */
export type PluginCategory = "component" | "tool" | "guide" | "integration" | undefined;

const CAT_ICONS = {
  component: Layers,
  tool: Wrench,
  guide: BookOpen,
  integration: Zap,
} as const;

/** 按真实分类取图标（市场列表用，数据里有 category） */
export function catIcon(category: PluginCategory, size = 14): React.ReactNode {
  const Icon = (category && CAT_ICONS[category]) || Package;
  return <Icon size={size} />;
}

/** 从 tags/name 近似推分类（详情页用 —— pluginDetailStore 不带 category 字段，
 *  纯展示用途，不影响任何行为判定） */
export function categoryFromTags(tags: string[], name: string): PluginCategory {
  const hay = `${tags.join(" ")} ${name}`.toLowerCase();
  if (hay.includes("component")) return "component";
  if (hay.includes("integration") || hay.includes("mcp")) return "integration";
  if (hay.includes("guide") || hay.includes("docs")) return "guide";
  if (hay.includes("runtime") || hay.includes("tool")) return "tool";
  return undefined;
}

/** 依赖/标签小片 — 最多 2 个, 超出折叠为 +N（title 给全量） */
export function MetaChips({ items, style }: { items: string[]; style?: React.CSSProperties }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 2);
  const rest = items.length - shown.length;
  return (
    <>
      {shown.map((t, i) => <span key={`${t}-${i}`} style={style}>{t}</span>)}
      {rest > 0 && (
        <span style={style} title={items.join(", ")}>
          {i18nT("pluginMarket.moreTags", { count: rest })}
        </span>
      )}
    </>
  );
}
