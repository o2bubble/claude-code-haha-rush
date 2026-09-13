import MonacoEditor from "./Editor";
import { editorStore, isPreviewable } from "../stores/editorStore";
import { detectLanguageLabel } from "../utils/detectLanguage";
import { isMarkdownFile } from "../utils/markdownPreview";
import { useEventHandler } from "../services/useService";
import { Events, type EditorChangedPayload, type FileChangedPayload } from "../services/events";
import { fileService } from "../services/fileService";
import FilePreview from "./FilePreview";
import MarkdownPreview from "./MarkdownPreview";
import { t } from "../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye } from "lucide-react";
import { showCtxMenu } from "./ContextMenu";
import { revealFileInTree } from "../utils/revealFile";

export function EditorPanel() {
  const [, setTick] = useState(0);

  useEventHandler<EditorChangedPayload>(Events.EDITOR_CHANGED, () => setTick((t) => t + 1));
  useEventHandler<FileChangedPayload>(Events.FILE_CHANGED, async ({ path }) => {
    const needsReload = editorStore.markExternalChanged(path);
    if (needsReload) {
      // 预览类标签（图片/PDF/SVG）的 content 必须保持空 —— FilePreview 自己用
      // read_bytes 加载。当文本读进来会得到乱码，还会污染 tabType 的语义。
      if (isPreviewable(path)) {
        editorStore.reloadContent(path, "");
        return;
      }
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

  // ── 所有 hooks 必须在提前 return(无活动标签)之前无条件调用 ──
  // 否则 activeTab null↔非null 切换(开文件/关文件)时 hook 数量变化, React 报
  // "Rendered more/fewer hooks than expected"(prod minify 后即 #300/#310)。
  // 稳定身份, 配合 MonacoEditor(React.memo) 避免无关重渲染推高竞态。
  const handleEditorChange = useCallback((content: string) => {
    if (activeTab?.path) editorStore.setContent(activeTab.path, content);
  }, [activeTab?.path]);

  const tabBarRef = useRef<HTMLDivElement>(null);

  // 删除/关闭标签后滚动到当前活动标签(标签溢出时防止活动标签被藏在屏外)
  useEffect(() => {
    try {
      const el = tabBarRef.current?.querySelector('[data-active="true"]') as HTMLElement | null;
      el?.scrollIntoView({ inline: "nearest", block: "nearest" });
    } catch { /* 滚动定位失败不致命 */ }
  }, [activeTab?.path]);

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

  // 标签右键菜单：关闭 / 关闭其他 / 关闭未修改 / 关闭全部 / 复制路径 / 定位目录树 / 资源管理器
  const handleTabContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
      { label: t("editor.closeTab"), action: () => editorStore.closeTab(path) },
      { label: t("editor.closeOthers"), action: () => editorStore.closeOthers(path) },
      { label: t("editor.closeUnmodified"), action: () => editorStore.closeUnmodified() },
      { label: t("editor.closeAll"), action: () => editorStore.closeAll() },
      { separator: true as any },
      { label: t("editor.copyPath"), action: () => { navigator.clipboard.writeText(path).catch(() => {}); } },
      { label: t("editor.revealInTree"), action: () => revealFileInTree(path) },
      { label: t("files.openInExplorer"), action: () => {
        import("@tauri-apps/api/core").then(({ invoke }) => invoke("open_in_explorer", { path }).catch(() => {}));
      }},
    ]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab bar — 溢出横向滚动(滚轮/拖动)+隐藏滚动条 */}
      <div
        ref={tabBarRef}
        data-editor-tabbar
        onWheel={(e) => {
          const el = e.currentTarget as HTMLElement;
          el.scrollLeft += (e as any).deltaY || (e as any).deltaX;
        }}
        style={{
          display: "flex", height: 32, backgroundColor: "var(--bg-hover)",
          borderBottom: "1px solid var(--border-medium)", flexShrink: 0,
          overflowX: "auto", overflowY: "hidden",
          scrollbarWidth: "none", msOverflowStyle: "none",
          fontFamily: "var(--font-sans)",
        }}
      >
        {tabs.map((tab) => {
          const active = tab.path === activeTab.path;
          return (
            <div
              key={tab.path}
              data-active={active ? "true" : undefined}
              onClick={() => handleTabClick(tab.path)}
              onContextMenu={(e) => handleTabContextMenu(e, tab.path)}
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
          // 不设 key：切文件时复用同一 Monaco 实例、经 path 换 model（@monaco-editor/react 支持），
          // 避免每次重挂 Monaco 触发懒加载渲染竞态(React #300/#310) + 重载闪烁。
          <MonacoEditor
            path={activeTab.path}
            name={activeTab.name}
            content={activeTab.content}
            readOnly={activeTab.deleted === true}
            onChange={handleEditorChange}
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
