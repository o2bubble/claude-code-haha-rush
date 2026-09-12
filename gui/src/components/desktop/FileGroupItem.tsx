import React, { useCallback, useMemo, useState, useRef } from "react";
import type { DesktopItem } from "../../types/desktop";
import type { FileGroupContent } from "../../types/desktop";
import { windowBus } from "../../services/windowBus";
import { Events } from "../../services/events";
import { t } from "../../i18n";

interface Props {
  item: DesktopItem;
}

interface TreeEntry {
  type: "file" | "dir";
  path: string;
  label: string;
}

const TYPE_ICONS: Record<string, string> = { file: "📄", dir: "📁" };

/** Collect all file entries visible in the current tree state */
function collectVisible(
  entries: TreeEntry[],
  expandedPaths: Set<string>,
  childCache: Map<string, TreeEntry[]>,
  depth: number,
): { entry: TreeEntry; depth: number }[] {
  const result: { entry: TreeEntry; depth: number }[] = [];
  for (const entry of entries) {
    result.push({ entry, depth });
    if (entry.type === "dir" && expandedPaths.has(entry.path)) {
      const children = childCache.get(entry.path);
      if (children && children.length > 0) {
        result.push(...collectVisible(children, expandedPaths, childCache, depth + 1));
      }
    }
  }
  return result;
}

/** Count all visible files (not dirs) in the tree */
function countFiles(
  entries: TreeEntry[],
  expandedPaths: Set<string>,
  childCache: Map<string, TreeEntry[]>,
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "file") count++;
    if (entry.type === "dir" && expandedPaths.has(entry.path)) {
      const children = childCache.get(entry.path);
      if (children) count += countFiles(children, expandedPaths, childCache);
    }
  }
  return count;
}

/** Collect all visible file paths for "Send All" */
function collectFiles(
  entries: TreeEntry[],
  expandedPaths: Set<string>,
  childCache: Map<string, TreeEntry[]>,
): TreeEntry[] {
  const result: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "file") result.push(entry);
    if (entry.type === "dir" && expandedPaths.has(entry.path)) {
      const children = childCache.get(entry.path);
      if (children) result.push(...collectFiles(children, expandedPaths, childCache));
    }
  }
  return result;
}

export function FileGroupItem({ item }: Props) {
  const content = item.content as FileGroupContent;
  // 数据契约防御（同 RefItem）：块内容可能不完整（AI 经 MCP 创建时漏 path），
  // 渲染期抛错会被 ErrorBoundary 捕获 → 整个超级桌面消失。故过滤无效条目并告知。
  const { rootEntries, dropped } = useMemo(() => {
    const list = Array.isArray(content.files) ? content.files : [];
    const valid = list.filter(
      (f): f is (typeof list)[number] =>
        !!f && typeof f === "object" && typeof f.path === "string" && f.path.length > 0,
    );
    return {
      rootEntries: valid.map((f) => ({
        type: f.type === "dir" ? ("dir" as const) : ("file" as const),
        path: f.path,
        label: f.label || f.path.split(/[/\\]/).pop() || f.path,
      })),
      dropped: list.length - valid.length,
    };
  }, [content.files]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [childCache, setChildCache] = useState<Map<string, TreeEntry[]>>(new Map());
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleDir = useCallback(async (entry: TreeEntry) => {
    if (expandedPaths.has(entry.path)) {
      // Collapse
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
    } else {
      // Expand — lazy load if not cached
      if (!childCache.has(entry.path)) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const entries = await invoke<any[]>("read_dir", { path: entry.path });
          const children: TreeEntry[] = entries.map((e: any) => ({
            type: e.is_dir ? "dir" : "file",
            path: e.path,
            label: e.name,
          }));
          setChildCache((prev) => {
            const next = new Map(prev);
            next.set(entry.path, children);
            return next;
          });
        } catch {
          // Can't read — don't expand
          return;
        }
      }
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(entry.path);
        return next;
      });
    }
  }, [expandedPaths, childCache]);

  const sendToAgent = (entry: TreeEntry) => {
    windowBus.emit(Events.CHAT_ADD_REFERENCE, { reference: entry });
  };

  const sendAllToAgent = () => {
    const files = collectFiles(rootEntries, expandedPaths, childCache);
    for (const f of files) {
      windowBus.emit(Events.CHAT_ADD_REFERENCE, { reference: f });
    }
  };

  if (rootEntries.length === 0) {
    return (
      <div style={{ padding: 16, color: dropped > 0 ? "var(--semantic-warning)" : "var(--fg-muted)", fontSize: 12, textAlign: "center" }}>
        {dropped > 0 ? t("desktop.block.droppedRefs", { n: dropped }) : t("desktop.block.noFiles")}
      </div>
    );
  }

  const visible = collectVisible(rootEntries, expandedPaths, childCache, 0);
  const fileCount = countFiles(rootEntries, expandedPaths, childCache);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    borderBottom: "1px solid var(--border-light)",
    fontSize: 12,
    fontFamily: "var(--font-sans)",
  };
  const rowHoverStyle: React.CSSProperties = { backgroundColor: "var(--bg-hover)" };

  return (
    <div
      ref={containerRef}
      style={{ padding: "0", fontSize: 12, fontFamily: "var(--font-sans)", userSelect: "none" }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {dropped > 0 && (
        <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--semantic-warning)", borderBottom: "1px solid var(--border-light)" }}>
          {t("desktop.block.droppedRefs", { n: dropped })}
        </div>
      )}
      {visible.map(({ entry, depth }, i) => {
        const icon = TYPE_ICONS[entry.type] || "📄";
        const isDir = entry.type === "dir";
        const isExpanded = isDir && expandedPaths.has(entry.path);
        const toggleWidth = 16;
        const indent = depth * toggleWidth + 4;

        return (
          <div
            key={entry.path}
            style={hoveredPath === entry.path ? { ...rowStyle, ...rowHoverStyle } : rowStyle}
            onMouseEnter={() => setHoveredPath(entry.path)}
            onMouseLeave={() => setHoveredPath(null)}
          >
            <span style={{ width: indent, flexShrink: 0 }} />
            {isDir ? (
              <button
                onClick={(e) => { e.stopPropagation(); toggleDir(entry); }}
                style={{
                  width: toggleWidth,
                  height: toggleWidth,
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  fontSize: 10,
                  color: "var(--fg-muted)",
                  padding: 0,
                  flexShrink: 0,
                  lineHeight: "16px",
                  textAlign: "center",
                }}
                title={isExpanded ? t("desktop.block.collapse") : t("desktop.block.expand")}
              >
                {isExpanded ? "▼" : "▶"}
              </button>
            ) : (
              <span style={{ width: toggleWidth, flexShrink: 0 }} />
            )}
            <span style={{ flexShrink: 0 }}>{icon}</span>
            <span
              style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-primary)" }}
              title={entry.path}
            >
              {entry.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); sendToAgent(entry); }}
              title={t("desktop.block.sendFileToAgent", { name: entry.label })}
              style={{
                fontSize: 11,
                padding: "1px 6px",
                border: "1px solid var(--accent)",
                borderRadius: 3,
                background: "var(--bg-root)",
                color: "var(--accent)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {t("desktop.sendToAgent")}
            </button>
          </div>
        );
      })}
      {fileCount > 1 && (
        <div style={{ padding: "4px 8px", borderTop: "1px solid var(--border-light)" }}>
          <button
            onClick={sendAllToAgent}
            style={{
              fontSize: 11,
              padding: "2px 10px",
              border: "1px solid var(--accent)",
              borderRadius: 3,
              background: "var(--accent)",
              color: "var(--fg-inverse)",
              cursor: "pointer",
            }}
          >
            {t("desktop.sendItemsToAgent", { count: fileCount })}
          </button>
        </div>
      )}
    </div>
  );
}
