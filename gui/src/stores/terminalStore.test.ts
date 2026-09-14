import { describe, it, expect, beforeEach } from "vitest";
import {
  startCommand, appendOutput, setOutput,
  getEntries, finishCommand, _reset,
} from "./terminalStore";

// ── 滚动尾部窗口去重 ──
//
// 后端进度回调送来的不是增量，而是**滚动尾部窗口**：
// BashTool → exec 的 onProgress(lastLines=最近5行, allLines=最近100行)
// （src/utils/task/TaskOutput.ts → CircularBuffer.getRecent(5)）。
// 每次回调窗口滑动，与上一次重叠 → 直接 `output += text` 会把重复内容
// 累积进条目，短输出（≤5 行）时整段重复，表现为"命令和结果出现了两遍"。

describe("terminalStore — 滚动尾部窗口去重", () => {
  beforeEach(() => _reset());

  it("窗口完全没滑动（内容原样重推）不产生重复", () => {
    startCommand("t1", "date; echo hello");
    const w = "Sun Sep 13 02:06:00\n--- exe mtime is old";
    appendOutput("t1", w);
    appendOutput("t1", w);
    appendOutput("t1", w); // 多次轮询

    expect(getEntries()[0].output).toBe(w);
  });

  it("窗口滑动一行 → 只追加新行", () => {
    startCommand("t1", "cmd");
    appendOutput("t1", "L1\nL2\nL3\nL4\nL5");
    appendOutput("t1", "L2\nL3\nL4\nL5\nL6");

    expect(getEntries()[0].output).toBe("L1\nL2\nL3\nL4\nL5\nL6");
  });

  it("窗口一次滑多行 → 追加全部新行", () => {
    startCommand("t1", "cmd");
    appendOutput("t1", "L1\nL2\nL3");
    appendOutput("t1", "L2\nL3\nL4\nL5\nL6");

    expect(getEntries()[0].output).toBe("L1\nL2\nL3\nL4\nL5\nL6");
  });

  it("窗口完全滑出旧内容（无重叠）→ 按续写追加", () => {
    startCommand("t1", "cmd");
    appendOutput("t1", "L1\nL2");
    appendOutput("t1", "L3\nL4");

    expect(getEntries()[0].output).toBe("L1\nL2\nL3\nL4");
  });

  it("输出超过窗口容量时逐行累积不重复", () => {
    startCommand("t1", "seq 1 8");
    // 模拟：窗口只有 5 行，命令输出 8 行 → 三次 poll
    appendOutput("t1", "1\n2\n3\n4\n5");
    appendOutput("t1", "3\n4\n5\n6\n7");
    appendOutput("t1", "4\n5\n6\n7\n8");

    expect(getEntries()[0].output).toBe("1\n2\n3\n4\n5\n6\n7\n8");
  });

  it("真实重复行（相邻两行内容相同）保守保留，不吞数据", () => {
    startCommand("t1", "echo same; echo same");
    appendOutput("t1", "same\nsame");
    expect(getEntries()[0].output).toBe("same\nsame");
  });

  it("setOutput（最终结果）整体覆盖累积值", () => {
    startCommand("t1", "cmd");
    appendOutput("t1", "partial");
    setOutput("t1", "final result");
    expect(getEntries()[0].output).toBe("final result");
  });

  it("并发工具各写各的条目（按 toolUseId 寻址）", () => {
    startCommand("t1", "cmd1");
    startCommand("t2", "cmd2");
    appendOutput("t1", "A1\nA2");
    appendOutput("t2", "B1\nB2");
    appendOutput("t1", "A2\nA3"); // t1 继续滑窗，不该碰 t2

    const [e1, e2] = getEntries();
    expect(e1.output).toBe("A1\nA2\nA3");
    expect(e2.output).toBe("B1\nB2");
  });

  it("窗口未回归的滞后写入不覆盖已有输出", () => {
    startCommand("t1", "cmd");
    appendOutput("t1", "L1\nL2\nL3");
    appendOutput("t1", "L1\nL2\nL3"); // 旧窗口迟到重放
    expect(getEntries()[0].output).toBe("L1\nL2\nL3");
  });

  it("finishCommand 后仍可收尾追加（exitCode 独立）", () => {
    startCommand("t1", "cmd");
    appendOutput("t1", "out");
    finishCommand("t1", 0);
    expect(getEntries()[0].exitCode).toBe(0);
    expect(getEntries()[0].output).toBe("out");
  });

  // 截图现象的直接回归：短输出（≤5 行）被轮询多次重推 → 曾整段重复。
  it("回归：短命令输出经多次轮询后不重复（截图场景）", () => {
    const OUT = "Sun Sep 13 02:06:00     2026\n--- exe mtime is old (01:29), build still running.";
    startCommand("t1", 'date; echo "--- exe mtime is old"');
    // 后端 poll 3 次，每次窗口都是同样这 2 行（命令已结束、无新行）
    appendOutput("t1", OUT);
    appendOutput("t1", OUT);
    appendOutput("t1", OUT);

    expect(getEntries()[0].output).toBe(OUT);
    expect(getEntries()[0].output.split("\n")).toHaveLength(2);
  });
});
