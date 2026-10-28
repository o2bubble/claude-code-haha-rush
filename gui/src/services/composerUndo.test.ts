import { describe, it, expect } from "vitest";
import { createComposerUndo, type ComposerSnapshot } from "./composerUndo";

// 撤销的**分组粒度**是这个模块的全部价值所在：
// 用户按 Ctrl+Z 期望回到"上一次编辑的样子"，而不是少一个字符，
// 也不是回到某个被程序化写入污染过的中间态。下面按用户视角逐条锁死。

const snap = (html: string, caret = html.length): ComposerSnapshot => ({ html, caret });

/** 模拟"用户连续键入"，每字符间隔 gapMs */
function typeChars(u: ReturnType<typeof createComposerUndo>, text: string, startAt: number, gapMs = 100) {
  let t = startAt;
  let acc = "";
  for (const ch of text) {
    acc += ch;
    t += gapMs;
    u.record(snap(acc), "typing", t);
  }
  return t;
}

describe("composerUndo — 撤销粒度", () => {
  it("连续键入合并成一步：一次 Ctrl+Z 回到开始输入之前", () => {
    const u = createComposerUndo();
    u.record(snap(""), "typing", 0); // 基线
    typeChars(u, "你好世界", 0); // 100ms 一个字符
    expect(u.canUndo()).toBe(true);

    expect(u.undo()?.html).toBe("");
    expect(u.canUndo()).toBe(false);
  });

  it("停顿超过合并窗口 → 另起一步", () => {
    const u = createComposerUndo({ coalesceMs: 800 });
    u.record(snap(""), "typing", 0);
    typeChars(u, "第一段", 0); // t 到 300
    typeChars(u, "第二段", 2000, 100); // 停了 1.7s 再打

    expect(u.undo()?.html).toBe("第一段");
    expect(u.undo()?.html).toBe("");
  });

  it("结构性编辑（chip / 粘贴）永远独立成步，不与键入合并", () => {
    const u = createComposerUndo();
    u.record(snap(""), "typing", 0);
    typeChars(u, "看看", 0); // t=200
    // 紧接着插入引用 chip —— 只隔 10ms 也必须是独立一步
    u.record(snap("看看<span data-ref='@ref{file:a.ts}'>📄 a.ts</span>"), "edit", 210);

    expect(u.undo()?.html).toBe("看看");
    expect(u.undo()?.html).toBe("");
  });

  it("内容没变的记录不产生空步", () => {
    const u = createComposerUndo();
    u.record(snap("abc"), "typing", 0);
    u.record(snap("abc"), "typing", 500); // 光标动了而已
    u.record(snap("abc"), "edit", 900);
    expect(u.undo()).toBeNull(); // 只有基线，没有可撤销的一步
  });

  it("首次记录只做基线 —— 不会撤销到空的初始态", () => {
    const u = createComposerUndo();
    u.record(snap("abc"), "typing", 0);
    expect(u.canUndo()).toBe(false);
  });
});

describe("composerUndo — 重做", () => {
  it("撤销后可重做回原状态", () => {
    const u = createComposerUndo();
    u.record(snap(""), "typing", 0);
    typeChars(u, "abc", 0);
    u.record(snap("abc!"), "edit", 1000);

    u.undo();
    expect(u.canRedo()).toBe(true);
    expect(u.redo()?.html).toBe("abc!");
  });

  it("撤销后继续输入 → 重做栈作废（新分支）", () => {
    const u = createComposerUndo();
    u.record(snap(""), "typing", 0);
    typeChars(u, "abc", 0);
    u.undo();
    expect(u.canRedo()).toBe(true);

    u.record(snap("新内容"), "typing", 5000);
    expect(u.canRedo()).toBe(false);
  });

  it("撤销之后立刻键入（哪怕在合并窗口内）也另起一步，不与旧键入合并", () => {
    const u = createComposerUndo();
    u.record(snap(""), "typing", 0);
    typeChars(u, "abc", 0); // 到 t=300
    u.undo(); // 回到 ""

    // 距上次键入只过了 50ms —— 若不清合并状态，这一笔会并进已撤销的那一步
    u.record(snap("x"), "typing", 350);
    expect(u.undo()?.html).toBe("");
  });

  it("多次撤销 / 重做来回都稳定", () => {
    const u = createComposerUndo();
    u.record(snap(""), "typing", 0);
    u.record(snap("a"), "edit", 1000);
    u.record(snap("ab"), "edit", 2000);
    u.record(snap("abc"), "edit", 3000);

    expect(u.undo()?.html).toBe("ab");
    expect(u.undo()?.html).toBe("a");
    expect(u.undo()?.html).toBe("");
    expect(u.redo()?.html).toBe("a");
    expect(u.redo()?.html).toBe("ab");
    expect(u.redo()?.html).toBe("abc");
    expect(u.redo()).toBeNull();
  });
});

describe("composerUndo — 边界", () => {
  it("空栈 undo/redo 返回 null（调用方据此决定要不要 preventDefault）", () => {
    const u = createComposerUndo();
    expect(u.undo()).toBeNull();
    expect(u.redo()).toBeNull();
    expect(u.canUndo()).toBe(false);
    expect(u.canRedo()).toBe(false);
  });

  it("reset 清空历史并重设基线（发送后用）", () => {
    const u = createComposerUndo();
    u.record(snap(""), "typing", 0);
    typeChars(u, "要发出去的内容", 0);
    u.reset(snap(""));

    expect(u.canUndo()).toBe(false);
    expect(u.canRedo()).toBe(false);
    expect(u.current()?.html).toBe("");
  });

  it("超出步数上限时丢最旧的，保留最近的", () => {
    const u = createComposerUndo({ limit: 3 });
    u.record(snap("0"), "edit", 0);
    for (let i = 1; i <= 6; i++) u.record(snap(String(i)), "edit", i * 1000);

    // 只剩最近 3 步：6→5→4→3
    expect(u.undo()?.html).toBe("5");
    expect(u.undo()?.html).toBe("4");
    expect(u.undo()?.html).toBe("3");
    expect(u.canUndo()).toBe(false);
  });

  it("存的是快照 —— chip 的 html 原样进出", () => {
    const u = createComposerUndo();
    const withChip = `看看<span contenteditable="false" data-ref="@ref{file:a.ts}">📄 a.ts</span>吧`;
    u.record(snap("看看"), "typing", 0);
    u.record(snap(withChip, 5), "edit", 1000);

    const back = u.undo()!;
    expect(back.html).toBe("看看");

    u.redo();
    // redo 拿到的是写入时那份，不是重新构造的
    expect(u.current()?.html).toBe(withChip);
    expect(u.current()?.caret).toBe(5);
  });
});
