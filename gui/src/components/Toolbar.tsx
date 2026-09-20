import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { PanelLeft, PanelRight, PanelBottom, Settings, Grid3x3, Shield, Layers, Terminal, FolderOpen, LayoutTemplate, RefreshCw, User, Sun, Moon, Bug, Download, HelpCircle, Search, Stethoscope, Copy, Brain, Gauge, GripHorizontal } from "lucide-react";
import { getTree, findParentSplit, toggleGroupHidden, toggleLeftColumn, toggleRightPanel, addFloatingPanel, getFloatingPanels, bringFloatingToFront, findTabByPanelId, applyLayoutPreset, LAYOUT_PRESETS, togglePanelInTree, isPanelOpenInTree } from "../stores/layoutStore";
import { iconFor } from "../utils/icons";
import { getRecent, sortByRecent } from "../utils/recentUsage";
import { getChatState } from "../stores/chatStore";
import { GuardButton, GuardConfirmDialog } from "./chat/GuardButton";
import { WindowControls, isWindowsChrome } from "./TitleBar";
import { AppMenu } from "./AppMenu";
import { useToolbarCollapse, DRAG_GUTTER_PX } from "./useToolbarCollapse";
import { partitionItems, type ToolbarItem } from "./toolbarItems";
import { DEFAULT_SHORTCUTS, resolveBindings, displayKeys } from "../services/shortcuts";
import { isMacPlatform } from "../services/shortcutDispatcher";
import { updateSettings, saveSettings, getSettings } from "../stores/settingsStore";
import { workspaceBasename } from "../utils/workspace";
import { isDarkTheme } from "../utils/themeUtils";
import { t } from "../i18n";
import { layoutMode } from "../stores/layoutMode";
import { useEvent, useEventHandler } from "../services/useService";
import { Events, type LayoutTreeChangedPayload, type ChatStateChangedPayload, type PanelRegistryChangedPayload, type SettingsChangedPayload, type UpdateAvailabilityPayload } from "../services/events";
import { commandRegistry, windowBus } from "../services/windowBus";
import { addStatusMessage } from "../stores/statusMsgStore";

let floatSettingsId: string | null = null;
let floatProfileId: string | null = null;
let floatFeedbackId: string | null = null;
let floatUpdateId: string | null = null;
let floatHelpId: string | null = null;
let floatDiagnosticsId: string | null = null;

function isVisible(groupId: string): boolean {
  const parent = findParentSplit(getTree(), groupId);
  if (!parent) return true;
  return parent.split.sizes[parent.index] > 0;
}

/**
 * 查某个功能的当前键位（供菜单提示显示）。
 *
 * **从快捷键注册表读，不硬编码** —— 用户在设置里改键后提示自动跟随，
 * 不会出现"菜单写着 Ctrl+R 但实际绑了别的键"。返回 `undefined` 表示
 * 该功能无快捷键（下拉菜单项就不显示灰字）。
 */
function shortcutFor(id: string): string | undefined {
  const overrides = getSettings().shortcuts;
  const e = resolveBindings(DEFAULT_SHORTCUTS, overrides).find((x) => x.id === id);
  if (!e || !e.keys) return undefined;
  return displayKeys(e.keys, isMacPlatform());
}

const PERM_MODES = [
  { value: "default", labelKey: "permission.default", descKey: "permission.defaultDesc" },
  { value: "acceptEdits", labelKey: "permission.acceptEdits", descKey: "permission.acceptEditsDesc" },
  { value: "plan", labelKey: "permission.plan", descKey: "permission.planDesc" },
  { value: "bypassPermissions", labelKey: "permission.bypass", descKey: "permission.bypassDesc" },
  { value: "dontAsk", labelKey: "permission.dontAsk", descKey: "permission.dontAskDesc" },
];

export function openSettingsFloat() {
  if (floatSettingsId) {
    const existing = getFloatingPanels().find((fp) => fp.id === floatSettingsId);
    if (existing) {
      bringFloatingToFront(floatSettingsId);
      return;
    }
    floatSettingsId = null;
  }
  const w = 640, h = 480;
  floatSettingsId = addFloatingPanel(
    {
      type: "group",
      id: "settings-float-group",
      tabs: [
        { id: "tab-settings-float", panelId: "settings", title: t("settings.title"), icon: "settings" },
      ],
      activeTabId: "tab-settings-float",
    },
    Math.round((window.innerWidth - w) / 2),
    Math.round((window.innerHeight - h) / 2),
    w, h,
  );
}

export function openUpdateFloat() {
  if (floatUpdateId) {
    const existing = getFloatingPanels().find((fp) => fp.id === floatUpdateId);
    if (existing) {
      bringFloatingToFront(floatUpdateId);
      return;
    }
    floatUpdateId = null;
  }
  const w = 560, h = 440;
  floatUpdateId = addFloatingPanel(
    {
      type: "group",
      id: "update-float-group",
      tabs: [
        { id: "tab-update-float", panelId: "update", title: t("update.title"), icon: "update" },
      ],
      activeTabId: "tab-update-float",
    },
    Math.round((window.innerWidth - w) / 2),
    Math.round((window.innerHeight - h) / 2),
    w, h,
  );
}

export function openFeedbackFloat() {
  if (floatFeedbackId) {
    const existing = getFloatingPanels().find((fp) => fp.id === floatFeedbackId);
    if (existing) {
      bringFloatingToFront(floatFeedbackId);
      return;
    }
    floatFeedbackId = null;
  }
  const w = 480, h = 480;
  floatFeedbackId = addFloatingPanel(
    {
      type: "group",
      id: "feedback-float-group",
      tabs: [
        { id: "tab-feedback-float", panelId: "feedback", title: t("feedback.title"), icon: "feedback" },
      ],
      activeTabId: "tab-feedback-float",
    },
    Math.round((window.innerWidth - w) / 2),
    Math.round((window.innerHeight - h) / 2),
    w, h,
  );
}

export function openHelpFloat() {
  if (floatHelpId) {
    const existing = getFloatingPanels().find((fp) => fp.id === floatHelpId);
    if (existing) {
      bringFloatingToFront(floatHelpId);
      return;
    }
    floatHelpId = null;
  }
  // 按当前窗口比例占用大部分空间（保留少量边距）
  const w = Math.round(window.innerWidth * 0.9);
  const h = Math.round(window.innerHeight * 0.86);
  floatHelpId = addFloatingPanel(
    {
      type: "group",
      id: "help-float-group",
      tabs: [
        { id: "tab-help-float", panelId: "help", title: t("help.title"), icon: "help" },
      ],
      activeTabId: "tab-help-float",
    },
    Math.round((window.innerWidth - w) / 2),
    Math.round((window.innerHeight - h) / 2),
    w, h,
  );
}

export function openDiagnosticsFloat() {
  if (floatDiagnosticsId) {
    const existing = getFloatingPanels().find((fp) => fp.id === floatDiagnosticsId);
    if (existing) {
      bringFloatingToFront(floatDiagnosticsId);
      return;
    }
    floatDiagnosticsId = null;
  }
  const w = 560, h = 480;
  floatDiagnosticsId = addFloatingPanel(
    {
      type: "group",
      id: "diagnostics-float-group",
      tabs: [
        { id: "tab-diagnostics-float", panelId: "diagnostics", title: t("panel.diagnostics"), icon: "diagnostics" },
      ],
      activeTabId: "tab-diagnostics-float",
    },
    Math.round((window.innerWidth - w) / 2),
    Math.round((window.innerHeight - h) / 2),
    w, h,
  );
}

export function openProfileFloat() {
  if (floatProfileId) {
    const existing = getFloatingPanels().find((fp) => fp.id === floatProfileId);
    if (existing) {
      bringFloatingToFront(floatProfileId);
      return;
    }
    floatProfileId = null;
  }
  const w = 460, h = 400;
  floatProfileId = addFloatingPanel(
    {
      type: "group",
      id: "profile-float-group",
      tabs: [
        { id: "tab-profile-float", panelId: "profile-manager", title: t("toolbar.profiles"), icon: "user" },
      ],
      activeTabId: "tab-profile-float",
    },
    Math.round((window.innerWidth - w) / 2),
    Math.round((window.innerHeight - h) / 2),
    w, h,
  );
}

const TOOLBAR_BTN_BASE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  // 永不压缩：flex 子项默认 flexShrink:1 会把按钮挤扁、文字压成竖排。
  // 宽度不够是**折叠机制**要解决的问题（把项收进菜单），不是让按钮变形。
  flexShrink: 0,
  whiteSpace: "nowrap",
} as const;

const btn = (active: boolean): React.CSSProperties => ({
  ...TOOLBAR_BTN_BASE,
  background: active ? "var(--bg-hover)" : "transparent",
  color: active ? "var(--fg-primary)" : "var(--fg-secondary)",
});

// 布局模式按钮开启态：绿色身份色（与布局模式 chrome 一致）
const LM_ACCENT = "oklch(0.56 0.15 150)";
const lmBtn = (active: boolean): React.CSSProperties => ({
  ...TOOLBAR_BTN_BASE,
  background: active ? LM_ACCENT : "transparent",
  color: active ? "var(--fg-inverse)" : "var(--fg-secondary)",
  boxShadow: active ? "0 0 0 2px oklch(0.56 0.15 150 / 0.2)" : undefined,
});

const DROPDOWN_MENU_BASE = {
  position: "absolute",
  top: "100%",
  marginTop: 2,
  background: "var(--bg-root)",
  border: "1px solid var(--border-medium)",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
  zIndex: 100,
  padding: "4px 0",
  opacity: 1,
  transform: "scale(1)",
  transition: "opacity var(--transition-fast), transform var(--transition-fast)",
  transformOrigin: "top",
} as const;

const DROPDOWN_ITEM_BASE = {
  padding: "5px 12px",
  cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 12px)",
  fontFamily: "var(--font-sans)",
} as const;

/**
 * 下拉弹层的容器属性。
 *
 * ⚠️ `data-tauri-drag-region="false"` 是必需的：工具栏容器带 `="deep"`
 * （空白处可拖窗口），而 Tauri 的 drag.js 只豁免 BUTTON/INPUT 等标签 ——
 * 下拉里的菜单项是 `<div onClick>`，会被 `preventDefault()` **吞掉点击**
 * （表现为"菜单显示正常但点不动"）。`false` 在遍历路径中命中即返回，
 * 阻止该子树及祖先的拖拽判定，点击恢复正常。
 */
export const DROPDOWN_MENU_ATTRS = { "data-tauri-drag-region": "false" } as const;

const DROPDOWN_EMPTY_MSG = {
  padding: "8px 12px",
  fontSize: "calc(var(--font-scale, 1) * 11px)",
  color: "var(--fg-muted)",
  fontFamily: "var(--font-sans)",
} as const;

const DROPDOWN_TRIGGER_BTN = {
  width: "auto",
  padding: "0 6px",
  fontSize: "calc(var(--font-scale, 1) * 11px)",
  fontFamily: "var(--font-sans)",
  display: "flex",
  gap: 4,
} as const;

const DROPDOWN_ARROW = {
  fontSize: 8,
  opacity: 0.4,
} as const;

const TOOLBAR_CONTAINER = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 0 4px 8px", // 右侧留给窗口按钮（自带 padding 语义）
  borderBottom: "1px solid var(--border-light)",
  backgroundColor: "var(--bg-surface)",
  height: 36,
  flexShrink: 0,
  // 必须定位 + 高于内容区：否则下拉弹层被下面的 LayoutRenderer 盖住
  // （它有 position:relative，定位元素恒压在非定位元素之上，
  //  下拉自身的 z-index:100 只在**自己的堆叠上下文内**有效，救不了父级）。
  position: "relative",
  zIndex: 20,
  // 不用 overflow:hidden —— 它会裁掉下拉弹层。溢出交给折叠机制解决
  // （隐藏只会掩盖折叠算法的偏差，让它露出来才可发现、可修）。
} as const;

/** 可折叠项上的红点（如「有新版本」）—— 贴按钮右上角。 */
function ToolbarBadgeDot() {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute", top: 2, right: 2,
        width: 8, height: 8, borderRadius: "50%",
        backgroundColor: "var(--semantic-error)",
        border: "1.5px solid var(--bg-surface)",
        pointerEvents: "none",
      }}
    />
  );
}

const TOOLBAR_DIVIDER = {
  width: 1,
  height: 20,
  backgroundColor: "var(--border-light)",
  margin: "0 4px",
} as const;

const groups = [
  { id: "sidebar-left", icon: PanelLeft, key: "toolbar.toggleLeftPanel" },
  { id: "chat-split", icon: PanelRight, key: "toolbar.toggleRightPanel" },
  { id: "bottom-panel", icon: PanelBottom, key: "toolbar.toggleBottomPanel" },
];

import { useClickOutside } from "../utils/useClickOutside";
import { useDropdownAlign } from "./useDropdownAlign";

// ── Permission mode dropdown ──

function PermModeDropdown() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const mode = payload?.state?.permissionMode ?? getChatState().permissionMode ?? "default";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  // 权限选项带描述文字，弹层较宽（minWidth 220）；窄窗口下按钮可能已靠近右边界
  const { align, maxWidth } = useDropdownAlign(ref, 220, open);

  const current = PERM_MODES.find((m) => m.value === mode) || PERM_MODES[0];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        title={t(current.descKey)}
        style={{ ...btn(false), ...DROPDOWN_TRIGGER_BTN }}
        onClick={() => setOpen(!open)}
      >
        <Shield size={13} />
        <span>{t(current.labelKey)}</span>
        <span style={DROPDOWN_ARROW}>▼</span>
      </button>
      {open && (
        <div {...DROPDOWN_MENU_ATTRS} style={{ ...DROPDOWN_MENU_BASE, ...align, minWidth: 220, maxWidth }}>
          {PERM_MODES.map((m) => (
            <div
              key={m.value}
              onClick={() => { commandRegistry.execute("SET_PERMISSION_MODE", m.value); setOpen(false); }}
              style={{
                ...DROPDOWN_ITEM_BASE,
                padding: "6px 12px",
                backgroundColor: m.value === mode ? "var(--accent-subtle)" : "transparent",
                color: m.value === mode ? "var(--accent)" : "var(--fg-primary)",
              }}
            >
              <div style={{ fontWeight: 500 }}>{t(m.labelKey)}</div>
              <div style={{ fontSize: 10, color: "var(--fg-muted)" }}>{t(m.descKey)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Model profile dropdown（含思考/档位/Profile 管理，见 ModelTuningSections）──

interface ModelProfile {
  id: string;
  label: string;
  model: string;
}

function ModelDropdown() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  // Load profiles on mount
  const loadProfiles = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result: any = await invoke("list_model_profiles");
      setProfiles(result.profiles || []);
      setActive(result.active || null);
    } catch { console.warn("Tauri not available"); }
  }, []);
  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  // Reload when profiles change (created/deleted/switched in the manager)
  useEffect(() => {
    return windowBus.on(Events.PROFILES_CHANGED, loadProfiles);
  }, [loadProfiles]);

  // Sync active profile from chatStore.model after backend restart
  useEffect(() => {
    const unsub = windowBus.on(Events.CHAT_STATE_CHANGED, (payload: any) => {
      if (payload?.state?.connected) setSwitching(false);
      const backendModel = payload?.state?.model;
      if (backendModel && profiles.length > 0) {
        // 只在 model 名唯一时才按 model 反推 active。同名(多个 profile 共用同一
        // model 字符串)下 find() 会永远命中第一条, 把用户刚切到的 profile 覆盖回
        // 第一条(如 deepseek-v4-flash-vision-exp 同名的官方/自定义两条)——
        // 这是"切换后仍显示官方"的根源。重复时不猜, 交给 active-profile 标记
        // (list_model_profiles().active) 与用户点击决定。
        const matches = profiles.filter((p) => p.model === backendModel);
        if (matches.length === 1) {
          setActive(matches[0].id);
          setSwitching(false);
        }
      }
    });
    return unsub;
  }, [profiles]);

  const current = profiles.find((p) => p.id === active);
  const label = switching ? t("toolbar.switching") : (current ? current.label : (active || t("toolbar.model")));

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        title={current?.model || ""}
        disabled={switching}
        style={{
          ...btn(false),
          ...DROPDOWN_TRIGGER_BTN,
          maxWidth: 140,
          overflow: "hidden",
          opacity: switching ? 0.5 : 1,
          cursor: switching ? "default" : "pointer",
        }}
        onClick={() => { if (!switching) setOpen(!open); }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        <span style={{ ...DROPDOWN_ARROW, flexShrink: 0 }}>{switching ? "⏳" : "▼"}</span>
      </button>
      {open && (
        <div {...DROPDOWN_MENU_ATTRS} style={{ ...DROPDOWN_MENU_BASE, right: 0, minWidth: 200, maxHeight: 340, overflowY: "auto" }}>
          {/* ── 模型 ── */}
          {profiles.length === 0 && (
            <div style={DROPDOWN_EMPTY_MSG}>
              {t("toolbar.noProfiles")}
            </div>
          )}
          {profiles.map((p) => (
            <div
              key={p.id}
              onClick={async () => {
                setOpen(false);
                setSwitching(true);
                setActive(p.id);
                addStatusMessage(t("toolbar.tbModelSwitching", { name: p.label }), "info");
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  await invoke("switch_model_profile", { profileId: p.id });
                  addStatusMessage(t("toolbar.tbModelSwitched", { name: p.label }), "success");
                } catch {
                  addStatusMessage(t("toolbar.tbModelSwitchFailed"), "error");
                } finally {
                  setSwitching(false);
                }
              }}
              style={{
                ...DROPDOWN_ITEM_BASE,
                backgroundColor: p.id === active ? "var(--accent-subtle)" : "transparent",
                color: p.id === active ? "var(--accent)" : "var(--fg-primary)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {p.label}
              {p.model && <span style={{ fontSize: 10, color: "var(--fg-muted)", marginLeft: 6 }}>{p.model}</span>}
            </div>
          ))}

          <DropdownSep />

          {/* ── 思考 / 档位（原独立下拉，收进这里：重要但不常改） ── */}
          <ModelTuningSections onPicked={() => setOpen(false)} />

          {/* ── Profile 管理 ── */}
          <DropdownSep />
          <div
            onClick={() => { setOpen(false); openProfileFloat(); }}
            style={{ ...DROPDOWN_ITEM_BASE, display: "flex", alignItems: "center", gap: 7, color: "var(--fg-primary)" }}
          >
            <User size={12} />
            {t("toolbar.profileManage")}
          </div>
        </div>
      )}
    </div>
  );
}

/** 下拉里的分隔线。 */
function DropdownSep() {
  return <div style={{ height: 1, background: "var(--border-light)", margin: "4px 0" }} />;
}

/**
 * 「思考」「档位」两段（从原 ThinkingDropdown / EffortDropdown 合并而来）。
 *
 * 收进模型下拉的理由：两者都只在支持对应能力的模型下出现、都属"模型行为调参"，
 * 且**不常改动** —— 工具栏常态不值得各占一个按钮。能力判断沿用各自原逻辑，
 * 某段不可用则该段不渲染。
 *
 * 自带数据订阅（不依赖父组件传值），因为它渲染在下拉内部、位置由父决定。
 */
function ModelTuningSections({ onPicked }: { onPicked: () => void }) {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = payload?.state ?? getChatState();
  const cap = state.modelCapabilities;

  const canThink = !!cap && (cap.thinking || cap.reasoning);
  const canEffort = !!cap && (cap.effort || cap.reasoning);
  if (!canThink && !canEffort) return null;

  const thinkingOn = state.thinkingModeEnabled;

  // Reasoning-capable providers (DeepSeek) accept low/high/max, not 'medium'
  // (Claude-native supports all four) — GUI decides the tiers, so drop medium.
  const effort = state.effort;
  const baseLevels = cap?.reasoning ? ["low", "high"] : ["low", "medium", "high"];
  const levels: Array<{ id: string }> = baseLevels.map((id) => ({ id }));
  if (cap?.maxEffort) levels.push({ id: "max" });
  const effortNow = effort ?? cap?.defaultEffort;

  return (
    <>
      {canThink && (
        <>
          <DropdownSectionLabel icon={<Brain size={11} />} text={t("toolbar.thinkingMode")} />
          {[{ id: true }, { id: false }].map((o) => (
            <div
              key={String(o.id)}
              onClick={() => {
                commandRegistry.execute("SET_THINKING_MODE", { enabled: o.id, effort: state.effort ?? undefined });
                onPicked();
              }}
              style={{
                ...DROPDOWN_ITEM_BASE,
                backgroundColor: o.id === thinkingOn ? "var(--accent-subtle)" : "transparent",
                color: o.id === thinkingOn ? "var(--accent)" : "var(--fg-primary)",
              }}
            >
              {o.id ? t("toolbar.thinkingOn") : t("toolbar.thinkingOff")}
            </div>
          ))}
        </>
      )}
      {canThink && canEffort && <DropdownSep />}
      {canEffort && (
        <>
          <DropdownSectionLabel icon={<Gauge size={11} />} text={t("toolbar.effort")} />
          {levels.map((l) => (
            <div
              key={l.id}
              onClick={() => { commandRegistry.execute("SET_EFFORT", l.id); onPicked(); }}
              style={{
                ...DROPDOWN_ITEM_BASE,
                backgroundColor: l.id === effortNow ? "var(--accent-subtle)" : "transparent",
                color: l.id === effortNow ? "var(--accent)" : "var(--fg-primary)",
              }}
            >
              {t(`toolbar.effort_${l.id}`)}
            </div>
          ))}
        </>
      )}
    </>
  );
}

/** 下拉内的分段小标题（不可点，仅视觉分组）。 */
function DropdownSectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      padding: "4px 12px 2px",
      fontSize: "calc(var(--font-scale, 1) * 10px)",
      color: "var(--fg-muted)",
      fontFamily: "var(--font-sans)",
      userSelect: "none",
    }}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

// ── System terminal launcher ──

/** 开一个新 GUI 实例（工具栏按钮与折叠后的菜单项共用同一动作）。 */
export async function spawnNewInstance() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("spawn_gui_instance");
  } catch (e) {
    console.warn("spawn new instance failed:", e);
  }
}

function TerminalDropdown() {
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const workDir = settingsPayload?.settings?.workDir ?? "";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  async function openTerminal(type: string) {
    setOpen(false);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_system_terminal", { terminalType: type, workDir });
    } catch (e) {
      // 把底层错误(如 macOS 自动化权限被拒)显示给用户，而不是静默 console.warn。
      const msg = e instanceof Error ? e.message : String(e);
      addStatusMessage(t("toolbar.terminalOpenFailed") + msg, "error");
    }
  }

  const isMac = /mac/i.test(navigator.platform || "");
  const terminals = isMac
    ? [{ id: "terminal", label: "Terminal (macOS)" }]
    : [
        { id: "cmd", label: "Command Prompt" },
        { id: "powershell", label: "PowerShell" },
        { id: "git-bash", label: "Git Bash" },
      ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        title={t("toolbar.openSystemTerminal")}
        aria-label={t("toolbar.openSystemTerminal")}
        style={{ ...btn(false), ...DROPDOWN_TRIGGER_BTN }}
        onClick={() => setOpen(!open)}
      >
        <Terminal size={13} />
        <span style={DROPDOWN_ARROW}>▼</span>
      </button>
      {open && (
        <div {...DROPDOWN_MENU_ATTRS} style={{ ...DROPDOWN_MENU_BASE, right: 0, minWidth: 160 }}>
          {terminals.map((t) => (
            <div
              key={t.id}
              onClick={() => openTerminal(t.id)}
              style={{ ...DROPDOWN_ITEM_BASE, color: "var(--fg-primary)" }}
            >
              {t.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Panel visibility dropdown ──

function PanelDropdown() {
  const panelPayload = useEvent<PanelRegistryChangedPayload>(Events.PANEL_REGISTRY_CHANGED);
  const allPanels = (panelPayload?.panels ?? []).filter((p) => p.userManaged !== false);
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  useEventHandler(Events.LAYOUT_TREE_CHANGED, () => setTick((t) => t + 1));

  function isPanelOpen(panelId: string): boolean {
    return isPanelOpenInTree(panelId);
  }

  function togglePanel(panelId: string) {
    return togglePanelInTree(panelId);
  }

  const openCount = allPanels.filter((p) => isPanelOpen(p.id)).length;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        title={t("toolbar.panels")}
        aria-label={t("toolbar.panels")}
        style={{ ...btn(false), ...DROPDOWN_TRIGGER_BTN }}
        onClick={() => setOpen(!open)}
      >
        <Layers size={13} />
        <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>{openCount}</span>
        <span style={DROPDOWN_ARROW}>▼</span>
      </button>
      {open && (
        <div {...DROPDOWN_MENU_ATTRS} style={{ ...DROPDOWN_MENU_BASE, right: 0, minWidth: 200 }}>
          {allPanels.length === 0 && (
            <div style={DROPDOWN_EMPTY_MSG}>
              {t("toolbar.noPanels")}
            </div>
          )}
          {(() => {
            const openPanels = allPanels.filter((p) => isPanelOpen(p.id));
            const otherPanels = sortByRecent(
              allPanels.filter((p) => !isPanelOpen(p.id)),
              getRecent("panel").map((r) => r.replace("panel-", "")),
            );
            const renderItem = (p: (typeof allPanels)[number], isOpen: boolean) => (
              <div
                key={p.id}
                onClick={() => togglePanel(p.id)}
                style={{
                  ...DROPDOWN_ITEM_BASE,
                  display: "flex", alignItems: "center", gap: 8,
                  color: isOpen ? "var(--fg-primary)" : "var(--fg-muted)",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", width: 18, height: 18 }}>
                  {iconFor(p.icon)}
                </span>
                <span style={{ flex: 1 }}>{p.title}</span>
                {isOpen && (
                  <span style={{ color: "var(--accent)", fontSize: 12, fontWeight: 600 } as const}>✓</span>
                )}
              </div>
            );
            return (
              <>
                {openPanels.map((p) => renderItem(p, true))}
                {openPanels.length > 0 && otherPanels.length > 0 && (
                  <div style={{ height: 1, background: "var(--border-light)", margin: "4px 8px" }} />
                )}
                {otherPanels.map((p) => renderItem(p, false))}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── 布局预设选择器（C 变体：预览弹层 + 确认框）──

/** 每个预设的迷你布局示意图（抽象色块：蓝=侧栏、绿=编辑器、紫=聊天、浅紫=技能） */
function PresetMini({ id }: { id: string }) {
  const cell = (color: string, flex: number, children?: React.ReactNode) => (
    <div
      style={{
        flex,
        background: color,
        minWidth: 0,
        display: "flex",
        ...(children ? { flexDirection: "column" as const } : {}),
      }}
    >
      {children}
    </div>
  );
  const inner = (color: string, flex: number) => (
    <div style={{ flex, background: color, width: "100%" }} />
  );
  if (id === "chat") {
    // 左栏(会话/技能) + 聊天
    return (
      <div style={{ display: "flex", height: "100%", width: "100%" }}>
        {cell("#4f8ef7", 15, <>
          {inner("#4f8ef7", 62)}
          {inner("#b07af7", 38)}
        </>)}
        {cell("#7c5cf0", 85)}
      </div>
    );
  }
  const map: Record<string, [string, number][]> = {
    default: [["#4f8ef7", 25], ["#34a853", 45], ["#7c5cf0", 30]],
    dense: [["#4f8ef7", 20], ["#34a853", 50], ["#7c5cf0", 30]],
  };
  return (
    <div style={{ display: "flex", height: "100%", width: "100%" }}>
      {(map[id] || map.default).map(([c, w]) => cell(c, w))}
    </div>
  );
}

/** 布局预设弹层的最大宽度（3 张 150px 预览卡 + gap + padding）。 */
const PRESET_MENU_WIDTH = 520;

/**
 * 工作区切换按钮（供 barItems 的 render 复用）。
 *
 * ⚠️ **不要把它做成固定渲染** —— 它的宽度随工作区名变化（maxWidth 175px），
 * 长名字（如 `claude-code-haha-dev`）会把右侧的窗口按钮**挤出可视区**
 * （实测 800px 窗口下三个按钮全部消失 → 用户失去控制窗口的手段）。
 * 做成可折叠项后，窄窗口下自动收进应用菜单。
 */
function WorkspaceButton({ workDir, fallbackLabel }: { workDir: string; fallbackLabel: string }) {
  const name = workspaceBasename(workDir);
  return (
    <button
      type="button"
      title={name ? workDir : fallbackLabel}
      aria-label={fallbackLabel}
      style={{
        ...btn(false),
        width: "auto",
        padding: "0 8px",
        gap: 5,
        maxWidth: 175,
      }}
      onClick={() => windowBus.emit(Events.WORKSPACE_OPEN_SELECTOR)}
    >
      <FolderOpen size={16} style={{ pointerEvents: "none", flexShrink: 0 }} />
      {name && (
        <span style={{
          fontSize: 11,
          color: "var(--fg-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 125,
        }}>
          {name}
        </span>
      )}
    </button>
  );
}

/** 预设预览网格 —— **下拉与居中浮层共用**（内容单一来源）。 */
function PresetGrid({ onPick }: { onPick: (p: (typeof LAYOUT_PRESETS)[number]) => void }) {
  return (
    <>
      {LAYOUT_PRESETS.map((p) => (
        <div
          key={p.id}
          onClick={() => onPick(p)}
          style={{
            width: 150,
            border: "1px solid var(--border-medium)",
            borderRadius: 8,
            padding: 6,
            cursor: "pointer",
            background: "transparent",
            fontFamily: "var(--font-sans)",
          }}
        >
          <div style={{ height: 70, borderRadius: 4, overflow: "hidden" }}>
            <PresetMini id={p.id} />
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 5, color: "var(--fg-primary)" }}>
            {t(p.nameKey)}
          </div>
          <div style={{ fontSize: 9, color: "var(--fg-muted)", marginTop: 1, lineHeight: 1.3 }}>
            {t(p.descKey)}
          </div>
        </div>
      ))}
    </>
  );
}

/** 应用预设的确认框（**居中模态**）—— 下拉与浮层共用。 */
function PresetConfirmDialog({
  preset,
  onClose,
}: {
  preset: (typeof LAYOUT_PRESETS)[number] | null;
  onClose: () => void;
}) {
  if (!preset) return null;
  return (
    <div
      {...DROPDOWN_MENU_ATTRS}
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
        style={{
          background: "var(--bg-root)",
          borderRadius: 10,
          padding: "18px 20px",
          width: 340,
          boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
          fontFamily: "var(--font-sans)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: "var(--fg-primary)" }}>
          {t("toolbar.layoutApplyTitle").replace("{name}", t(preset.nameKey))}
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 16, lineHeight: 1.5 }}>
          {t("toolbar.layoutApplyMsg")}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid var(--border-medium)",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              cursor: "pointer",
              background: "transparent",
              color: "var(--fg-primary)",
            }}
          >
            {t("toolbar.layoutCancel")}
          </button>
          <button
            type="button"
            onClick={() => { applyLayoutPreset(preset.id); onClose(); }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              borderRadius: 6,
              padding: "6px 14px",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              cursor: "pointer",
              background: "var(--accent)",
              color: "var(--fg-inverse)",
              fontWeight: 600,
            }}
          >
            {t("toolbar.layoutApply")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 工具栏上的**下拉形态**（按钮 + 下拉网格 + 确认框）。 */
function LayoutPresetDropdown() {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<(typeof LAYOUT_PRESETS)[number] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  // 弹层很宽（~520px）：按钮靠右时翻左展开；两边都放不下时靠 maxWidth 收缩
  const { align, maxWidth } = useDropdownAlign(ref, PRESET_MENU_WIDTH, open);

  return (
    <>
      <div ref={ref} style={{ position: "relative" }}>
        <button
          type="button"
          title={t("toolbar.layoutPicker")}
          aria-label={t("toolbar.layoutPicker")}
          style={btn(false)}
          onClick={() => setOpen(!open)}
        >
          <LayoutTemplate size={16} style={{ pointerEvents: "none" }} />
        </button>
        {open && (
          <div
            {...DROPDOWN_MENU_ATTRS}
            style={{
              position: "absolute",
              top: "100%",
              ...align,
              marginTop: 2,
              zIndex: 100,
              background: "var(--bg-root)",
              border: "1px solid var(--border-medium)",
              borderRadius: 10,
              boxShadow: "0 6px 20px rgba(0,0,0,0.15)",
              padding: 10,
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              maxWidth,
            }}
          >
            <PresetGrid onPick={(p) => { setConfirming(p); setOpen(false); }} />
          </div>
        )}
      </div>
      <PresetConfirmDialog preset={confirming} onClose={() => setConfirming(null)} />
    </>
  );
}

/**
 * 布局预设的**居中浮层形态** —— 工具栏折叠后从应用菜单进入时用。
 *
 * 为什么不是"把预设拆成菜单项"：那会让菜单膨胀（3 个预设 + 未来的预设都要占位），
 * 而用户点开菜单是想找**功能**，不是找某个预设的具体选项。一次点击进浮层、
 * 在浮层里完成选择，菜单只多 1 项。
 */
export function PresetPickerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [confirming, setConfirming] = useState<(typeof LAYOUT_PRESETS)[number] | null>(null);
  if (!open) return null;
  return (
    <>
      <div
        {...DROPDOWN_MENU_ATTRS}
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
          style={{
            background: "var(--bg-root)",
            border: "1px solid var(--border-medium)",
            borderRadius: 12,
            padding: 16,
            boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
            fontFamily: "var(--font-sans)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--fg-primary)" }}>
            {t("toolbar.layoutPicker")}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, maxWidth: 500 }}>
            <PresetGrid onPick={setConfirming} />
          </div>
        </div>
      </div>
      <PresetConfirmDialog preset={confirming} onClose={() => setConfirming(null)} />
    </>
  );
}

export default function Toolbar() {
  const [, setTick] = useState(0);
  const [isDark, setIsDark] = useState(() => isDarkTheme(document.documentElement.dataset.theme));

  // Red-dot badge when an update is available (set by startup/panel update check)
  const updateAvail = useEvent<UpdateAvailabilityPayload>(Events.UPDATE_AVAILABILITY_CHANGED);
  const hasUpdate = !!updateAvail?.hasUpdate;

  // Keep isDark in sync with the applied theme (startup restore, settings panel)
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDark(isDarkTheme(document.documentElement.dataset.theme));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    // 从亮切暗用默认暗色 B（dark，视觉等同 dark-b）；从暗切回亮恢复 light
    document.documentElement.dataset.theme = next ? "dark" : "light";
    updateSettings({ theme: next ? "dark" : "light" });
    void saveSettings({ theme: next ? "dark" : "light" }, "global").catch(() => {});
  };

  useEventHandler<LayoutTreeChangedPayload>(Events.LAYOUT_TREE_CHANGED, () => setTick((t) => t + 1));

  // Git 分支不在工具栏显示 —— 由 git-viewer 插件面板提供（真 git 命令 + 自动刷新）。
  // 旧实现读 .git/HEAD 且只在 workDir 变化时拉一次：切分支不更新、worktree 下失效，
  // 常驻显示错误分支比不显示更危险（2026-09-11 移除）。
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const workDir = settingsPayload?.settings?.workDir ?? "";
  const workspaceName = workspaceBasename(workDir);
  // Windows 用自绘标题栏（Rust 侧 decorations(false)）；mac 保留原生装饰。
  const chrome = isWindowsChrome();

  // Session name
  const chatPayload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = chatPayload?.state ?? getChatState();
  const sessionTitle = state.sessions.find((s) => s.id === state.sessionId)?.title ?? "";

  useEffect(() => {
    const u2 = layoutMode.subscribe(() => setTick((t) => t + 1));
    return () => { u2(); };
  }, []);

  // ── 应用菜单 + 响应式折叠（两套独立机制，最终汇入同一个菜单）──
  //
  //   ① `inMenuByDefault` —— **固定降级**：功能低频，就该待在菜单里，与窗口宽度无关
  //   ② 折叠 —— **被动降级**：窗口太窄放不下，从数组头开始依次折进菜单
  //
  // 数组顺序只影响 ②（靠前先折）。①的项不参与折叠计算（本来就不在工具栏）。
  //
  // 只收「简单动作按钮」——带自身弹出层的下拉组件（模型/权限/面板/布局预设/
  // 终端）不参与：塞进菜单会变成嵌套下拉，交互难看且易错。它们常驻工具栏。
  // 折叠后从菜单进入时打开的**居中浮层**（null = 没开）。
  // ⚠️ 不把弹层里的选项拆成菜单项 —— 那会让菜单随选项数量膨胀，而用户点开菜单
  // 是想找**功能**。一次点击进浮层、在浮层里完成选择，菜单只多 1 项。
  const [openModal, setOpenModal] = useState<null | "preset" | "guard">(null);
  /** 拖拽抓手的 hover 态（仅用于视觉反馈，不影响拖拽本身） */
  const [hoverGrip, setHoverGrip] = useState(false);

  const barItems: ToolbarItem[] = useMemo(() => [
    // ① 固定降级（永远在菜单里）
    { id: "theme", label: isDark ? t("toolbar.switchToLight") : t("toolbar.switchToDark"),
      icon: isDark ? <Sun size={14} /> : <Moon size={14} />, onClick: toggleTheme,
      inMenuByDefault: true },
    { id: "hardRefresh", label: t("toolbar.hardRefresh"),
      // 从快捷键注册表读 —— 唯一真相源。用户在设置里改了键，菜单提示自动跟随。
      shortcut: shortcutFor("app.hardRefresh"),
      icon: <RefreshCw size={14} />, onClick: () => window.location.reload(),
      inMenuByDefault: true },
    { id: "layoutMode", label: t("toolbar.layoutMode"), icon: <Grid3x3 size={14} />,
      onClick: () => layoutMode.toggle(), inMenuByDefault: true },
    // profile 管理不在这里 —— 已归入模型下拉（模型相关的设置聚在一处）
    { id: "update", label: t("update.title"), icon: <Download size={14} />,
      onClick: openUpdateFloat, hasBadge: hasUpdate, inMenuByDefault: true },
    // 帮助原先标着 shortcut: "F1" —— 但 F1 是**命令面板**不是帮助，是错误提示。
    // 快捷键表里也没有"帮助"这个功能，故不显示（显示错的比不显示更糟）。
    { id: "help", label: t("help.title"), icon: <HelpCircle size={14} />,
      onClick: openHelpFloat, inMenuByDefault: true },
    { id: "diagnostics", label: t("toolbar.diagnostics"), icon: <Stethoscope size={14} />,
      onClick: openDiagnosticsFloat, inMenuByDefault: true },
    { id: "feedback", label: t("feedback.title"), icon: <Bug size={14} />,
      onClick: openFeedbackFloat, inMenuByDefault: true },
    // ② 常驻（高频：很多人靠它快速开新窗口）——不进菜单、不参与折叠。
    //    用短标签「新实例」而非完整描述（完整描述留给 title 悬停提示）。
    { id: "newInstance", label: t("toolbar.newInstance"), shortLabel: t("toolbar.newInstanceShort"),
      title: t("toolbar.newInstance"), icon: <Copy size={14} />,
      onClick: spawnNewInstance, showLabel: true, alwaysVisible: true },
    // ③ 带自身弹层、但**允许折叠**的两项（用户要求：窄窗口下收进菜单腾出拖拽区）。
    //    与上面①的"固定降级"不同 —— 它们宽窗口下常驻工具栏，只在放不下时进菜单。
    //    ⚠️ 折叠后菜单里不能用 render（菜单项只支持 icon+onClick），
    //       故 menuItems 里另给「菜单形态」：布局预设 → 逐个预设；无人值守 → toggle。
    // onClick = **菜单态**（折叠进应用菜单后）：开居中浮层完成完整交互。
    // render  = **工具栏态**：直接用带自身弹层的组件（交互原样保留）。
    { id: "layoutPreset", label: t("toolbar.layoutPicker"), icon: <LayoutTemplate size={14} />,
      onClick: () => setOpenModal("preset"), render: () => <LayoutPresetDropdown /> },
    { id: "guard", label: t("guard.title"), icon: <Shield size={14} />,
      onClick: () => setOpenModal("guard"), render: () => <GuardButton /> },
    // 工作区切换器 —— 也做成**可折叠**：它的宽度随工作区名变化（最长 175px），
    // 长名字会把窗口按钮挤出可视区（实测 800px 窗口下溢出）。
    // 折叠后菜单项直接开工作区选择器（与点击按钮同效）。
    { id: "workspace", label: t("workspace.title"), icon: <FolderOpen size={14} />,
      onClick: () => windowBus.emit(Events.WORKSPACE_OPEN_SELECTOR),
      render: () => <WorkspaceButton workDir={workDir} fallbackLabel={t("workspace.title")} /> },
  ], [isDark, hasUpdate, toggleTheme]);

  const { containerRef, collapsed } = useToolbarCollapse(barItems);
  const { inBar, inMenu } = partitionItems(barItems, collapsed);

  // 菜单项直接用 partitionItems 的结果 —— 折叠的项自带正确的 onClick
  // （见 barItems 里两项：工具栏态走 render，菜单态走 onClick 开浮层）。
  const menuItems = inMenu;

  return (
    <div
      ref={containerRef}
      style={TOOLBAR_CONTAINER}
      {...(chrome ? { "data-tauri-drag-region": "deep" } : {})}
    >
      {/* 应用菜单入口（跨平台）：图标可点 → 弹出低频功能区。
          拖拽靠容器的 data-tauri-drag-region="deep" —— 子树内空白处都能拖，
          按钮天然阻止拖拽（Tauri drag.js 对 BUTTON 的处理），无需逐个排除。 */}
      <div data-toolbar-item="__appmenu">
        <AppMenu items={menuItems} hasBadge={hasUpdate} />
      </div>

      {groups.map(({ id, icon: Icon, key }) => (
        <button
          type="button"
          key={id}
          data-toolbar-item={`group-${id}`}
          title={t(key)}
          aria-label={t(key)}
          style={btn(isVisible(id))}
          onClick={() => id === "chat-split" ? toggleRightPanel() : id === "sidebar-left" ? toggleLeftColumn() : toggleGroupHidden(id)}
        >
          <Icon size={16} style={{ pointerEvents: "none" }} />
        </button>
      ))}
      {/* Workspace switcher — icon + bound workspace basename (hover = full path) */}
      <div style={TOOLBAR_DIVIDER} />

      {/* Command palette — 全局搜索入口 */}
      <button
        type="button"
        data-toolbar-item="__search"
        title={t("toolbar.commandPalette")}
        aria-label={t("toolbar.commandPalette")}
        style={btn(false)}
        onClick={() => windowBus.emit(Events.COMMAND_PALETTE_OPEN, { context: "global" })}
      >
        <Search size={15} style={{ pointerEvents: "none" }} />
      </button>

      {/* Middle area: 会话名 + **拖拽安全带**。
          flex:1 让它吸收剩余空间（宽窗口下这片空白就是拖窗口的抓手）；
          minWidth 保证**窄窗口下也不被压到 0** —— 否则空白消失，用户没有稳定的
          拖拽触发区（无装饰窗口下拖标题栏是移动窗口的主要手段）。
          `data-toolbar-flex` 供折叠算法识别并跳过（它是剩余空间的**吸收者**，
          实测宽度取决于折叠结果，计入 fixedWidth 会形成循环依赖）。 */}
      <div
        data-toolbar-flex="1"
        style={{ flex: 1, minWidth: DRAG_GUTTER_PX, display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}
      >
        {sessionTitle && (
          <span title={`Session: ${sessionTitle}`} style={{
            fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-secondary)",
            maxWidth: 200, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {sessionTitle}
          </span>
        )}
        {/* 拖拽抓手 —— **常驻可见标识**：明确告诉用户"这片区域能拖动窗口"。
            用户反馈"窄窗口下看不出哪里能拖"，光有空白不够，需要可见的提示。
            ⚠️ 不能加 tabindex/role —— Tauri 的 drag.js 会把带这些的元素判为
            clickable 并**阻断拖拽**（见其 isClickableElement）。当前写法
            （span + svg，无 tabindex）会被正确跳过，拖拽照常生效。 */}
        <span
          title={t("toolbar.dragRegionHint")}
          aria-hidden="true"
          onMouseEnter={() => setHoverGrip(true)}
          onMouseLeave={() => setHoverGrip(false)}
          style={{
            marginLeft: "auto",
            display: "flex", alignItems: "center",
            color: "var(--fg-secondary)",
            // 平时克制（不干扰会话名），鼠标移上去变亮 —— 让"这里能拖"的提示
            // 只在用户可能要用时才吸引注意。
            opacity: hoverGrip ? 1 : 0.45,
            cursor: "grab",
            transition: "opacity .15s ease",
            flexShrink: 0,
          }}
        >
          <GripHorizontal size={14} />
        </span>
      </div>

      {/* 可折叠项（未折叠的那些）。逐个渲染，带 data-toolbar-item 供折叠器实测宽度。
          放在此处（中间弹性区之后、核心控件之前）：折叠时右侧核心控件位置稳定，
          不会因为折叠而左右抖动。 */}
      {inBar.map((it) =>
        it.render ? (
          // 带自身弹层/交互的组件（布局预设的预览网格、无人值守的确认框）——
          // 直接用 render 输出组件本身，交互完全保留。
          // ⚠️ 折叠进菜单时不能这么干（菜单项只支持 icon+onClick），
          //    故这类项必须在 menuItems 里另给「菜单形态」（见下）。
          <div key={it.id} data-toolbar-item={it.id} style={{ display: "flex", flexShrink: 0 }}>
            {it.render()}
          </div>
        ) : (
        <button
          key={it.id}
          type="button"
          data-toolbar-item={it.id}
          title={it.title ?? it.label}
          aria-label={it.title ?? it.label}
          style={{
            ...btn(false),
            position: "relative",
            ...(it.showLabel ? { width: "auto", padding: "0 8px", gap: 5 } : {}),
          }}
          onClick={it.onClick}
        >
          <span style={{ pointerEvents: "none", display: "flex" }}>{it.icon}</span>
          {it.showLabel && (
            <span style={{ fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }}>
              {it.shortLabel ?? it.label}
            </span>
          )}
          {it.hasBadge && <ToolbarBadgeDot />}
        </button>
        ),
      )}

      <PermModeDropdown />
      {/* 系统终端：自带弹层（选终端类型），同样固定渲染 */}
      <TerminalDropdown />
      {/* 模型名 = 模型相关设置的统一入口：点开含 模型列表 / 思考 / 档位 / Profile 管理。
          这些设置重要但不常改，工具栏常态不提供切换交互、只显示当前模型名。 */}
      <ModelDropdown />
      <PanelDropdown />
      <button
        type="button"
        data-toolbar-item="__settings"
        title={t("toolbar.settings")}
        aria-label={t("toolbar.settings")}
        style={btn(false)}
        onClick={openSettingsFloat}
      >
        <Settings size={16} style={{ pointerEvents: "none" }} />
      </button>

      {/* 折叠后的居中浮层（应用菜单里点「布局预设」/「无人值守」进入） */}
      <PresetPickerModal open={openModal === "preset"} onClose={() => setOpenModal(null)} />
      <GuardConfirmDialog open={openModal === "guard"} onClose={() => setOpenModal(null)} />

      {/* 自绘窗口按钮（仅 Windows）。放最右且与工具栏按钮留有间距 ——
          Win11 的关闭按钮贴角，视觉上不该和功能按钮挤在一起。
          这三个永不折叠：无装饰窗口下失去它们 = 窗口无法控制。 */}
      {chrome && (
        <>
          <div style={{ width: 6, flexShrink: 0 }} />
          <WindowControls />
        </>
      )}
    </div>
  );
}
