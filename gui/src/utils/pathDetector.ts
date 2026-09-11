/**
 * pathDetector.ts — Find file/directory paths in text for hover popover
 *
 * Matches paths containing at least one separator (/ or \),
 * excluding bare filenames (no separator).
 *
 * Returns offset ranges on the original text so callers can correlate
 * with DOM text nodes after markdown rendering.
 */

export interface PathMatch {
  /** The matched path string */
  path: string;
  /** Character offset where the match starts in the source text */
  start: number;
  /** Character offset where the match ends (exclusive) */
  end: number;
}

/**
 * Regex that matches paths with at least one / or \ separator.
 *
 * Breakdown:
 *   (?:[a-zA-Z]:[/\\])?     — optional Windows drive letter prefix (C:\)
 *   (?:[/\\])?               — optional leading separator
 *   (?:[^\s<>:"|?*]+[/\\])+  — one or more path-segments ending in separator
 *   [^\s<>:"|?*]+            — final segment (no separator)
 *
 * This naturally excludes bare filenames because the `(?:…[/\\])+` part
 * requires at least one separator.
 */
/** Reusable regex — exported so callers can use it directly for DOM scanning. */
export const PATH_REGEX = /(?:[a-zA-Z]:[/\\])?(?:[/\\])?(?:[^\s<>:"|?*]+[/\\])+[^\s<>:"|?*]+/g;

/**
 * Escape spaces that belong to the workspace directory with a `\u0001`
 * placeholder. PATH_REGEX excludes whitespace, so a path under a workspace whose
 * folders contain spaces (e.g. `C:\Work Space\src\a.ts`) would be split at the
 * space into two false matches. Replacing only the workspace's own spaces lets
 * the regex match the whole path as one token; callers restore the placeholder
 * to a space after matching. No-op when the workspace has no spaces.
 */
export function escapePathSpaces(text: string, workDir: string | undefined): string {
  if (!workDir || !workDir.includes(" ")) return text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 完整工作区路径（分隔符 / 或 \ 兼容）在文本中出现 → 其内部空格全部占位
  const dirRe = new RegExp(workDir.split(/[\\/]+/).map(esc).join("[\\\\/]"), "g");
  let out = text.replace(dirRe, (m) => m.replace(/ /g, "\u0001"));
  // 兜底：工作区最后一段（可能含空格）以相对路径形式单独出现也占位
  const base = workDir.split(/[\\/]+/).pop();
  if (base && base.includes(" ")) {
    out = out.replace(new RegExp(esc(base), "g"), (m) => m.replace(/ /g, "\u0001"));
  }
  return out;
}

/**
 * Scan text for paths, workspace-aware: spaces inside the workspace directory
 * are escaped first so a path under a space-containing workspace folder matches
 * as a single token, then restored. Deduplicated.
 */
export function findPathsWithWorkspace(text: string, workDir?: string): string[] {
  const escaped = escapePathSpaces(text, workDir);
  const regex = new RegExp(PATH_REGEX.source, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(escaped)) !== null) {
    out.push(m[0].replace(/\u0001/g, " "));
  }
  return [...new Set(out)];
}

/**
 * Find all file/directory paths in text.
 *
 * @param text - The text to scan (e.g. raw assistant markdown content)
 * @param excludeRanges - Optional ranges to skip (e.g. code block offsets).
 *                        Each range is `{start, end}` in character offsets.
 * @returns Array of PathMatch sorted by start offset.
 */
export function findPathsInText(
  text: string,
  excludeRanges?: { start: number; end: number }[],
): PathMatch[] {
  const results: PathMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = PATH_REGEX.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    // Check if this match falls inside any excluded range
    if (excludeRanges && isOverlapping(start, end, excludeRanges)) {
      continue;
    }

    results.push({
      path: match[0],
      start,
      end,
    });
  }

  return results;
}

/**
 * Check if [start, end) overlaps any of the given ranges.
 */
function isOverlapping(
  start: number,
  end: number,
  ranges: { start: number; end: number }[],
): boolean {
  for (const r of ranges) {
    if (start < r.end && end > r.start) return true;
  }
  return false;
}

/**
 * Extract code block ranges from a markdown string.
 * Returns the character offsets of fenced code blocks (```...```)
 * so the caller can exclude paths inside them.
 */
export function findCodeBlockRanges(markdown: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const codeFenceRegex = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = codeFenceRegex.exec(markdown)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  // Also match indented code blocks (4+ spaces or 1+ tab)
  const indentBlockRegex = /(?:^|\n)(?: {4,}|\t).*(?:\n(?: {4,}|\t).*)*/g;
  while ((m = indentBlockRegex.exec(markdown)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}