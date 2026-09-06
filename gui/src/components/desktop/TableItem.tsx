import React, { memo, useCallback, useMemo, useState } from "react";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type { DesktopItem, TableContent } from "../../types/desktop";
import { updateItem } from "../../stores/desktopStore";
import { t } from "../../i18n";
import { useEvent } from "../../services/useService";
import { Events, type SettingsChangedPayload } from "../../services/events";
import { isDarkTheme } from "../../utils/themeUtils";
import {
  toColumnDefs,
  toRowData,
  fromRowData,
  leafColumns,
  cellStyleFor,
  colSpanFor,
  gridThemeFor,
} from "../../utils/tableAdapter";

// AG Grid 36: 需显式注册 Community 模块（一次性）
ModuleRegistry.registerModules([AllCommunityModule]);

interface Props {
  item: DesktopItem;
}

function generateId() {
  return crypto.randomUUID();
}

function TableItemImpl({ item }: Props) {
  const content = item.content as TableContent;
  const { columns, rows } = content;
  const [editingHeader, setEditingHeader] = useState<string | null>(null); // colId

  const commit = useCallback(
    (patch: Partial<TableContent>) => {
      updateItem(item.id, { content: { ...content, ...patch } });
    },
    [item.id, content],
  );

  // ── AG Grid 数据（adapter 主 seam）──

  const columnDefs = useMemo(() => toColumnDefs(content), [content]);
  const rowData = useMemo(() => toRowData(content), [content]);

  // cellStyles → 逐格 cellClass 规则走 cellRenderer 太重，改用 colDef cellStyle 回调
  // （在 toColumnDefs 已含 valueFormatter；这里补动态样式回调 + colSpan 回调）
  const styledColumnDefs = useMemo(() => {
    const patch = (def: any): any => ({
      ...def,
      ...(def.field
        ? {
            cellStyle: (p: { data?: { id?: string }; colDef?: { field?: string } }) =>
              cellStyleFor(content, p.data?.id ?? "", p.colDef?.field ?? ""),
            colSpan: (p: { data?: { id?: string } }) =>
              colSpanFor(content, p.data?.id ?? "", def.field),
          }
        : {}),
      ...(def.children ? { children: def.children.map(patch) } : {}),
    });
    return columnDefs.map(patch);
  }, [columnDefs, content]);

  // ── 编辑回写（grid → store）──

  const handleCellValueChanged = useCallback(
    (p: { data: Record<string, string>; oldValue?: unknown; newValue?: unknown }) => {
      if (p.oldValue === p.newValue) return;
      const nextRows = fromRowData(content, [p.data]);
      // 只更新这一行（按 rowId 对齐，不整表替换 rows 引用外的内容）
      const rowId = p.data.id;
      const idx = rows.findIndex((r) => r.id === rowId);
      if (idx < 0) return;
      const newRows = [...rows];
      newRows[idx] = nextRows[0];
      commit({ rows: newRows });
    },
    [content, rows, commit],
  );

  // ── 结构操作（沿用原交互）──

  const addRow = () => {
    commit({ rows: [...rows, { id: generateId(), cells: Object.fromEntries(leafColumns(columns).map((c) => [c.id, ""])) }] });
  };

  const deleteRow = (rowId: string) => {
    commit({ rows: rows.filter((r) => r.id !== rowId) });
  };

  const addColumn = () => {
    const id = generateId();
    const name = t("desktop.block.colName", { n: leafColumns(columns).length + 1 });
    commit({
      columns: [...columns, { id, name }],
      rows: rows.map((r) => ({ ...r, cells: { ...r.cells, [id]: "" } })),
    });
  };

  const deleteColumn = (colId: string) => {
    const walk = (cols: typeof columns): typeof columns =>
      cols
        .filter((c) => c.id !== colId)
        .map((c) => (c.children ? { ...c, children: walk(c.children) } : c))
        // 组表头 children 空了就整组删除
        .filter((c) => !c.children || c.children.length > 0);
    commit({
      columns: walk(columns),
      rows: rows.map((r) => {
        const next = { ...r.cells };
        delete next[colId];
        return { ...r, cells: next };
      }),
    });
  };

  const renameColumn = (colId: string, name: string) => {
    const walk = (cols: typeof columns): typeof columns =>
      cols.map((c) =>
        c.id === colId ? { ...c, name } : c.children ? { ...c, children: walk(c.children) } : c,
      );
    commit({ columns: walk(columns) });
  };

  // 编辑态按键不穿透画布（与 title 编辑一致的守卫）
  const swallowKeys = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  // 主题：跟随设置变化（isDarkTheme 单一来源），切换即时重建 AG Grid theme
  const sp = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const isDark = isDarkTheme(
    sp?.settings?.theme ?? (typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined),
  );
  const gridTheme = useMemo(() => gridThemeFor(isDark), [isDark]);

  return (
    <div style={CONTAINER} onKeyDown={swallowKeys} onKeyUp={swallowKeys}>
      <div style={GRID_WRAP}>
        <AgGridReact
          theme={gridTheme as never}
          columnDefs={styledColumnDefs}
          rowData={rowData}
          getRowId={(p) => String(p.data.id)}
          defaultColDef={{ sortable: false, lockPinned: true, suppressMovable: true } as never}
          stopEditingWhenCellsLoseFocus
          suppressCellFocus={false}
          suppressRowClickSelection
          suppressDragLeaveHidesColumns
          onCellValueChanged={handleCellValueChanged as never}
          headerHeight={34}
          rowHeight={30}
        />
      </div>

      <div style={FOOTER}>
        <button onClick={addRow} style={ADD_ROW_BTN}>{t("desktop.block.addRow")}</button>
        <span style={ROW_COUNT}>{t("desktop.block.rowColCount", { r: rows.length, c: leafColumns(columns).length })}</span>
      </div>

      {/* 表头改名沿用：列出叶子列名 + 删除按钮（AG Grid 内嵌表头编辑复杂度高，首版沿用底部条） */}
      <div style={COL_BAR}>
        {leafColumns(columns).map((col) => (
          <span key={col.id} style={COL_CHIP}>
            {editingHeader === col.id ? (
              <input
                autoFocus
                value={col.name}
                onChange={(e) => renameColumn(col.id, e.target.value)}
                onBlur={() => setEditingHeader(null)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") setEditingHeader(null); }}
                style={HEADER_INPUT}
              />
            ) : (
              <span
                style={{ cursor: "pointer", whiteSpace: "nowrap" }}
                title={t("desktop.block.renameColumn")}
                onDoubleClick={() => setEditingHeader(col.id)}
              >
                {col.name}
              </span>
            )}
            {leafColumns(columns).length > 1 && (
              <button onClick={() => deleteColumn(col.id)} style={DEL_BTN} title={t("desktop.block.deleteColumn")}>×</button>
            )}
          </span>
        ))}
        <button onClick={addColumn} style={ADD_BTN} title={t("desktop.block.addColumn")}>+</button>
      </div>
    </div>
  );
}

export const TableItem = memo(TableItemImpl);

// ── Styles ──

const CONTAINER: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  fontSize: 12, fontFamily: "var(--font-sans)",
  gap: 4, padding: 4, boxSizing: "border-box",
};

const GRID_WRAP: React.CSSProperties = {
  flex: 1, minHeight: 0, width: "100%",
};

const FOOTER: React.CSSProperties = {
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

const COL_BAR: React.CSSProperties = {
  display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
  borderTop: "1px solid var(--border-light)", paddingTop: 4,
};

const COL_CHIP: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 2,
  padding: "1px 6px", border: "1px solid var(--border-light)", borderRadius: 3,
  fontSize: 11, color: "var(--fg-secondary)",
};

const HEADER_INPUT: React.CSSProperties = {
  width: 70, fontSize: 11, fontFamily: "inherit",
  padding: "1px 4px", border: "1px solid var(--accent)",
  borderRadius: 2, outline: "none",
};

const DEL_BTN: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: 12, color: "var(--fg-muted)", padding: 0,
  lineHeight: 1, opacity: 0.5,
};

const ADD_BTN: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: 14, color: "var(--accent)", padding: "0 4px",
  lineHeight: 1, fontWeight: 600,
};
