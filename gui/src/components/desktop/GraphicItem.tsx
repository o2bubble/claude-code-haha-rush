import React, { memo, useEffect, useRef, useState, useCallback } from "react";
import type { DesktopItem, GraphicContent, GraphicNode, GraphicEdge } from "../../types/desktop";
import { updateItem } from "../../stores/desktopStore";
import { registerDataSource, unloadDataSource } from "../../services/dataRegistry";
import { isMermaidContent } from "./graphicContent";
import { MermaidDialog } from "./MermaidDialog";
import { isDarkTheme } from "../../utils/themeUtils";
import { t } from "../../i18n";
import { useContentZoom } from "./useContentZoom";

interface Props {
  item: DesktopItem;
}

const NODE_W = 140;
const NODE_H = 50;
const COLORS = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#b07aa1", "#edc948"];

function GraphicItemImpl({ item }: Props) {
  const content = item.content as GraphicContent;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);

  const isMermaid = isMermaidContent(content);
  const isDark = typeof document !== "undefined" && isDarkTheme(document.documentElement.dataset.theme);
  // SVG 属性不能用 CSS 变量(var 在 fill/stroke 不生效), 按主题取具体色
  const nodeFill = isDark ? "#2d2d2d" : "#ffffff";
  const nodeStroke = isDark ? "#505050" : "#dddddd";
  const nodeText = isDark ? "#d4d4d4" : "#333333";
  const edgeStroke = isDark ? "#6e6e6e" : "#bbbbbb";
  const edgeLabel = isDark ? "#999999" : "#aaaaaa";

  const nodes = content.nodes || [];
  const edges = content.edges || [];
  // 内容内部缩放（Ctrl/Cmd+滚轮）—— 两种模式共用同一 hook，分工见 useContentZoom
  // 结构化模式：内容可能超出固定视口，1x 时也允许平移（panAlways）
  // 两模式互斥渲染，同一 hook 各绑一次；svgRef 另有节点拖拽用途，故组合绑定。
  const czSvg = useContentZoom({ panAlways: true });
  const czMermaid = useContentZoom();

  // ── Mermaid 渲染（懒加载 mermaid.js；fit 适配 item；主题跟随；错误保留文本）──

  const [mermaidSvg, setMermaidSvg] = useState<string | null>(null);
  const [mermaidErr, setMermaidErr] = useState<string | null>(null);
  const mermaidReq = useRef(0);
  const [showMermaidEdit, setShowMermaidEdit] = useState(false);

  useEffect(() => {
    if (!isMermaid || !content.mermaid) return;
    let cancelled = false;
    const reqId = ++mermaidReq.current;
    setMermaidSvg(null);
    setMermaidErr(null);
    (async () => {
      try {
        const mod: any = await import("mermaid");
        const mermaid = mod.default ?? mod;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "default",
          // 用项目已备的高对比度配色覆盖主题，避免 Mermaid 内建主题在某版本/子类型
          // 下节点文字与底色对比度低（如浅字配浅底）导致看不清。沿用上方 nodeText 等色值。
          themeVariables: isDark
            ? {
                primaryColor: nodeFill,       // 节点底（深灰 #2d2d2d）
                primaryTextColor: nodeText,   // 节点文字（浅灰 #d4d4d4）
                primaryBorderColor: nodeStroke,// 节点描边
                lineColor: edgeStroke,        // 边线
                nodeTextColor: nodeText,      // 节点文字（flowchart 节点）
                textColor: nodeText,
                edgeLabelBackground: nodeFill, // 边标签底，避免透明映出低对比
              }
            : undefined,
        });
        const { svg } = await mermaid.render(`gm-${reqId}-${Date.now()}`, content.mermaid);
        if (!cancelled) setMermaidSvg(svg);
      } catch (e: any) {
        if (!cancelled) setMermaidErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [item.id, isMermaid, content.mermaid, isDark]);

  // ── Data registry (AI-driven) ──

  useEffect(() => {
    registerDataSource({
      itemId: item.id,
      desktopId: item.desktopId,
      label: item.label,
      contentType: "graphic",
      dataKeys: ["nodes", "edges", "mermaid", "structure"],
      queryHandler: (key: string) => {
        switch (key) {
          case "nodes": return { keys: ["nodes"], value: nodes };
          case "edges": return { keys: ["edges"], value: edges };
          case "mermaid": return { keys: ["mermaid"], value: content.mermaid };
          case "structure": return { keys: ["structure"], value: isMermaid ? { type: "mermaid", text: content.mermaid } : { nodes, edges, subType: content.subType } };
          default: return undefined;
        }
      },
      opHandler: (op: string, params?: Record<string, unknown>) => {
        if (op === "update_data" && params) {
          const update: any = {};
          if (params.nodes) update.nodes = params.nodes as GraphicNode[];
          if (params.edges) update.edges = params.edges as GraphicEdge[];
          if (params.mermaid) update.mermaid = params.mermaid as string;
          if (Object.keys(update).length > 0) {
            updateItem(item.id, { content: { ...content, ...update } } as any);
            return { success: true };
          }
        }
        return { success: false, error: `Unknown operation: ${op}` };
      },
    });
    return () => unloadDataSource(item.id);
  }, [item.id, item.desktopId, item.label, nodes, edges, content.subType, content.mermaid, isMermaid]);

  // ── Node drag ──

  const handleNodeMouseDown = useCallback((nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDragNodeId(nodeId);
  }, []);

  useEffect(() => {
    if (!dragNodeId) return;
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    const onMove = (e: MouseEvent) => {
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const svgPt = pt.matrixTransform(ctm.inverse());
      const newNodes = nodes.map((n) =>
        n.id === dragNodeId ? { ...n, x: svgPt.x - n.width / 2, y: svgPt.y - 20 } : n
      );
      updateItem(item.id, { content: { ...content, nodes: newNodes } } as any);
    };
    const onUp = () => setDragNodeId(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragNodeId, nodes, item.id, content]);

  // ── Auto-layout ──

  const autoLayout = () => {
    if (isFlowchart) {
      const inDegree = new Map<string, number>();
      const childMap = new Map<string, string[]>();
      for (const n of nodes) { inDegree.set(n.id, 0); childMap.set(n.id, []); }
      for (const e of edges) {
        inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
        childMap.get(e.from)?.push(e.to);
      }
      let roots = nodes.filter((n) => (inDegree.get(n.id) || 0) === 0).map((n) => n.id);
      if (roots.length === 0) roots = [nodes[0].id];

      const levels: string[][] = [];
      const visited = new Set<string>();
      let current = roots;
      while (current.length > 0) {
        levels.push(current);
        current.forEach((id) => visited.add(id));
        const next: string[] = [];
        for (const id of current)
          for (const child of childMap.get(id) || [])
            if (!visited.has(child) && !next.includes(child)) next.push(child);
        current = next;
      }
      const unvisited = nodes.filter((n) => !visited.has(n.id));
      if (unvisited.length > 0) levels.push(unvisited.map((n) => n.id));

      const newNodes = nodes.map((n) => ({ ...n, width: NODE_W, height: NODE_H }));
      const maxLevelLen = Math.max(...levels.map((l) => l.length), 1);
      const rowW = maxLevelLen * (NODE_W + 30);
      levels.forEach((level, li) => {
        const rowX = (rowW - level.length * (NODE_W + 30)) / 2;
        level.forEach((id, ni) => {
          const node = newNodes.find((n) => n.id === id);
          if (node) {
            node.x = rowX + ni * (NODE_W + 30);
            node.y = 20 + li * (NODE_H + 50);
          }
        });
      });
      updateItem(item.id, { content: { ...content, nodes: newNodes } } as any);
    } else {
      const root = nodes.find((n) => n.id === (content.rootId || nodes[0]?.id));
      if (!root) return;
      const kidMap = new Map<string, string[]>();
      for (const n of nodes) kidMap.set(n.id, []);
      for (const e of edges) kidMap.get(e.from)?.push(e.to);
      const newNodes = nodes.map((n) => ({ ...n, width: NODE_W, height: NODE_H }));
      const layOut = (nodeId: string, x: number, y: number): number => {
        const node = newNodes.find((n) => n.id === nodeId);
        if (!node) return x;
        node.x = x; node.y = y;
        const kids = kidMap.get(nodeId) || [];
        if (kids.length === 0) return x + NODE_W + 30;
        let cx = x;
        for (const kid of kids) cx = layOut(kid, cx, y + NODE_H + 50);
        const last = newNodes.find((n) => n.id === kids[kids.length - 1]);
        node.x = (x + (last ? last.x + NODE_W : x + NODE_W)) / 2 - NODE_W / 2;
        return Math.max(cx, x + NODE_W + 30);
      };
      layOut(root.id, 30, 20);
      updateItem(item.id, { content: { ...content, nodes: newNodes } } as any);
    }
  };

  // ── SVG pan/zoom ──
  // 缩放/平移/复位统一由 useContentZoom 提供；节点（rect/text）上的按下不平移，
  // 让给节点拖拽（handleNodeMouseDown）。

  const handleSvgMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as Element;
    if (target.closest("rect") || target.closest("text") || target.closest("button")) return;
    czSvg.onMouseDown(e);
  }, [czSvg]);

  // ── Render ──

  const svgW = Math.max(400, item.width - 16);
  const svgH = Math.max(150, item.height - 32);
  const markerId = `arrow-${item.id}`;
  const isFlowchart = content.subType !== "mindmap";

  // ── Mermaid 模式：mermaid.js 渲染的 SVG，等比 fit 适配 item（viewBox + max 约束）──
  // 内部缩放走 czMermaid（Ctrl/Cmd+滚轮）。注意**双击已被"编辑源码"占用**，
  // 故复位只能靠角标按钮（结构化模式无此冲突，双击即复位）。
  if (isMermaid) {
    return (
      <div
        ref={czMermaid.ref}
        data-wheel-zoom
        onMouseDown={czMermaid.onMouseDown}
        title={t("desktop.block.zoomHint")}
        style={{ padding: 4, height: "100%", overflow: "hidden", position: "relative", cursor: czMermaid.cursor }}
      >
        <style>{`.mermaid-graphic-svg svg{width:auto !important;max-width:100%;max-height:100%;height:auto !important;display:block;}`}</style>
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", ...czMermaid.style }}>
        {mermaidErr ? (
          <div style={{ color: "var(--semantic-error)", fontSize: 12, maxWidth: "100%", overflow: "auto", textAlign: "center" }}>
            {t("desktop.mermaidError")}
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{mermaidErr}</div>
          </div>
        ) : mermaidSvg ? (
          <div
            className="mermaid-graphic-svg"
            onDoubleClick={(e) => { e.stopPropagation(); setShowMermaidEdit(true); }}
            style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
            dangerouslySetInnerHTML={{ __html: mermaidSvg }}
          />
        ) : (
          <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{t("common.loading")}</div>
        )}
        </div>

        {czMermaid.isZoomed && (
          <button
            onClick={(e) => { e.stopPropagation(); czMermaid.reset(); }}
            title={t("desktop.block.zoomReset")}
            style={{
              position: "absolute", bottom: 6, right: 6,
              padding: "2px 8px", borderRadius: 4, cursor: "pointer",
              border: "1px solid var(--border-medium)", background: "var(--bg-root)",
              color: "var(--fg-primary)", fontFamily: "var(--font-sans)", fontSize: 11,
            }}
          >{Math.round(czMermaid.zoom * 100)}% ↺</button>
        )}

        {showMermaidEdit && (
          <MermaidDialog
            title={t("desktop.mermaidDialogTitle")}
            initial={content.mermaid || ""}
            onConfirm={(text) => {
              updateItem(item.id, { content: { ...content, mermaid: text } } as any);
              setShowMermaidEdit(false);
            }}
            onClose={() => setShowMermaidEdit(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div
      title={t("desktop.block.zoomHint")}
      style={{ padding: 4, height: "100%", display: "flex", flexDirection: "column" }}
    >
      <svg
        ref={(node) => { svgRef.current = node; czSvg.ref(node); }}
        data-wheel-zoom
        width={svgW}
        height={svgH}
        onMouseDown={handleSvgMouseDown}
        onDoubleClick={czSvg.onDoubleClick}
        style={{ flex: 1, backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-light)", borderRadius: 4, overflow: "hidden", minHeight: 0, cursor: czSvg.cursor }}
      >
        <defs>
          <marker id={markerId} markerWidth="10" markerHeight="7" refX="8" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill={edgeStroke} />
          </marker>
        </defs>

        {/* Transformed content group */}
        <g transform={czSvg.svgTransform}>
          {/* Edges */}
          {edges.map((edge: GraphicEdge) => {
          const fromNode = nodes.find((n: GraphicNode) => n.id === edge.from);
          const toNode = nodes.find((n: GraphicNode) => n.id === edge.to);
          if (!fromNode || !toNode) return null;

          if (isFlowchart) {
            const x1 = fromNode.x + fromNode.width / 2;
            const y1 = fromNode.y + fromNode.height;
            const x2 = toNode.x + toNode.width / 2;
            const y2 = toNode.y;
            const midY = (y1 + y2) / 2;
            const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
            return (
              <g key={edge.id}>
                <path d={d} fill="none" stroke={edgeStroke} strokeWidth={1.5} markerEnd={`url(#${markerId})`} />
                {edge.label && (
                  <text x={(x1 + x2) / 2} y={midY - 4} textAnchor="middle" fontSize={10} fill={edgeLabel}>{edge.label}</text>
                )}
              </g>
            );
          } else {
            const px = fromNode.x + fromNode.width / 2;
            const py = fromNode.y + fromNode.height;
            const cx = toNode.x + toNode.width / 2;
            const cy = toNode.y;
            const d = `M ${px} ${py} C ${px} ${(py + cy) / 2}, ${cx} ${(py + cy) / 2}, ${cx} ${cy}`;
            return (
              <g key={edge.id}>
                <path d={d} fill="none" stroke={edgeStroke} strokeWidth={1.2} />
                {edge.label && (
                  <text x={(px + cx) / 2} y={(py + cy) / 2 - 4} textAnchor="middle" fontSize={9} fill={edgeLabel}>{edge.label}</text>
                )}
              </g>
            );
          }
        })}

        {/* Nodes */}
        {nodes.map((node: GraphicNode, ni: number) => {
          const color = COLORS[ni % COLORS.length];
          const isDragging = dragNodeId === node.id;
          return (
            <g key={node.id}>
              <rect
                x={node.x} y={node.y} width={node.width} height={node.height} rx={6}
                fill={nodeFill} stroke={isDragging ? color : nodeStroke} strokeWidth={isDragging ? 2 : 1}
                filter={isDragging ? "drop-shadow(2px 3px 4px rgba(0,0,0,0.15))" : undefined}
              />
              <path d={`M ${node.x + 5} ${node.y + 6} L ${node.x + 5} ${node.y + node.height - 6}`} stroke={color} strokeWidth={5} strokeLinecap="round" />
              <text
                x={node.x + node.width / 2 + 3} y={node.y + node.height / 2 + 5}
                textAnchor="middle" fontSize={12} fontWeight={500} fill={nodeText}
                onMouseDown={(e) => handleNodeMouseDown(node.id, e)}
                style={{ cursor: "move", userSelect: "none" }}
              >
                {node.label.length > 20 ? node.label.slice(0, 18) + "\u2026" : node.label}
              </text>
            </g>
          );
        })}
        </g>
      </svg>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
        <button onClick={autoLayout} style={{ fontSize: 12, padding: "3px 8px", border: "1px solid var(--border-medium)", borderRadius: 3, background: "var(--bg-root)", color: "var(--fg-primary)", cursor: "pointer" }}>Auto Layout</button>
        <button
          onClick={czSvg.reset}
          title={t("desktop.block.zoomReset")}
          style={{ fontSize: 11, padding: "3px 8px", border: 0, borderRadius: 3, background: "transparent", color: "var(--fg-muted)", cursor: "pointer", fontFamily: "var(--font-sans)" }}
        >{Math.round(czSvg.zoom * 100)}% ↺</button>
      </div>
    </div>
  );
}
export const GraphicItem = memo(GraphicItemImpl);
