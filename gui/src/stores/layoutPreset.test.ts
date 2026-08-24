// ── 布局预设注册表 — 每个预设必须能构建出可序列化/反序列化的合法布局树 ──
// 预设替代旧的「恢复默认布局」：从预设里选一套面板排布（默认/聊天为主/信息密度最高）。

import { beforeEach, describe, it, expect } from "vitest";
import { resetLayout, LAYOUT_PRESETS, applyLayoutPreset, getLayoutPreset, serializeLayout, deserializeLayout, getTree } from "./layoutStore";

beforeEach(() => {
  resetLayout();
});

/** 收集树上所有 group id + tab 的 panelId */
function collectGroups(node: any): string[] {
  if (node.type === "group") {
    return [node.id, ...(node.tabs || []).map((t: any) => t.panelId)];
  }
  return (node.children || []).flatMap(collectGroups);
}

describe("layout presets", () => {
  it("registers 3 presets: default / chat / dense", () => {
    expect(LAYOUT_PRESETS.map((p) => p.id)).toEqual(["default", "chat", "dense"]);
  });

  it("each preset build() round-trips serialize → deserialize without throwing", () => {
    for (const p of LAYOUT_PRESETS) {
      resetLayout();
      applyLayoutPreset(p.id);
      const data = serializeLayout() as any;
      expect(() => deserializeLayout(data)).not.toThrow();
    }
  });

  it("chat preset: messages+editor centered, input at bottom, files in left, no right chat-split", () => {
    applyLayoutPreset("chat");
    const groups = collectGroups(getTree());
    expect(groups).toContain("chat-center-group");
    expect(groups).toContain("chat-messages");
    expect(groups).toContain("editor");
    expect(groups).toContain("bottom-panel");
    expect(groups).toContain("chat-input");
    expect(groups).toContain("skills-panel");
    expect(groups).toContain("files");
    expect(groups).not.toContain("chat-split");
    expect(groups).not.toContain("editor-area");
  });

  it("dense preset: editor-area + bottom-panel + chat-messages all present", () => {
    applyLayoutPreset("dense");
    const groups = collectGroups(getTree());
    expect(groups).toContain("editor-area");
    expect(groups).toContain("bottom-panel");
    expect(groups).toContain("chat-messages-group");
    expect(groups).toContain("quick-prompts-panel");
    expect(groups).toContain("plan-panel");
  });

  it("unknown preset id is rejected", () => {
    expect(applyLayoutPreset("nope")).toBe(false);
    expect(getLayoutPreset("nope")).toBeUndefined();
  });
});
