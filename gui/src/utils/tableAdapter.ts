// tableAdapter — 自有 TableContent ⇄ AG Grid 的双向转换纯函数（无 React/DOM 依赖）。
// 架构决策（grilling 定稿）：持久化/AI/同步只见自有 schema，AG Grid 仅是渲染层——
// 将来换库只改本文件。旧数据（无 children/cellStyles/formats/pinned）零迁移。
import type {
  ColDef,
  ColGroupDef,
  ValueFormatterParams,
} from "ag-grid-community";
import { themeQuartz } from "ag-grid-community";
import type { TableContent, TableColumn, TableCell } from "../types/desktop";
import { isDarkTheme } from "./themeUtils";

// ── Schema 遍历 ──

/** 按顺序展开全部叶子列（组表头不承载数据，叶子才承载） */
export function leafColumns(columns: TableColumn[]): TableColumn[] {
  const out: TableColumn[] = [];
  const walk = (cols: TableColumn[]) => {
    for (const c of cols) {
      if (c.children?.length) walk(c.children);
      else out.push(c);
    }
  };
  walk(columns);
  return out;
}

// ── 数字格式 → AG Grid valueFormatter ──

/** 千分位 + 固定小数位（"0,0.00"）与百分比（"0%"）两种 AI 常用格式 */
function formatNumber(value: unknown, fmt: string): string {
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || value == null || Number.isNaN(n)) return value == null ? "" : String(value);
  if (fmt === "0%") {
    return `${(n * 100).toFixed(0)}%`;
  }
  // "0,0" / "0,0.00" / "0,0.0" — 千分位 + 小数位由小数点后位数决定
  const decimals = fmt.includes(".") ? fmt.split(".")[1].length : 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 列级数字格式串（如 "0,0.00"/"0%"），无则 undefined */
export function formatFor(content: TableContent, colId: string): string | undefined {
  return content.formats?.[colId];
}

function valueFormatterFor(fmt: string | undefined) {
  if (!fmt) return undefined;
  return (p: ValueFormatterParams) => formatNumber(p.value, fmt);
}

// ── 单元格样式 ──

/** cellStyles 的 key 规约（"rowId:colId"）——唯一构造点，防两处手拼漂移 */
export function cellStyleKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

/** 某格的 colSpan（>1 才合并）；供 colSpan 回调用，与 CSS 样式解耦 */
export function colSpanFor(content: TableContent, rowId: string, colId: string): number {
  const s = content.cellStyles?.[cellStyleKey(rowId, colId)];
  return s?.colSpan && s.colSpan > 1 ? s.colSpan : 1;
}

/** 取某格样式并映射为 AG Grid cellStyle（纯 CSS 对象）；未命中/无样式返回 undefined */
export function cellStyleFor(content: TableContent, rowId: string, colId: string): Record<string, string> | undefined {
  const s: TableCell | undefined = content.cellStyles?.[cellStyleKey(rowId, colId)];
  if (!s) return undefined;
  const out: Record<string, string> = {};
  if (s.color) out.color = s.color;
  if (s.bgColor) out.backgroundColor = s.bgColor;
  if (s.bold) out.fontWeight = "bold";
  if (s.italic) out.fontStyle = "italic";
  if (s.align) out.textAlign = s.align;
  return Object.keys(out).length ? out : undefined;
}

// ── 列定义 ──

function leafColDef(content: TableContent, col: TableColumn): ColDef {
  const fmt = formatFor(content, col.id);
  const def: ColDef = {
    field: col.id,
    headerName: col.name,
    editable: true,
    resizable: true,
    ...(col.width ? { width: col.width } : {}),
    ...(col.pinned ? { pinned: col.pinned } : {}),
    ...(fmt ? { valueFormatter: valueFormatterFor(fmt) } : {}),
  };
  return def;
}

/**
 * 自有 columns（树）→ AG Grid 列定义（组表头递归为 columnGroup children）。
 * 旧数据（扁平列、无 pinned/formats）产出与旧行为等价的纯字段列。
 */
export function toColumnDefs(content: TableContent): (ColDef | ColGroupDef)[] {
  const walk = (cols: TableColumn[]): (ColDef | ColGroupDef)[] =>
    cols.map((c) =>
      c.children?.length
        ? { headerName: c.name, marryChildren: true, children: walk(c.children) }
        : leafColDef(content, c),
    );
  return walk(content.columns);
}

// ── 行数据 ──

/**
 * rows.cells（Record<colId, string>）→ 平铺 rowData（leaf colId 为 key）。
 * 缺失 cell 补空串（防 undefined 渲染）；rowId 存进 `id` 供编辑回写定位。
 */
export function toRowData(content: TableContent): Record<string, string>[] {
  const leaves = leafColumns(content.columns).map((c) => c.id);
  return content.rows.map((r) => {
    const out: Record<string, string> = { id: r.id };
    for (const colId of leaves) out[colId] = r.cells[colId] ?? "";
    return out;
  });
}

/** rowData 编辑回写：从 grid rowData 还原 rows.cells（只写叶子列，rowId 对齐） */
export function fromRowData(content: TableContent, rowData: Record<string, string>[]): TableContent["rows"] {
  const leaves = new Set(leafColumns(content.columns).map((c) => c.id));
  return rowData.map((r) => {
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== "id" && leaves.has(k)) cells[k] = v;
    }
    return { id: r.id ?? crypto.randomUUID(), cells };
  });
}

// ── 主题（对齐 CSS 变量，暗色 4 档统一判定走 themeUtils.isDarkTheme）──

/** 亮/暗共享的布局参数（差异只在配色） */
const GRID_THEME_BASE = {
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 12,
  headerFontSize: 12,
  cellHorizontalPadding: 10,
  rowHeight: 30,
  headerHeight: 34,
  wrapperBorder: false,
} as const;

/** AG Grid 36 Theming API 参数 —— 跟随亮/暗主题 */
export function gridThemeParams(isDark: boolean): Record<string, unknown> {
  return isDark
    ? {
        ...GRID_THEME_BASE,
        accentColor: "#4a9eff",
        backgroundColor: "#1e1e2e",
        foregroundColor: "#d0d0d8",
        borderColor: "#3a3a4a",
        headerBackgroundColor: "#262636",
        headerTextColor: "#e0e0e8",
        oddRowBackgroundColor: "#232333",
      }
    : {
        ...GRID_THEME_BASE,
        accentColor: "#1a73e8",
        backgroundColor: "#ffffff",
        foregroundColor: "#1a1a1a",
        borderColor: "#e0e0e0",
        headerBackgroundColor: "#f5f5f5",
        headerTextColor: "#1a1a1a",
        oddRowBackgroundColor: "#fafafa",
      };
}

/** 由 isDark 构造 AG Grid Theme（调用方用 isDarkTheme 判定并响应主题切换） */
export function gridThemeFor(isDark: boolean) {
  return themeQuartz.withParams(gridThemeParams(isDark) as Record<string, never>);
}
