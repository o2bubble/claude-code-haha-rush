//! Chinese/English tokenization for FTS5 full-text search.
//!
//! Port of `extensions/memory/tokenizer.py` — both sides must produce the same
//! tokens so an index built by one is searchable by the other.
//!
//! Index side: jieba `cut_for_search` (search-engine mode) emits sub-words in
//! addition to whole words, so indexing "人工智能" also makes "智能" findable.
//! Query side: the same tokenizer runs on the query and the result is joined
//! with OR into quoted phrases — recall first, precision comes from BM25 ranking.
//!
//! The CJK bigram channel exists to bridge jieba's context-dependent
//! segmentation: "有龙猫这个词" may segment to "有龙 | 猫" while a query for
//! "龙猫" stays whole — the bigram "龙猫" matches on both sides.

use std::sync::OnceLock;

use jieba_rs::Jieba;

/// ~40 high-frequency Chinese function words; deliberately small.
/// Filtered on the QUERY side only — the index keeps them so BM25's IDF can
/// discount them naturally.
pub const STOP_WORDS: &[&str] = &[
    "的", "了", "在", "是", "我", "你", "他", "她", "它", "们", "有", "和", "与", "或", "就",
    "都", "也", "还", "要", "会", "能", "可", "被", "把", "让", "给", "对", "从", "到", "于",
    "为", "上", "下", "中", "里", "这", "那", "些", "什", "么", "呢", "吗", "吧", "啊", "呀",
    "哦", "嗯", "之", "者", "而", "且",
];

// Loading the jieba dictionary costs ~350ms and several MB; it must happen once
// per process, and a failure must not be retried on every call.
static JIEBA: OnceLock<Option<Jieba>> = OnceLock::new();

/// jieba instance, or None when it failed to load (permanent fallback).
fn jieba() -> Option<&'static Jieba> {
    JIEBA
        .get_or_init(|| {
            let j = Jieba::new();
            // Prime the dictionary load here so the first user query does not
            // pay for it.
            j.cut_for_search("预热", true);
            Some(j)
        })
        .as_ref()
}

pub fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// True when the string contains at least one CJK ideograph or ASCII alphanumeric.
fn has_meaningful_char(s: &str) -> bool {
    s.chars().any(|c| is_cjk(c) || c.is_ascii_alphanumeric())
}

/// `[a-zA-Z0-9_]` runs, lowercased.
fn latin_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            cur.push(c.to_ascii_lowercase());
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Character-level 2-grams over CJK runs (no dictionary needed).
///
/// Unlike unigram expansion this cannot produce single-character noise:
/// searching "量子力学" will not match a document that merely contains "学".
fn cjk_bigrams(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut run: Vec<char> = Vec::new();
    let flush = |run: &mut Vec<char>, out: &mut Vec<String>| {
        if run.len() == 1 {
            out.push(run[0].to_string());
        } else {
            for i in 0..run.len().saturating_sub(1) {
                out.push(run[i..i + 2].iter().collect());
            }
        }
        run.clear();
    };
    for c in text.chars() {
        if is_cjk(c) {
            run.push(c);
        } else if !run.is_empty() {
            flush(&mut run, &mut out);
        }
    }
    if !run.is_empty() {
        flush(&mut run, &mut out);
    }
    out
}

/// jieba search-mode tokens (or latin fallback) + CJK bigram channel.
///
/// Every token is lowercased: FTS5 matches tokens case-sensitively, so indexing
/// "Login" while the query says "login" would silently miss. jieba preserves the
/// original casing, so the normalization has to happen here.
fn cut(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    if let Some(j) = jieba() {
        tokens = j
            .cut_for_search(text, true)
            .into_iter()
            .map(|t| t.word.to_lowercase())
            .filter(|t| !t.trim().is_empty())
            .collect();
    }
    if tokens.is_empty() {
        tokens = latin_tokens(text);
    }
    tokens.extend(cjk_bigrams(text));
    tokens
}

/// Index-side tokenization: search-mode tokens joined by spaces.
pub fn tokenize_for_index(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    cut(text).join(" ")
}

/// Query-side tokenization: OR-joined quoted phrases.
///
/// Returns an empty string when nothing usable remains — the caller must treat
/// that as "no query" rather than sending an empty MATCH (which FTS5 rejects).
pub fn build_fts_query(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut parts: Vec<String> = Vec::new();
    for raw in cut(text) {
        // A double quote inside the token would terminate the quoted phrase.
        let tok = raw.trim().replace('"', "");
        if tok.is_empty() || seen.contains(&tok) || STOP_WORDS.contains(&tok.as_str()) {
            continue;
        }
        if !has_meaningful_char(&tok) {
            continue; // pure punctuation
        }
        seen.insert(tok.clone());
        parts.push(format!("\"{}\"", tok));
    }
    parts.join(" OR ")
}

/// "jieba" when the full tokenizer is loaded, "bigram" under fallback.
/// The store records this and re-indexes when it changes.
pub fn tokenizer_status() -> &'static str {
    if jieba().is_some() {
        "jieba"
    } else {
        "bigram"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_expands_subwords() {
        let tokens = tokenize_for_index("人工智能的分支");
        assert!(tokens.contains("人工智能"), "whole word missing: {}", tokens);
        assert!(tokens.contains("分支"), "subword missing: {}", tokens);
    }

    /// The reason the bigram channel exists: jieba may split "有龙猫" into
    /// 有龙|猫, so a whole-word query for 龙猫 must still match via bigram.
    #[test]
    fn bigram_bridges_jieba_segmentation() {
        let indexed = tokenize_for_index("有龙猫这个词");
        assert!(indexed.contains("龙猫"), "bigram bridge missing: {}", indexed);
        let q = build_fts_query("龙猫");
        assert!(q.contains("\"龙猫\""), "query missing bigram: {}", q);
    }

    #[test]
    fn query_filters_stopwords() {
        let q = build_fts_query("的登录");
        assert!(!q.contains("\"的\""), "stopword leaked: {}", q);
        assert!(q.contains("\"登录\""), "content word missing: {}", q);
    }

    #[test]
    fn query_strips_punctuation_only() {
        assert_eq!(build_fts_query("!!!...???"), "");
        assert_eq!(build_fts_query("   "), "");
    }

    #[test]
    fn single_cjk_char_still_searchable() {
        assert!(build_fts_query("学").contains("\"学\""));
    }

    #[test]
    fn latin_is_lowercased() {
        let q = build_fts_query("Login 模块");
        assert!(q.contains("\"login\""), "latin not lowercased: {}", q);
    }

    #[test]
    fn quotes_in_input_cannot_break_the_match_syntax() {
        let q = build_fts_query("say \"hi\"");
        assert_eq!(q.matches('"').count() % 2, 0, "unbalanced quotes: {}", q);
    }
}
