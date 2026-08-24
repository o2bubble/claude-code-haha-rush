// ── recentUsage — 最近使用记录与排序 ──

import { describe, it, expect } from "vitest";
import { recordIntoList, sortByRecent } from "./recentUsage";

describe("recordIntoList", () => {
  it("新 id 插到最前", () => {
    expect(recordIntoList(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("已存在的 id 去重并移到最前", () => {
    expect(recordIntoList(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("截断到 max", () => {
    expect(recordIntoList(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("sortByRecent", () => {
  const items = [
    { id: "panel-editor" },
    { id: "panel-terminal" },
    { id: "panel-files" },
    { id: "panel-notes" },
  ];

  it("空 recent 保持原顺序", () => {
    expect(sortByRecent(items, []).map((i) => i.id)).toEqual(["panel-editor", "panel-terminal", "panel-files", "panel-notes"]);
  });

  it("最近使用的排最前（按时间倒序）", () => {
    const recent = ["panel-notes", "panel-terminal"];
    expect(sortByRecent(items, recent).map((i) => i.id)).toEqual(["panel-notes", "panel-terminal", "panel-editor", "panel-files"]);
  });

  it("未出现的保持在尾部且相对顺序不变", () => {
    const recent = ["panel-notes"];
    const sorted = sortByRecent(items, recent);
    expect(sorted.slice(1).map((i) => i.id)).toEqual(["panel-editor", "panel-terminal", "panel-files"]);
  });
});
