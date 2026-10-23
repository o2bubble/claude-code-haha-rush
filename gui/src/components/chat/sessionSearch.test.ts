import { describe, it, expect } from "vitest";
import { normalizeQuery, sessionMatches, filterSessions, visibleFolders } from "./sessionSearch";
import { folderPathLabel, type SessionFolderTree } from "./sessionFolders";

const tree: SessionFolderTree = {
  folders: [
    { id: "work", name: "工作" },
    { id: "projA", name: "项目A", parentId: "work" },
    { id: "life", name: "生活" },
  ],
  assignments: { s1: "projA", s2: "life", s3: "work" },
};

const sessions = [
  { id: "s1", title: "重构登录" },
  { id: "s2", title: "周末计划" },
  { id: "s3", title: "登录排查" },
  { id: "s4", title: "未归属的会话" },
];

const label = (id: string) => folderPathLabel(tree, id);

describe("normalizeQuery", () => {
  it("去空白 + 小写", () => {
    expect(normalizeQuery("  Hello  ")).toBe("hello");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("sessionMatches — 标题 / 文件夹路径，任一命中", () => {
  it("空查询 → 一律命中", () => {
    expect(sessionMatches("任意", "", "")).toBe(true);
  });
  it("标题包含（不区分大小写）", () => {
    expect(sessionMatches("Refactor Login", "", "login")).toBe(true);
    expect(sessionMatches("重构登录", "", "登录")).toBe(true);
  });
  it("文件夹路径包含", () => {
    expect(sessionMatches("无关标题", "工作 / 项目A", "项目a")).toBe(true);
    expect(sessionMatches("无关标题", "工作 / 项目A", "工作")).toBe(true);
  });
  it("都不包含 → 不命中", () => {
    expect(sessionMatches("无关标题", "生活", "登录")).toBe(false);
  });
});

describe("filterSessions — 保持原顺序，空查询返回同一引用", () => {
  it("按标题匹配", () => {
    const out = filterSessions(sessions, "登录", label);
    // s1 标题命中；s3 标题命中且文件夹路径也含"工作"
    expect(out.map((s) => s.id)).toEqual(["s1", "s3"]);
  });
  it("按文件夹名匹配（会话标题不含关键词）", () => {
    const out = filterSessions(sessions, "生活", label);
    expect(out.map((s) => s.id)).toEqual(["s2"]);
  });
  it("嵌套文件夹的父级名也参与匹配", () => {
    const out = filterSessions(sessions, "工作", label);
    // s1 在 工作/项目A；s3 直接在 工作
    expect(out.map((s) => s.id)).toEqual(["s1", "s3"]);
  });
  it("无查询 → 原数组（同一引用，避免无谓重渲染）", () => {
    expect(filterSessions(sessions, "  ", label)).toBe(sessions);
  });
  it("无命中 → 空数组", () => {
    expect(filterSessions(sessions, "zzz", label)).toEqual([]);
  });
  it("未归属会话按标题照常匹配", () => {
    const out = filterSessions(sessions, "未归属", label);
    expect(out.map((s) => s.id)).toEqual(["s4"]);
  });
});

describe("visibleFolders — 只留有命中的分支", () => {
  it("空查询 → null（不过滤）", () => {
    expect(visibleFolders(tree, sessions, "")).toBeNull();
  });

  it("文件夹自身命中 → 整棵子树可见（含祖先）", () => {
    const v = visibleFolders(tree, sessions, "工作")!;
    expect(v.has("work")).toBe(true);
    expect(v.has("projA")).toBe(true);
    expect(v.has("life")).toBe(false);
  });

  it("会话命中 → 该路径上的祖先文件夹可见", () => {
    const v = visibleFolders(tree, sessions, "周末")!; // s2 在 生活
    expect(v.has("life")).toBe(true);
    expect(v.has("work")).toBe(false);
  });

  it("没有命中的分支整体隐藏", () => {
    const v = visibleFolders(tree, sessions, "登录")!;
    expect(v.has("projA")).toBe(true); // s1 命中（重构登录）
    expect(v.has("work")).toBe(true);  // 祖先
    expect(v.has("life")).toBe(false); // s2 不命中
  });

  it("无任何命中 → 空集合", () => {
    const v = visibleFolders(tree, sessions, "zzz")!;
    expect(v.size).toBe(0);
  });

  it("父文件夹自身命中时，子文件夹即使不命中也可见", () => {
    const v = visibleFolders(tree, sessions, "项目")!;
    expect(v.has("projA")).toBe(true);
    expect(v.has("work")).toBe(true);
  });
});
