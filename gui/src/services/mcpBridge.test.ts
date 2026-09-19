// ── MCP 工具结果包装 ──
// 核心不变量：图片类工具的结果里，**base64 只能出现在 image 块里，绝不能同时
// 以文本形式再进上下文** —— 1920×1080 的 PNG base64 约 30 万字符 ≈ 数十万 token，
// 而且模型从文本里根本读不出图像内容，纯属烧钱。

import { describe, it, expect } from "vitest";
import { buildToolContent } from "./mcpBridge";

/** 取 content 里第一个 text 块的文本。 */
function textOf(content: unknown[]): string {
  const t = content.find((c) => (c as { type?: string }).type === "text") as { text?: string } | undefined;
  return t?.text ?? "";
}

describe("buildToolContent — 普通工具", () => {
  it("结果原样 JSON 进单个 text 块", () => {
    const r = buildToolContent({ ok: true, count: 3 }, false);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(textOf(r.content))).toEqual({ ok: true, count: 3 });
  });

  it("即使是图片形状的结果，没声明 image 也走文本（声明式优先，不靠猜）", () => {
    const r = buildToolContent({ image: { data: "AAAA", mimeType: "image/png" } }, false);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: "text" });
  });
});

describe("buildToolContent — 图片工具", () => {
  const shot = {
    ok: true,
    path: "C:\\shots\\a.png",
    name: "a.png",
    image: { data: "iVBORw0KGgoAAAANSUhEUg", mimeType: "image/png" },
    meta: { width: 1920, height: 1080, monitorIndex: 0 },
  };

  it("产出 image 块 + text 块", () => {
    const r = buildToolContent(shot, true);
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toMatchObject({
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUg",
      mimeType: "image/png",
    });
  });

  it("🔴 文本块里**不含** base64（否则同一份数据进两次上下文）", () => {
    const r = buildToolContent(shot, true);
    const text = textOf(r.content);
    expect(text).not.toContain("iVBORw0KGgoAAAANSUhEUg");
    expect(text).not.toContain("image");
    // base64 只应该出现在 image 块里，全量统计一次
    const joined = JSON.stringify(r.content);
    expect(joined.split("iVBORw0KGgoAAAANSUhEUg").length - 1).toBe(1);
  });

  it("文本块保留路径与尺寸等元数据（AI 后续要引用）", () => {
    const r = buildToolContent(shot, true);
    const parsed = JSON.parse(textOf(r.content));
    expect(parsed.path).toBe("C:\\shots\\a.png");
    expect(parsed.meta).toEqual({ width: 1920, height: 1080, monitorIndex: 0 });
  });

  it("mimeType 缺失 → 回落 image/png", () => {
    const r = buildToolContent({ image: { data: "AA" } }, true);
    expect(r.content[0]).toMatchObject({ mimeType: "image/png" });
  });

  it("声明了 image 但没拿到图（插件报错/取消）→ 退回纯文本，原因照实带上", () => {
    const r = buildToolContent({ ok: false, error: "抓屏失败" }, true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect(textOf(r.content)).toContain("抓屏失败");
  });

  it("data 为空串 → 同样退回文本（空图对模型没意义）", () => {
    const r = buildToolContent({ image: { data: "", mimeType: "image/png" } }, true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: "text" });
  });

  it("image 不是对象 / result 不是对象 → 不炸", () => {
    expect(buildToolContent(null, true).content).toHaveLength(1);
    expect(buildToolContent("oops", true).content).toHaveLength(1);
    expect(buildToolContent({ image: "not-an-object" }, true).content).toHaveLength(1);
  });
});
