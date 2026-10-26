// 文件内容搜索 —— 纯函数与结果分组。
//
// 后端（Rust）负责走盘与匹配；这里锁的是**展示层契约**：
// 分组保持后端顺序、高亮切片不改变原文、大小写切换影响切片位置。

import { describe, it, expect } from "vitest";
import { groupHitsByFile, splitHighlight, type SearchHit } from "./FileSearchPanel";

const hit = (rel: string, line: number, text: string): SearchHit => ({
  path: `C:\\ws\\${rel.replace(/\//g, "\\")}`,
  rel,
  line,
  text,
});

describe("groupHitsByFile", () => {
  it("按文件分组，保持首次出现顺序", () => {
    const hits = [
      hit("b.ts", 3, "x needle"),
      hit("a.ts", 1, "needle"),
      hit("b.ts", 9, "needle again"),
    ];
    const groups = groupHitsByFile(hits);
    expect(groups.map((g) => g.rel)).toEqual(["b.ts", "a.ts"]);
    expect(groups[0].hits.map((h) => h.line)).toEqual([3, 9]);
    expect(groups[1].hits).toHaveLength(1);
  });

  it("空输入 → 空分组", () => {
    expect(groupHitsByFile([])).toEqual([]);
  });

  it("分组路径取该文件第一条命中的绝对路径", () => {
    const hits = [hit("dir/f.md", 2, "needle")];
    const [g] = groupHitsByFile(hits);
    expect(g.path).toBe(hits[0].path);
  });
});

describe("splitHighlight", () => {
  it("大小写不敏感时按实际文本切片（保留原文大小写）", () => {
    const r = splitHighlight("const NeEdLe = 1;", "needle", false);
    expect(r).not.toBeNull();
    expect(r!.before).toBe("const ");
    expect(r!.match).toBe("NeEdLe");
    expect(r!.after).toBe(" = 1;");
  });

  it("大小写敏感时不匹配则返回 null", () => {
    expect(splitHighlight("const NeEdLe = 1;", "needle", true)).toBeNull();
    expect(splitHighlight("const needle = 1;", "needle", true)).not.toBeNull();
  });

  it("只切第一处命中（与预览语义一致）", () => {
    const r = splitHighlight("a needle b needle c", "needle", false);
    expect(r!.before).toBe("a ");
    expect(r!.after).toBe(" b needle c");
  });

  it("空查询 → null（不高亮）", () => {
    expect(splitHighlight("anything", "   ", false)).toBeNull();
  });

  it("切出来的三段拼回去必须等于原文", () => {
    const text = "  ünïcode needle 中文 ";
    const r = splitHighlight(text, "needle", false)!;
    expect(r.before + r.match + r.after).toBe(text);
  });
});
