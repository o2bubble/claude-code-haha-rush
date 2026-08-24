import React, { useState } from "react";
import type { Desktop } from "../../types/desktop";
import { setActiveDesktop, createDesktop, deleteDesktop, renameDesktop } from "../../stores/desktopStore";
import { t } from "../../i18n";

interface Props {
  desktops: Desktop[];
  activeDesktopId: string | null;
}

export function DesktopTabs({ desktops, activeDesktopId }: Props) {
  const [contextMenu, setContextMenu] = useState<{ desktopId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ desktopId: id, x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => setContextMenu(null);

  const startRename = (id: string, name: string) => {
    setRenaming(id);
    setRenameText(name);
    closeContextMenu();
  };

  const commitRename = () => {
    if (renaming && renameText.trim()) {
      renameDesktop(renaming, renameText.trim());
    }
    setRenaming(null);
  };

  const handleDelete = (id: string) => {
    closeContextMenu();
    if (desktops.length > 1) {
      deleteDesktop(id);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0,
        borderBottom: "1px solid var(--border-light)",
        backgroundColor: "var(--bg-hover)",
        padding: "0 4px",
        minHeight: 32,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {desktops.map((d) => (
        <div
          key={d.id}
          onClick={() => setActiveDesktop(d.id)}
          onContextMenu={(e) => handleContextMenu(e, d.id)}
          style={{
            padding: "4px 12px",
            fontSize: 12,
            cursor: "pointer",
            userSelect: "none",
            borderBottom: d.id === activeDesktopId ? "2px solid var(--accent)" : "2px solid transparent",
            backgroundColor: d.id === activeDesktopId ? "var(--bg-root)" : "transparent",
            color: d.id === activeDesktopId ? "var(--accent)" : "var(--fg-secondary)",
            fontWeight: d.id === activeDesktopId ? 600 : 400,
            whiteSpace: "nowrap",
            transition: "background-color 0.1s",
            flexShrink: 0,
          }}
        >
          {renaming === d.id ? (
            <input
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: 12,
                padding: "1px 4px",
                width: 100,
                border: "1px solid var(--accent)",
                outline: "none",
              }}
            />
          ) : (
            d.name
          )}
        </div>
      ))}

      {/* New desktop button */}
      <button
        onClick={() => createDesktop(t("desktop.newDesktop", { n: desktops.length + 1 }))}
        title={t("desktop.newDesktopTitle")}
        aria-label={t("desktop.newDesktopTitle")}
        style={{
          border: "none",
          background: "none",
          cursor: "pointer",
          fontSize: 16,
          color: "var(--fg-muted)",
          padding: "4px 8px",
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        +
      </button>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            onClick={closeContextMenu}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 999,
            }}
          />
          <div
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
              zIndex: 1000,
              backgroundColor: "var(--bg-root)",
              border: "1px solid var(--border-medium)",
              borderRadius: 4,
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              padding: "4px 0",
              minWidth: 120,
            }}
          >
            <button
              onClick={() => {
                const d = desktops.find((dt) => dt.id === contextMenu.desktopId);
                if (d) startRename(d.id, d.name);
              }}
              style={menuItemStyle}
            >
              {t("files.rename")}
            </button>
            <button
              onClick={() => handleDelete(contextMenu.desktopId)}
              style={{ ...menuItemStyle, color: desktops.length <= 1 ? "var(--fg-muted)" : "var(--semantic-error)" }}
              disabled={desktops.length <= 1}
            >
              {t("desktop.delete")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 16px",
  border: "none",
  background: "none",
  cursor: "pointer",
  fontSize: 12,
  textAlign: "left",
  color: "var(--fg-primary)",
};
