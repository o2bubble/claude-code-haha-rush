// ── CommandPalette controller — 管理 open 状态 + 数据收集 + 执行动作 ──

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEvent, useEventHandler } from "../services/useService";
import { Events, type ChatStateChangedPayload, type LayoutTreeChangedPayload, type LayoutFloatingChangedPayload, type CommandPaletteOpenPayload } from "../services/events";
import { windowBus } from "../services/windowBus";
import { togglePanelInTree, isPanelOpenInTree } from "../stores/layoutStore";
import { getChatState } from "../stores/chatStore";
import { switchSession } from "./chat/useChatBridge";
import { ALL_PANEL_DEFS } from "../services/panelDefs";
import type { PaletteItem } from "../utils/commandPaletteLogic";
import { shouldOpenPalette } from "../utils/commandPaletteLogic";
import { buildPanelItems, buildCommandItems, buildSessionItems, type SkillI18n } from "../utils/commandPaletteItems";
import { buildEditorCommandItems } from "../utils/editorCommands";
import { recordRecent, getRecent, sortByRecent } from "../utils/recentUsage";
import { CATEGORIES } from "./chat/SettingsPanel";
import { crossWindowBus } from "../services/crossWindowBus";
import { openSettingsFloat } from "./Toolbar";
import { executePluginCommand } from "../services/pluginCommandBridge";
import { getActiveManifests, pluginCommandId } from "../services/pluginRegistry";
import { t } from "../i18n";

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<"editor" | "global">("global");
  const [initialQuery, setInitialQuery] = useState("");
  const [skillI18n, setSkillI18n] = useState<SkillI18n>({});

  // 加载技能翻译（与 SkillsPanel 同源），用于 AI 命令描述的国际化显示
  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const json: string = await invoke("load_skills_i18n");
        if (json) setSkillI18n(JSON.parse(json));
      } catch { /* 无翻译，保持原描述 */ }
    })();
  }, []);

  // 订阅 store 变更触发重算（面板、命令、会话）
  useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  useEvent<LayoutTreeChangedPayload>(Events.LAYOUT_TREE_CHANGED);
  useEvent<LayoutFloatingChangedPayload>(Events.LAYOUT_FLOATING_CHANGED);

  const chat = getChatState();

  const openPalette = useCallback((opts?: { context?: "editor" | "global"; query?: string }) => {
    setContext(opts?.context ?? "global");
    setInitialQuery(opts?.query ?? "");
    setOpen(true);
  }, []);

  // 监听外部触发（Monaco 快捷键、斜杠下拉、Toolbar）
  useEventHandler<CommandPaletteOpenPayload>(Events.COMMAND_PALETTE_OPEN, (payload) => {
    openPalette({ context: payload?.context, query: payload?.query });
  });

  // 全局 F1 / Ctrl+Shift+P 快捷键（编辑器外）。焦点在 Monaco 内时跳过，交给 Monaco 处理。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inMonaco = !!document.activeElement?.closest(".monaco-editor");
      if (!shouldOpenPalette(e, open, inMonaco)) return;
      e.preventDefault();
      openPalette({ context: "global" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, openPalette]);

  const close = useCallback(() => setOpen(false), []);

  const items = useMemo<PaletteItem[]>(() => {
    // 面板：最近使用排序，点击记录
    const panels: PaletteItem[] = sortByRecent(
      buildPanelItems(ALL_PANEL_DEFS, (panelId) => isPanelOpenInTree(panelId)),
      getRecent("panel"),
    ).map((p) => ({
      ...p,
      run: () => { recordRecent("panel", p.id); togglePanelInTree(p.id.replace("panel-", "")); },
    }));

    // AI 命令：最近使用排序，点击记录。插入带前导 / 的命令，固定插到输入框最前
    const commands: PaletteItem[] = sortByRecent(
      buildCommandItems(
        chat.slashCommands.filter((c) => c && c.cmd && (c.type === "prompt" || c.type === "skill")),
        skillI18n,
      ),
      getRecent("command"),
    ).map((c) => ({
      ...c,
      run: () => {
        recordRecent("command", c.id);
        const cmd = c.label.startsWith("/") ? c.label : "/" + c.label;
        windowBus.emit(Events.CHAT_INSERT_TEXT, { text: cmd + " ", atStart: true });
      },
    }));

    // 会话：最近使用排序，点击记录
    const sessions: PaletteItem[] = sortByRecent(
      buildSessionItems(chat.sessions, chat.sessionId),
      getRecent("session"),
    ).map((s) => ({
      ...s,
      run: () => { recordRecent("session", s.id); switchSession(s.id.replace("session-", "")); },
    }));

    // 设置项：打开设置面板并定位到对应分类（DataBus 跨窗口导航）
    const settings: PaletteItem[] = CATEGORIES.map((c) => ({
      id: `setting-${c.id}`,
      kind: "setting",
      label: t(c.i18nKey),
      sublabel: t("settings.title"),
      icon: "settings",
      run: () => {
        openSettingsFloat();
        // 浮动窗口创建是异步的（Tauri 建 webview），SettingsPanel 可能尚未挂载订阅。
        // 重试发布几次（state channel 无缓存，SettingsPanel 就绪后即收到；setCat 幂等）。
        const nav = () => crossWindowBus.publish("settings.navigate", { category: c.id });
        nav();
        const t1 = setTimeout(nav, 150);
        const t2 = setTimeout(nav, 350);
        void t1; void t2;
      },
    }));

    // 编辑器命令实时读取（无活动编辑器时为空数组）
    const editor = buildEditorCommandItems();

    // 插件命令：点按 → executePluginCommand（eventBus + crossWindowBus 双写）
    const pluginCmds: PaletteItem[] = getActiveManifests().flatMap((m) =>
      (m.contributes?.commands ?? []).map((c) => ({
        id: pluginCommandId(m.pluginName, c.id),
        kind: "plugin" as const,
        label: c.title || c.id,
        sublabel: `${m.displayName} · ${c.id}`,
        icon: "grid3x3",
        run: () => executePluginCommand(m.pluginName, c.id, c.onInvoke),
      })),
    );

    return [...panels, ...commands, ...sessions, ...settings, ...pluginCmds, ...editor];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.slashCommands, chat.sessions, chat.sessionId, skillI18n, open, context]);

  return { open, context, initialQuery, items, openPalette, close };
}
