// ── 编辑器 Markdown 渲染预览 · 纯函数测试（T1）──
// 接缝：markdownPreview.ts 的 renderMarkdownPreview / isMarkdownFile（无 DOM 依赖）

import { describe, it, expect, vi } from "vitest";
import hljs from "highlight.js";
import { renderMarkdownPreview, isMarkdownFile } from "./markdownPreview";

describe("renderMarkdownPreview", () => {
  it("标题 → h1", () => {
    expect(renderMarkdownPreview("# Hello")).toContain("<h1");
  });

  it("列表 → ul/li", () => {
    const html = renderMarkdownPreview("- a\n- b");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>a</li>");
  });

  it("粗体 → strong, 斜体 → em", () => {
    expect(renderMarkdownPreview("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdownPreview("*em*")).toContain("<em>em</em>");
  });

  it("链接 → a[href]", () => {
    expect(renderMarkdownPreview("[link](https://x.com)")).toContain('<a href="https://x.com"');
  });

  it("表格 → table", () => {
    const html = renderMarkdownPreview("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
  });

  it("行内代码 → code", () => {
    expect(renderMarkdownPreview("use `code` here")).toContain("<code>code</code>");
  });

  it("代码块带语言 → hljs 高亮 class + 语言 class", () => {
    const html = renderMarkdownPreview("```js\nconst x = 1;\n```");
    expect(html).toContain("hljs");
    expect(html).toContain("language-js");
  });

  it("代码块内容被转义（不注入可执行 HTML）", () => {
    const html = renderMarkdownPreview("```html\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("hljs 抛错 → 回退转义不崩溃", () => {
    const spy = vi.spyOn(hljs, "highlight").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const html = renderMarkdownPreview("```js\n<script>alert(1)</script>\n```");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
    } finally {
      spy.mockRestore();
    }
  });

  it("空 / 仅空白 → 安全不抛错", () => {
    expect(() => renderMarkdownPreview("")).not.toThrow();
    expect(() => renderMarkdownPreview("   ")).not.toThrow();
  });
});

describe("isMarkdownFile", () => {
  it("md 系列 → true", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("doc.markdown")).toBe(true);
    expect(isMarkdownFile("page.mdx")).toBe(true);
  });

  it("非 md → false", () => {
    expect(isMarkdownFile("app.ts")).toBe(false);
    expect(isMarkdownFile("x.txt")).toBe(false);
    expect(isMarkdownFile("noext")).toBe(false);
  });
});
