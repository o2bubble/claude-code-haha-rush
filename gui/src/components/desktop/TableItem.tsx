import React, { memo, useCallback, useState } from "react";
import type { DesktopItem, TableContent } from "../../types/desktop";
import { updateItem } from "../../stores/desktopStore";
import { t } from "../../i18n";

interface Props {
  item: DesktopItem;
}

function generateId() {
  return crypto.randomUUID();
}

function TableItemImpl({ item }: Props) {
  const content = item.content as TableContent;
  const { columns, rows } = content;
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editingHeader, setEditingHeader] = useState<number | null>(null);

  const commit = useCallback(
    (patch: Partial<TableContent>) => {
      updateItem(item.id, { content: { ...content, ...patch } });
    },
    [item.id, content],
  );

  // ── Rows ──

  const addRow = () => {
    const newRow = {
      id: generateId(),
      cells: Object.fromEntries(columns.map((c) => [c.id, ""])),
    };
    commit({ rows: [...rows, newRow] });
  };

  const deleteRow = (rowIdx: number) => {
    commit({ rows: rows.filter((_, i) => i !== rowIdx) });
  };

  const setCellValue = (rowIdx: number, colId: string, value: string) => {
    const newRows = rows.map((r, i) => {
      if (i !== rowIdx) return r;
      return { ...r, cells: { ...r.cells, [colId]: value } };
    });
    commit({ rows: newRows });
  };

  // ── Columns ──

  const addColumn = () => {
    const id = generateId();
    const name = t("desktop.block.colName", { n: columns.length + 1 });
    commit({
      columns: [...columns, { id, name }],
      rows: rows.map((r) => ({ ...r, cells: { ...r.cells, [id]: "" } })),
    });
  };

  const deleteColumn = (colIdx: number) => {
    const targetId = columns[colIdx].id;
    commit({
      columns: columns.filter((_, i) => i !== colIdx),
      rows: rows.map((r) => {
        const next = { ...r.cells };
        delete next[targetId];
        return { ...r, cells: next };
      }),
    });
  };

  const renameColumn = (colIdx: number, name: string) => {
    commit({ columns: columns.map((c, i) => i === colIdx ? { ...c, name } : c) });
  };

  // ── Keyboard navigation ──

  const handleCellKeyDown = (e: React.KeyboardEvent, rowIdx: number, colIdx: number) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setEditingCell(null);
      const nextCol = e.shiftKey ? colIdx - 1 : colIdx + 1;
      if (nextCol >= 0 && nextCol < columns.length) {
        setEditingCell({ row: rowIdx, col: nextCol });
      } else if (!e.shiftKey && rowIdx + 1 < rows.length) {
        setEditingCell({ row: rowIdx + 1, col: 0 });
      } else if (e.shiftKey && rowIdx - 1 >= 0) {
        setEditingCell({ row: rowIdx - 1, col: columns.length - 1 });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      setEditingCell(null);
    } else if (e.key === "Escape") {
      setEditingCell(null);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rowIdx + 1 < rows.length) setEditingCell({ row: rowIdx + 1, col: colIdx });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowIdx - 1 >= 0) setEditingCell({ row: rowIdx - 1, col: colIdx });
    }
  };

  const colCount = columns.length;

  return (
    <div style={CONTAINER}>
      <table style={TABLE}>
        <thead>
          <tr>
            {columns.map((col, ci) => (
              <th
                key={col.id}
                style={{ ...TH, width: col.width || undefined }}
                onDoubleClick={() => setEditingHeader(ci)}
              >
                {editingHeader === ci ? (
                  <input
                    autoFocus
                    value={col.name}
                    onChange={(e) => renameColumn(ci, e.target.value)}
                    onBlur={() => setEditingHeader(null)}
                    onKeyDown={(e) => { if (e.key === "Enter") setEditingHeader(null); }}
                    style={HEADER_INPUT}
                  />
                ) : (
                  <span style={{ cursor: "pointer" }} title={t("desktop.block.renameColumn")}>{col.name}</span>
                )}
                {colCount > 1 && (
                  <button onClick={() => deleteColumn(ci)} style={DEL_BTN} title={t("desktop.block.deleteColumn")}>×</button>
                )}
              </th>
            ))}
            <th style={TH_ADD}>
              <button onClick={addColumn} style={ADD_BTN} title={t("desktop.block.addColumn")}>+</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount + 1} style={EMPTY_ROW}>
                {t("desktop.block.emptyTable")}
              </td>
            </tr>
          ) : (
            rows.map((row, ri) => (
              <tr key={row.id} style={ri % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                {columns.map((col, ci) => {
                  const isEditing = editingCell?.row === ri && editingCell?.col === ci;
                  const value = row.cells[col.id] ?? "";
                  return (
                    <td
                      key={col.id}
                      style={TD}
                      onClick={() => setEditingCell({ row: ri, col: ci })}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={value}
                          onChange={(e) => setCellValue(ri, col.id, e.target.value)}
                          onBlur={() => setEditingCell(null)}
                          onKeyDown={(e) => handleCellKeyDown(e, ri, ci)}
                          style={CELL_INPUT}
                        />
                      ) : (
                        <span style={CELL_TEXT}>{value || "\u00A0"}</span>
                      )}
                    </td>
                  );
                })}
                <td style={TD_DEL}>
                  <button onClick={() => deleteRow(ri)} style={DEL_BTN} title={t("desktop.block.deleteRow")}>×</button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div style={FOOTER}>
        <button onClick={addRow} style={ADD_ROW_BTN}>{t("desktop.block.addRow")}</button>
        <span style={ROW_COUNT}>{t("desktop.block.rowColCount", { r: rows.length, c: colCount })}</span>
      </div>
    </div>
  );
}

export const TableItem = memo(TableItemImpl);

// ── Styles ──

const CONTAINER: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  fontSize: 12, fontFamily: "var(--font-sans)",
  overflow: "auto",
};

const TABLE: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse",
  tableLayout: "auto",
};

const TH: React.CSSProperties = {
  position: "sticky", top: 0,
  backgroundColor: "var(--bg-surface)", color: "var(--fg-secondary)",
  fontWeight: 600, fontSize: 11, textAlign: "left",
  padding: "4px 6px", borderBottom: "2px solid var(--border-light)",
  userSelect: "none", whiteSpace: "nowrap",
};

const TH_ADD: React.CSSProperties = {
  ...TH, width: 32, textAlign: "center", padding: "2px",
};

const HEADER_INPUT: React.CSSProperties = {
  width: "100%", fontSize: 11, fontFamily: "inherit",
  padding: "1px 4px", border: "1px solid var(--accent)",
  borderRadius: 2, outline: "none",
};

const TD: React.CSSProperties = {
  padding: "3px 6px", borderBottom: "1px solid var(--border-light)",
  cursor: "text", minWidth: 60, maxWidth: 300,
};

const CELL_TEXT: React.CSSProperties = {
  display: "block", minHeight: 16, overflow: "hidden",
  textOverflow: "ellipsis", whiteSpace: "nowrap",
};

const CELL_INPUT: React.CSSProperties = {
  width: "100%", fontSize: 12, fontFamily: "inherit",
  padding: "1px 4px", border: "1px solid var(--accent)",
  borderRadius: 2, outline: "none", minWidth: 60,
};

const TD_DEL: React.CSSProperties = {
  ...TD, width: 28, textAlign: "center", cursor: "default", padding: "2px",
};

const ROW_EVEN: React.CSSProperties = {};
const ROW_ODD: React.CSSProperties = { backgroundColor: "var(--bg-hover)" };

const EMPTY_ROW: React.CSSProperties = {
  padding: 24, textAlign: "center", color: "var(--fg-muted)", fontSize: 12,
};

const DEL_BTN: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: 14, color: "var(--fg-muted)", padding: 0,
  lineHeight: 1, opacity: 0.5,
};

const ADD_BTN: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: 16, color: "var(--accent)", padding: 0,
  lineHeight: 1, fontWeight: 600,
};

const FOOTER: React.CSSProperties = {
  padding: "4px 8px", borderTop: "1px solid var(--border-light)",
  display: "flex", justifyContent: "space-between", alignItems: "center",
};

const ADD_ROW_BTN: React.CSSProperties = {
  fontSize: 11, padding: "2px 10px", border: "1px dashed var(--border-medium)",
  borderRadius: 3, background: "var(--bg-root)",
  color: "var(--fg-muted)", cursor: "pointer",
};

const ROW_COUNT: React.CSSProperties = {
  fontSize: 10, color: "var(--fg-muted)",
};
