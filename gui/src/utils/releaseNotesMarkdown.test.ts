import { describe, it, expect } from "vitest";
import { renderReleaseNotes } from "./releaseNotesMarkdown";

describe("renderReleaseNotes — markdown 结构", () => {
  it("### 分节标题渲染为 h 标签", () => {
    const html = renderReleaseNotes("### 修复");
    expect(html).toContain("<h3");
    expect(html).toContain("修复");
  });

  it("**粗体** 渲染为 strong（不再显示字面星号）", () => {
    const html = renderReleaseNotes("这是 **重点** 内容");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).not.toContain("**");
  });

  it("- 列表渲染为 ul/li", () => {
    const html = renderReleaseNotes("- 第一条\n- 第二条");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>第一条</li>");
    expect(html).toContain("<li>第二条</li>");
  });

  it("--- 渲染为分隔线", () => {
    expect(renderReleaseNotes("a\n\n---\n\nb")).toContain("<hr>");
  });

  it("累积多版（标题+列表+分隔）结构完整", () => {
    const notes = "v2026.09.10.2\n\n### 修复\n- 甲\n\n---\n\nv2026.09.10.1\n\n### 新增\n- 乙";
    const html = renderReleaseNotes(notes);
    expect(html).toContain("v2026.09.10.2");
    expect(html).toContain("v2026.09.10.1");
    expect(html).toContain("<hr>");
    expect((html.match(/<h3/g) || []).length).toBe(2);
  });

  it("空字符串 → 空输出", () => {
    expect(renderReleaseNotes("")).toBe("");
  });
});

describe("renderReleaseNotes — 防护（内容来自服务端，属外部输入）", () => {
  it("裸 <script> 被转义为可见文本，不产生可执行标签", () => {
    const html = renderReleaseNotes('<script>alert(1)</script>');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("带事件处理器的标签被转义（img onerror）", () => {
    const html = renderReleaseNotes('<img src=x onerror="alert(1)">');
    // 整个标签降级为可见文本 → 不产生真实 <img>，也就没有可执行的 onerror 属性
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    // 引号也被转义，无法闭合属性（关键：onerror= 只是字面文本，非属性）
    expect(html).toContain("onerror=&quot;alert(1)&quot;");
  });

  it("行内裸 HTML 同样被转义", () => {
    const html = renderReleaseNotes("文字 <b onmouseover=alert(1)>x</b> 结尾");
    expect(html).not.toContain("<b onmouseover");
    expect(html).toContain("&lt;b");
  });

  it("markdown 链接降级为纯文本（无 <a href>）", () => {
    const html = renderReleaseNotes("[点我](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
    expect(html).toContain("点我");
  });

  it("markdown 图片降级（无 <img src>）", () => {
    const html = renderReleaseNotes("![alt](http://evil/x.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("[图片: alt]");
  });

  it("代码块内容被转义但仍包裹在 pre/code（不二次转义成 &amp;lt;）", () => {
    const html = renderReleaseNotes("`<div>`");
    expect(html).toContain("<code>");
    expect(html).toContain("&lt;div&gt;");
    expect(html).not.toContain("&amp;lt;");
  });
});
