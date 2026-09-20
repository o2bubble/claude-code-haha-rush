// ── commandPaletteItems — 从 store 数据构建 PaletteItem ──

import { describe, it, expect } from "vitest";
import { buildPanelItems, buildCommandItems, buildSessionItems } from "./commandPaletteItems";

describe("buildPanelItems", () => {
  it("只保留用户可管理面板（userManaged !== false）", () => {
    const panels = [
      { id: "editor", title: "编辑器" },                 // undefined → 保留
      { id: "settings", title: "设置", userManaged: false },  // 系统面板 → 过滤
      { id: "terminal", title: "终端" },                 // undefined → 保留
      { id: "feedback", title: "反馈", userManaged: false },  // 系统面板 → 过滤
    ];
    const items = buildPanelItems(panels, () => false);
    expect(items.map((i) => i.id)).toEqual(["panel-editor", "panel-terminal"]);
    // 系统面板绝不能出现在命令面板
    expect(items.some((i) => i.id.includes("settings") || i.id.includes("feedback"))).toBe(false);
  });

  it("标注已打开状态", () => {
    const panels = [{ id: "editor", title: "编辑器" }, { id: "terminal", title: "终端" }];
    const items = buildPanelItems(panels, (id) => id === "editor");
    expect(items.find((i) => i.id === "panel-editor")?.active).toBe(true);
    expect(items.find((i) => i.id === "panel-terminal")?.active).toBe(false);
  });

  it("kind 为 panel", () => {
    const items = buildPanelItems([{ id: "files", title: "文件" }], () => false);
    expect(items[0].kind).toBe("panel");
  });
});

describe("buildCommandItems", () => {
  it("构建 cmd + desc", () => {
    const items = buildCommandItems([{ cmd: "/commit", desc: "生成提交信息", type: "prompt" }]);
    expect(items[0]).toMatchObject({ id: "cmd-/commit", kind: "command", label: "/commit", sublabel: "生成提交信息", icon: "quickPrompts" });
  });

  it("复用技能国际化 desc（无 / key 匹配）", () => {
    const i18n = { "code-review": { title: "代码审查", desc: "审查分支改动" } };
    const items = buildCommandItems([{ cmd: "code-review", desc: "Review changes", type: "skill" }], i18n);
    expect(items[0].sublabel).toBe("审查分支改动");
  });

  it("复用技能国际化 desc（带 / key 匹配）", () => {
    const i18n = { "/code-review": { title: "代码审查", desc: "审查分支改动" } };
    const items = buildCommandItems([{ cmd: "code-review", desc: "Review changes", type: "skill" }], i18n);
    expect(items[0].sublabel).toBe("审查分支改动");
  });

  it("无匹配翻译时保持原 desc", () => {
    const i18n = { "/other": { title: "其他", desc: "别的" } };
    const items = buildCommandItems([{ cmd: "code-review", desc: "Review changes", type: "skill" }], i18n);
    expect(items[0].sublabel).toBe("Review changes");
  });

  it("无 i18n 参数时保持原 desc", () => {
    const items = buildCommandItems([{ cmd: "code-review", desc: "Review changes", type: "skill" }]);
    expect(items[0].sublabel).toBe("Review changes");
  });

  it("跳过 cmd 缺失的条目，避免重复 key（cmd-undefined）", () => {
    const items = buildCommandItems([
      { cmd: "/commit", desc: "a", type: "prompt" },
      { cmd: "", desc: "空", type: "prompt" },
      { cmd: undefined as unknown as string, desc: "无", type: "skill" },
      { cmd: "/code-review", desc: "b", type: "prompt" },
    ]);
    expect(items.map((i) => i.id)).toEqual(["cmd-/commit", "cmd-/code-review"]);
    expect(items.some((i) => i.id.includes("undefined"))).toBe(false);
  });
});

describe("buildSessionItems", () => {
  const now = 1_000_000;
  const sessions = [
    { id: "s1", title: "旧会话", timestamp: now - 100 },
    { id: "s2", title: "新会话", timestamp: now },
  ];

  it("按时间倒序", () => {
    const items = buildSessionItems(sessions, null);
    expect(items.map((i) => i.label)).toEqual(["新会话", "旧会话"]);
    expect(items[0].icon).toBe("sessions");
  });

  it("标注当前会话", () => {
    const items = buildSessionItems(sessions, "s1");
    expect(items.find((i) => i.id === "session-s1")?.active).toBe(true);
    expect(items.find((i) => i.id === "session-s2")?.active).toBe(false);
  });

  it("空标题回退为 id", () => {
    const items = buildSessionItems([{ id: "s3", title: "", timestamp: 0 }], null);
    expect(items[0].label).toBe("s3");
  });

  it("传 folderTree 时，有归属的会话带层级 prefix", () => {
    const tree = {
      folders: [
        { id: "f1", name: "工作" },
        { id: "f2", name: "项目A", parentId: "f1" },
      ],
      assignments: { s2: "f2" },
    };
    const items = buildSessionItems(sessions, null, tree);
    expect(items.find((i) => i.id === "session-s2")?.prefix).toBe("工作 / 项目A");
    // 无归属的会话不带 prefix（渲染层据此留空）
    expect(items.find((i) => i.id === "session-s1")?.prefix).toBeUndefined();
  });

  it("不传 folderTree 时一律无 prefix（向后兼容）", () => {
    const items = buildSessionItems(sessions, null);
    expect(items.every((i) => i.prefix === undefined)).toBe(true);
  });
});
