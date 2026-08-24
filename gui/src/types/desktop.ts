import type { Reference } from "./reference";

// ─── Content types for canvas items ───

export type ItemContentType = "text" | "chart" | "graphic" | "ref" | "file-group" | "image" | "form" | "drawing" | "table";

export interface TextContent {
  type: "text";
  format: "plain" | "markdown" | string; // language ID for hljs code preview
  text: string;
}

export interface ChartContent {
  type: "chart";
  /** 简单数据形式下决定渲染方式; 给了 series/option 时仅作提示, 不影响渲染 */
  chartType?: "bar" | "line" | "pie" | "scatter" | "area" | "radar" | "funnel" | "gauge";
  title?: string;
  /** 简单形式: { labels: string[], datasets: { label: string, data: number[] }[] }. 有 series/option 时忽略 */
  data?: Record<string, unknown>;
  /** 进阶形式: 直接传 ECharts series[]. 给定时覆盖 chartType+data 的自动映射 */
  series?: unknown[];
  /** 最高级形式: 完整 ECharts option (可含 series/xAxis/yAxis/legend 等). 给定时原样透传 */
  option?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface GraphicNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children?: string[]; // mindmap child node ids
}

export interface GraphicEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface GraphicContent {
  type: "graphic";
  /** 旧结构化模式：flowchart | mindmap */
  subType?: "flowchart" | "mindmap";
  /** 旧结构化模式：节点 */
  nodes?: GraphicNode[];
  /** 旧结构化模式：边 */
  edges?: GraphicEdge[];
  /** root node id for mindmap */
  rootId?: string;
  /** Mermaid 文本模式：非空时走 mermaid.js 渲染 */
  mermaid?: string;
}

export interface RefContent {
  type: "ref";
  references: Reference[];
  note?: string;
}

export interface FileGroupContent {
  type: "file-group";
  files: Reference[];
}

export interface ImageContent {
  type: "image";
  path: string;
  width?: number;
  height?: number;
}

export type FormFieldType = "text" | "textarea" | "number" | "checkbox" | "select" | "date" | "switch" | "radio" | "color" | "slider";

export interface FormField {
  id: string;
  name: string;
  type: FormFieldType;
  value: unknown;
  options?: string[];      // select/radio 选项
  placeholder?: string;
  required?: boolean;
  /** number/slider 专用 */
  min?: number;
  max?: number;
  step?: number;
  /** text 专用 */
  maxlength?: number;
  /** textarea 专用 */
  rows?: number;
}

export interface FormContent {
  type: "form";
  fields: FormField[];
}

// ─── Drawing element types (for AI-editable vector art) ───

interface Pt { x: number; y: number; }

export type DrawElement =
  | { id: string; type: "freehand"; points: Pt[]; color: string; strokeWidth: number; opacity: number; }
  | { id: string; type: "rect"; x: number; y: number; w: number; h: number; color: string; strokeWidth: number; fillColor: string | null; opacity: number; }
  | { id: string; type: "circle"; cx: number; cy: number; r: number; color: string; strokeWidth: number; fillColor: string | null; opacity: number; }
  | { id: string; type: "line"; x1: number; y1: number; x2: number; y2: number; color: string; strokeWidth: number; opacity: number; }
  | { id: string; type: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; strokeWidth: number; opacity: number; }
  | { id: string; type: "text"; x: number; y: number; text: string; color: string; fontSize: number; opacity: number; };

export interface DrawingContent {
  type: "drawing";
  svg: string;         // full SVG markup (always present, for view mode)
  width: number;       // viewBox width
  height: number;      // viewBox height
  elements?: DrawElement[]; // editable stroke elements (user can edit when present)
}

export interface TableColumn {
  id: string;
  name: string;
  width?: number;
}

export interface TableRow {
  id: string;
  cells: Record<string, string>; // keyed by column id
}

export interface TableContent {
  type: "table";
  columns: TableColumn[];
  rows: TableRow[];
}

export type ItemContent = TextContent | ChartContent | GraphicContent | RefContent | FileGroupContent | ImageContent | FormContent | DrawingContent | TableContent;

// ─── Canvas item ───

export interface DesktopItem {
  id: string;
  desktopId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  content: ItemContent;
  label: string;
  color?: string;
  collapsed?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Connection ───

export interface ConnectionAnchor {
  itemId: string;
  side: "top" | "right" | "bottom" | "left" | "center";
}

export interface Connection {
  id: string;
  desktopId: string;
  from: ConnectionAnchor;
  to: ConnectionAnchor;
  label?: string;
  strokeColor?: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  createdAt: number;
}

// ─── Desktop ───

export interface Desktop {
  id: string;
  name: string;
  items: DesktopItem[];
  connections: Connection[];
  panX: number;
  panY: number;
  zoom: number;
  showGrid: boolean;
  gridSize: number;
  snapToGrid: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── AI-facing summary (lightweight, no content payload) ───

export interface DesktopItemSummary {
  id: string;
  type: ItemContentType;
  label: string;
  x: number; y: number;
  width: number; height: number;
  zIndex: number;
  /** Screen pixel position within the current viewport */
  screenX: number; screenY: number;
  /** Whether the item is visible in the current viewport */
  visible: "full" | "partial" | "none";
  selected: boolean;
}

export interface DesktopSummary {
  desktops: Array<{
    id: string;
    name: string;
    itemCount: number;
  }>;
  activeId: string;
  activeDesktop: {
    viewport: {
      panX: number;
      panY: number;
      zoom: number;
    };
    items: DesktopItemSummary[];
    connections: Desktop["connections"];
  };
}
