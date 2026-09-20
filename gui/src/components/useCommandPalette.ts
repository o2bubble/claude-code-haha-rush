// ── CommandPalette controller — 管理 open 状态 + 数据收集 + 执行动作 ──

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEvent, useEventHandler } from "../services/useService";
import { Events, type ChatStateChangedPayload, type LayoutTreeChangedPayload, type LayoutFloatingChangedPayload, type CommandPaletteOpenPayload } from "../services/events";
import { windowBus, commandRegistry } from "../services/windowBus";
import { Commands } from "../services/commands";
import { togglePanelInTree, isPanelOpenInTree } from "../stores/layoutStore";
import { getChatState } from "../stores/chatStore";
import { switchSession } from "./chat/useChatBridge";
import { getAllPanels } from "../stores/panelRegistry";
import type { PaletteItem } from "../utils/commandPaletteLogic";
import { buildPanelItems, buildCommandItems, buildSessionItems, type SkillI18n } from "../utils/commandPaletteItems";
import { getSettings } from "../stores/settingsStore";
import type { SessionFolderTree } from "./chat/sessionFolders";
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
  // 🔴 面板注册表变化（装/卸/禁用插件时 registerPanel/rerenderPanel/unregisterPanel 都会 emit）。
  // 少了这一条，插件面板要等别的刷新才出现 —— 见下方 buildPanelItems 的数据源说明。
  useEvent(Events.PANEL_REGISTRY_CHANGED);

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

  // F1 / Ctrl+Shift+P 开面板 —— 键位由快捷键系统统一定义（services/shortcuts.ts），
  // 这里只注册**动作**。"已打开时不重复触发"这个状态知识必须留在此处 ——
  // 分发器不持有 `open`，交给它判会重复触发。
  // Monaco / 输入框的让位逻辑在分发器的 shouldDispatch 里统一处理。
  useEffect(() => {
    return commandRegistry.register(Commands.PALETTE_OPEN, () => {
      if (open) return;
      openPalette({ context: "global" });
    });
  }, [open, openPalette]);

  const close = useCallback(() => setOpen(false), []);

  const items = useMemo<PaletteItem[]>(() => {
    // 面板：最近使用排序，点击记录
    // 🔴 数据源用**运行时注册表** getAllPanels()，不是静态 ALL_PANEL_DEFS ——
    // 插件面板经 rerenderPanel() 注册进 Map，不在静态列表里。用静态列表会导致
    // 插件面板「在下拉里能开、在命令面板搜不到」（2026-09-18 修）。
    // 子窗口（FloatingApp）里两者等价：那边只 forEach ALL_PANEL_DEFS 注册。
    const panels: PaletteItem[] = sortByRecent(
      buildPanelItems(getAllPanels(), (panelId) => isPanelOpenInTree(panelId)),
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
    // 文件夹功能开启时传 tree → 有归属的会话在名称前显示层级路径
    const st = getSettings();
    const sessionFolderTree: SessionFolderTree | undefined =
      st.sessionFolders ? (st.sessionFolderTree ?? { folders: [], assignments: {} }) : undefined;
    const sessions: PaletteItem[] = sortByRecent(
      buildSessionItems(chat.sessions, chat.sessionId, sessionFolderTree),
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
