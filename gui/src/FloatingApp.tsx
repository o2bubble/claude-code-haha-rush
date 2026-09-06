import { useEffect, useRef, useState } from "react";

declare global { interface Window { __TAURI_INTERNALS__?: { webview?: { label?: string } } } }
import LayoutRenderer from "./components/LayoutRenderer";
import { registerPanel, getPanel } from "./stores/panelRegistry";
import { scanPlugins } from "./services/pluginRegistry";
import { registerPluginPanels } from "./services/pluginPanelBridge";
import { getTree, setTree } from "./stores/layoutStore";
import type { TabGroup } from "./types/layout";
import { t } from "./i18n";
import { bridge } from "./services/bridge";
import { startCrossWindowBusLeaf } from "./services/crossWindowBusLeaf";
import { ALL_PANEL_DEFS } from "./services/panelDefs";
import { setCurrentViewerItemId } from "./services/desktopItemViewerRegistry";
import CommandPalette from "./components/CommandPalette";
import { useCommandPalette } from "./components/useCommandPalette";

export default function FloatingApp() {
  const [ready, setReady] = useState(false);
  const realMount = useRef(false);

  // 子窗口也挂载统一命令面板（F1/Ctrl+Shift+P 打开，数据由 DataBus Leaf 镜像）
  const { open: cpOpen, context: cpContext, initialQuery: cpQuery, items: cpItems, close: cpClose } = useCommandPalette();

  const hash = window.location.hash;
  const hm = hash.match(/^#floating\/(.+?)\/(.+?)\/.+$/);
  const label = window.__TAURI_INTERNALS__?.webview?.label || "";
  const lm = label.match(/^float-(.+?)--(.+?)--(.+)$/);
  const panelId = hm
    ? decodeURIComponent(hm[1])
    : lm
      ? decodeURIComponent(lm[1])
      : "";
  const rawTitle = hm
    ? decodeURIComponent(hm[2])
    : lm
      ? decodeURIComponent(lm[2])
      : "";

  // Parse embedded itemId from title (format: "Label [item:uuid]")
  let panelTitle = rawTitle;
  let parsedItemId: string | null = null;
  const itemMatch = rawTitle.match(/^(.*) \[item:([a-f0-9-]+)\]$/);
  if (itemMatch) {
    panelTitle = itemMatch[1].trim();
    parsedItemId = itemMatch[2];
  }

  useEffect(() => {
    // ── Register ALL panels (shared definitions, each window registers independently) ──
    ALL_PANEL_DEFS.forEach(registerPanel);
    // 插件面板注册（浮窗窗口独立 render, 需自注册; registerPanel 有 dup 保护）
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const entries = (await invoke<{ name: string; manifestJson?: string }[]>("list_plugin_manifests")) ?? [];
        registerPluginPanels(scanPlugins(entries));
      } catch (e) {
        console.warn("[FloatingApp] 插件面板注册失败:", e);
      }
    })();

    // Set desktop item viewer id from parsed title (format: "Label [item:uuid]")
    if (panelId === "desktop-item-view" && parsedItemId) {
      setCurrentViewerItemId(parsedItemId);
    }

    const panel = getPanel(panelId);
    const tab = {
      id: `tab-${panelId}-1`,
      panelId,
      title: panelTitle || panel?.title || panelId,
      icon: panel?.icon ?? "default",
    };
    const group: TabGroup = {
      type: "group",
      id: "main",
      tabs: [tab],
      activeTabId: tab.id,
    };
    setTree(group);

    let cancelled = false;

    // ── Start Bridge + DataBus Leaf ──
    (async () => {
      // "settings.*" 覆盖精确 "settings"（数据同步）+ "settings.navigate"（命令面板分类导航）
      // "plugin.*" 让浮窗/Leaf 能收插件的 crossWindowBus topic（插件浮窗用 plugin.<name>.* 命名空间，bridge 通配已支持）
      const subs = ["chat.*", "plan.*", "subagents.*", "terminal.*", "editor.*", "settings.*", "workers.*", "files.*", "desktop.*", "layout.*", "plugin.*"];
      await bridge.startLeaf(subs);
      if (cancelled) return;
      startCrossWindowBusLeaf(subs);
      setReady(true);
      realMount.current = true;
    })();

    return () => {
      cancelled = true;
      realMount.current = false;
      // Use setTimeout to avoid StrictMode double-mount triggering goodbye
      // (StrictMode: mount→unmount→mount; realMount=true after 2nd mount)
      setTimeout(() => {
        if (!realMount.current) {
          bridge.sendGoodbye().catch(() => {});
        }
      }, 0);
    };
  }, [panelId, panelTitle]);

  if (!ready) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 14px)", fontFamily: "var(--font-sans)" }}>{t("common.loading") + "..."}</div>;

  return (
    <>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <LayoutRenderer />
      </div>
      <CommandPalette
        open={cpOpen}
        onClose={cpClose}
        items={cpItems}
        editorFocused={cpContext === "editor"}
        initialQuery={cpQuery}
      />
    </>
  );
}
