// ── ItemType registry — one per-type adapter seam for desktop items ──
// Every item type registers { render, searchText } here. The two canvas
// renderers (DesktopItemView / DesktopItemViewer) and the desktop search all
// dispatch through this single registry instead of duplicated switch blocks —
// adding a type now touches one module + one registration line.

import React from "react";
import type { DesktopItem } from "../types/desktop";
import { TextItem } from "../components/desktop/TextItem";
import { ChartItem } from "../components/desktop/ChartItem";
import { GraphicItem } from "../components/desktop/GraphicItem";
import { graphicSearchText } from "../components/desktop/graphicContent";
import { RefItem } from "../components/desktop/RefItem";
import { FileGroupItem } from "../components/desktop/FileGroupItem";
import { ImageItem } from "../components/desktop/ImageItem";
import { FormItem } from "../components/desktop/FormItem";
import { DrawItem } from "../components/desktop/DrawItem";
import { TableItem } from "../components/desktop/TableItem";

export interface ItemTypeAdapter {
  type: string;
  render: (item: DesktopItem) => React.ReactNode;
  /** Searchable text for this item type (desktop search). Empty = not searchable. */
  searchText?: (item: DesktopItem) => string;
}

const adapters = new Map<string, ItemTypeAdapter>();

export function registerItemType(adapter: ItemTypeAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function getItemType(type: string): ItemTypeAdapter | undefined {
  return adapters.get(type);
}

/** Render an item's content, or undefined for an unregistered type. */
export function renderItemContent(item: DesktopItem): React.ReactNode {
  return adapters.get(item.content.type)?.render(item);
}

registerItemType({
  type: "text",
  render: (item) => <TextItem item={item} />,
  searchText: (item) => (item.content as any).text || "",
});
registerItemType({
  type: "chart",
  render: (item) => <ChartItem item={item} />,
  searchText: (item) => (item.content as any).title || "",
});
registerItemType({
  type: "graphic",
  render: (item) => <GraphicItem item={item} />,
  searchText: (item) => graphicSearchText(item.content),
});
registerItemType({
  type: "ref",
  render: (item) => <RefItem item={item} />,
  searchText: (item) => {
    const c = item.content as any;
    return [c.note || "", (c.references || []).map((r: any) => r.label || "").join(" ")].join(" ");
  },
});
registerItemType({
  type: "file-group",
  render: (item) => <FileGroupItem item={item} />,
  searchText: (item) => ((item.content as any).files || []).map((f: any) => f.label || "").join(" "),
});
registerItemType({
  type: "image",
  render: (item) => <ImageItem item={item} />,
});
registerItemType({
  type: "form",
  render: (item) => <FormItem item={item} />,
  searchText: (item) =>
    ((item.content as any).fields || []).map((f: any) => [f.name || "", String(f.value ?? "")].join(" ")).join(" "),
});
registerItemType({
  type: "drawing",
  render: (item) => <DrawItem item={item} />,
});
registerItemType({
  type: "table",
  render: (item) => <TableItem item={item} />,
});
