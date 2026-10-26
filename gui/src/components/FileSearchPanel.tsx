// ── 文件内容搜索（文件面板的搜索模式）──
//
// 为什么放在文件面板而不是新开一个面板（2026-10-26 用户需求）：
//   ① 找内容和找文件是同一件事的两半 —— 在树旁边切一下就过去，不用记另一个面板叫什么；
//   ② 新面板要动面板注册与布局，收益不抵成本。
//
// 交互约定（对齐编辑器里的"全局搜索"直觉）：
//   · 输入即搜（300ms 防抖），回车立即搜；Esc 清空
//   · 默认大小写不敏感，Aa 可切换
//   · 结果按文件分组，点一条就直接打开该文件并跳到那一行
//   · 结果被上限截断时**明确告知**，不让用户以为"就这么多"

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X, CaseSensitive, Loader2 } from "lucide-react";
import { t } from "../i18n";

export interface SearchHit {
  path: string;
  rel: string;
  line: number;
  text: string;
}

interface SearchResponse {
  hits: SearchHit[];
  truncated: boolean;
  scanned: number;
}

/** 把命中按文件分组（保持后端顺序 = 遍历顺序）。纯函数，便于单测。 */
export function groupHitsByFile(hits: SearchHit[]): Array<{ rel: string; path: string; hits: SearchHit[] }> {
  const out: Array<{ rel: string; path: string; hits: SearchHit[] }> = [];
  const index = new Map<string, number>();
  for (const h of hits) {
    const i = index.get(h.rel);
    if (i === undefined) {
      index.set(h.rel, out.length);
      out.push({ rel: h.rel, path: h.path, hits: [h] });
    } else {
      out[i].hits.push(h);
    }
  }
  return out;
}

/** 把一行里的命中片段切成 [前, 命中, 后]（大小写不敏感）。纯函数，便于单测。 */
export function splitHighlight(
  text: string,
  query: string,
  caseSensitive: boolean,
): { before: string; match: string; after: string } | null {
  const q = query.trim();
  if (!q) return null;
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? q : q.toLowerCase();
  const i = hay.indexOf(needle);
  if (i < 0) return null;
  return {
    before: text.slice(0, i),
    match: text.slice(i, i + q.length),
    after: text.slice(i + q.length),
  };
}

const SEARCH_DEBOUNCE_MS = 300;

export function FileSearchPanel({
  rootPath,
  showHidden,
  onOpenHit,
}: {
  rootPath: string;
  showHidden: boolean;
  onOpenHit: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求序号：快速输入时只认最后一次的结果，避免旧结果覆盖新结果
  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(
    async (raw: string, cs: boolean) => {
      const q = raw.trim();
      const seq = ++seqRef.current;
      if (!q) {
        setResult(null);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const r = await invoke<SearchResponse>("search_in_files", {
          root: rootPath,
          query: q,
          showHidden,
          caseSensitive: cs,
        });
        if (seq !== seqRef.current) return; // 已有更新的请求
        setResult(r);
      } catch (e: any) {
        if (seq !== seqRef.current) return;
        setError(String(e?.message ?? e));
        setResult(null);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [rootPath, showHidden],
  );

  // 防抖：输入变化后 300ms 再查（回车会立刻查，见输入框的 onKeyDown）
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => void runSearch(query, caseSensitive), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, runSearch]);

  const groups = useMemo(() => groupHitsByFile(result?.hits ?? []), [result]);
  const totalHits = result?.hits.length ?? 0;

  const clear = () => {
    setQuery("");
    setResult(null);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontFamily: "var(--font-sans)" }}>
      {/* 搜索框 */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", borderBottom: "1px solid var(--border-light)", flexShrink: 0 }}>
        <Search size={13} style={{ color: "var(--fg-muted)", flexShrink: 0 }} />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void runSearch(query, caseSensitive);
            } else if (e.key === "Escape") {
              e.preventDefault();
              clear();
            }
          }}
          placeholder={t("files.searchPlaceholder")}
          aria-label={t("files.searchPlaceholder")}
          style={{
            flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
            color: "var(--fg-primary)", fontSize: "calc(var(--font-scale, 1) * 13px)",
            fontFamily: "var(--font-sans)",
          }}
        />
        <button
          type="button"
          onClick={() => setCaseSensitive((v) => !v)}
          title={t("files.searchCaseSensitive")}
          aria-label={t("files.searchCaseSensitive")}
          aria-pressed={caseSensitive}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, padding: 0, border: "none", borderRadius: 3,
            cursor: "pointer", flexShrink: 0,
            background: caseSensitive ? "var(--accent)" : "transparent",
            color: caseSensitive ? "var(--fg-inverse)" : "var(--fg-muted)",
          }}
        >
          <CaseSensitive size={13} />
        </button>
        {query && (
          <button
            type="button"
            onClick={clear}
            title={t("files.searchClear")}
            aria-label={t("files.searchClear")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 20, height: 20, padding: 0, border: "none", borderRadius: 3,
              cursor: "pointer", background: "transparent", color: "var(--fg-muted)", flexShrink: 0,
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* 状态行 */}
      {query.trim() && (
        <div style={{ padding: "3px 8px", fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", flexShrink: 0 }}>
          {loading
            ? t("files.searching")
            : error
              ? t("files.searchFailed", { error })
              : result
                ? result.truncated
                  ? t("files.searchResultsTruncated", { count: String(totalHits), scanned: String(result.scanned) })
                  : t("files.searchResults", { count: String(totalHits), scanned: String(result.scanned) })
                : ""}
        </div>
      )}

      {/* 结果区 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "2px 0" }}>
        {loading && totalHits === 0 && (
          <div style={{ padding: 12, display: "flex", justifyContent: "center", color: "var(--fg-muted)" }}>
            <Loader2 size={16} className="ccg-spin" />
          </div>
        )}
        {!loading && query.trim() && !error && result && totalHits === 0 && (
          <div style={{ padding: "12px 10px", color: "var(--fg-muted)", fontSize: "calc(var(--font-scale, 1) * 12px)", textAlign: "center" }}>
            {t("files.searchNoResults")}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.rel}>
            {/* 文件分组标题 */}
            <div
              title={g.path}
              style={{
                padding: "4px 8px 2px", fontSize: "calc(var(--font-scale, 1) * 11px)",
                color: "var(--fg-secondary)", fontWeight: 600,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{g.rel}</span>
              <span style={{ color: "var(--fg-muted)", fontWeight: 400, flexShrink: 0 }}>{g.hits.length}</span>
            </div>
            {g.hits.map((h, i) => {
              const parts = splitHighlight(h.text, query, caseSensitive);
              return (
                <div
                  key={`${h.line}-${i}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenHit(h.path, h.line)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenHit(h.path, h.line); } }}
                  title={`${h.rel}:${h.line}`}
                  style={{
                    display: "flex", alignItems: "baseline", gap: 8,
                    padding: "2px 8px 2px 16px", cursor: "pointer",
                    fontSize: "calc(var(--font-scale, 1) * 12px)",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
                >
                  <span style={{ color: "var(--fg-muted)", flexShrink: 0, minWidth: 28, textAlign: "right", fontSize: "calc(var(--font-scale, 1) * 11px)" }}>
                    {h.line}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {parts ? (
                      <>
                        <span style={{ color: "var(--fg-muted)" }}>{parts.before}</span>
                        <mark style={{ background: "var(--semantic-warning-subtle)", color: "var(--fg-primary)", borderRadius: 2, padding: "0 1px" }}>
                          {parts.match}
                        </mark>
                        <span style={{ color: "var(--fg-muted)" }}>{parts.after}</span>
                      </>
                    ) : (
                      <span style={{ color: "var(--fg-secondary)" }}>{h.text}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
