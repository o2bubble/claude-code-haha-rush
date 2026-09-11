// graphicContent.ts — 超级桌面图形内容的纯逻辑
// 图形 item 支持两种模式：Mermaid 文本（mermaid.js 渲染）与旧的结构化 nodes/edges。
// 本模块集中判别、搜索文本提取、fit 缩放、内容规范化 —— 全部纯函数，便于单测。

/** 是否为 Mermaid 模式（content 带非空 mermaid 字段） */
export function isMermaidContent(content: unknown): boolean {
  return !!(content && typeof content === "object" && (content as any).mermaid);
}

/** 提取图形的可搜索文本：Mermaid 模式返回其文本，旧模式拼接节点标签 */
export function graphicSearchText(content: unknown): string {
  const c = content as any;
  if (isMermaidContent(c)) return c.mermaid;
  const nodes = Array.isArray(c?.nodes) ? c.nodes : [];
  return nodes.map((n: any) => n?.label || "").join(" ");
}

/** Mermaid SVG 等比适配 box 的缩放比例（保持比例、最大 1，不放大） */
export function graphicFitScale(svgW: number, svgH: number, boxW: number, boxH: number): number {
  if (svgW <= 0 || svgH <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(1, Math.min(boxW / svgW, boxH / svgH));
}

/** 规范化图形内容：Mermaid 文本 → 保留；旧 nodes/edges → 结构化；空 → 默认示例 */
export function normalizeGraphicContent(
  raw: unknown
): { mermaid?: string; nodes?: unknown[]; edges?: unknown[]; subType?: string } {
  const c = raw as any;
  if (c?.mermaid) return { mermaid: c.mermaid };
  if (Array.isArray(c?.nodes) || Array.isArray(c?.edges)) {
    return {
      nodes: c.nodes || [],
      edges: c.edges || [],
      subType: c.subType || "flowchart",
    };
  }
  return { mermaid: "graph TD;\n  A-->B;" };
}
