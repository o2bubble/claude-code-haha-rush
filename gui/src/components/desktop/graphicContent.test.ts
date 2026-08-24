import { describe, it, expect } from "vitest";
import { isMermaidContent, graphicSearchText, graphicFitScale, normalizeGraphicContent } from "./graphicContent";

describe("isMermaidContent", () => {
  it("带 mermaid 字段 → true", () => {
    expect(isMermaidContent({ mermaid: "graph TD; A-->B" })).toBe(true);
  });
  it("只有 nodes/edges → false（旧结构化模式）", () => {
    expect(isMermaidContent({ nodes: [], edges: [] })).toBe(false);
  });
  it("空/无内容 → false", () => {
    expect(isMermaidContent(undefined)).toBe(false);
    expect(isMermaidContent({})).toBe(false);
  });
});

describe("graphicSearchText", () => {
  it("Mermaid 模式返回其文本", () => {
    expect(graphicSearchText({ mermaid: "graph TD;\n  A-->B" })).toBe("graph TD;\n  A-->B");
  });
  it("旧结构化模式拼接节点标签", () => {
    const content = {
      nodes: [
        { label: "开始" },
        { label: "处理" },
        { label: "结束" },
      ],
      edges: [],
    };
    expect(graphicSearchText(content)).toBe("开始 处理 结束");
  });
  it("无节点 → 空串", () => {
    expect(graphicSearchText({ nodes: [] })).toBe("");
  });
});

describe("graphicFitScale", () => {
  it("宽比例更紧时按宽缩放", () => {
    // svg 1000x500，box 400x300 → 宽 0.4，高 0.6 → 取 0.4
    expect(graphicFitScale(1000, 500, 400, 300)).toBeCloseTo(0.4);
  });
  it("高比例更紧时按高缩放", () => {
    expect(graphicFitScale(500, 1000, 400, 300)).toBeCloseTo(0.3);
  });
  it("svg 小于 box 时不放大超过 1（fit 上限 1）", () => {
    expect(graphicFitScale(100, 50, 400, 300)).toBeCloseTo(1);
  });
  it("零/负尺寸返回 1（防御）", () => {
    expect(graphicFitScale(0, 100, 400, 300)).toBe(1);
    expect(graphicFitScale(100, 0, 400, 300)).toBe(1);
    expect(graphicFitScale(100, 50, 0, 300)).toBe(1);
  });
});

describe("normalizeGraphicContent", () => {
  it("带 mermaid → 保留 Mermaid 模式", () => {
    expect(normalizeGraphicContent({ mermaid: "graph TD; A-->B" })).toEqual({ mermaid: "graph TD; A-->B" });
  });
  it("旧结构 → 规范化为 nodes/edges/subType（默认 flowchart）", () => {
    expect(normalizeGraphicContent({ nodes: [{ label: "n1" }], edges: [] })).toEqual({
      nodes: [{ label: "n1" }],
      edges: [],
      subType: "flowchart",
    });
  });
  it("空输入 → 默认示例 Mermaid 图", () => {
    expect(normalizeGraphicContent(undefined)).toEqual({ mermaid: "graph TD;\n  A-->B;" });
  });
});
