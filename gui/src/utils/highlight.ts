// ── 代码高亮 — 纯函数，消息区与编辑器 md 预览共用 ──
// 单一实现防分叉：任何高亮修复只改这一处。

import hljs from "highlight.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 语法高亮代码；无匹配语言/hljs 抛错时回退为 HTML 转义（防注入）。 */
export function highlightCode(code: string, lang: string): string {
  if (!code) return "";
  try {
    if (lang && hljs.getLanguage(lang)) {
      const r = hljs.highlight(code, { language: lang });
      if (r.value) return r.value;
    }
    const auto = hljs.highlightAuto(code);
    if (auto.value) return auto.value;
  } catch { /* fall through to escape */ }
  return escapeHtml(code);
}
