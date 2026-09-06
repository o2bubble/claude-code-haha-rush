import { useState } from "react";
import FileTree from "./FileTree";
import { getSettings } from "../stores/settingsStore";
import { t } from "../i18n";
import { editorStore, isPreviewable } from "../stores/editorStore";
import { fileService } from "../services/fileService";
import { showCtxMenu } from "./ContextMenu";
import { useEvent, useEventHandler } from "../services/useService";
import { eventBus } from "../services/serviceBus";
import { Events, type SettingsChangedPayload, type FileRevealPayload } from "../services/events";

export function FileBrowserPanel() {
  const settingsPayload = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const rootPath = settingsPayload?.settings?.workDir ?? (getSettings().workDir || null);
  const showHidden = settingsPayload?.settings?.showHiddenFiles ?? getSettings().showHiddenFiles ?? false;
  const [treeKey, setTreeKey] = useState(0);
  const refreshTree = () => setTreeKey((k) => k + 1);

  // 编辑器"定位目录树" → 文件树展开祖先并选中目标(粘性事件, 面板延迟挂载也能收到)
  const [revealPath, setRevealPath] = useState<string | null>(null);
  useEventHandler<FileRevealPayload>(Events.FILE_REVEAL, ({ path }) => {
    setRevealPath(path);
    eventBus.clearSticky(Events.FILE_REVEAL);
  });

  if (!rootPath) {
    return (
      <div style={{ padding: 16, color: "var(--fg-muted)", fontSize: 12, textAlign: "center", fontFamily: "var(--font-sans)" }}>
        {t("files.notConfigured")}
      </div>
    );
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
      onContextMenu={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("[data-file-node]")) return; // handled by FileTree
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, [
          { label: t("files.pasteFile"), action: async () => {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const text: string = await invoke("read_clipboard_text");
              if (text && rootPath) {
                const srcPath = text.trim();
                const fname = srcPath.split(/[/\\]/).pop() || "pasted_file";
                const sep = navigator.platform.toUpperCase().includes("WIN") ? "\\" : "/";
                await invoke("copy_file", { src: srcPath, dst: rootPath + sep + fname });
                refreshTree();
              }
            } catch (e) { console.error("[FileBrowser] paste:", e); }
          }},
          { separator: true as any },
          { label: t("files.refresh"), action: refreshTree },
        ]);
      }}
    >
      <div style={{
        padding: "4px 8px", borderBottom: "1px solid var(--border-light)",
        fontSize: 11, color: "var(--fg-muted)", fontFamily: "var(--font-sans)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {rootPath}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <FileTree forceRefresh={treeKey} rootPath={rootPath} showHidden={showHidden} revealPath={revealPath} onOpenFile={async (p) => {
          const name = p.split(/[/\\]/).pop() || p;
          if (isPreviewable(p)) {
            editorStore.openPreview(p, name);
          } else {
            const content = await fileService.readFile(p);
            editorStore.openFile(p, name, content);
          }
        }} />
      </div>
    </div>
  );
}
