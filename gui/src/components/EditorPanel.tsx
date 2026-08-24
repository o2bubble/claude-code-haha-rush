import MonacoEditor from "./Editor";
import { editorStore } from "../stores/editorStore";
import { detectLanguageLabel } from "../utils/detectLanguage";
import { isMarkdownFile } from "../utils/markdownPreview";
import { useEventHandler } from "../services/useService";
import { Events, type EditorChangedPayload, type FileChangedPayload } from "../services/events";
import { fileService } from "../services/fileService";
import FilePreview from "./FilePreview";
import MarkdownPreview from "./MarkdownPreview";
import { t } from "../i18n";
import { useState } from "react";
import { Eye } from "lucide-react";

export function EditorPanel() {
  const [, setTick] = useState(0);

  useEventHandler<EditorChangedPayload>(Events.EDITOR_CHANGED, () => setTick((t) => t + 1));
  useEventHandler<FileChangedPayload>(Events.FILE_CHANGED, async ({ path }) => {
    const needsReload = editorStore.markExternalChanged(path);
    if (needsReload) {
      try {
        const content = await fileService.readFile(path);
        editorStore.reloadContent(path, content);
      } catch {
        editorStore.markDeleted(path);
      }
    }
  });

  const tabs = editorStore.tabs;
  const activeTab = editorStore.activeTab;

  if (!activeTab) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100%", color: "var(--fg-muted)", fontSize: 13,
        fontFamily: "var(--font-sans)",
      }}>
        {t("editor.openFileHint")}
      </div>
    );
  }

  const isMd = isMarkdownFile(activeTab.name);
  const showMdPreview = isMd && !!activeTab.previewMode;

  const handleTabClick = (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.externalChanged && !tab.dirty) {
      // Clean tab with pending external change — reload silently
      fileService.readFile(path).then((content) => {
        editorStore.reloadContent(path, content);
      }).catch(() => {});
    }
    editorStore.setActive(path);
  };

  const handleReloadClick = (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    if (tab.dirty && tab.externalChanged) {
      if (!confirm(t("editor.diskChangedConfirm"))) return;
    }
    fileService.readFile(path).then((content) => {
      editorStore.reloadContent(path, content);
    }).catch(() => {});
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab bar */}
      <div style={{
        display: "flex", height: 32, backgroundColor: "var(--bg-hover)",
        borderBottom: "1px solid var(--border-medium)", flexShrink: 0,
        overflow: "hidden", fontFamily: "var(--font-sans)",
      }}>
        {tabs.map((tab) => {
          const active = tab.path === activeTab.path;
          return (
            <div
              key={tab.path}
              onClick={() => handleTabClick(tab.path)}
              onMouseDown={(e) => {
                if (e.button === 1) { editorStore.closeTab(tab.path); }
              }}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "0 12px", height: "100%", cursor: "pointer",
                fontSize: 12, userSelect: "none", whiteSpace: "nowrap",
                color: tab.deleted ? "var(--semantic-error)" : active ? "var(--fg-primary)" : "var(--fg-secondary)",
                backgroundColor: active ? "var(--bg-root)" : "transparent",
                borderBottom: active ? `2px solid ${tab.deleted ? "var(--semantic-error)" : "var(--accent)"}` : "none",
                borderRight: "1px solid var(--border-light)",
              }}
            >
              {tab.tabType === "preview" && <span style={{ fontSize: 12 }}>🖼 </span>}
              <span style={tab.deleted ? { textDecoration: "line-through" } : undefined}>{tab.name}</span>
              {tab.deleted && (
                <span style={{ color: "var(--semantic-error)", fontSize: 11, fontWeight: 600 }}>
                  {t("editor.fileDeleted")}
                </span>
              )}
              {tab.dirty && !tab.deleted && <span style={{ color: "var(--semantic-warning)", fontSize: 16 }}>●</span>}
              {tab.externalChanged && !tab.deleted && (
                <span
                  title={tab.dirty ? t("editor.diskUpdatedDirty") : t("editor.diskUpdated")}
                  style={{
                    color: tab.dirty ? "#f38ba8" : "var(--accent)",
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                  onClick={(e) => { e.stopPropagation(); handleReloadClick(tab.path); }}
                >{tab.dirty ? "\u26A0" : "\u21BB"}</span>
              )}
              <span
                onClick={(e) => { e.stopPropagation(); editorStore.closeTab(tab.path); }}
                style={{
                  marginLeft: 2, fontSize: 11, color: "var(--fg-muted)",
                  padding: "0 2px", borderRadius: 2,
                }}
              >
                ×
              </span>
            </div>
          );
        })}
      </div>

      {/* Editor / Preview */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {activeTab.tabType === "preview" ? (
          <FilePreview key={activeTab.path} path={activeTab.path} name={activeTab.name} />
        ) : showMdPreview ? (
          <MarkdownPreview key={activeTab.path} content={activeTab.content} />
        ) : (
          <MonacoEditor
            key={activeTab.path}
            path={activeTab.path}
            name={activeTab.name}
            content={activeTab.content}
            readOnly={activeTab.deleted === true}
            onChange={(content) => editorStore.setContent(activeTab.path!, content)}
          />
        )}

        {/* md 预览切换胶囊 — 右上角, 右偏移避开 Monaco minimap */}
        {isMd && (
          <button
            type="button"
            onClick={() => editorStore.togglePreviewMode(activeTab.path)}
            title={showMdPreview ? t("editor.edit") : t("editor.preview")}
            style={{
              position: "absolute", top: 8, right: 100, zIndex: 10,
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 10px", borderRadius: 14,
              border: "1px solid var(--border-medium)",
              backgroundColor: showMdPreview ? "var(--accent)" : "var(--bg-surface)",
              color: showMdPreview ? "var(--fg-inverse)" : "var(--fg-secondary)",
              cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "var(--font-sans)",
              fontWeight: 600, boxShadow: "var(--shadow-sm)",
              opacity: 0.5, transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
          >
            <Eye size={12} />
            {showMdPreview ? t("editor.edit") : t("editor.preview")}
          </button>
        )}
      </div>

      {/* Status bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 22, padding: "0 10px", flexShrink: 0,
        backgroundColor: "var(--accent)", color: "var(--fg-inverse)", fontSize: 11,
        fontFamily: "var(--font-sans)",
      }}>
        <span>{activeTab.path}</span>
        <span>{activeTab.tabType === "preview" ? t("editor.preview") : detectLanguageLabel(activeTab.name)}</span>
      </div>
    </div>
  );
}
