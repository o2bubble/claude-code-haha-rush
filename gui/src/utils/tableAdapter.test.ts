// tableAdapter — 自有 TableContent ⇄ AG Grid（colDef/rowData/cellStyle）双向转换纯函数。
// 主 seam：所有兼容性与转换语义测试都打在这层（不测 AG Grid 库本身）。
import { describe, it, expect } from "vitest";
import type { ColDef, ColGroupDef } from "ag-grid-community";
import {
  leafColumns,
  toColumnDefs,
  toRowData,
  fromRowData,
  cellStyleFor,
  cellStyleKey,
  colSpanFor,
  formatFor,
  gridThemeParams,
} from "./tableAdapter";
import type { TableContent, TableColumn } from "../types/desktop";

/** 测试辅助：从 (ColDef|ColGroupDef)[] 中收窄取叶子 ColDef（valueFormatter 收窄为函数） */
function asLeaf(d: ColDef | ColGroupDef): ColDef & { valueFormatter?: (p: never) => string } {
  expect(d).not.toHaveProperty("children");
  return d as ColDef & { valueFormatter?: (p: never) => string };
}
function asGroup(d: ColDef | ColGroupDef): ColGroupDef {
  expect(d).toHaveProperty("children");
  return d as ColGroupDef;
}

// ── fixtures ──

function flatContent(): TableContent {
  return {
    type: "table",
    columns: [
      { id: "c1", name: "名称" },
      { id: "c2", name: "数量" },
    ],
    rows: [
      { id: "r1", cells: { c1: "苹果", c2: "12" } },
      { id: "r2", cells: { c1: "梨", c2: "3" } },
    ],
  };
}

function groupedContent(): TableContent {
  const east: TableColumn = {
    id: "g-east", name: "华东", children: [
      { id: "q1", name: "Q1" },
      { id: "q2", name: "Q2" },
    ],
  };
  return {
    type: "table",
    columns: [
      { id: "c0", name: "城市", pinned: "left" },
      east,
      { id: "c3", name: "总计" },
    ],
    rows: [
      { id: "r1", cells: { c0: "上海", q1: "10", q2: "20", c3: "30" } },
    ],
    cellStyles: {
      "r1:c3": { color: "#ff0000", bgColor: "#ffeeee", bold: true, align: "center", colSpan: 1 },
    },
    formats: { q1: "0,0.00", q2: "0%" },
  };
}

// ── leafColumns ──

describe("leafColumns", () => {
  it("扁平列直接返回", () => {
    expect(leafColumns(flatContent().columns).map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("组表头递归展开叶子（叶子才承载数据）", () => {
    expect(leafColumns(groupedContent().columns).map((c) => c.id)).toEqual(["c0", "q1", "q2", "c3"]);
  });
});

// ── toColumnDefs ──

describe("toColumnDefs（旧数据兼容：无新字段）", () => {
  it("扁平列 → field/headerName，无 children/pinned 痕迹", () => {
    const defs = toColumnDefs(flatContent());
    expect(defs).toHaveLength(2);
    expect(defs[0]).toMatchObject({ field: "c1", headerName: "名称", editable: true });
    expect(defs[0]).not.toHaveProperty("children");
    expect(defs[0]).not.toHaveProperty("pinned");
  });

  it("旧数据无 formats → colDef 无 valueFormatter", () => {
    const defs = toColumnDefs(flatContent());
    expect(defs[0]).not.toHaveProperty("valueFormatter");
  });
});

describe("toColumnDefs（新能力）", () => {
  it("组表头 → children 递归为 columnGroup", () => {
    const defs = toColumnDefs(groupedContent());
    const group = asGroup(defs[1]);
    expect(group).toMatchObject({ headerName: "华东" });
    expect(group.children).toHaveLength(2);
    expect(asLeaf(group.children[0])).toMatchObject({ field: "q1", headerName: "Q1" });
  });

  it("pinned 透传", () => {
    const defs = toColumnDefs(groupedContent());
    expect(asLeaf(defs[0])).toMatchObject({ field: "c0", pinned: "left" });
  });

  it("formats → valueFormatter 千分位", () => {
    const defs = toColumnDefs(groupedContent());
    const leaf = asLeaf(asGroup(defs[1]).children[0]);
    expect(typeof leaf.valueFormatter).toBe("function");
    // 千分位: 12345.6 → "12,345.60"
    const fmt = leaf.valueFormatter!;
    expect(fmt({ value: 12345.6 } as never)).toBe("12,345.60");
  });

  it("formats → 百分比", () => {
    const defs = toColumnDefs(groupedContent());
    const leaf = asLeaf(asGroup(defs[1]).children[1]);
    const fmt = leaf.valueFormatter!;
    expect(fmt({ value: 0.25 } as never)).toBe("25%");
  });

  it("非数字值走 valueFormatter 原样返回", () => {
    const defs = toColumnDefs(groupedContent());
    const fmt = asLeaf(asGroup(defs[1]).children[0]).valueFormatter!;
    expect(fmt({ value: "abc" } as never)).toBe("abc");
    expect(fmt({ value: "" } as never)).toBe("");
  });
});

// ── toRowData ──

describe("toRowData", () => {
  it("cells 按 leaf colId 平铺（组表头叶子为 key）", () => {
    const rows = toRowData(groupedContent());
    expect(rows).toEqual([{ id: "r1", "c0": "上海", q1: "10", q2: "20", c3: "30" }]);
  });

  it("缺失 cell 补空串（防 AG Grid undefined 渲染）", () => {
    const rows = toRowData(flatContent());
    expect(rows[0]).toMatchObject({ id: "r1", c1: "苹果", c2: "12" });
    const partial: TableContent = {
      type: "table",
      columns: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }],
      rows: [{ id: "r1", cells: { c1: "x" } }],
    };
    expect(toRowData(partial)[0].c2).toBe("");
  });

  it("千分位格的数字字符串可被 valueFormatter 处理（rowData 保持原字符串）", () => {
    const rows = toRowData(groupedContent());
    expect(rows[0].q1).toBe("10");
  });
});

// ── cellStyleFor ──

describe("cellStyleFor", () => {
  it("无 cellStyles → undefined（旧数据零开销）", () => {
    expect(cellStyleFor(flatContent(), "r1", "c1")).toBeUndefined();
  });

  it("命中样式 → 映射为 CSS 对象", () => {
    const s = cellStyleFor(groupedContent(), "r1", "c3");
    expect(s).toMatchObject({
      color: "#ff0000",
      backgroundColor: "#ffeeee",
      fontWeight: "bold",
      textAlign: "center",
    });
  });

  it("未命中的格 → undefined", () => {
    expect(cellStyleFor(groupedContent(), "r1", "c0")).toBeUndefined();
  });

  it("colSpan 不进 CSS 样式对象（由 colSpanFor 单独取，职责解耦）", () => {
    const c: TableContent = {
      type: "table",
      columns: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      rows: [{ id: "r1", cells: { a: "x" } }],
      cellStyles: { "r1:a": { colSpan: 2 } },
    };
    // colSpan 不是 CSS —— cellStyleFor 不含它
    const s = cellStyleFor(c, "r1", "a");
    expect(s).toBeUndefined();
    // 合并数走 colSpanFor
    expect(colSpanFor(c, "r1", "a")).toBe(2);
  });
});

// ── round-trip（toRowData → 编辑 → fromRowData）──

describe("fromRowData / round-trip", () => {
  it("round-trip: toRowData 后原样 fromRowData 还原 rows（叶子列一致）", () => {
    const c = flatContent();
    const rowData = toRowData(c);
    // 模拟编辑一格
    rowData[1].c2 = "7";
    const rows = fromRowData(c, rowData);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "r1", cells: { c1: "苹果", c2: "12" } });
    expect(rows[1]).toEqual({ id: "r2", cells: { c1: "梨", c2: "7" } });
  });

  it("round-trip: 组表头内容按叶子列还原", () => {
    const c = groupedContent();
    const rowData = toRowData(c);
    rowData[0].q1 = "99";
    const rows = fromRowData(c, rowData);
    expect(rows[0].cells).toEqual({ c0: "上海", q1: "99", q2: "20", c3: "30" });
  });

  it("fromRowData 忽略非叶子列键（不污染 cells）", () => {
    const c = flatContent();
    const rows = fromRowData(c, [{ id: "r1", c1: "x", ghost: "y" }]);
    expect(rows[0].cells).toEqual({ c1: "x" });
    expect(rows[0].cells).not.toHaveProperty("ghost");
  });

  it("fromRowData: 缺 id 时兜底生成 rowId", () => {
    const c = flatContent();
    const rows = fromRowData(c, [{ c1: "x", c2: "" }]);
    expect(rows[0].id).toBeTruthy();
  });
});

// ── cellStyleKey / colSpanFor ──

describe("cellStyleKey / colSpanFor", () => {
  it("key 规约 rowId:colId", () => {
    expect(cellStyleKey("r1", "c3")).toBe("r1:c3");
  });
  it("colSpanFor: 无样式/colSpan<=1 → 1；>1 → N", () => {
    expect(colSpanFor(groupedContent(), "r1", "c3")).toBe(1);
    const c: TableContent = {
      ...flatContent(),
      cellStyles: { "r1:c1": { colSpan: 2 } },
    };
    expect(colSpanFor(c, "r1", "c1")).toBe(2);
    expect(colSpanFor(c, "r1", "c2")).toBe(1);
  });
});

// ── formatFor ──

describe("formatFor", () => {
  it("无 formats → undefined", () => {
    expect(formatFor(flatContent(), "c1")).toBeUndefined();
  });
  it("命中 formats 返回格式串", () => {
    expect(formatFor(groupedContent(), "q1")).toBe("0,0.00");
  });
});

// ── gridThemeParams（主题对齐 CSS 变量）──

describe("gridThemeParams", () => {
  it("亮色参数", () => {
    const p = gridThemeParams(false);
    expect(p).toMatchObject({ accentColor: "#1a73e8" });
    expect(p.backgroundColor).toBe("#ffffff");
  });
  it("暗色参数", () => {
    const p = gridThemeParams(true);
    expect(p.backgroundColor).toBe("#1e1e2e");
    expect(p.foregroundColor).not.toBe("#1a1a1a");
  });
});
