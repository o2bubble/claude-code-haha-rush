// ── 会话列表搜索（标题 + 文件夹名，简单包含匹配）──
//
// 语义（用户 2026-10-23 定）：**简单的包含匹配**，标题和文件夹路径任一命中即保留。
// 不做模糊/分词/拼音 —— 会话面板是窄侧栏，精确子串够用且可预期。
//
// 关键取舍：
// - 匹配**不区分大小写**（英文标题/文件夹名常见，用户不会在意大小写）；
// - 文件夹**路径**整串参与匹配（所以搜"工作"能命中"工作 / 项目A"下的会话）；
// - "未归类"不是文件夹，不参与文件夹名匹配（但会话标题照常匹配）。

import type { SessionFolderTree } from "./sessionFolders";
import { folderPathLabel } from "./sessionFolders";

/** 归一化：去掉首尾空白 + 小写。空串表示"不过滤"。 */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/** 会话是否命中：标题或文件夹路径包含查询串。 */
export function sessionMatches(
  title: string,
  folderLabel: string,
  query: string,
): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  return title.toLowerCase().includes(q) || folderLabel.toLowerCase().includes(q);
}

/**
 * 过滤会话列表（保持原顺序）。`folderLabelOf` 由调用方提供（依赖文件夹树）。
 * 无查询串时**原样返回同一数组**（避免无谓的重渲染/新引用）。
 */
export function filterSessions<T extends { id: string; title: string }>(
  sessions: T[],
  query: string,
  folderLabelOf: (sessionId: string) => string,
): T[] {
  const q = normalizeQuery(query);
  if (!q) return sessions;
  return sessions.filter((s) => sessionMatches(s.title, folderLabelOf(s.id), q));
}

/**
 * 过滤文件夹树：只保留**自身命中**或**子树里有命中会话**的文件夹，
 * 并自动隐藏没有任何命中的分支。
 *
 * 返回 `visible: Set<folderId>`（用于渲染时判断）；空查询时返回 `null`
 * （语义 = 不过滤，调用方据此跳过所有判断）。
 *
 * ⚠️ 自身命中的文件夹（如搜"工作"命中文件夹"工作"）应展示其**全部**子会话 ——
 * 用户找的是这个文件夹，不是同时还得让会话标题也命中。
 */
export function visibleFolders(
  tree: SessionFolderTree,
  sessions: Array<{ id: string; title: string }>,
  query: string,
): Set<string> | null {
  const q = normalizeQuery(query);
  if (!q) return null;

  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  const visible = new Set<string>();

  const markSelfAndAncestors = (folderId: string) => {
    const seen = new Set<string>();
    let cur = byId.get(folderId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      visible.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  };

  // ① 文件夹自身名命中 → 整棵子树可见
  for (const f of tree.folders) {
    if (f.name.toLowerCase().includes(q)) {
      const stack = [f.id];
      const seen = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        visible.add(id);
        for (const child of tree.folders) if (child.parentId === id) stack.push(child.id);
      }
      markSelfAndAncestors(f.id);
    }
  }

  // ② 会话命中（标题或所属文件夹路径）→ 那条路径上的文件夹都可见
  for (const s of sessions) {
    const fid = tree.assignments[s.id];
    if (fid && byId.has(fid) && sessionMatches(s.title, folderPathLabel(tree, s.id), q)) {
      markSelfAndAncestors(fid);
    }
  }

  return visible;
}
