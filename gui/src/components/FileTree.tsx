import { memo, useState, useEffect, useCallback, useRef } from "react";
import { FilePlus, FolderPlus, RefreshCw, Send } from "lucide-react";
import { fileService } from "../services/fileService";
import { showCtxMenu, type ContextMenuItem } from "./ContextMenu";
import { useEventHandler } from "../services/useService";
import { Events } from "../services/events";
import { t } from "../i18n";
import { windowBus } from "../services/windowBus";
import { getDesktops, addItem, findSmartPlace, loadDesktops, panToItem } from "../stores/desktopStore";
import { setSelection } from "./desktop/selectionStore";
import { activatePanel } from "../stores/layoutStore";
import { getSettings } from "../stores/settingsStore";

// ── Confirm overlay ──

function ConfirmOverlay({ title, message, confirmLabel, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: "rgba(0,0,0,0.3)",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: "var(--bg-root)", borderRadius: 8,
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        padding: 20, minWidth: 280, maxWidth: 400,
        fontFamily: "var(--font-sans)",
      }}>
        <div style={{ fontSize: "calc(var(--font-scale, 1) * 14px)", fontWeight: 600, color: "var(--fg-primary)", marginBottom: 10 }}>
          {title}
        </div>
        <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", color: "var(--fg-secondary)", marginBottom: 18, lineHeight: 1.4 }}>
          {message}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onCancel} style={{
            padding: "6px 16px", border: "1px solid var(--border-medium)", borderRadius: 4,
            backgroundColor: "var(--bg-root)", cursor: "pointer",
            fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-primary)",
          }}>
            {t("sessions.cancel")}
          </button>
          <button type="button" onClick={onConfirm} style={{
            padding: "6px 16px", border: "none", borderRadius: 4,
            backgroundColor: "var(--semantic-error)", cursor: "pointer",
            fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-inverse)", fontWeight: 600,
          }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

let _sep: string | null = null;
function pathSep(): string {
  if (_sep === null) _sep = navigator.platform.toUpperCase().includes("WIN") ? "\\" : "/";
  return _sep;
}
function isWin(): boolean { return pathSep() === "\\"; }
function parentDir(p: string): string { const s = pathSep(); const i = p.lastIndexOf(s); return i > 0 ? p.slice(0, i) : p; }
function joinPath(a: string, b: string): string { return a + pathSep() + b; }

async function invokeTauri(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface FileTreeProps {
  rootPath: string | null;
  showHidden: boolean;
  onOpenFile: (path: string) => void;
  selectedPath?: string | null;
  onSelect?: (path: string | null) => void;
  forceRefresh?: number;
  /** 定位到目录树：展开祖先链并选中该文件（编辑器右键"定位目录树"） */
  revealPath?: string | null;
}

const S = {
  tree: { fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 13px)", color: "var(--fg-primary)", padding: "4px 0" } as React.CSSProperties,
  node: { display: "flex", alignItems: "center", padding: "2px 8px", cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" } as React.CSSProperties,
  arrow: { width: 16, marginRight: 0, flexShrink: 0, fontSize: 10, textAlign: "center", transition: "transform 0.1s" } as React.CSSProperties,
  arrowOpen: { transform: "rotate(90deg)" } as React.CSSProperties,
  empty: { padding: "16px 12px", color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 12px)", textAlign: "center" } as React.CSSProperties,
  icon: { width: 16, marginRight: 4, flexShrink: 0, textAlign: "center" } as React.CSSProperties,
  input: { flex: 1, border: "1px solid var(--accent)", borderRadius: 2, padding: "1px 4px", fontSize: "calc(var(--font-scale, 1) * 13px)", fontFamily: "var(--font-sans)", outline: "none", minWidth: 0 } as React.CSSProperties,
};

function icon(isDir: boolean, expanded: boolean) {
  return isDir ? (expanded ? "📂" : "📁") : "📄";
}

function sortFileEntries(entries: FileEntry[]): FileEntry[] {
  const order = getSettings().fileSortOrder ?? "name";
  const sorted = [...entries];
  if (order === "name") {
    sorted.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } else if (order === "type") {
    sorted.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const extA = a.name.includes(".") ? a.name.split(".").pop() || "" : "";
      const extB = b.name.includes(".") ? b.name.split(".").pop() || "" : "";
      return extA.localeCompare(extB) || a.name.localeCompare(b.name);
    });
  } else {
    // "date" — not supported without file stats, fallback to name
    sorted.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  return sorted;
}

function DirNode({ entry, depth, showHidden, onOpenFile, refreshParent, rootPath, selectedPath, onSelect, treeVersion, revealPath }: {
  entry: FileEntry; depth: number; showHidden: boolean; onOpenFile: (path: string) => void; refreshParent: () => void; rootPath: string;
  selectedPath?: string | null; onSelect?: (path: string | null) => void; treeVersion?: number; revealPath?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);

  // 定位目录树：若本目录是 revealPath 的祖先 → 自动展开并加载子项
  const norm = (p: string) => p.replace(/\\/g, "/");
  const revealNorm = revealPath ? norm(revealPath) : null;
  const entryNorm = norm(entry.path);
  const isRevealAncestor = !!entry.isDir && !!revealNorm && revealNorm.startsWith(entryNorm + "/");
  const isRevealTarget = !!revealNorm && revealNorm === entryNorm;

  useEffect(() => {
    if (isRevealAncestor && !expanded) {
      setExpanded(true);
      if (children === null || children.length === 0) refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRevealAncestor]);

  // 定位到目标文件后滚入视野
  useEffect(() => {
    if (isRevealTarget) nodeRef.current?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRevealTarget]);

  const refresh = useCallback(async () => {
    if (!entry.isDir) return;
    setLoading(true);
    try {
      const entries = await fileService.readDir(entry.path, showHidden);
      setChildren([...sortFileEntries(entries)]);
    } catch { setChildren([]); }
    setLoading(false);
  }, [entry, showHidden]);

  // Re-read children when treeVersion bumps (global refresh) — only if expanded
  useEffect(() => {
    if (!entry.isDir || !expanded || children === null || treeVersion === undefined) return;
    refresh();
  }, [treeVersion]); // eslint-disable-line

  const handleToggle = useCallback(async () => {
    if (!entry.isDir) { onOpenFile(entry.path); return; }
    if (!expanded) {
      if (children === null) {
        setLoading(true);
        try {
          const items = await fileService.readDir(entry.path, showHidden);
          setChildren([...sortFileEntries(items)]);
        }
        catch { setChildren([]); }
        setLoading(false);
      }
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  }, [entry, expanded, children, showHidden, onOpenFile]);

  const handleDelete = useCallback(async () => {
    setDeletePending(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    setDeletePending(false);
    try {
      await fileService.deletePath(entry.path);
      windowBus.emit(Events.FILE_CHANGED, { path: entry.path });
    }
    catch (e) { alert(String(e)); }
    refreshParent();
  }, [entry.path, refreshParent]);

  const handleRename = useCallback(() => {
    setRenameValue(entry.name);
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [entry.name]);

  const commitRename = useCallback(async () => {
    setRenaming(false);
    if (renameValue && renameValue !== entry.name) {
      try { await fileService.renamePath(entry.path, renameValue); }
      catch (e) { alert(String(e)); }
      refreshParent();
    }
  }, [entry.path, entry.name, renameValue, refreshParent]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (onSelect) onSelect(entry.path);
      const refType = entry.isDir ? "dir" : "file";
      const refObj = { type: refType, path: entry.path, label: entry.name };
      const absPath = entry.path.replace(/\//g, pathSep());
      const relPath = rootPath ? absPath.replace(rootPath.replace(/\//g, pathSep()) + pathSep(), "") : entry.name;
      const dirPath = entry.isDir ? absPath : parentDir(absPath);

      const items: ContextMenuItem[] = [
        { label: t("files.copyFile"), action: () => { navigator.clipboard.writeText(absPath).catch(() => {}); } },
        { label: t("files.copyFileName"), action: () => { navigator.clipboard.writeText(entry.name).catch(() => {}); } },
        { label: t("files.copyRelativePath"), action: () => { navigator.clipboard.writeText(relPath).catch(() => {}); } },
        { label: t("files.copyAbsolutePath"), action: () => { navigator.clipboard.writeText(absPath).catch(() => {}); } },
        { label: t("files.openInExplorer"), action: () => {
          invokeTauri("open_in_explorer", { path: absPath }).catch(() => {
            invokeTauri("open_in_explorer", { path: dirPath }).catch(() => {});
          });
        }},
        { label: t("files.openInTerminal"), action: () => {
          invokeTauri("open_system_terminal", { terminalType: isWin() ? "powershell" : (/mac/i.test(navigator.platform || "") ? "terminal" : "git-bash"), workDir: dirPath, claudeLaunch: false }).catch(() => {});
        }},
      ];

      // Folders get Paste option (file copy from clipboard path)
      if (entry.isDir) {
        items.splice(4, 0, {
          label: t("files.pasteFile"),
          action: async () => {
            try {
              const text: string = await invokeTauri("read_clipboard_text");
              if (!text) return;
              const srcPath = text.trim();
              const name = srcPath.split(/[/\\]/).pop() || "pasted_file";
              const dstPath = joinPath(entry.path, name);
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("copy_file", { src: srcPath, dst: dstPath });
              refresh(); // refresh THIS folder, not parent
            } catch (e) { console.error("[FileTree] paste:", e); }
          },
        });
      }

      // Send to Super Desktop → pick a desktop (submenu)
      const desktops = getDesktops();
      if (desktops.length > 0) {
        items.push({
          label: t("files.sendToSuperDesktop"),
          children: desktops.map((d) => ({
            label: d.name,
            action: () => {
              const place = findSmartPlace(d, entry.isDir ? 280 : 250, entry.isDir ? 280 : 100);
              const item = addItem(d.id, {
                x: place.x,
                y: place.y,
                width: entry.isDir ? 280 : 250,
                height: entry.isDir ? 280 : 100,
                label: entry.name,
                content: entry.isDir
                  ? { type: "file-group" as const, files: [{ type: "dir" as const, path: entry.path, label: entry.name }] }
                  : { type: "ref" as const, references: [{ type: "file" as const, path: entry.path, label: entry.name }] },
              });
              activatePanel("super-desktop");
              setSelection(new Set([item.id]));
              setTimeout(() => panToItem(item.id), 200);
            },
          })),
        });
      }

      items.push(
        { separator: true as any },
        { label: t("files.rename"), action: handleRename },
        { label: t("files.sendToChat"), icon: <Send size={12} />, action: () => {
          windowBus.emit(Events.CHAT_ADD_REFERENCE, { reference: refObj });
        }},
        { label: t("files.delete"), action: handleDelete },
      );

      showCtxMenu(e.clientX, e.clientY, items);
    },
    [handleRename, handleDelete, entry, rootPath, refreshParent],
  );

  const indent = depth * 16;
  const isDir = entry.isDir;

  return (
    <>
      <div
        ref={nodeRef}
        data-file-node="true"
        onClick={(e) => {
          if (renaming) return;
          if (onSelect) onSelect(entry.path);
          handleToggle();
        }}
        onContextMenu={onContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...S.node,
          paddingLeft: 8 + indent,
          backgroundColor: selectedPath === entry.path ? "var(--bg-active)" : hovered ? "var(--bg-hover)" : "transparent",
        }}
      >
        {isDir && <span style={{ ...S.arrow, ...(expanded ? S.arrowOpen : {}) }}>▶</span>}
        {!isDir && <span style={S.arrow} />}
        <span style={S.icon}>{isDir ? (expanded ? "📂" : "📁") : "📄"}</span>
        {renaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(false); }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            style={S.input}
            autoFocus
          />
        ) : (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}</span>
        )}
        {loading && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--fg-muted)" }}>...</span>}
      </div>
      {isDir && expanded && children && children.map((child) => (
        <DirNode key={child.path} entry={child} depth={depth + 1} showHidden={showHidden} onOpenFile={onOpenFile} refreshParent={refresh} rootPath={rootPath} selectedPath={selectedPath} onSelect={onSelect} treeVersion={treeVersion} />
      ))}
      {deletePending && (
        <ConfirmOverlay
          title={t("files.delete")}
          message={t("files.deleteConfirm", { name: entry.name })}
          confirmLabel={t("files.delete")}
          onConfirm={confirmDelete}
          onCancel={() => setDeletePending(false)}
        />
      )}
    </>
  );
}

// ── Root component ──

function _FileTree({ rootPath, showHidden, onOpenFile, forceRefresh, revealPath }: FileTreeProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [createName, setCreateName] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // 编辑器"定位目录树"→ 选中目标(展开祖先在 DirNode 内自动处理)
  useEffect(() => {
    if (revealPath) setSelectedPath(revealPath);
  }, [revealPath]);
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const [treeVersion, setTreeVersion] = useState(0);

  const refreshRoot = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const entries = await fileService.readDir(rootPath, showHidden);
      setRootEntries([...sortFileEntries(entries)]);
      setTreeVersion((v) => v + 1);
    }
    catch { setRootEntries([]); }
    setLoading(false);
  }, [rootPath, showHidden]);

  useEffect(() => {
    if (!rootPath) { setRootEntries(null); return; }
    setLoading(true);
    fileService.readDir(rootPath, showHidden).then((e) => setRootEntries(sortFileEntries(e))).catch(() => setRootEntries([])).finally(() => setLoading(false));
  }, [rootPath, showHidden]);

  // Pre-load desktops so "Send to Super Desktop" works without opening the panel
  useEffect(() => { loadDesktops().catch(() => {}); }, []);

  const forceRef = useRef(forceRefresh);
  useEffect(() => {
    if (forceRefresh !== undefined && forceRef.current !== forceRefresh) {
      forceRef.current = forceRefresh;
      refreshRoot();
    }
  }, [forceRefresh]); // eslint-disable-line

  // Auto-refresh when AI writes/deletes files on disk
  useEventHandler(Events.FILE_CHANGED, () => {
    if (rootPath) refreshRoot();
  });

  const startCreate = (type: "file" | "dir") => {
    setCreating(type);
    setCreateName("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitCreate = useCallback(async () => {
    if (!rootPath || !creating || !createName.trim()) { setCreating(null); return; }
    const p = joinPath(rootPath, createName.trim());
    try { await fileService.createPath(p, creating === "dir"); }
    catch (e) { alert(String(e)); }
    setCreating(null);
    setCreateName("");
    refreshRoot();
  }, [rootPath, creating, createName, refreshRoot]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await fileService.deletePath(deleteTarget.path);
      windowBus.emit(Events.FILE_CHANGED, { path: deleteTarget.path });
    }
    catch (err) { alert(String(err)); }
    setDeleteTarget(null);
    setSelectedPath(null);
    refreshRoot();
  }, [deleteTarget, refreshRoot]);

  // Keyboard shortcuts
  const onKeyDown = useCallback(async (e: React.KeyboardEvent) => {
    if (!selectedPath) return;
    const name = selectedPath.split(/[/\\]/).pop() || selectedPath;
    const isDir = rootEntries?.some((en) => en.path === selectedPath && en.isDir) ?? false;

    if (e.key === "Escape") {
      setSelectedPath(null);
    } else if (e.ctrlKey && e.key === "c") {
      e.preventDefault();
      navigator.clipboard.writeText(selectedPath).catch(() => {});
    } else if (e.key === "F2" && selectedPath) {
      e.preventDefault();
      // Find the DirNode for selectedPath and trigger rename — skip for now
    } else if (e.key === "Delete") {
      e.preventDefault();
      setDeleteTarget({ path: selectedPath, name: selectedPath.split(/[/\\]/).pop() || selectedPath });
    } else if (e.ctrlKey && e.key === "v") {
      e.preventDefault();
      try {
        const text: string = await invokeTauri("read_clipboard_text");
        if (text && rootPath) {
          const srcPath = text.trim();
          const fname = srcPath.split(/[/\\]/).pop() || "pasted_file";
          const dstDir = isDir ? selectedPath : (parentDir(selectedPath) || rootPath!);
          const dst = joinPath(dstDir, fname);
          try { await invokeTauri("copy_file", { src: srcPath, dst }); refreshRoot(); }
          catch (e) { console.error("[FileTree] paste:", e); }
        }
      } catch (e) { console.error("[FileTree] ctrl+v:", e); }
    }
  }, [selectedPath, rootEntries, refreshRoot]);

  // Empty-area context menu
  const onRootContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Only show on empty area, not on file/folder nodes
    if (target.closest("[data-file-node]")) return;
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: t("files.newFile"), action: () => startCreate("file") },
      { label: t("files.newFolder"), action: () => startCreate("dir") },
      { label: t("files.pasteFile"), action: async () => {
        try {
          const text: string = await invokeTauri("read_clipboard_text");
          if (text && rootPath) {
            const srcPath = text.trim();
            const fname = srcPath.split(/[/\\]/).pop() || "pasted_file";
            const dst = joinPath(rootPath, fname);
            try { await invokeTauri("copy_file", { src: srcPath, dst }); refreshRoot(); }
            catch (e) { console.error("[FileTree] paste:", e); }
          }
        } catch { /* clipboard read failed */ }
      }},
      { separator: true as any },
      { label: t("files.refresh"), action: refreshRoot },
    ]);
  }, [rootPath, refreshRoot]);

  return (
    <div
      ref={treeRef}
      style={S.tree}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={onRootContextMenu}
    >
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 2,
        padding: "2px 4px", borderBottom: "1px solid var(--border-light)",
      }}>
        <button type="button" onClick={() => startCreate("file")} title={t("files.newFile")} aria-label={t("files.newFile")}
          style={toolBtn}><FilePlus size={14} /></button>
        <button type="button" onClick={() => startCreate("dir")} title={t("files.newFolder")} aria-label={t("files.newFolder")}
          style={toolBtn}><FolderPlus size={14} /></button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={refreshRoot} title={t("files.refresh")} aria-label={t("files.refresh")}
          style={toolBtn}><RefreshCw size={14} /></button>
      </div>

      {/* New file/folder input */}
      {creating && (
        <div style={{ display: "flex", padding: "4px 8px", gap: 4, alignItems: "center" }}>
          <span style={S.icon}>{creating === "dir" ? "📁" : "📄"}</span>
          <input
            ref={inputRef}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitCreate(); if (e.key === "Escape") setCreating(null); }}
            onBlur={commitCreate}
            placeholder={creating === "dir" ? t("files.folderName") : t("files.fileName")}
            style={S.input}
            autoFocus
          />
        </div>
      )}

      {/* Content */}
      {!rootPath && <div style={S.empty}>{t("files.notConfigured")}</div>}
      {loading && <div style={S.empty}>{t("files.loading")}</div>}
      {rootEntries && rootEntries.length === 0 && !loading && !creating && (
        <div style={S.empty}>{t("files.emptyFolder")}</div>
      )}
      {rootEntries && rootEntries.map((entry) => (
        <DirNode key={entry.path} entry={entry} depth={0} showHidden={showHidden} onOpenFile={onOpenFile} refreshParent={refreshRoot} rootPath={rootPath || ""} selectedPath={selectedPath} onSelect={setSelectedPath} treeVersion={treeVersion} revealPath={revealPath} />
      ))}
      {deleteTarget && (
        <ConfirmOverlay
          title={t("files.delete")}
          message={t("files.deleteConfirm", { name: deleteTarget.name })}
          confirmLabel={t("files.delete")}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
export default memo(_FileTree);

const toolBtn: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  padding: 3, borderRadius: 3, display: "flex", alignItems: "center",
  color: "var(--fg-secondary)",
};
