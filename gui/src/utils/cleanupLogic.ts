// ── 清理工具的前端纯逻辑 ──
//
// 规格：.scratch/cleanup-tool/PRD.md
//
// 这里只放**可单测的判定**：类别元数据、默认勾选、二次确认门禁、工作区归一化。
// 实际扫描与删除都在 Rust（`cleanup.rs`），前端不做文件系统操作。

/** 清理类别 id —— 与 Rust 的 `CAT_*` 常量**逐字对应**（跨端契约）。 */
export type CleanupCategory =
  | "temp"
  | "app-cache"
  | "file-history"
  | "archive"
  | "orphan";

/** 一条候选（结构对应 Rust `CleanupItem`，camelCase）。 */
export interface CleanupItem {
  id: string;
  category: CleanupCategory;
  /** 具体种类：`tool-results` / `shell-snapshots` / `workspace-pasted` … */
  kind: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  lastModifiedMs: number | null;
  deletable: boolean;
  /** `protected` / `active-workspace` / `in-use` */
  blockedReason: string | null;
  timedOut: boolean;
}

export interface ScanResult {
  items: CleanupItem[];
  workspacesTotal: number;
  workspacesTimedOut: number;
}

export interface DeleteOutcome {
  id: string;
  path: string;
  ok: boolean;
  error: string | null;
  freedBytes: number;
}

export interface RunReport {
  outcomes: DeleteOutcome[];
  freedBytes: number;
}

/** 类别的显示顺序与默认勾选。
 *
 * 默认只有「临时产物」勾上 —— 规格 Q20：其余全部默认不勾。 */
export const CATEGORY_ORDER: CleanupCategory[] = [
  "temp",
  "app-cache",
  "file-history",
  "archive",
  "orphan",
];

export const DEFAULT_CHECKED: Record<CleanupCategory, boolean> = {
  temp: true,
  "app-cache": false,
  "file-history": false,
  archive: false,
  orphan: false,
};

/** 需要二次确认的类别 —— 规格：只有编辑快照。
 *
 * 它不是"更危险"，而是**不可恢复且不易察觉**：删完界面上什么都看不出来，
 * 直到某天想撤销一次历史编辑才发现回不去。 */
export const NEEDS_CONFIRM: ReadonlySet<CleanupCategory> = new Set<CleanupCategory>([
  "file-history",
]);

/** 默认勾选集合（用于首次渲染）。 */
export function initialSelection(): Set<CleanupCategory> {
  return new Set(
    CATEGORY_ORDER.filter((c) => DEFAULT_CHECKED[c]),
  );
}

/** 某个类别能否被勾选：至少有一条能删的项。
 *
 * `force` 打开后被跳过的项也算「能删」（`protected` 除外）。
 * 否则一个类别若全是「其他窗口正在用」的项，打开开关后仍然勾不动。 */
export function isCategorySelectable(
  category: CleanupCategory,
  items: readonly CleanupItem[],
  force = false,
): boolean {
  return items.some(
    (i) =>
      i.category === category &&
      (i.deletable || (force && i.blockedReason !== "protected")),
  );
}

/** 汇总某类别：可删项总大小 / 文件数 / 明细（`force` 时把可强制项也算上）。 */
export function summarizeCategory(
  category: CleanupCategory,
  items: readonly CleanupItem[],
  force = false,
): { bytes: number; files: number; entries: CleanupItem[] } {
  const entries = items.filter((i) => i.category === category);
  let bytes = 0;
  let files = 0;
  for (const e of entries) {
    const counts = e.deletable || (force && e.blockedReason !== "protected");
    if (!counts) continue;
    bytes += e.sizeBytes;
    files += e.fileCount;
  }
  return { bytes, files, entries };
}

/** 被跳过的项统计。
 *
 * `forced` 与 `protected` 必须分开：前者是「别人正在用」这类**可绕过**的保护，
 * 后者（`.git` 配置版本仓库）**永远不能**包含 —— 删掉就丢配置历史。 */
export interface BlockedSummary {
  /** 可强制包含的项（其他窗口正在使用的工作区） */
  forced: number;
  /** 永远不可包含的项（受保护） */
  protected: number;
  total: number;
}

export function summarizeBlocked(items: readonly CleanupItem[]): BlockedSummary {
  let forced = 0;
  let prot = 0;
  for (const i of items) {
    if (i.deletable) continue;
    if (i.blockedReason === "protected") prot++;
    else forced++;
  }
  return { forced, protected: prot, total: forced + prot };
}

/** 是否还有可被强制的项（供界面决定要不要显示开关）。 */
export function hasForceableItems(items: readonly CleanupItem[]): boolean {
  return items.some((i) => !i.deletable && i.blockedReason !== "protected");
}

/** 构造删除请求载荷。
 *
 * `force` 用于**用户明确要求**包含那些被跳过的项（规格：强制开关默认关闭）。
 * 但 `protected` 永远排除 —— `.git` 是配置版本仓库，不是垃圾。
 * Rust 侧 `validate_deletable` 也会再拒一次；这里只是不发注定失败的请求。 */
export function buildDeleteRequest(
  selection: ReadonlySet<CleanupCategory>,
  items: readonly CleanupItem[],
  force = false,
): CleanupItem[] {
  return items.filter((i) => {
    if (!selection.has(i.category)) return false;
    if (i.deletable) return true;
    return force && i.blockedReason !== "protected";
  });
}

/** 这一次操作是否需要弹二次确认。 */
export function needsConfirm(selection: ReadonlySet<CleanupCategory>): boolean {
  for (const c of selection) {
    if (NEEDS_CONFIRM.has(c)) return true;
  }
  return false;
}

/** 工作区路径归一化（用于比较）。与 Rust `normalize_path` 同义。 */
export function normalizeWorkspacePath(p: string): string {
  let s = (p ?? "").trim().replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (/^[a-z]:/i.test(s)) s = s.toLowerCase();
  return s;
}

/** 去重：同一工作区的不同写法只保留首次出现的那条。 */
export function dedupeWorkspaces(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of list) {
    if (!w || !w.trim()) continue;
    const key = normalizeWorkspacePath(w);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** 人类可读的字节数。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** 执行结果摘要。失败项单独挑出来 —— 结果页要把路径和原因都列出来。 */
export function summarizeRun(report: RunReport): {
  okCount: number;
  failCount: number;
  freedBytes: number;
  failures: DeleteOutcome[];
} {
  const failures = report.outcomes.filter((o) => !o.ok);
  return {
    okCount: report.outcomes.length - failures.length,
    failCount: failures.length,
    freedBytes: report.freedBytes,
    failures,
  };
}
