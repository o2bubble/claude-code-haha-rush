// ── 会话文件夹 — 纯函数，可单测 ──
// 接缝：文件夹树 + 会话归属的全部状态变换（无 DOM 依赖，同 sessionFavorites.ts 先例）。
// 约定：parentId 实现嵌套树；删除文件夹级联（子文件夹 + 会话上移父级或未归类）；
// 移动文件夹防循环（不能移到自身/后代）。

export interface SessionFolder {
  id: string;
  name: string;
  parentId?: string;
}

export interface SessionFolderTree {
  folders: SessionFolder[];
  /** sessionId -> folderId */
  assignments: Record<string, string>;
}

export interface FolderNode {
  folder: SessionFolder;
  children: FolderNode[];
}

export function createFolder(tree: SessionFolderTree, id: string, name: string, parentId?: string): SessionFolderTree {
  return { ...tree, folders: [...tree.folders, { id, name, parentId }] };
}

export function renameFolder(tree: SessionFolderTree, id: string, name: string): SessionFolderTree {
  return { ...tree, folders: tree.folders.map((f) => (f.id === id ? { ...f, name } : f)) };
}

/** 删除文件夹（折叠语义）：只删它本身；其直接子文件夹上移到父级；
 *  它直接归属的会话上移到父级（根则未归类）；子文件夹内的会话保留在原文件夹。 */
export function deleteFolder(tree: SessionFolderTree, id: string): SessionFolderTree {
  const deleted = tree.folders.find((f) => f.id === id);
  if (!deleted) return tree;
  const parentId = deleted.parentId;
  const folders = tree.folders
    .filter((f) => f.id !== id)
    .map((f) => (f.parentId === id ? { ...f, parentId } : f));
  const assignments: Record<string, string> = {};
  for (const [sid, fid] of Object.entries(tree.assignments)) {
    if (fid === id) {
      if (parentId) assignments[sid] = parentId;
    } else {
      assignments[sid] = fid;
    }
  }
  return { folders, assignments };
}

/** 移动文件夹到新父级；不能移到自身或自己的后代（防环）。newParentId 缺省=移到根。 */
export function moveFolder(tree: SessionFolderTree, id: string, newParentId?: string): SessionFolderTree {
  if (newParentId === id) return tree;
  const descendants = new Set<string>();
  const collect = (fid: string) => {
    for (const f of tree.folders) {
      if (f.parentId === fid && !descendants.has(f.id)) {
        descendants.add(f.id);
        collect(f.id);
      }
    }
  };
  collect(id);
  if (newParentId && descendants.has(newParentId)) return tree;
  return { ...tree, folders: tree.folders.map((f) => (f.id === id ? { ...f, parentId: newParentId } : f)) };
}

export function assignSession(tree: SessionFolderTree, sessionId: string, folderId: string): SessionFolderTree {
  return { ...tree, assignments: { ...tree.assignments, [sessionId]: folderId } };
}

export function unassignSession(tree: SessionFolderTree, sessionId: string): SessionFolderTree {
  const { [sessionId]: _drop, ...rest } = tree.assignments;
  return { ...tree, assignments: rest };
}

/** 会话列表是否完整（孤儿清理的前提）。total 未知（旧后端）时信任 loaded 列表；
 *  total > 返回数（截断/分页）时列表不完整，不能据此清理孤儿归属——否则真实存在
 *  的会话被误删归属，下次回列表显示为未分类/找不到。 */
export function isSessionListComplete(returned: number, total: number | null): boolean {
  return total == null || returned >= total;
}

/** 清理 assignments 里已不在 liveIds 中的孤儿归属（防数据膨胀兜底）。
 *  ⚠️ 调用方必须先用 isSessionListComplete 确认 liveIds 是完整会话全集——截断/分页
 *  列表会把仍真实存在的会话归属误删。 */
export function pruneOrphanAssignments(
  assignments: Record<string, string>,
  liveIds: Iterable<string>,
): Record<string, string> {
  const live = new Set(liveIds);
  const entries = Object.entries(assignments);
  const orphans = entries.filter(([id]) => !live.has(id));
  if (orphans.length === 0) return assignments; // 无孤儿 → 原引用，调用方可据此跳过保存
  return Object.fromEntries(entries.filter(([id]) => live.has(id)));
}

/** 批量移动；folderId=null 时归未归类。 */
export function moveSessions(tree: SessionFolderTree, sessionIds: string[], folderId: string | null): SessionFolderTree {
  const assignments = { ...tree.assignments };
  for (const sid of sessionIds) {
    if (folderId === null) delete assignments[sid];
    else assignments[sid] = folderId;
  }
  return { ...tree, assignments };
}

/** 扁平 folders → 嵌套树（根级顺序 = folders 数组顺序，子级同理）。
 *  根级判定统一 `null`/`undefined` 为同一层——持久化时 Rust `default` 会省略
 *  parentId 字段(undefined)，而旧数据/手动构造可能是 null；两者都是根级，
 *  若分开分组会导致部分根文件夹永不渲染（会话被藏）。 */
export function buildFolderTree(tree: SessionFolderTree): FolderNode[] {
  const byParent = new Map<string | undefined, SessionFolder[]>();
  for (const f of tree.folders) {
    const key = f.parentId ?? undefined;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(f);
  }
  const build = (parentId?: string): FolderNode[] =>
    (byParent.get(parentId ?? undefined) ?? []).map((f) => ({ folder: f, children: build(f.id) }));
  return build(undefined);
}

/** 会话按文件夹分组（直接归属）；归属到不存在文件夹的会话进未归类（防悬挂）。 */
export function partitionSessions<T extends { id: string }>(
  tree: SessionFolderTree,
  sessions: T[],
): { byFolder: Record<string, T[]>; uncategorized: T[] } {
  const byFolder: Record<string, T[]> = {};
  const uncategorized: T[] = [];
  const valid = new Set(tree.folders.map((f) => f.id));
  for (const s of sessions) {
    const fid = tree.assignments[s.id];
    if (fid && valid.has(fid)) (byFolder[fid] ??= []).push(s);
    else uncategorized.push(s);
  }
  return { byFolder, uncategorized };
}
