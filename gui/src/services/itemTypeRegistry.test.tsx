// ── ItemType registry — all 9 built-in types registered, dispatch works ──

import { describe, it, expect } from "vitest";
import { getItemType, renderItemContent } from "./itemTypeRegistry";
import type { DesktopItem } from "../types/desktop";

const TYPES = ["text", "chart", "graphic", "ref", "file-group", "image", "form", "drawing", "table"];

function item(type: string, content: unknown): DesktopItem {
  return {
    id: "i1",
    desktopId: "d1",
    label: "L",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 0,
    content: { type, ...(content as any) },
  } as DesktopItem;
}

describe("itemTypeRegistry", () => {
  it("registers all 9 built-in item types", () => {
    for (const t of TYPES) {
      expect(getItemType(t), `missing adapter for ${t}`).toBeDefined();
    }
  });

  it("renderItemContent returns an element for a registered type and undefined for unknown", () => {
    expect(renderItemContent(item("text", { text: "hi" }))).toBeDefined();
    expect(renderItemContent(item("unknown-type", {}))).toBeUndefined();
  });

  it("searchText extracts searchable text per type", () => {
    expect(getItemType("text")!.searchText!(item("text", { text: "Hello World" }))).toBe("Hello World");
    expect(getItemType("chart")!.searchText!(item("chart", { title: "My Chart" }))).toBe("My Chart");
    expect(getItemType("graphic")!.searchText!(item("graphic", { nodes: [{ label: "n1" }, { label: "n2" }] }))).toBe("n1 n2");
    expect(getItemType("graphic")!.searchText!(item("graphic", { mermaid: "graph TD; A-->B" }))).toBe("graph TD; A-->B");
    expect(getItemType("form")!.searchText!(item("form", { fields: [{ name: "Name", value: "Alice" }] }))).toContain("Alice");
    // image has no searchText → not searchable
    expect(getItemType("image")!.searchText).toBeUndefined();
  });
});
