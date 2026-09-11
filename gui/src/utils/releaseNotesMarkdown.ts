// ── 发布说明 Markdown 渲染 — 纯函数，可单测 ──
//
// 发布说明来自服务端（manifest.release_notes），是**外部输入**。渲染走
// dangerouslySetInnerHTML，因此必须自带防护 —— 与消息区的 renderMarkdownPreview
// 不同：那里内容是用户自己/AI 写的，这里可能是被篡改的服务端响应。Tauri webview
// 能调 invoke（删 profile、改设置等），绝不能放行原始 HTML。
//
// 策略：只放行 markdown 语法产生的结构（标题/列表/粗体/代码/分隔线）。
// marked 把内容里的裸 HTML 交给 html() 渲染，覆写为转义输出即可 ——
// `<script>` / `<img onerror>` 退化为可见文本。其余 token（codespan 等）
// marked 内部已做转义，不要二次转义（会显示成 &amp;lt;）。
//
// 与 build.ts 的 --notes 写法约定（累积风格）配套：
//   ### 修复            ← 分节标题（h3）
//   - 一句话说明 — 为什么
//   ---                 ← 版本分隔（累积多版时）

import { marked } from "marked";

/** HTML 实体转义 —— 原样文本里的标签降级为可见字符 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const renderer = new marked.Renderer();

// 关键防护：marked 把无法识别的裸 HTML（块级/行内）都交给 html() 输出原文，
// 覆写为转义 → 任何标签都变成可见文本，不会被浏览器当标签执行。
renderer.html = ({ text }) => escapeHtml(text);

// 说明里不需要可点击外链（webview 内导航另有风险）——链接降级为纯文本。
renderer.link = ({ text }) => escapeHtml(text);

// 图片同理降级（说明里放图无意义，且 src 可被利用做请求）。
renderer.image = ({ text }) => escapeHtml(`[图片: ${text || ""}]`);

/** 把发布说明 markdown 渲染为**已防护**的 HTML。解析失败回退纯文本转义。 */
export function renderReleaseNotes(notes: string): string {
  if (!notes) return "";
  try {
    const html = marked.parse(notes, { renderer, gfm: true });
    return typeof html === "string" ? html : "";
  } catch {
    return escapeHtml(notes).replace(/\r?\n/g, "<br>");
  }
}
