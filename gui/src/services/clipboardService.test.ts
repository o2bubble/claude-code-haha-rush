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

  // ── 路径探测的两道闸 + Alt 强制纯文本（2026-09-20）──
  // 背景：工作区里几乎总有 src/docs/temp 这类目录，粘贴一个普通单词（哪怕不含斜杠）
  // 只要撞上真实目录名就被转成引用 —— 命中率高得离谱（用户实测反馈）。

  it("不含分隔符的单词（如 docs）即使存在也不转 —— 挡单词撞名", async () => {
    const pathExists = mkPathExists(true);
    const d = await resolvePaste({
      files: [], images: [], text: "docs", pathExists,
    });
    expect(d).toEqual({ kind: "inlineText", text: "docs" });
    // 连存在性探测都不该发起（含分隔符检查在 pathExists 之前短路）
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("含分隔符且存在 → 照常转引用（保留『粘贴路径』的用法）", async () => {
    const d = await resolvePaste({
      files: [], images: [], text: "gui/src", pathExists: mkPathExists(true),
    });
    expect(d).toEqual({
      kind: "refs",
      refs: [{ type: "file", path: "gui/src", label: "src" }],
    });
  });

  it("整段超过 200 字 → 不做路径探测（长文本里列路径是内容，不是引用）", async () => {
    const longPathLike = "/w/" + "a".repeat(250);
    const pathExists = mkPathExists(true);
    const d = await resolvePaste({
      files: [], images: [], text: longPathLike, pathExists,
    });
    expect(pathExists).not.toHaveBeenCalled();
    // >120 字 → 仍是 paste chip（长文本折叠），但不是 file/dir ref
    expect(d.kind).toBe("refs");
    if (d.kind === "refs") expect(d.refs[0].type).toBe("paste");
  });

  it("Alt（forceText）：存在的路径也不转，原样插入", async () => {
    const pathExists = mkPathExists(true);
    const d = await resolvePaste({
      files: [], images: [], text: "/w/src/a.ts", pathExists, forceText: true,
    });
    expect(d).toEqual({ kind: "inlineText", text: "/w/src/a.ts" });
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("Alt（forceText）：长文本也不折叠 —— 所见即所得", async () => {
    const long = "y".repeat(300);
    const d = await resolvePaste({
      files: [], images: [], text: long, pathExists: mkPathExists(true), forceText: true,
    });
    expect(d).toEqual({ kind: "inlineText", text: long });
  });

  // ── 路径的"字形"闸：除盘符外，路径里不可能出现的字符不该被拿去探测 ──
  // 背景：只查"含不含斜杠"就无脑发文件系统查询，等于把 glob、引号、多行文本
  // 全当成候选路径去问一遍。

  it.each([
    ["glob 模式", "src/*.ts"],
    ["问号包裹", "foo/bar?"],
    ["内部引号（非包裹）", 'a/b "c"'],
    ["管道", "a|b/c"],
    ["尖括号", "a<b/c>d"],
    ["非盘符位置的冒号", "a:b/c"],
    ["多行（含换行）", "line1/x\nline2/y"],
    ["含制表符", "a/b\tc"],
  ])("不可能字符（%s）→ 不探测，直接按文本处理", async (_name, text) => {
    const pathExists = mkPathExists(true); // 即便"存在"也不该问
    const d = await resolvePaste({
      files: [], images: [], text, pathExists,
    });
    expect(pathExists).not.toHaveBeenCalled();
    expect(d).toEqual({ kind: "inlineText", text });
  });

  // ── 整段被成对引号包裹（Windows 右键「复制文件地址」的形态）──
  // 引号是转录噪音，剥掉不丢内容（保留率 100%）→ 该照常探测，引用里存干净路径。

  it.each([
    ["ASCII 双引号", '"C:\\Storage\\proj\\a.txt"'],
    ["单引号",       "'C:\\Storage\\proj\\a.txt'"],
    ["中文弯引号",   "\u201CC:\\Storage\\proj\\a.txt\u201D"],
  ])("%s 包裹的真实路径 → 剥引号后转引用，存干净路径", async (_n, text) => {
    const pathExists = mkPathExists(true);
    const d = await resolvePaste({ files: [], images: [], text, pathExists });
    // 探测的是剥引号后的路径（引号本身在 Windows 上非法）
    expect(pathExists).toHaveBeenCalledWith("C:\\Storage\\proj\\a.txt");
    expect(d).toEqual({
      kind: "refs",
      refs: [{ type: "file", path: "C:\\Storage\\proj\\a.txt", label: "a.txt" }],
    });
  });

  it("引号包裹但剥后不存在 → 纯文本原样插入（带引号，不丢字符）", async () => {
    const pathExists = mkPathExists(false);
    const d = await resolvePaste({
      files: [], images: [], text: '"a/b"', pathExists,
    });
    expect(pathExists).toHaveBeenCalledWith("a/b");
    // 注意：不做引号剥离，任何情况下都不丢字符
    expect(d).toEqual({ kind: "inlineText", text: '"a/b"' });
  });

  it("引号包裹的目录 → 转目录引用（存干净路径）", async () => {
    const d = await resolvePaste({
      files: [], images: [],
      text: '"C:\\Storage\\proj\\gui"',
      pathExists: mkPathExists(true),
      readDir: vi.fn().mockResolvedValue([{ path: "x", name: "x", is_dir: false }]),
    });
    expect(d).toEqual({
      kind: "refs",
      refs: [{ type: "dir", path: "C:\\Storage\\proj\\gui", label: "gui" }],
    });
  });

  it("单侧引号不是包裹 → 不剥（不做无依据的猜测）", async () => {
    const pathExists = mkPathExists(false);
    const d = await resolvePaste({
      files: [], images: [], text: '"C:\\Storage\\proj\\a.txt', pathExists,
    });
    expect(pathExists).not.toHaveBeenCalled(); // 未剥 → 字形闸拦下
    expect(d).toEqual({ kind: "inlineText", text: '"C:\\Storage\\proj\\a.txt' });
  });

  it("Alt（forceText）优先于剥引号：所见即所得", async () => {
    const pathExists = mkPathExists(true);
    const d = await resolvePaste({
      files: [], images: [], text: '"C:\\Storage\\proj\\a.txt"',
      pathExists, forceText: true,
    });
    expect(pathExists).not.toHaveBeenCalled();
    expect(d).toEqual({ kind: "inlineText", text: '"C:\\Storage\\proj\\a.txt"' });
  });

  it("盘符的冒号合法 → 绝对路径照常探测（不能误伤）", async () => {
    const d = await resolvePaste({
      files: [], images: [],
      text: "C:\\Storage\\proj\\gui\\src",
      pathExists: mkPathExists(true),
    });
    expect(d).toEqual({
      kind: "refs",
      refs: [{ type: "file", path: "C:\\Storage\\proj\\gui\\src", label: "src" }],
    });
  });

  it("空格与中文是合法路径字符 → 不做字形拦截（只靠存在性兜底）", async () => {
    // `C:\Program Files\app.exe` 这类真实路径必须能过 —— 所以空白不能进黑名单。
    // 代价：`看看 a/b 目录` 这种句子仍会探一次（结果为"不存在"→ 纯文本），无害。
    const pathExists = mkPathExists(true);
    const d = await resolvePaste({
      files: [], images: [], text: "C:\\Program Files\\app.exe", pathExists,
    });
    expect(pathExists).toHaveBeenCalledWith("C:\\Program Files\\app.exe");
    expect(d.kind).toBe("refs");

    const pathExists2 = mkPathExists(false);
    const d2 = await resolvePaste({
      files: [], images: [], text: "看看 a/b 目录", pathExists: pathExists2,
    });
    expect(pathExists2).toHaveBeenCalledWith("看看 a/b 目录"); // 没被字形拦（空格/中文合法）
    expect(d2).toEqual({ kind: "inlineText", text: "看看 a/b 目录" }); // 靠"不存在"兜底
  });

  it("Alt（forceText）只影响文本 —— 剪贴板里的真实文件照常走引用", async () => {
    const d = await resolvePaste({
      files: [{ name: "a.ts", blob: mkBlob("x"), path: "/w/a.ts" }],
      images: [], text: "", pathExists: mkPathExists(true), forceText: true,
    });
    expect(d).toEqual({
      kind: "refs",
      refs: [{ type: "file", path: "/w/a.ts", label: "a.ts" }],
    });
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

  // ── 粘贴文件的源路径补全（readClipboardFiles）──
  // 背景：File.path 是 Electron 扩展，Tauri 只对拖放注入 —— 粘贴的文件一律无 path。
  // 若不管，粘贴文件会走"复制内容到 .claude/pasted"，而拖放同一文件走引用（行为不一致）。

  it("无 .path 文件 + 剪贴板路径数量匹配 → 引用原路径（不复制）", async () => {
    const readClipboardFiles = vi.fn().mockResolvedValue(["/w/a.md", "/w/b.json"]);
    const d = await resolvePaste({
      files: [
        { name: "a.md", blob: mkBlob("a"), type: "text/markdown" },
        { name: "b.json", blob: mkBlob("b"), type: "application/json" },
      ],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
      readClipboardFiles,
    });
    expect(d).toEqual({
      kind: "refs",
      refs: [
        { type: "file", path: "/w/a.md", label: "a.md" },
        { type: "file", path: "/w/b.json", label: "b.json" },
      ],
    });
  });

  it("无 .path 文件是目录 → 引用目录本身", async () => {
    const readDir = vi.fn().mockResolvedValue([{ path: "/w/d/x", name: "x", is_dir: false }]);
    const d = await resolvePaste({
      files: [{ name: "d", blob: mkBlob("d") }],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
      readDir,
      readClipboardFiles: vi.fn().mockResolvedValue(["/w/d"]),
    });
    expect(d).toEqual({ kind: "refs", refs: [{ type: "dir", path: "/w/d", label: "d" }] });
  });

  it("剪贴板路径数量不匹配（混合粘贴）→ 保守回退复制，不错配引用", async () => {
    const d = await resolvePaste({
      files: [
        { name: "a.md", blob: mkBlob("a"), type: "text/markdown" },
        { name: "shot.png", blob: mkBlob("i", "image/png"), type: "image/png" },
      ],
      images: [{ blob: mkBlob("i", "image/png"), mime: "image/png" }],
      text: "",
      pathExists: mkPathExists(true),
      // 剪贴板只有 1 个路径，files 有 2 个 → 不配对
      readClipboardFiles: vi.fn().mockResolvedValue(["/w/a.md"]),
    });
    // a.md 回退复制；png 交给 images（既有行为）
    expect(d.kind).toBe("saveImages");
    if (d.kind === "saveImages") expect(d.items.map((i) => i.name)).toEqual(["a.md", undefined]);
  });

  it("图片不参与补全 —— 即使剪贴板能给出路径（粘贴图片应保持二进制语义）", async () => {
    const readClipboardFiles = vi.fn().mockResolvedValue(["/w/pic.png"]);
    const b = mkBlob("i", "image/png");
    const d = await resolvePaste({
      files: [{ name: "pic.png", blob: b, type: "image/png" }],
      images: [{ blob: b, mime: "image/png" }],
      text: "",
      pathExists: mkPathExists(true),
      readClipboardFiles,
    });
    expect(d.kind).toBe("saveImages");
    // 图片不算"需要补路径"，故不该白调一次剪贴板
    expect(readClipboardFiles).not.toHaveBeenCalled();
  });

  it("剪贴板读取失败 → 回退复制（不抛错）", async () => {
    const d = await resolvePaste({
      files: [{ name: "a.md", blob: mkBlob("a"), type: "text/markdown" }],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
      readClipboardFiles: vi.fn().mockRejectedValue(new Error("no clipboard")),
    });
    expect(d.kind).toBe("saveImages");
  });

  it("未注入 readClipboardFiles（非 Tauri / 旧调用方）→ 保持旧行为复制", async () => {
    const d = await resolvePaste({
      files: [{ name: "a.md", blob: mkBlob("a"), type: "text/markdown" }],
      images: [],
      text: "",
      pathExists: mkPathExists(true),
    });
    expect(d.kind).toBe("saveImages");
  });

  // ── Ctrl+Shift+V 的 Shift 跟踪（forceText 的信号源）──
  // ClipboardEvent 上没有修饰键信息，所以"粘贴时是否按着 Shift"靠键盘事件跟踪。
  // 用假 window 验证事件 → 状态 → 幂等这条链。

  it("Shift 跟踪：按住期间 true，松开 / 窗口失焦 → false", async () => {
    vi.resetModules();
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: (t: string, fn: (e: unknown) => void) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t)!.push(fn);
      },
    };
    try {
      const m = await import("./clipboardService");
      expect(m.isPlainPasteHeld()).toBe(false);
      m.ensurePlainPasteTracking();
      const fire = (t: string, e: unknown) => (listeners.get(t) || []).forEach((fn) => fn(e));

      fire("keydown", { shiftKey: true });          // 按住 Shift（Ctrl+Shift+V 的中间态）
      expect(m.isPlainPasteHeld()).toBe(true);
      fire("keyup", { shiftKey: false });           // 松开 Shift
      expect(m.isPlainPasteHeld()).toBe(false);
      fire("keydown", { shiftKey: true });
      fire("blur", undefined);                      // Alt+Tab 切走 → 不能把状态卡住
      expect(m.isPlainPasteHeld()).toBe(false);
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("Shift 跟踪是幂等的：重复安装只挂一份监听", async () => {
    vi.resetModules();
    let keydownCount = 0;
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: (t: string) => { if (t === "keydown") keydownCount++; },
    };
    try {
      const m = await import("./clipboardService");
      m.ensurePlainPasteTracking();
      m.ensurePlainPasteTracking();
      m.ensurePlainPasteTracking();
      expect(keydownCount).toBe(1);
    } finally {
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });

  it("Shift 跟踪：无 window 环境（测试 / 非浏览器）下调用不抛", async () => {
    vi.resetModules();
    const m = await import("./clipboardService");
    expect(() => m.ensurePlainPasteTracking()).not.toThrow();
    expect(m.isPlainPasteHeld()).toBe(false);
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
