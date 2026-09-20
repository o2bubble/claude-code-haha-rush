// ── 会话文件夹 · 纯函数测试（T2）──
// 接缝：sessionFolders.ts（无 DOM 依赖，同 sessionFavorites.ts 先例）

import { describe, it, expect } from "vitest";
import {
  createFolder, renameFolder, deleteFolder, moveFolder,
  assignSession, unassignSession, moveSessions,
  buildFolderTree, partitionSessions, pruneOrphanAssignments, isSessionListComplete,
  folderPathOf, folderPathLabel,
  type SessionFolderTree,
} from "./sessionFolders";

const empty = { folders: [], assignments: {} };

describe("createFolder / renameFolder", () => {
  it("创建根级文件夹", () => {
    const t = createFolder(empty, "f1", "项目A");
    expect(t.folders).toEqual([{ id: "f1", name: "项目A", parentId: undefined }]);
  });

  it("创建子文件夹（嵌套）", () => {
    let t = createFolder(empty, "f1", "工作");
    t = createFolder(t, "f2", "前端", "f1");
    expect(t.folders.find((f) => f.id === "f2")?.parentId).toBe("f1");
  });

  it("重命名", () => {
    let t = createFolder(empty, "f1", "旧名");
    t = renameFolder(t, "f1", "新名");
    expect(t.folders[0].name).toBe("新名");
  });
});

describe("deleteFolder（折叠语义, 会话级联上移）", () => {
  it("删除根文件夹 → 子文件夹上移到根, 根的直接会话未归类, 子级会话保留", () => {
    let t = createFolder(empty, "f1", "根");
    t = createFolder(t, "f2", "子", "f1");
    t = assignSession(t, "s1", "f1");
    t = assignSession(t, "s2", "f2");
    t = deleteFolder(t, "f1");
    expect(t.folders.map((f) => f.id)).toEqual(["f2"]);
    expect(t.folders[0].parentId).toBeUndefined();
    expect(t.assignments.s1).toBeUndefined(); // 根的直接会话未归类
    expect(t.assignments.s2).toBe("f2"); // 子级会话保留
  });

  it("删除子文件夹 → 其直接会话上移到父级, 孙级文件夹上移, 孙级会话保留", () => {
    let t = createFolder(empty, "f1", "根");
    t = createFolder(t, "f2", "子", "f1");
    t = createFolder(t, "f3", "孙", "f2");
    t = assignSession(t, "s1", "f2");
    t = assignSession(t, "s2", "f3");
    t = deleteFolder(t, "f2");
    expect(t.folders.map((f) => f.id)).toEqual(["f1", "f3"]);
    expect(t.folders.find((f) => f.id === "f3")?.parentId).toBe("f1");
    expect(t.assignments.s1).toBe("f1"); // f2 直接会话上移到 f1
    expect(t.assignments.s2).toBe("f3"); // 孙级会话保留
  });

  it("删除不存在的文件夹 → 原样返回", () => {
    const t = createFolder(empty, "f1", "根");
    expect(deleteFolder(t, "ghost")).toBe(t);
  });
});

describe("moveFolder（防循环）", () => {
  it("移动到另一文件夹", () => {
    let t = createFolder(empty, "f1", "根");
    t = createFolder(t, "f2", "甲");
    t = createFolder(t, "f3", "乙");
    t = moveFolder(t, "f2", "f3");
    expect(t.folders.find((f) => f.id === "f2")?.parentId).toBe("f3");
  });

  it("不能移到自身", () => {
    let t = createFolder(empty, "f1", "根");
    t = moveFolder(t, "f1", "f1");
    expect(t.folders.find((f) => f.id === "f1")?.parentId).toBeUndefined();
  });

  it("不能移到自己的后代（防环）", () => {
    let t = createFolder(empty, "f1", "根");
    t = createFolder(t, "f2", "子", "f1");
    t = createFolder(t, "f3", "孙", "f2");
    t = moveFolder(t, "f1", "f3"); // f1 是 f3 的祖先, 拒绝
    expect(t.folders.find((f) => f.id === "f1")?.parentId).toBeUndefined();
  });
});

describe("assignSession / unassignSession / moveSessions", () => {
  it("归属/取消归属", () => {
    let t = createFolder(empty, "f1", "根");
    t = assignSession(t, "s1", "f1");
    expect(t.assignments.s1).toBe("f1");
    t = unassignSession(t, "s1");
    expect(t.assignments.s1).toBeUndefined();
  });

  it("批量移动 + null 归未归类", () => {
    let t = createFolder(empty, "f1", "根");
    t = moveSessions(t, ["s1", "s2"], "f1");
    expect(t.assignments.s1).toBe("f1");
    expect(t.assignments.s2).toBe("f1");
    t = moveSessions(t, ["s1"], null);
    expect(t.assignments.s1).toBeUndefined();
    expect(t.assignments.s2).toBe("f1");
  });
});

describe("buildFolderTree", () => {
  it("扁平列表 → 嵌套树（根级 + 子级 + 孙级）", () => {
    let t = createFolder(empty, "f1", "根");
    t = createFolder(t, "f2", "子", "f1");
    t = createFolder(t, "f3", "孙", "f2");
    t = createFolder(t, "f4", "独立");
    const tree = buildFolderTree(t);
    expect(tree.map((n) => n.folder.id)).toEqual(["f1", "f4"]); // 根级顺序
    expect(tree[0].children.map((n) => n.folder.id)).toEqual(["f2"]);
    expect(tree[0].children[0].children.map((n) => n.folder.id)).toEqual(["f3"]);
  });

  it("根级 parentId 为 null 与 undefined 混合时全部渲染（防根文件夹被藏）", () => {
    // Rust `default` 序列化会省略根级 parentId 字段(undefined)，但旧数据可能存
    // null；两者都是根级，若分开分组会导致部分根文件夹永不渲染、会话被藏。
    const t = {
      folders: [
        // 旧数据可能把根级 parentId 存成 null（脏数据），这里显式模拟
        { id: "f-null", name: "根A", parentId: null },
        { id: "f-undef", name: "根B" },
        { id: "f-child", name: "子", parentId: "f-null" },
      ],
      assignments: {},
    } as unknown as SessionFolderTree;
    const tree = buildFolderTree(t);
    expect(tree.map((n) => n.folder.id)).toEqual(["f-null", "f-undef"]);
    expect(tree[0].children.map((n) => n.folder.id)).toEqual(["f-child"]);
  });
});

describe("partitionSessions（分组 + 未归类 + 收藏共存）", () => {
  it("按文件夹分组, 未归属进未归类", () => {
    let t = createFolder(empty, "f1", "项目A");
    t = assignSession(t, "s1", "f1");
    const sessions = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
    const p = partitionSessions(t, sessions);
    expect(p.byFolder.f1.map((s) => s.id)).toEqual(["s1"]);
    expect(p.uncategorized.map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  it("归属到已删除文件夹的会话 → 未归类（防悬挂）", () => {
    const t = { folders: [], assignments: { s1: "ghost" } };
    const p = partitionSessions(t, [{ id: "s1" }]);
    expect(p.byFolder.ghost).toBeUndefined();
    expect(p.uncategorized.map((s) => s.id)).toEqual(["s1"]);
  });

  it("收藏与文件夹独立共存：同一会话既被收藏又在文件夹, 分组不丢", () => {
    let t = createFolder(empty, "f1", "项目A");
    t = assignSession(t, "s1", "f1");
    // favIds 是独立维度（partitionSessions 不关心收藏）
    const p = partitionSessions(t, [{ id: "s1" }]);
    expect(p.byFolder.f1.map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("pruneOrphanAssignments", () => {
  it("完整列表下清理真孤儿：不存在的会话归属被清掉", () => {
    const assignments = { s1: "f1", s2: "f1", s3: "f1" };
    const pruned = pruneOrphanAssignments(assignments, ["s1", "s3"]); // s2 真被删了
    expect(pruned).toEqual({ s1: "f1", s3: "f1" });
  });

  it("无孤儿返回原引用（调用方据此跳过保存）", () => {
    const assignments = { s1: "f1", s2: "f1" };
    expect(pruneOrphanAssignments(assignments, ["s1", "s2"])).toBe(assignments);
  });
});

describe("isSessionListComplete（列表完整性保护）", () => {
  it("total 未知（旧后端）→ 信任 loaded 列表", () => {
    expect(isSessionListComplete(50, null)).toBe(true);
  });

  it("返回数达到 total → 完整，可清理", () => {
    expect(isSessionListComplete(60, 60)).toBe(true);
    expect(isSessionListComplete(50, 50)).toBe(true);
  });

  it("total > 返回数（截断/分页）→ 不完整，孤儿清理必须跳过", () => {
    // 会话全集 60 个，后端只返回 50（旧 slice(0,50) 行为）→ 不能据此清理，
    // 否则后 10 个真实存在会话的归属被误删（回列表时变未分类/找不到）。
    expect(isSessionListComplete(50, 60)).toBe(false);
  });
});

describe("folderPathOf / folderPathLabel（命令面板的层级前缀）", () => {
  // 结构：工作 ─┬─ 项目A
  //                └─ 项目B
  const tree: SessionFolderTree = {
    folders: [
      { id: "f-work", name: "工作" },
      { id: "f-a", name: "项目A", parentId: "f-work" },
      { id: "f-b", name: "项目B", parentId: "f-work" },
    ],
    assignments: { s1: "f-a", s2: "f-work" },
  };

  it("嵌套层级按 根 → 叶 顺序返回", () => {
    expect(folderPathOf(tree, "s1")).toEqual(["工作", "项目A"]);
  });

  it("一级文件夹返回单元素", () => {
    expect(folderPathOf(tree, "s2")).toEqual(["工作"]);
  });

  it("无归属返回空（渲染层据此不显示前缀）", () => {
    expect(folderPathOf(tree, "s3")).toEqual([]);
    expect(folderPathLabel(tree, "s3")).toBe("");
  });

  it("归属到不存在的文件夹 → 空（防悬挂，与 partitionSessions 同语义）", () => {
    const dangling: SessionFolderTree = { folders: [{ id: "f1", name: "X" }], assignments: { s9: "gone" } };
    expect(folderPathOf(dangling, "s9")).toEqual([]);
  });

  it("成环时不死循环（返回已走到的部分）", () => {
    // A → B → A（moveFolder 有防环，但数据可能来自旧版本/手改）
    const cyclic: SessionFolderTree = {
      folders: [{ id: "a", name: "A", parentId: "b" }, { id: "b", name: "B", parentId: "a" }],
      assignments: { s: "a" },
    };
    expect(folderPathOf(cyclic, "s")).toEqual(["B", "A"]);
  });

  it("显示串用 ` / ` 连接", () => {
    expect(folderPathLabel(tree, "s1")).toBe("工作 / 项目A");
  });
});
