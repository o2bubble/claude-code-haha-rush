// ── 编辑器 Markdown 渲染预览 — 纯函数，可单测 ──
// 接缝：renderMarkdownPreview / isMarkdownFile（无 DOM 依赖）

import { marked } from "marked";
import { highlightCode } from "./highlight";

const markdownRenderer = makeRenderer();

function makeRenderer() {
  const r = new marked.Renderer();
  r.code = ({ text, lang }) => {
    const langCls = lang ? ` language-${lang}` : "";
    return `<pre><code class="hljs${langCls}">${highlightCode(text, lang || "")}</code></pre>`;
  };
  return r;
}

/** 把 markdown 渲染为 HTML（代码块 hljs 高亮，失败回退转义）。
 *  渲染选项与消息区 assistant markdown 对齐(gfm, breaks 默认 false), 视觉一致。 */
export function renderMarkdownPreview(content: string): string {
  const html = marked.parse(content, { renderer: markdownRenderer, gfm: true });
  return typeof html === "string" ? html : "";
}

const MD_EXT = new Set(["md", "markdown", "mdx"]);

/** 是否 markdown 系列文件（决定编辑器是否显示预览切换） */
export function isMarkdownFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MD_EXT.has(ext);
}
