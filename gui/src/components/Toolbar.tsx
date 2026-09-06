import { useEffect, useState, useRef, useCallback } from "react";
import { PanelLeft, PanelRight, PanelBottom, Settings, Grid3x3, Shield, Layers, Terminal, FolderOpen, LayoutTemplate, RefreshCw, User, Sun, Moon, Bug, Download, HelpCircle, Search, Stethoscope, Copy, Brain, Gauge } from "lucide-react";
import { getTree, findParentSplit, toggleGroupHidden, toggleRightPanel, addFloatingPanel, getFloatingPanels, bringFloatingToFront, findTabByPanelId, applyLayoutPreset, LAYOUT_PRESETS, togglePanelInTree, isPanelOpenInTree } from "../stores/layoutStore";
import { iconFor } from "../utils/icons";
import { getRecent, sortByRecent } from "../utils/recentUsage";
import { getChatState } from "../stores/chatStore";
import { GuardButton } from "./chat/GuardButton";
import { updateSettings, saveSettings } from "../stores/settingsStore";
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
} as const;

const btn = (active: boolean): React.CSSProperties => ({
  ...TOOLBAR_BTN_BASE,
  background: active ? "var(--bg-hover)" : "transparent",
  color: active ? "var(--fg-primary)" : "var(--fg-muted)",
});

// 布局模式按钮开启态：绿色身份色（与布局模式 chrome 一致）
const LM_ACCENT = "oklch(0.56 0.15 150)";
const lmBtn = (active: boolean): React.CSSProperties => ({
  ...TOOLBAR_BTN_BASE,
  background: active ? LM_ACCENT : "transparent",
  color: active ? "var(--fg-inverse)" : "var(--fg-muted)",
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
  padding: "4px 8px",
  borderBottom: "1px solid var(--border-light)",
  backgroundColor: "var(--bg-surface)",
  height: 36,
  flexShrink: 0,
} as const;

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

// ── Permission mode dropdown ──

function PermModeDropdown() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const mode = payload?.state?.permissionMode ?? getChatState().permissionMode ?? "default";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

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
        <div style={{ ...DROPDOWN_MENU_BASE, left: 0, minWidth: 220 }}>
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

// ── Thinking mode dropdown (3P reasoning-capable models: DeepSeek etc.) ──

function ThinkingDropdown() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = payload?.state ?? getChatState();
  const cap = state.modelCapabilities;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  // Only show for models that report thinking support (Claude `thinking` block
  // or 3P `reasoning` field). Hide while capabilities haven't arrived yet.
  if (!cap || (!cap.thinking && !cap.reasoning)) return null;

  const check = state.thinkingModeEnabled;
  const label = check ? t("toolbar.thinkingOn") : t("toolbar.thinkingOff");

  const options = [
    { id: true, label: t("toolbar.thinkingOn") },
    { id: false, label: t("toolbar.thinkingOff") },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        title={t("toolbar.thinkingMode")}
        style={{ ...btn(check), ...DROPDOWN_TRIGGER_BTN }}
        onClick={() => setOpen(!open)}
      >
        <Brain size={13} />
        <span>{label}</span>
        <span style={DROPDOWN_ARROW}>▼</span>
      </button>
      {open && (
        <div style={{ ...DROPDOWN_MENU_BASE, left: 0, minWidth: 140 }}>
          {options.map((o) => (
            <div
              key={String(o.id)}
              onClick={() => { commandRegistry.execute("SET_THINKING_MODE", { enabled: o.id, effort: state.effort ?? undefined }); setOpen(false); }}
              style={{
                ...DROPDOWN_ITEM_BASE,
                backgroundColor: o.id === check ? "var(--accent-subtle)" : "transparent",
                color: o.id === check ? "var(--accent)" : "var(--fg-primary)",
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Effort strength dropdown ──

function EffortDropdown() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = payload?.state ?? getChatState();
  const cap = state.modelCapabilities;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  // Only show when the model supports the effort parameter (or reasoning).
  if (!cap || !(cap.effort || cap.reasoning)) return null;

  const effort = state.effort;
  // Reasoning-capable providers (DeepSeek) accept low/high/max, not 'medium'
  // (Claude-native supports all four) — GUI decides the tiers, so drop medium.
  const baseLevels = cap.reasoning ? ["low", "high"] : ["low", "medium", "high"];
  const levels: Array<{ id: string }> = baseLevels.map((id) => ({ id }));
  if (cap.maxEffort) levels.push({ id: "max" });

  const current = levels.find((l) => l.id === (effort ?? cap.defaultEffort));
  const label = current ? t(`toolbar.effort_${current.id}`) : t("toolbar.effortAuto");

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        title={t("toolbar.effort")}
        style={{ ...btn(false), ...DROPDOWN_TRIGGER_BTN }}
        onClick={() => setOpen(!open)}
      >
        <Gauge size={13} />
        <span>{label}</span>
        <span style={DROPDOWN_ARROW}>▼</span>
      </button>
      {open && (
        <div style={{ ...DROPDOWN_MENU_BASE, left: 0, minWidth: 140 }}>
          {levels.map((l) => (
            <div
              key={l.id}
              onClick={() => { commandRegistry.execute("SET_EFFORT", l.id); setOpen(false); }}
              style={{
                ...DROPDOWN_ITEM_BASE,
                backgroundColor: l.id === (effort ?? cap.defaultEffort) ? "var(--accent-subtle)" : "transparent",
                color: l.id === (effort ?? cap.defaultEffort) ? "var(--accent)" : "var(--fg-primary)",
              }}
            >
              {t(`toolbar.effort_${l.id}`)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Model profile dropdown ──

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
        <div style={{ ...DROPDOWN_MENU_BASE, right: 0, minWidth: 180, maxHeight: 300, overflow: "auto" }}>
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
        </div>
      )}
    </div>
  );
}

// ── System terminal launcher ──

function NewInstanceButton() {
  async function openNew() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("spawn_gui_instance");
    } catch (e) {
      console.warn("spawn new instance failed:", e);
    }
  }
  return (
    <button
      type="button"
      title={t("toolbar.newInstance")}
      aria-label={t("toolbar.newInstance")}
      style={{ ...btn(false), ...DROPDOWN_TRIGGER_BTN }}
      onClick={openNew}
    >
      <Copy size={13} />
      <span style={{ marginLeft: 5, fontSize: 11, fontWeight: 500, whiteSpace: "nowrap" }}>{t("toolbar.newInstanceShort")}</span>
    </button>
  );
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
        <div style={{ ...DROPDOWN_MENU_BASE, right: 0, minWidth: 160 }}>
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
        <div style={{ ...DROPDOWN_MENU_BASE, right: 0, minWidth: 200 }}>
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

function LayoutPresetDropdown() {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<(typeof LAYOUT_PRESETS)[number] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

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
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              marginTop: 2,
              zIndex: 100,
              background: "var(--bg-root)",
              border: "1px solid var(--border-medium)",
              borderRadius: 10,
              boxShadow: "0 6px 20px rgba(0,0,0,0.15)",
              padding: 10,
              display: "flex",
              gap: 10,
            }}
          >
            {LAYOUT_PRESETS.map((p) => (
              <div
                key={p.id}
                onClick={() => { setConfirming(p); setOpen(false); }}
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
          </div>
        )}
      </div>
      {confirming && (
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
          onClick={() => setConfirming(null)}
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
              {t("toolbar.layoutApplyTitle").replace("{name}", t(confirming.nameKey))}
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 16, lineHeight: 1.5 }}>
              {t("toolbar.layoutApplyMsg")}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setConfirming(null)}
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
                onClick={() => { applyLayoutPreset(confirming.id); setConfirming(null); }}
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
      )}
    </>
  );
}

export default function Toolbar() {
  const [, setTick] = useState(0);
  const [gitBranch, setGitBranch] = useState<string>("");
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

  // Git branch — fetch when workDir changes
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const workDir = settingsPayload?.settings?.workDir ?? "";
  const workspaceName = workspaceBasename(workDir);
  useEffect(() => {
    if (!workDir) return;
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const branch: string = await invoke("get_git_branch", { path: workDir });
        if (!cancelled) setGitBranch(branch);
      } catch { if (!cancelled) setGitBranch(""); console.warn("Git branch fetch failed"); }
    })();
    return () => { cancelled = true; };
  }, [workDir]);

  // Session name
  const chatPayload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = chatPayload?.state ?? getChatState();
  const sessionTitle = state.sessions.find((s) => s.id === state.sessionId)?.title ?? "";

  useEffect(() => {
    const u2 = layoutMode.subscribe(() => setTick((t) => t + 1));
    return () => { u2(); };
  }, []);

  return (
    <div style={TOOLBAR_CONTAINER}>
      {groups.map(({ id, icon: Icon, key }) => (
        <button
          type="button"
          key={id}
          title={t(key)}
          aria-label={t(key)}
          style={btn(isVisible(id))}
          onClick={() => id === "chat-split" ? toggleRightPanel() : toggleGroupHidden(id)}
        >
          <Icon size={16} style={{ pointerEvents: "none" }} />
        </button>
      ))}
      {/* Workspace switcher — icon + bound workspace basename (hover = full path) */}
      <div style={TOOLBAR_DIVIDER} />
      <button
        type="button"
        title={workspaceName ? workDir : t("workspace.title")}
        aria-label={t("workspace.title")}
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
        {workspaceName && (
          <span style={{
            fontSize: 11,
            color: "var(--fg-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 125,
          }}>
            {workspaceName}
          </span>
        )}
      </button>
      {/* Command palette — 全局搜索入口 */}
      <button
        type="button"
        title={t("toolbar.commandPalette")}
        aria-label={t("toolbar.commandPalette")}
        style={btn(false)}
        onClick={() => windowBus.emit(Events.COMMAND_PALETTE_OPEN, { context: "global" })}
      >
        <Search size={15} style={{ pointerEvents: "none" }} />
      </button>
      <button
        type="button"
        title={t("toolbar.layoutMode")}
        aria-label={t("toolbar.layoutMode")}
        style={lmBtn(layoutMode.enabled)}
        onClick={() => layoutMode.toggle()}
      >
        <Grid3x3 size={16} style={{ pointerEvents: "none" }} />
      </button>
      <LayoutPresetDropdown />
      {/* Hard refresh */}
      <button
        type="button"
        title={t("toolbar.hardRefresh")}
        aria-label={t("toolbar.hardRefresh")}
        style={btn(false)}
        onClick={() => window.location.reload()}
      >
        <RefreshCw size={15} style={{ pointerEvents: "none" }} />
      </button>
      {/* Theme toggle */}
      <button
        type="button"
        title={isDark ? t("toolbar.switchToLight") : t("toolbar.switchToDark")}
        aria-label={isDark ? t("toolbar.switchToLight") : t("toolbar.switchToDark")}
        style={btn(false)}
        onClick={toggleTheme}
      >
        {isDark ? <Sun size={15} style={{ pointerEvents: "none" }} /> : <Moon size={15} style={{ pointerEvents: "none" }} />}
      </button>

      {/* Middle area: git branch + session name */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
        {gitBranch && (
          <span title={`Git: ${gitBranch}`} style={{
            fontSize: 11, color: "var(--fg-muted)", fontFamily: "var(--font-mono)",
            display: "flex", alignItems: "center", gap: 2,
            maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            <span style={{ color: "var(--fg-muted)" }}>⎇</span> {gitBranch}
          </span>
        )}
        {sessionTitle && (
          <span title={`Session: ${sessionTitle}`} style={{
            fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)",
            maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {sessionTitle}
          </span>
        )}
      </div>

      <PermModeDropdown />
      <ThinkingDropdown />
      <EffortDropdown />
      <ModelDropdown />
      <button
        type="button"
        title={t("toolbar.profileManage")}
        aria-label={t("toolbar.profileManage")}
        style={btn(false)}
        onClick={openProfileFloat}
      >
        <User size={15} style={{ pointerEvents: "none" }} />
      </button>
      <PanelDropdown />
      <TerminalDropdown />
      <NewInstanceButton />
      <button
        type="button"
        title={t("update.title")}
        aria-label={t("update.title")}
        style={{ ...btn(false), position: "relative" }}
        onClick={openUpdateFloat}
      >
        <Download size={15} style={{ pointerEvents: "none" }} />
        {hasUpdate && (
          <span style={{
            position: "absolute",
            top: 2,
            right: 2,
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: "var(--semantic-error)",
            border: "1.5px solid var(--bg-root)",
            pointerEvents: "none",
          }} />
        )}
      </button>
      <button
        type="button"
        title={t("help.title")}
        aria-label={t("help.title")}
        style={btn(false)}
        onClick={openHelpFloat}
      >
        <HelpCircle size={15} style={{ pointerEvents: "none" }} />
      </button>
      <button
        type="button"
        title={t("toolbar.diagnostics")}
        aria-label={t("toolbar.diagnostics")}
        style={btn(false)}
        onClick={openDiagnosticsFloat}
      >
        <Stethoscope size={15} style={{ pointerEvents: "none" }} />
      </button>
      <GuardButton />
      <button
        type="button"
        title={t("feedback.title")}
        aria-label={t("feedback.title")}
        style={btn(false)}
        onClick={openFeedbackFloat}
      >
        <Bug size={15} style={{ pointerEvents: "none" }} />
      </button>
      <button
        type="button"
        title={t("toolbar.settings")}
        aria-label={t("toolbar.settings")}
        style={btn(false)}
        onClick={openSettingsFloat}
      >
        <Settings size={16} style={{ pointerEvents: "none" }} />
      </button>
    </div>
  );
}
