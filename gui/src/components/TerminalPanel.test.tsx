import { describe, it, expect } from "vitest";
import { renderEntry, terminalOptions } from "./TerminalPanel";
import type { TerminalEntry } from "../stores/terminalStore";

// 用假 Terminal 断言"真正写进 xterm 的是什么"。
//
// 这是本次排版问题的**最后一道防线**：只要有任何一次 writeln 的内容里带裸
// `\n`，xterm 就会「只下移不回左」→ 阶梯错位（用户 2026-10-28 的截图）。
// 所以这里断言的不是"好看"，而是"每行都不含换行符"这个硬性质。

function capture(entry: TerminalEntry): string[] {
  const lines: string[] = [];
  renderEntry({ writeln: (s: string) => { lines.push(s); } }, entry);
  return lines;
}

const entry = (patch: Partial<TerminalEntry> = {}): TerminalEntry => ({
  id: "e1",
  toolUseId: "t1",
  command: "ls",
  output: "",
  exitCode: null,
  timestamp: 0,
  ...patch,
});

/** 去掉 ANSI 颜色后看真实文本 */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderEntry — 写进终端的每一行", () => {
  it("多行命令（heredoc）不会产生任何裸换行", () => {
    const cmd = `git commit -m "$(cat <<'EOF'
fix: 修好了

正文
EOF
)" 2>&1 | tail -3`;
    const lines = capture(entry({ command: cmd, output: "ok\n", exitCode: 0 }));

    // 硬性质：没有任何一次 writeln 的内容里带 \n
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
    // 每条逻辑行各占一行，续行缩进对齐
    expect(plain(lines[0])).toBe(`$ git commit -m "$(cat <<'EOF'`);
    expect(plain(lines[1])).toBe("  fix: 修好了");
    expect(plain(lines[3])).toBe("  正文");
    expect(plain(lines[5])).toBe(`  )" 2>&1 | tail -3`);
  });

  it("输出行保留缩进、去掉行尾空白", () => {
    const lines = capture(entry({ output: "  indented   \nplain\n", exitCode: 0 }));
    // 0：命令行；1：第一条输出；2：第二条输出；3：exit；4：收尾空行
    expect(plain(lines[1])).toBe("    indented"); // 面板缩进 2 + 原文缩进 2
    expect(plain(lines[2])).toBe("  plain");
    expect(plain(lines[3])).toBe("[exit: 0]");
  });

  it("exit code 非 0 用红色（同时保留文本）", () => {
    const lines = capture(entry({ output: "boom\n", exitCode: 2 }));
    const exitLine = lines.find((l) => plain(l).startsWith("[exit:"))!;
    expect(plain(exitLine)).toBe("[exit: 2]");
    expect(exitLine).toContain("\x1b[31m");
  });

  it("没有输出时不写输出行，但仍有命令与 exit", () => {
    const lines = capture(entry({ output: "", exitCode: 0 }));
    expect(lines.map(plain)).toEqual(["$ ls", "[exit: 0]", ""]);
  });

  it("运行中（exitCode=null）不写 exit 行", () => {
    const lines = capture(entry({ output: "", exitCode: null }));
    expect(lines.map(plain)).toEqual(["$ ls", ""]);
  });
});

// ── Terminal 构造选项 ──
//
// convertEol 是这次排版修复的**兜底防线**：即使某处忘了把文本按行拆开，
// 裸 `\n` 也不会再产生阶梯错位。它很容易在重构构造函数时被顺手删掉
// （看起来像个无关紧要的选项），所以单独锁一条。

describe("terminalOptions", () => {
  it("必须开 convertEol —— 否则裸 \n 会让下一行从上一行结尾那列开始", () => {
    expect(terminalOptions().convertEol).toBe(true);
  });

  it("面板永远只读（不接收键盘输入）", () => {
    const o = terminalOptions();
    expect(o.disableStdin).toBe(true);
    expect(o.cursorBlink).toBe(false);
  });
});
