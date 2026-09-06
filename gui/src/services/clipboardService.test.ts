import { describe, it, expect, vi } from "vitest";
import { resolvePaste } from "./clipboardService";

const mkBlob = (name: string, type = "application/octet-stream") =>
  new Blob([name], { type });
const mkPathExists = (v: boolean) => vi.fn().mockResolvedValue(v);

describe("resolvePaste — 粘贴内容 → 引用/保存/文本 决策", () => {
  it("文件对象带 .path → 直接 file ref（不复制）", async () => {
    const d = await resolvePaste({
      files: [{ name: "a.ts", blob: mkBlob("x"), path: "/w/a.ts" }],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
    });
    expect(d).toEqual({
      kind: "refs",
      refs: [{ type: "file", path: "/w/a.ts", label: "a.ts" }],
    });
  });

  it("文件对象是目录 → 只引用目录本身（不展开子项）", async () => {
    const readDir = vi.fn().mockResolvedValue([
      { path: "/w/dir/b.ts", name: "b.ts", is_dir: false },
      { path: "/w/dir/sub", name: "sub", is_dir: true },
    ]);
    const d = await resolvePaste({
      files: [{ name: "dir", blob: mkBlob(""), path: "/w/dir" }],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
      readDir,
    });
    expect(d).toEqual({ kind: "refs", refs: [{ type: "dir", path: "/w/dir", label: "dir" }] });
  });

  it("无 .path 的文件 blob → saveImages，且保留原始文件名", async () => {
    const b = mkBlob("data");
    const d = await resolvePaste({
      files: [{ name: "report.pdf", blob: b }],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
    });
    expect(d).toEqual({ kind: "saveImages", items: [{ blob: b, name: "report.pdf" }] });
  });

  it("剪贴板图片 blob（image/*）→ saveImages", async () => {
    const b = mkBlob("img", "image/png");
    const d = await resolvePaste({
      files: [],
      images: [{ blob: b, mime: "image/png" }],
      text: "",
      pathExists: mkPathExists(true),
    });
    expect(d).toEqual({ kind: "saveImages", items: [{ blob: b, name: undefined }] });
  });

  it("路径文本指向文件 → file ref", async () => {
    const d = await resolvePaste({
      files: [],
      images: [],
      text: "/w/src/a.ts",
      pathExists: mkPathExists(true),
    });
    expect(d).toEqual({
      kind: "refs",
      refs: [{ type: "file", path: "/w/src/a.ts", label: "a.ts" }],
    });
  });

  it("路径文本指向目录 → 只引用目录本身（不展开子项，避免一堆子路径 chip）", async () => {
    const readDir = vi.fn().mockResolvedValue([
      { path: "/w/src/b.ts", name: "b.ts", is_dir: false },
      { path: "/w/src/sub", name: "sub", is_dir: true },
    ]);
    const d = await resolvePaste({
      files: [],
      images: [],
      text: "/w/src",
      pathExists: mkPathExists(true),
      readDir,
    });
    expect(d).toEqual({ kind: "refs", refs: [{ type: "dir", path: "/w/src", label: "src" }] });
  });

  it("路径文本不存在 → 长文本回落 paste ref", async () => {
    const d = await resolvePaste({
      files: [],
      images: [],
      text: "x".repeat(200),
      pathExists: mkPathExists(false),
    });
    expect(d.kind).toBe("refs");
    if (d.kind === "refs") expect(d.refs[0].type).toBe("paste");
  });

  it("路径文本不存在 → 短文本 inline", async () => {
    const d = await resolvePaste({
      files: [],
      images: [],
      text: "hello",
      pathExists: mkPathExists(false),
    });
    expect(d).toEqual({ kind: "inlineText", text: "hello" });
  });

  it("空输入 → 空 refs（不抛错）", async () => {
    const d = await resolvePaste({
      files: [],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
    });
    expect(d.kind).toBe("refs");
    if (d.kind === "refs") expect(d.refs).toEqual([]);
  });

  it("无 .path 的图片不会因 files+images 重复计数（粘贴图片只出一个 clip）", async () => {
    const b = mkBlob("img", "image/png");
    const d = await resolvePaste({
      files: [{ name: "Screenshot.png", blob: b, type: "image/png" }],
      images: [{ blob: b, mime: "image/png" }],
      text: "",
      pathExists: mkPathExists(true),
    });
    // 修复前：files 的图 + images 的图各 push 一次 → items 长为 2 → 产生两个 chip
    expect(d).toEqual({ kind: "saveImages", items: [{ blob: b }] });
  });
});
