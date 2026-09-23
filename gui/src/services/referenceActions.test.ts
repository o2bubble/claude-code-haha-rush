import { describe, it, expect, beforeEach, vi } from "vitest";

// openPathInEditor 的**类型分流**是这里最要紧的性质（2026-09-21 用户反馈驱动：
// 划词选中的文件明明能在编辑器里看，却只能跳资源管理器）。
// 分流规则：图片/PDF → 预览；文本 → 编辑器；读失败 → **自动回退资源管理器**。

const openPreview = vi.fn();
const openFile = vi.fn();
const readFile = vi.fn();
const invoke = vi.fn();
const addStatusMessage = vi.fn();

vi.mock("../stores/editorStore", () => ({
  editorStore: {
    openPreview: (...a: unknown[]) => openPreview(...a),
    openFile: (...a: unknown[]) => openFile(...a),
  },
  isPreviewable: (p: string) => /\.(png|jpg|jpeg|gif|webp|bmp|ico|svg|pdf)$/i.test(p),
}));
vi.mock("./fileService", () => ({
  fileService: { readFile: (...a: unknown[]) => readFile(...a) },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("../stores/statusMsgStore", () => ({
  addStatusMessage: (...a: unknown[]) => addStatusMessage(...a),
}));
// 这两个模块只为 openReference 的其它分支服务，这里不需要真实现
vi.mock("../stores/layoutStore", () => ({
  getTree: () => ({}), findTabByPanelId: () => null, findGroup: () => null,
  ensureGroupVisible: vi.fn(), setActiveTab: vi.fn(), setActiveChild: vi.fn(),
}));
vi.mock("../components/chat/useChatBridge", () => ({ switchSession: vi.fn() }));

async function load() {
  vi.resetModules();
  return import("./referenceActions");
}

describe("openPathInEditor — 按类型分流", () => {
  beforeEach(() => {
    openPreview.mockClear();
    openFile.mockClear();
    readFile.mockClear();
    invoke.mockClear();
    addStatusMessage.mockClear();
  });

  it("图片/PDF → 走预览（不当文本读，否则读出乱码）", async () => {
    const { openPathInEditor } = await load();
    const ok = await openPathInEditor("C:/a/shot.png");
    expect(ok).toBe(true);
    expect(openPreview).toHaveBeenCalledWith("C:/a/shot.png", "shot.png");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("文本文件 → 读内容后进编辑器", async () => {
    const { openPathInEditor } = await load();
    readFile.mockResolvedValue("hello");
    const ok = await openPathInEditor("C:/a/main.ts");
    expect(ok).toBe(true);
    expect(readFile).toHaveBeenCalledWith("C:/a/main.ts");
    expect(openFile).toHaveBeenCalledWith("C:/a/main.ts", "main.ts", "hello");
  });

  it("读失败（二进制/超大）→ **自动回退资源管理器**并提示", async () => {
    const { openPathInEditor } = await load();
    readFile.mockRejectedValue(new Error("binary"));
    invoke.mockResolvedValue(undefined);
    const ok = await openPathInEditor("C:/a/blob.bin");
    expect(ok).toBe(true); // 回退成功也算成功
    expect(invoke).toHaveBeenCalledWith("open_in_explorer", { path: "C:/a/blob.bin" });
    expect(addStatusMessage).toHaveBeenCalled(); // 有提示，不是静默
  });

  it("回退也失败 → 返回 false（调用方据此提示）", async () => {
    const { openPathInEditor } = await load();
    readFile.mockRejectedValue(new Error("binary"));
    invoke.mockRejectedValue(new Error("no such file"));
    const ok = await openPathInEditor("C:/a/gone.bin");
    expect(ok).toBe(false);
    expect(addStatusMessage).toHaveBeenCalled();
  });

  it("空路径 → false，不做任何操作", async () => {
    const { openPathInEditor } = await load();
    expect(await openPathInEditor("")).toBe(false);
    expect(openPreview).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("silent 选项：回退到资源管理器时不弹提示（消息里点路径的场景）", async () => {
    const { openPathInEditor } = await load();
    readFile.mockRejectedValue(new Error("binary"));
    invoke.mockResolvedValue(undefined);
    await openPathInEditor("C:/a/blob.bin", { silent: true });
    expect(invoke).toHaveBeenCalled();
    expect(addStatusMessage).not.toHaveBeenCalled();
  });

  it("路径末段作文件名（正反斜杠都能取对）", async () => {
    const { openPathInEditor } = await load();
    readFile.mockResolvedValue("x");
    await openPathInEditor("C:\\deep\\dir\\file.txt");
    expect(openFile).toHaveBeenCalledWith("C:\\deep\\dir\\file.txt", "file.txt", "x");
  });
});
