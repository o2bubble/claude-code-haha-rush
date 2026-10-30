// ── 清理工具前端纯逻辑 ──
//
// 锁住三件最容易出事的判定：
//  ① 默认勾选只有「临时产物」（规格 Q20）—— 漏掉这条，用户一打开就可能
//     把编辑快照一起清了
//  ② 灰掉的项**永远**不能进入删除请求（规格 Q21/Q23）
//  ③ 工作区去重（大小写 / 斜杠方向）

import { describe, it, expect } from "vitest";
import {
  DEFAULT_CHECKED,
  NEEDS_CONFIRM,
  buildDeleteRequest,
  hasForceableItems,
  summarizeBlocked,
  dedupeWorkspaces,
  formatBytes,
  initialSelection,
  isCategorySelectable,
  needsConfirm,
  normalizeWorkspacePath,
  summarizeCategory,
  summarizeRun,
} from "./cleanupLogic";
import type { CleanupCategory, CleanupItem, RunReport } from "./cleanupLogic";

const item = (over: Partial<CleanupItem> & { id: string; category: CleanupCategory }): CleanupItem => ({
  kind: "k",
  path: `C:/x/${over.id}`,
  sizeBytes: 100,
  fileCount: 1,
  lastModifiedMs: null,
  deletable: true,
  blockedReason: null,
  timedOut: false,
  ...over,
});

describe("默认勾选", () => {
  it("只有临时产物默认勾选", () => {
    const sel = initialSelection();
    expect(sel.has("temp")).toBe(true);
    expect(sel.size).toBe(1);
  });

  it("编辑快照默认不勾（最高风险项）", () => {
    expect(DEFAULT_CHECKED["file-history"]).toBe(false);
  });

  it("每一类都有明确的默认值，没有遗漏", () => {
    for (const c of Object.keys(DEFAULT_CHECKED)) {
      expect(typeof DEFAULT_CHECKED[c as CleanupCategory]).toBe("boolean");
    }
  });
});

describe("二次确认门禁", () => {
  it("勾了编辑快照 → 要确认", () => {
    expect(needsConfirm(new Set<CleanupCategory>(["file-history"]))).toBe(true);
  });

  it("只勾临时产物 → 不要确认", () => {
    expect(needsConfirm(new Set<CleanupCategory>(["temp"]))).toBe(false);
  });

  it("混合勾选里有编辑快照 → 仍然要确认", () => {
    expect(
      needsConfirm(new Set<CleanupCategory>(["temp", "app-cache", "file-history"])),
    ).toBe(true);
  });

  it("NEEDS_CONFIRM 只包含编辑快照", () => {
    expect([...NEEDS_CONFIRM]).toEqual(["file-history"]);
  });
});

describe("删除请求载荷", () => {
  const items = [
    item({ id: "a", category: "temp" }),
    item({ id: "b", category: "file-history" }),
    // 被保护（灰掉）的临时产物 —— 即使类别被勾了也不能进载荷
    item({ id: "c", category: "temp", deletable: false, blockedReason: "protected" }),
  ];

  it("只包含勾选类别里的可删项", () => {
    const req = buildDeleteRequest(new Set<CleanupCategory>(["temp"]), items);
    expect(req.map((i) => i.id)).toEqual(["a"]);
  });

  it("灰掉的项永远不进入载荷", () => {
    const req = buildDeleteRequest(
      new Set<CleanupCategory>(["temp", "file-history"]),
      items,
    );
    expect(req.map((i) => i.id)).toEqual(["a", "b"]);
    expect(req.some((i) => !i.deletable)).toBe(false);
  });

  it("什么都没勾 → 空载荷", () => {
    expect(buildDeleteRequest(new Set<CleanupCategory>(), items)).toEqual([]);
  });
});

describe("类别汇总", () => {
  it("只累加可删项的大小与文件数", () => {
    const items = [
      item({ id: "a", category: "temp", sizeBytes: 10, fileCount: 2 }),
      item({ id: "b", category: "temp", sizeBytes: 20, fileCount: 3 }),
      item({ id: "c", category: "temp", sizeBytes: 999, deletable: false }),
    ];
    expect(summarizeCategory("temp", items)).toMatchObject({ bytes: 30, files: 5 });
  });

  it("没有可删项 → 类别不可选", () => {
    const items = [item({ id: "a", category: "archive", deletable: false })];
    expect(isCategorySelectable("archive", items)).toBe(false);
  });

  it("有可删项 → 可选", () => {
    expect(isCategorySelectable("archive", [item({ id: "a", category: "archive" })])).toBe(true);
  });
});

describe("工作区归一化与去重", () => {
  it("大小写与斜杠方向视为同一路径", () => {
    expect(normalizeWorkspacePath("C:\\Work\\Proj\\")).toBe(
      normalizeWorkspacePath("c:/work/proj"),
    );
  });

  it("去重保留首次出现的原始写法", () => {
    const out = dedupeWorkspaces([
      "C:\\Storage\\work\\docs",
      "C:/Storage/work/docs",
      "C:\\Storage\\work\\other",
      "   ",
    ]);
    expect(out).toEqual(["C:\\Storage\\work\\docs", "C:\\Storage\\work\\other"]);
  });

  it("空列表 → 空结果", () => {
    expect(dedupeWorkspaces([])).toEqual([]);
  });
});

describe("格式化与结果摘要", () => {
  it("字节数分档", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(147 * 1024 * 1024)).toBe("147 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });

  it("摘要把失败项单列出来（结果页要显示路径与原因）", () => {
    const report: RunReport = {
      freedBytes: 30,
      outcomes: [
        { id: "1", path: "C:/a", ok: true, error: null, freedBytes: 10 },
        { id: "2", path: "C:/b", ok: false, error: "被占用", freedBytes: 0 },
        { id: "3", path: "C:/c", ok: true, error: null, freedBytes: 20 },
      ],
    };
    const s = summarizeRun(report);
    expect(s.okCount).toBe(2);
    expect(s.failCount).toBe(1);
    expect(s.freedBytes).toBe(30);
    expect(s.failures.map((f) => f.path)).toEqual(["C:/b"]);
  });
});

// ── 强制包含被跳过的项 ──
//
// 规格里「有强制清理开关，默认关闭」这一条首版没实现。它的必要性来自实际场景：
// 其他窗口正在用的工作区默认跳过，但若那是**残留的实例记录**（PID 复用过、
// 进程早没了），没有开关就等于永远清不掉。
//
// 但 `protected`（`.git` 配置版本仓库）**永远**不能包含 —— 它不是垃圾。
describe("强制包含", () => {
  const items = [
    item({ id: "ok", category: "temp" }),
    item({ id: "used", category: "temp", deletable: false, blockedReason: "active-workspace" }),
    item({ id: "git", category: "archive", deletable: false, blockedReason: "protected" }),
  ];

  it("默认不带被跳过的项", () => {
    const req = buildDeleteRequest(new Set<CleanupCategory>(["temp", "archive"]), items);
    expect(req.map((i) => i.id)).toEqual(["ok"]);
  });

  it("force 后带上可强制项", () => {
    const req = buildDeleteRequest(new Set<CleanupCategory>(["temp", "archive"]), items, true);
    expect(req.map((i) => i.id)).toEqual(["ok", "used"]);
  });

  it("force **也带不上** protected —— .git 永远不删", () => {
    const req = buildDeleteRequest(new Set<CleanupCategory>(["temp", "archive"]), items, true);
    expect(req.some((i) => i.id === "git")).toBe(false);
  });

  it("汇总把可强制与受保护分开计数", () => {
    const s = summarizeBlocked(items);
    expect(s).toEqual({ forced: 1, protected: 1, total: 2 });
  });

  it("只有受保护项时，强制开关不该出现", () => {
    const onlyProtected = [item({ id: "git", category: "archive", deletable: false, blockedReason: "protected" })];
    expect(hasForceableItems(onlyProtected)).toBe(false);
    expect(hasForceableItems(items)).toBe(true);
  });

  it("类别全是可强制项时，force 打开后可勾选", () => {
    const allBlocked = [
      item({ id: "a", category: "temp", deletable: false, blockedReason: "active-workspace" }),
    ];
    expect(isCategorySelectable("temp", allBlocked)).toBe(false);
    expect(isCategorySelectable("temp", allBlocked, true)).toBe(true);
  });

  it("force 打开后汇总把可强制项也算进去", () => {
    const all = [
      item({ id: "a", category: "temp", sizeBytes: 10, fileCount: 1 }),
      item({ id: "b", category: "temp", sizeBytes: 20, fileCount: 2, deletable: false, blockedReason: "active-workspace" }),
    ];
    expect(summarizeCategory("temp", all).bytes).toBe(10);
    expect(summarizeCategory("temp", all, true).bytes).toBe(30);
  });
});
