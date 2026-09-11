"""Chinese/English tokenization for FTS5 full-text search.

Named `tokenizer` rather than `tokenize` to avoid shadowing the Python stdlib
`tokenize` module (imported internally by inspect/pdb/linecache).

Index side: jieba `cut_for_search` (search-engine mode) emits sub-words in
addition to whole words, so indexing "人工智能" also makes "智能" findable.
Query side: the same tokenizer runs on the query and the result is joined
with OR into quoted phrases — recall first, precision comes from BM25 ranking.

When jieba is unavailable the module degrades to a CJK bigram split, which is
far better than treating a whole CJK run as one token. Both sides always use
the same tokenizer, so the fallback stays self-consistent.
"""

from __future__ import annotations

import re

# ~40 high-frequency Chinese function words; deliberately small.
STOP_WORDS = frozenset(
    "的 了 在 是 我 你 他 她 它 们 有 和 与 或 就 都 也 还 要 会 能 可 被 把 让 给 "
    "对 从 到 于 为 上 下 中 里 这 那 些 什 么 呢 吗 吧 啊 呀 哦 嗯 之 者 而 且".split()
)

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]+")
_LATIN_RE = re.compile(r"[a-zA-Z0-9_]+")

_jieba = None
_load_attempted = False


def _get_jieba():
    """Lazily load jieba once; failures permanently fall back to bigram."""
    global _jieba, _load_attempted
    if not _load_attempted:
        _load_attempted = True
        try:
            import jieba

            jieba.setLogLevel(20)  # WARNING — silence build-dict INFO spam
            jieba.initialize()
            _jieba = jieba
        except Exception:
            _jieba = None
    return _jieba


def _latin_tokens(text: str) -> list[str]:
    return [m.group(0).lower() for m in _LATIN_RE.finditer(text)]


def _cjk_bigrams(text: str) -> list[str]:
    """Character-level 2-grams over CJK runs (no dictionary needed).

    This channel bridges jieba's context-dependent segmentation: "有龙猫这个
    词" may segment to "有龙 | 猫" while the query "龙猫" stays whole — the
    bigram "龙猫" matches on both sides. Unlike unigram expansion it cannot
    produce single-character noise (searching "量子力学" will not match a
    document that merely contains "学").
    """
    out: list[str] = []
    for run in _CJK_RUN_RE.findall(text):
        if len(run) == 1:
            out.append(run)
        else:
            for i in range(len(run) - 1):
                out.append(run[i : i + 2])
    return out


def _cut(text: str) -> list[str]:
    """jieba search-mode tokens (or latin fallback) + CJK bigram channel."""
    tokens: list[str] = []
    j = _get_jieba()
    if j is not None:
        try:
            tokens = [t for t in j.cut_for_search(text, HMM=True) if t.strip()]
        except Exception:
            tokens = []
    if not tokens:
        tokens = _latin_tokens(text)
    tokens.extend(_cjk_bigrams(text))
    return tokens


def tokenize_for_index(text: str) -> str:
    """Index-side tokenization: search-mode tokens joined by spaces."""
    if not text:
        return ""
    return " ".join(_cut(text))


def build_fts_query(text: str) -> str:
    """Query-side tokenization: OR-joined quoted phrases.

    Returns an empty string when nothing usable remains (caller should treat
    that as "no query" rather than sending an empty MATCH).
    """
    if not text or not text.strip():
        return ""
    seen: set[str] = set()
    parts: list[str] = []
    for tok in _cut(text):
        tok = tok.strip().replace('"', "")
        if not tok or tok in seen or tok in STOP_WORDS:
            continue
        if not (_CJK_RE.search(tok) or re.search(r"[a-zA-Z0-9]", tok)):
            continue  # pure punctuation
        seen.add(tok)
        parts.append(f'"{tok}"')
    return " OR ".join(parts)


def get_tokenizer_status() -> str:
    """'jieba' when the full tokenizer is loaded, 'bigram' under fallback."""
    return "jieba" if _get_jieba() is not None else "bigram"
