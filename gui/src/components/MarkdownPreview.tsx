// ── 编辑器 Markdown 渲染预览 — 只读视图 ──
// 用 renderMarkdownPreview 纯函数渲染, 套 md-body 样式(与消息区 markdown 一致)。

import { useMemo } from "react";
import { renderMarkdownPreview } from "../utils/markdownPreview";

interface Props {
  content: string;
}

export default function MarkdownPreview({ content }: Props) {
  const html = useMemo(() => renderMarkdownPreview(content), [content]);

  // 外层撑满编辑区(bg-root 填满, 两侧不露出编辑器残留), 文字在内层保持阅读宽度居中
  return (
    <div style={{ height: "100%", overflow: "auto", backgroundColor: "var(--bg-root)" }}>
      <div
        className="md-body"
        style={{
          maxWidth: 820,
          margin: "0 auto",
          padding: "12px 24px",
          color: "var(--fg-primary)",
          fontFamily: "var(--font-sans)",
          fontSize: "calc(var(--font-scale, 1) * 14px)",
          lineHeight: 1.6,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
