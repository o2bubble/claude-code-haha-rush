import { useEffect, useRef, useState } from "react";
import LayoutRenderer from "./components/LayoutRenderer";
import FloatingRenderer from "./components/FloatingRenderer";
import ContextMenu, { showCtxMenu } from "./components/ContextMenu";
import Toolbar from "./components/Toolbar";
import StatusBar from "./components/StatusBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WorkspaceSelector } from "./components/chat/WorkspaceSelector";
import { WelcomeWizard, type WizardSettings } from "./components/chat/WelcomeWizard";
import { registerPanel } from "./stores/panelRegistry";
import { reloadPlugins } from "./services/pluginRegistry";
import { startPluginProcessListener } from "./services/pluginProcessBridge";
import { ALL_PANEL_DEFS } from "./services/panelDefs";
import { getSettings, loadSettings, reloadSettings, saveSettings, updateSettings } from "./stores/settingsStore";
import { workspaceBasename } from "./utils/workspace";
import { normalizeTheme, isDarkTheme } from "./utils/themeUtils";
import { resolveLinkAction, isNavigableHref } from "./utils/linkOpen";
import { setLanguage, t } from "./i18n";
import { windowBus } from "./services/windowBus";
import { Events, type BackendStateChangedPayload } from "./services/events";
import { BackendService } from "./services/backendService";
import { startSessionStatusSync } from "./services/sessionStatusSync";
import { commandRegistry } from "./services/windowBus";
import { Commands } from "./services/commands";
import { toggleGroupHidden, restoreLayout, serializeLayout, getSkipSave, refreshAllTitles, activatePanel } from "./stores/layoutStore";
import { openSettingsFloat, openHelpFloat, openDiagnosticsFloat } from "./components/Toolbar";
import { useEventHandler } from "./services/useService";
import { addStatusMessage } from "./stores/statusMsgStore";
import CommandPalette from "./components/CommandPalette";
import { useCommandPalette } from "./components/useCommandPalette";
import ToastContainer from "./components/ToastContainer";
import { reloadDesktops } from "./stores/desktopStore";
import { loadSessionList, loadMorePlans, resetPagination } from "./stores/planHistoryStore";
import { chatSession } from "./chat/chatSession";

let _bridgeStarted = false;
/** 启动动画时间线: 1.5s 打字 + 0.3s 停顿 → 1.8s 点亮叙事点+镜头展开 → +0.5s 过渡完成 (~2.3s) */
const IGNITE_MS = 1800;
const LEAVE_MS = 1800;
const EXIT_MS = 500;
// Serialized signature of the last layout actually persisted (or restored).
// The save hook skips when the tree is unchanged — so a second instance bound
// to the same workspace can't re-write its stale layout over this instance's
// (multi-instance same-workspace clobber).
let lastPersistedLayout: string | null = null;

export default function App() {
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);
  const [showWelcomeWizard, setShowWelcomeWizard] = useState(false);
  const [workspaceList, setWorkspaceList] = useState<string[]>([]);
  const [langKey, setLangKey] = useState(0);
  const needShowHelp = useRef(false);

  // ── App ready state: settings loaded → show UI (backend status in StatusBar) ──
  const [appReady, setAppReady] = useState(false);
  const [uiFontSize, setUiFontSize] = useState<number>(100);

  // ── 后端启动失败/超时 → 自动打开诊断面板（浮动窗口，防抖 + 已打开则跳过）──
  const autoDiagAtRef = useRef(0);
  useEffect(() => {
    return windowBus.on(Events.BACKEND_STATE_CHANGED, (data: BackendStateChangedPayload) => {
      if (data.status !== "error") return;
      const now = Date.now();
      if (now - autoDiagAtRef.current < 5000) return; // 连续失败防抖
      autoDiagAtRef.current = now;
      // 浮动面板（与工具栏入口一致）——启动失败是"打断式"场景，不占用主布局
      openDiagnosticsFloat();
    });
  }, []);

  // ── 跨 GUI 数据同步：server 下推 db_changed → 本 GUI refetch（仅他 GUI 的变更）──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    import("@tauri-apps/api/event")
      .then(({ listen }) => {
        if (!alive) return;
        listen("server:data-changed", (e: any) => {
          const change = e?.payload as { entity?: string } | undefined;
          if (change?.entity === "desktop") {
            void reloadDesktops();
          } else if (change?.entity === "plan") {
            // 刷新计划历史时间线 + 计划记录（跨 GUI 另一实例改了计划）
            resetPagination();
            void loadSessionList();
            void loadMorePlans();
          } else if (change?.entity === "note") {
            windowBus.emit(Events.NOTES_CHANGED, {});
          } else if (change?.entity === "session") {
            chatSession.listSessions();
          } else if (change?.entity === "settings") {
            void reloadSettings();
          }
        }).then((un) => {
          if (alive) unlisten = un;
          else un();
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // ── 外部链接全局拦截：左键→内置窗口；Ctrl/Cmd/中键→系统浏览器；右键→菜单 ──
  // http(s) 绝对链接裁决由 resolveLinkAction 负责；相对/绝对路径 href 会导航走 app，
  // 一律 preventDefault（GUI 防替换另有 Rust on_navigation 守卫兜底）。
  useEffect(() => {
    const findAnchor = (e: MouseEvent): HTMLAnchorElement | null =>
      (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;

    const openUrlInWindow = (url: string) => {
      import("@tauri-apps/api/core").then(({ invoke }) =>
        void invoke("open_url_window", { url }).catch((err) =>
          console.error("[linkOpen] open_url_window failed:", err)
        )
      );
    };
    const openUrlInBrowser = (url: string) => {
      import("@tauri-apps/plugin-shell").then(({ open }) =>
        void open(url).catch((err) =>
          console.error("[linkOpen] open browser failed:", err)
        )
      );
    };

    const handleClick = (e: MouseEvent) => {
      const anchor = findAnchor(e);
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      const action = resolveLinkAction(href, {
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        middle: false,
        right: false,
      });
      if (action.kind === "ignore") {
        // 非 http(s)：相对/绝对路径仍会触发顶层导航 → 拦截防 GUI 被替换
        if (isNavigableHref(href)) e.preventDefault();
        return;
      }
      e.preventDefault();
      if (action.kind === "open_window") openUrlInWindow(action.url);
      else if (action.kind === "open_browser") openUrlInBrowser(action.url);
    };

    // 中键不触发 click，只触发 auxclick（button === 1）
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return;
      const anchor = findAnchor(e);
      if (!anchor) return;
      const action = resolveLinkAction(anchor.getAttribute("href"), {
        ctrl: false,
        meta: false,
        middle: true,
        right: false,
      });
      if (action.kind !== "open_browser") return;
      e.preventDefault();
      openUrlInBrowser(action.url);
    };

    // 捕获阶段 + stopPropagation：链接右键显示链接菜单，不落入内层组件自己的菜单
    const handleContextMenu = (e: MouseEvent) => {
      const anchor = findAnchor(e);
      if (!anchor) return;
      const action = resolveLinkAction(anchor.getAttribute("href"), {
        ctrl: false,
        meta: false,
        middle: false,
        right: true,
      });
      if (action.kind !== "context_menu") return;
      e.preventDefault();
      e.stopPropagation();
      const url = action.url;
      showCtxMenu(e.clientX, e.clientY, [
        { label: t("linkOpen.openWindow"), action: () => openUrlInWindow(url) },
        { label: t("linkOpen.openBrowser"), action: () => openUrlInBrowser(url) },
        { separator: true },
        {
          label: t("linkOpen.copyLink"),
          action: () => {
            void navigator.clipboard.writeText(url).catch(() => {});
          },
        },
      ]);
    };

    document.addEventListener("click", handleClick, true);
    document.addEventListener("auxclick", handleAuxClick, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("auxclick", handleAuxClick, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
    };
  }, []);

  // ── 启动动画时间线: splash(打字+停顿) → ignite(点亮叙事点) → leaving(镜头展开) → done ──
  // appReady 提前就绪时补齐到对应时间点, 慢就绪时立即推进
  const [phase, setPhase] = useState<"splash" | "ignite" | "leaving" | "done">("splash");
  const splashStartRef = useRef(Date.now());
  useEffect(() => {
    if (!appReady || phase === "done") return;
    const elapsed = Date.now() - splashStartRef.current;
    const delay =
      phase === "splash" ? Math.max(0, IGNITE_MS - elapsed)
      : phase === "ignite" ? Math.max(0, LEAVE_MS - elapsed)
      : EXIT_MS;
    const t = setTimeout(() => {
      setPhase(phase === "splash" ? "ignite" : phase === "ignite" ? "leaving" : "done");
    }, delay);
    return () => clearTimeout(t);
  }, [appReady, phase]);

  // ── Command palette ──
  const { open: cpOpen, context: cpContext, initialQuery: cpQuery, items: cpItems, close: cpClose } = useCommandPalette();

  useEffect(() => {
    loadSettings().then((s) => {
      // Restore persisted layout before anything else
      if (s.layoutTree) {
        try {
          restoreLayout(s.layoutTree);
          lastPersistedLayout = JSON.stringify(serializeLayout());
        } catch { /* corrupted — keep default */ }
      }

      if (s.language) setLanguage(s.language);

      setUiFontSize(s.uiFontSize ?? 100);

      // Apply persisted theme (defaults to light when unset; invalid values fall back)
      document.documentElement.dataset.theme = normalizeTheme(s.theme);

      // Seed JS memory with current window state so saveSettings() never
      // writes null. Window state restore is handled by Rust in setup().
      if (!s.windowWidth || !s.windowHeight) {
        import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
          const w = getCurrentWindow();
          Promise.all([
            w.innerSize(),
            w.outerPosition(),
            w.isMaximized(),
          ]).then(([size, pos, maximized]) => {
            // pos can be Windows' off-screen sentinel (-32000,-32000) while the OS
            // hasn't placed the window yet. Persisting it hides the GUI on the next
            // launch (Rust restores the sentinel). Only record an on-screen position;
            // otherwise leave it null so Rust centers the window.
            const posOk = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.x > -30000 && pos.y > -30000;
            s.windowWidth = size.width;
            s.windowHeight = size.height;
            s.windowX = posOk ? pos.x : undefined;
            s.windowY = posOk ? pos.y : undefined;
            s.windowMaximized = maximized;
            import("@tauri-apps/api/core").then(({ invoke }) => {
              invoke("save_window_state", {
                width: size.width, height: size.height,
                x: posOk ? pos.x : null, y: posOk ? pos.y : null, maximized,
              }).catch(() => {});
            }).catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
      }

      if (s.isFirstLaunch) {
        // Show welcome wizard before workspace selector
        setShowWelcomeWizard(true);
        setAppReady(true);
      } else {
        // Existing user — go straight to workspace selector, unless this
        // instance was launched with --workspace (bind directly, skip selector),
        // or auto-enter-recent-workspace is on and a workspace was recorded.
        const enterWorkspace = (ws: string) => {
          const merged = [ws, ...(s.workspaces ?? [])].filter((w, i, a) => a.indexOf(w) === i);
          setWorkspaceList(merged);
          setAppReady(true);
          void handleWorkspaceLaunch(ws, merged);
        };
        const showSelector = () => {
          setWorkspaceList(s.workspaces);
          setShowWorkspaceSelector(true);
          setAppReady(true);
        };
        const autoEnterOrSelector = () => {
          const recent = s.recentWorkspaces?.[0];
          if (s.autoEnterRecentWorkspace && recent) {
            enterWorkspace(recent);
          } else {
            showSelector();
          }
        };
        const launchNormal = () => {
          import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke<string | null>("get_cli_workspace").then((cliWs) => {
              if (cliWs) enterWorkspace(cliWs);
              else autoEnterOrSelector();
            }).catch(() => autoEnterOrSelector())
          ).catch(() => autoEnterOrSelector());
        };
        import("@tauri-apps/api/core").then(({ invoke }) => {
          // Intent mode runs first — it replaces landing / cli-ws entirely.
          invoke<boolean>("get_startup_intent_mode").then((intentMode) => {
            if (intentMode) {
              invoke<string | null>("get_startup_intent_id").then((intentId) => {
                void handleIntentLaunch(intentId ?? "");
              });
            } else {
              launchNormal();
            }
          }).catch(() => launchNormal());
        }).catch(() => launchNormal());
      }
    });
    return windowBus.on(Events.LANGUAGE_CHANGED, () => setLangKey((k) => k + 1));
  }, []);

  // ── Wizard completion: persist settings → show workspace selector ──
  async function handleWizardComplete(ws: WizardSettings) {
    const s = getSettings();
    s.language = ws.language;
    s.uiFontSize = ws.uiFontSize;
    s.forceChineseThinking = ws.forceChineseThinking;
    s.autoEnterRecentWorkspace = ws.autoEnterRecentWorkspace;
    s.isFirstLaunch = false;

    // Apply server profile
    const serverUrl = ws.serverProfile === "intranet"
      ? "http://192.168.186.96:8765"
      : "http://123.56.66.84:8765";
    s.skillRegistryUrl = serverUrl;
    s.updateServerUrl = serverUrl;
    // Wizard runs before a workspace is bound — these are global baseline fields,
    // so write them globally (a default workspace-scoped save would be skipped).
    await saveSettings(s, "global");
    setLanguage(s.language);
    setUiFontSize(s.uiFontSize ?? 100);

    // Switch profile if user selected/created one during wizard
    if (ws.selectedProfileId) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("switch_model_profile", { profileId: ws.selectedProfileId });
      } catch { /* profile switch is best-effort at this stage */ }
    }

    needShowHelp.current = true;
    setShowWelcomeWizard(false);
    setWorkspaceList(s.workspaces);
    setShowWorkspaceSelector(true);
  }

  // ── Called when user picks a workspace and clicks "Launch" ──
  async function handleWorkspaceLaunch(workDir: string, wss: string[]) {
    const s = getSettings();
    s.workDir = workDir;
    s.isFirstLaunch = false;
    // Persist the workspace LIST globally (baseline). The single workDir is no
    // longer a global value — each instance binds its own workspace.
    await saveSettings({ workspaces: wss, isFirstLaunch: false }, "global");
    updateSettings({ workDir, workspaces: wss, isFirstLaunch: false });
    setLanguage(s.language);

    // Show the bound workspace in the window title so multi-instance windows
    // are distinguishable in the taskbar / Alt-Tab.
    const basename = workspaceBasename(workDir);
    if (basename) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(`Claude Code Desktop (Preview) — ${basename}`);
      } catch { /* non-Tauri / ignore */ }
    }
    // Enter the workspace immediately — the backend starts asynchronously and
    // reports progress via the StatusBar message log + chat banner (non-blocking).
    setShowWorkspaceSelector(false);

    // Start DataBus + Bridge + MCP FIRST — the JS MCP bridge must be handling
    // requests before the backend connects to it (Rust also probes MCP readiness
    // before spawning the backend, so this ordering is belt-and-suspenders).
    if (!_bridgeStarted) {
      _bridgeStarted = true;
      import("./services/crossWindowBusHub").then((m) => m.startCrossWindowBusHub());
      import("./services/bridge").then((m) => m.bridge.startHub());
      import("./services/mcpBridge").then((m) => m.startMcpBridge());
      import("./services/guardBridge").then((m) => m.subscribeGuardActions());
      // Auto-open help panel once after wizard completion
      if (needShowHelp.current) {
        needShowHelp.current = false;
        setTimeout(() => openHelpFloat(), 2000);
      }
    }

    void BackendService.bind(workDir);

    // 跨 GUI 会话状态同步：上报本实例激活会话 + 订阅其他实例状态（server 通道）
    startSessionStatusSync(workDir);

    // Background update check (5s delay, non-blocking, silent on error).
    // Result drives the toolbar red-dot badge via setUpdateAvailability.
    setTimeout(() => {
      import("./services/updateService").then(({ updateService, setUpdateAvailability, hasRealUpdate }) => {
        updateService.checkForUpdates().then((result) => {
          const hasUpdates = hasRealUpdate(result.components);
          setUpdateAvailability(hasUpdates, result.version);
          if (hasUpdates) {
            addStatusMessage(t("update.updatesAvailable", { version: result.version }), "info");
          }
        }).catch(() => { /* silent fail — don't bother user */ });
      }).catch(() => {});
    }, 5000);
  }

  // ── Startup intent (--intent <id>) ──
  // Launched with --intent: skip landing, claim the intent on the server, bind
  // the workspace the payload names, execute the kind (open_session / focus_panel),
  // then ack. On any failure degrade to the workspace selector + a toast.
  const intentHandledRef = useRef(false);

  // Poll `fn` until it returns truthy (up to `attempts` × `gapMs`) — shared by
  // the backend-ready wait and the claim-on-server wait.
  async function retryUntil(fn: () => Promise<any>, attempts = 40, gapMs = 300): Promise<any> {
    for (let i = 0; i < attempts; i++) {
      try {
        const v = await fn();
        if (v) return v;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, gapMs));
    }
    return null;
  }

  async function runIntent(kind: string, payload: any, intentId: string) {
    const ack = (result: any) => {
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("ack_startup_intent", { intentId, result }).catch(() => {}));
    };
    if (kind === "open_session" && payload.session_id) {
      const sessId = payload.session_id as string;
      // §6.2: wait for the session list to be loaded before resolving a session.
      const ready = await retryUntil(async () => {
        const { getChatState } = await import("./stores/chatStore");
        return getChatState().sessionsLoaded;
      });
      if (!ready) {
        ack({ ok: false, kind, error: "sessions never loaded" });
        return;
      }
      import("./components/chat/useChatBridge").then(({ launchIntentSession, setIntentTargeted, requestSessionList }) => {
        requestSessionList();
        launchIntentSession(sessId);   // 一步打开目标，不先切最近
        setIntentTargeted(false);      // 目标已指定并加载，释放抑制
        ack({ ok: true, kind, session_id: sessId });
      }).catch(() => ack({ ok: false, kind, error: "no bridge" }));
    } else if (kind === "focus_panel" && payload.panel_id) {
      activatePanel(payload.panel_id as string);
      ack({ ok: true, kind, panel_id: payload.panel_id });
    } else {
      ack({ ok: false, kind, error: "unknown kind or missing id" });
    }
  }

  async function handleIntentLaunch(intentId: string) {
    if (intentHandledRef.current) return;
    intentHandledRef.current = true;
    setShowWorkspaceSelector(false);
    setAppReady(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Claim on the server (which Rust pre-ensured). Retry briefly: the server
      // may still be spawning / the claim may race another instance.
      const rec = await retryUntil(async () => {
        const r = await invoke<any>("claim_startup_intent", { intentId }).catch(() => null);
        return r ? (r.payload ?? r) : null;
      });
      const payload = rec?.payload ?? rec;
      if (!payload) {
        addStatusMessage("意图未兑现（server 不可用或意图已失效）", "warn");
        setShowWorkspaceSelector(true);
        return;
      }
      const ws = payload.workspace as string | undefined;
      const kind = payload.kind as string;
      // open_session 意图：提前标记目标会话，抑制 backend connect 后 session_list
      // 到达时的"自动加载最近会话"——否则新实例先切最近、再被 runIntent 切目标，
      // 造成两次跳变（应一步到位）。必须在 bind/connect 之前设置。
      if (kind === "open_session") {
        import("./components/chat/useChatBridge").then(({ setIntentTargeted }) => setIntentTargeted(true));
      }
      // Bind the workspace the intent names (starts the backend). Reuse the
      // normal launch path so the bridge/data-layer setup is identical.
      if (ws) {
        const cs = getSettings();
        const merged = [ws, ...(cs.workspaces ?? [])].filter((w: string, i: number, a: string[]) => a.indexOf(w) === i);
        setWorkspaceList(merged);
        await handleWorkspaceLaunch(ws, merged);
      }
      await runIntent(kind, payload, intentId);
    } catch (e) {
      addStatusMessage("意图未兑现", "warn");
      setShowWorkspaceSelector(true);
    }
  }

  // Listen for UI font size changes
  useEventHandler<{ settings: { uiFontSize?: number } }>(Events.SETTINGS_CHANGED, (data) => {
    setUiFontSize(data.settings.uiFontSize ?? 100);
  });

  // Listen for workspace switch request from SettingsPanel
  useEventHandler(Events.WORKSPACE_OPEN_SELECTOR, () => {
    const s = getSettings();
    setWorkspaceList(s.workspaces.length > 0 ? s.workspaces : (s.workDir ? [s.workDir] : []));
    setShowWorkspaceSelector(true);
  });

  // Register global commands
  useEffect(() => {
    const unregs: (() => void)[] = [];

    unregs.push(commandRegistry.register(Commands.LAYOUT_TOGGLE_LEFT, () => toggleGroupHidden("sidebar-left")));
    unregs.push(commandRegistry.register(Commands.LAYOUT_TOGGLE_RIGHT, () => toggleGroupHidden("chat-split")));
    unregs.push(commandRegistry.register(Commands.LAYOUT_TOGGLE_BOTTOM, () => toggleGroupHidden("bottom-panel")));
    unregs.push(commandRegistry.register(Commands.SETTINGS_OPEN, () => openSettingsFloat()));
    unregs.push(commandRegistry.register(Commands.BACKEND_RESTART, () => BackendService.restart()));

    return () => unregs.forEach((fn) => fn());
  }, []);

  // ── Layout persistence: debounced save on layout changes ──
  useEffect(() => {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (getSkipSave()) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
          const sig = JSON.stringify(serializeLayout());
          // Skip when nothing actually changed — a stale sibling instance bound
          // to the same workspace would otherwise re-write its old layout over
          // this instance's (multi-instance same-workspace clobber).
          if (sig === lastPersistedLayout) return;
          // Layout is workspace-scoped — each workspace restores its own layout.
          // FLOATING_CHANGED also carries tauriWindows, so sub-window add/remove
          // persists too (not just tree edits).
          const layout = serializeLayout();
          await saveSettings({ layoutTree: layout }, "workspace");
          // "保存布局到全局" — also mirror the layout into the global baseline so
          // workspaces without their own layout fall back to it.
          if (getSettings().saveLayoutToGlobal) {
            await saveSettings({ layoutTree: layout }, "global");
          }
          lastPersistedLayout = sig;
        } catch { /* Tauri not available */ }
      }, 1000);
    };
    const offTree = windowBus.on(Events.LAYOUT_TREE_CHANGED, schedule);
    const offFloating = windowBus.on(Events.LAYOUT_FLOATING_CHANGED, schedule);
    return () => { offTree(); offFloating(); };
  }, []);

  useEffect(() => {
    ALL_PANEL_DEFS.forEach(registerPanel);
    // The default layout was built at module load before panels registered, so
    // its tab titles are English panel ids. Refresh titles now that the registry
    // is populated — a layout-less workspace would otherwise keep English labels.
    refreshAllTitles();
    // 插件面板注册：reloadPlugins（单一入口：scan→setActiveManifests→registerPluginPanels
    // →事件转发→进程刷新）。异步, 不阻塞注册点; 插件面板在注册后自动进布局。
    void (async () => {
      await reloadPlugins();
      // T3: 启动插件进程状态监听(kill/restart/崩溃的 plugin-process-status 回收) —— 一次性
      await startPluginProcessListener();
      // 插件面板注册晚于布局恢复时, 标题可能仍是持久化值 → 再刷新一次收敛
      refreshAllTitles();
    })();
  }, []);

  // Restore the bound workspace's layout as soon as bind_workspace returns —
  // do NOT wait for the IDE backend to finish booting (that's seconds). WORKSPACE_BOUND
  // is sticky, so a listener registered after the event still receives it.
  useEffect(() => {
    return windowBus.on(Events.WORKSPACE_BOUND, () => {
      reloadSettings()
        .then((s) => {
          if (s.layoutTree) {
            restoreLayout(s.layoutTree);
            lastPersistedLayout = JSON.stringify(serializeLayout());
          }
        })
        .catch(() => {});
      // T3: 绑定工作区后启动插件声明的后台进程(决策#6 startOn=workspace_bound)。
      // 走 syncPluginProcesses 单一入口——与重扫共用"哪些该跑"的判定(幂等,
      // 已在跑的不重启; 未绑定时它自己会跳过, 这里是绑定后的实际拉起点)。
      void (async () => {
        try {
          const { syncPluginProcesses } = await import("./services/pluginProcessBridge");
          await syncPluginProcesses();
        } catch (e) {
          console.warn("[App] 启动插件后台进程失败:", e);
        }
      })();
    });
  }, []);

  // ── Highlight.js theme manager ──
  useEffect(() => {
    const applyHljsTheme = async () => {
      const isDark = isDarkTheme(document.documentElement.dataset.theme);
      if (isDark) {
        await import("highlight.js/styles/github-dark.min.css");
      } else {
        await import("highlight.js/styles/github.min.css");
      }
    };
    applyHljsTheme();
    const obs = new MutationObserver(applyHljsTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Set --font-scale CSS variable (100% = scale 1.0)
  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", (uiFontSize / 100).toFixed(2));
  }, [uiFontSize]);

  // ── Persist window state on resize/move (debounced) ──
  // Window state RESTORE happens in Rust setup() — before the window is shown.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function persistWindowState() {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        const [size, pos, maximized] = await Promise.all([
          w.innerSize(),
          w.outerPosition(),
          w.isMaximized(),
        ]);
        const s = getSettings();
        const posOk = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.x > -30000 && pos.y > -30000;
        s.windowWidth = size.width;
        s.windowHeight = size.height;
        s.windowX = posOk ? pos.x : undefined;
        s.windowY = posOk ? pos.y : undefined;
        s.windowMaximized = maximized;
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_window_state", {
          width: size.width, height: size.height,
          x: maximized || !posOk ? null : pos.x,
          y: maximized || !posOk ? null : pos.y,
          maximized,
        }).catch(() => {});
      } catch {}
    }

    function scheduleSave() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persistWindowState, 500);
    }

    window.addEventListener("resize", scheduleSave);

    // Tauri onMoved for position tracking
    let unlistenMove: (() => void) | undefined;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().onMoved(() => scheduleSave()).then((fn) => { unlistenMove = fn; });
    }).catch(() => {});

    return () => {
      window.removeEventListener("resize", scheduleSave);
      unlistenMove?.();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ── Loading overlay — 品牌打字机启动动画 + 镜头展开叙事点 ──
  const splashOverlay = (
    <div
      className={phase === "leaving" ? "splash-exit" : undefined}
      style={{
        position: "fixed", inset: 0, zIndex: 99999,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        backgroundColor: "var(--bg-root)",
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
      }}
    >
      {/* 点阵网格背景 */}
      <div style={{
        position: "absolute", inset: -40,
        backgroundImage: "radial-gradient(var(--grid-dot) 1px, transparent 1px)",
        backgroundSize: "22px 22px", opacity: 0.65, pointerEvents: "none",
      }} />
      {/* 品牌名 — 打字机逐字打出; ignite/leaving 时 accent 点亮叙事点 */}
      <div
        className={phase === "ignite" || phase === "leaving" ? "splash-ignite" : undefined}
        style={{
          position: "relative", display: "flex", alignItems: "center",
          fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 700,
          letterSpacing: 1, color: "var(--fg-primary)",
        }}
      >
        <span style={{
          overflow: "hidden", whiteSpace: "nowrap", width: 0,
          // forwards: 播完保持全字，末尾停顿期间不回到空（不回播）
          animation: "app-typing 1.5s steps(11) forwards",
        }}>
          <span style={{ color: "var(--accent)" }}>Claude</span> Code
        </span>
        <span style={{
          width: 2, height: 26, background: "var(--accent)", marginLeft: 2,
          animation: "app-blink 0.8s step-end infinite",
        }} />
      </div>
      {/* 副标题 */}
      <div style={{
        position: "relative", marginTop: 14, fontSize: 11,
        color: "var(--fg-muted)", letterSpacing: 2, textTransform: "uppercase",
        opacity: 0, animation: "app-fadein 1.5s forwards",
      }}>
        {t("common.loadingSubtitle")}
      </div>
    </div>
  );

  if (phase === "splash" || phase === "ignite") {
    return splashOverlay;
  }

  return (
    <>
      <div
        key={langKey}
        className={phase === "leaving" ? "app-enter" : undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflow: "hidden",
          backgroundColor: "var(--bg-root)",
          position: "relative",
        }}
      >
        <ErrorBoundary panelName="Toolbar"><Toolbar /></ErrorBoundary>
        <ErrorBoundary panelName="Layout"><LayoutRenderer /></ErrorBoundary>
        <ErrorBoundary panelName="StatusBar"><StatusBar /></ErrorBoundary>
        <ErrorBoundary panelName="FloatingOverlays">
          <><FloatingRenderer /><ContextMenu /></>
        </ErrorBoundary>
      </div>
      {phase === "leaving" && splashOverlay}
      {showWelcomeWizard && (
        <WelcomeWizard onComplete={handleWizardComplete} />
      )}
      {showWorkspaceSelector && (
        <WorkspaceSelector
          workspaces={workspaceList}
          activeWorkDir={getSettings().workDir}
          onLaunch={handleWorkspaceLaunch}
        />
      )}
      <ErrorBoundary panelName="CommandPalette">
        <CommandPalette
          open={cpOpen}
          onClose={cpClose}
          items={cpItems}
          editorFocused={cpContext === "editor"}
          initialQuery={cpQuery}
        />
      </ErrorBoundary>
      <ErrorBoundary panelName="ToastContainer"><ToastContainer /></ErrorBoundary>
    </>
  );
}
