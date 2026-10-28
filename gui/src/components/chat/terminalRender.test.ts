import { describe, it, expect } from "vitest";
import { formatCommandLines, formatOutputLines } from "./terminalRender";
import { createRenderScheduler } from "./terminalRender";

// 收集所有排入"微任务"的回调，由测试手动 flush —— 模拟 xterm 内部异步队列。
function makeManualScheduler() {
  const queue: Array<() => void> = [];
  const schedule = (fn: () => void) => queue.push(fn);
  const drain = () => { while (queue.length) queue.shift()!(); };
  return { schedule, drain, size: () => queue.length };
}

describe("createRenderScheduler — 合并重绘", () => {
  it("同一帧内多次 request 只渲染一次", () => {
    const { schedule, drain } = makeManualScheduler();
    let count = 0;
    const s = createRenderScheduler(() => { count++; }, schedule);

    s.request();
    s.request();
    s.request();
    expect(count).toBe(0);      // 尚未 drain

    drain();
    expect(count).toBe(1);      // 三次请求 → 一次渲染
  });

  it("跨帧的多次 request 各自渲染（不吞掉后续更新）", () => {
    const { schedule, drain } = makeManualScheduler();
    let count = 0;
    const s = createRenderScheduler(() => { count++; }, schedule);

    s.request();
    drain();
    expect(count).toBe(1);

    s.request();
    drain();
    expect(count).toBe(2);
  });

  it("flush 立即渲染且不做去重（挂载首帧用）", () => {
    const { schedule, drain } = makeManualScheduler();
    let count = 0;
    const s = createRenderScheduler(() => { count++; }, schedule);

    s.flush();
    expect(count).toBe(1);      // 同步执行，无需 drain
    drain();
    expect(count).toBe(1);      // 队列里没有多余任务
  });

  it("flush 会取消已排队的重绘（不重复渲染）", () => {
    const { schedule, drain } = makeManualScheduler();
    let count = 0;
    const s = createRenderScheduler(() => { count++; }, schedule);

    s.request();                // 排队
    s.flush();                  // 立即渲染
    expect(count).toBe(1);
    drain();                    // 之前的排队任务已被取消
    expect(count).toBe(1);
  });

  it("cancel 后不再渲染（组件卸载）", () => {
    const { schedule, drain } = makeManualScheduler();
    let count = 0;
    const s = createRenderScheduler(() => { count++; }, schedule);

    s.request();
    s.cancel();
    drain();
    expect(count).toBe(0);

    s.request();                // cancel 后新请求也无效
    drain();
    expect(count).toBe(0);
  });

  it("回归：流式密集触发不会让队列堆积多份内容", () => {
    // 模拟用户实测场景：进度事件密集触发 → 每次都请求重绘。
    // 旧实现直接 reset+write，队列里堆 N 份；新实现合并为 1 次。
    const { schedule, drain } = makeManualScheduler();
    const rendered: string[] = [];
    let snapshot = "";
    const s = createRenderScheduler(() => {
      rendered.push(snapshot);
    }, schedule);

    // 模拟 20 次进度更新（每次 store 内容都在增长）
    for (let i = 1; i <= 20; i++) {
      snapshot = Array.from({ length: i }, (_, k) => `line ${k + 1}`).join("\n");
      s.request();
    }
    drain();

    expect(rendered).toHaveLength(1);          // 只渲染一次，不堆 20 份
    expect(rendered[0]).toBe(snapshot);        // 且渲染的是最新内容
  });
});

// ── 行格式化（终端面板回显排版）──
//
// 用户截图里的症状：多行命令回显成**阶梯状** —— 每行从上一行结束的列开始。
// 根因是命令里的裸 `\n` 被一次性 writeln 送进 xterm（convertEol=false）。
// 下面锁住"按行拆开 + 续行缩进"这个修法。

describe("formatCommandLines — 命令行回显", () => {
  it("单行命令：加 `$ ` 前缀", () => {
    expect(formatCommandLines("git status")).toEqual(["$ git status"]);
  });

  it("多行命令：续行缩进两格，不再出现裸换行", () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfix: 修好了\n\n正文\nEOF\n)" 2>&1 | tail -3`;
    const out = formatCommandLines(cmd);
    expect(out).toEqual([
      `$ git commit -m "$(cat <<'EOF'`,
      "  fix: 修好了",
      "", // 空行保持空（不加缩进，免得凭空造行尾空白）
      "  正文",
      "  EOF",
      `  )" 2>&1 | tail -3`,
    ]);
    // 关键性质：任何一行都不能再含换行符（否则 xterm 又会阶梯）
    expect(out.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("去掉行尾空白 —— 否则会把放得下的内容挤到下一行", () => {
    expect(formatCommandLines("echo hi   ")).toEqual(["$ echo hi"]);
    expect(formatCommandLines("a\nb\t \nc")).toEqual(["$ a", "  b", "  c"]);
  });

  it("吃掉 CRLF 残留的 \r", () => {
    expect(formatCommandLines("a\r\nb\r\n")).toEqual(["$ a", "  b"]);
  });

  it("首尾的空行去掉（heredoc 常以换行起止）", () => {
    expect(formatCommandLines("\n\nls\n\n")).toEqual(["$ ls"]);
  });

  it("空命令不炸", () => {
    expect(formatCommandLines("")).toEqual(["$ "]);
  });
});

describe("formatOutputLines — 输出行", () => {
  it("保留行首缩进（缩进是内容的一部分）", () => {
    expect(formatOutputLines("    indented\nplain")).toEqual(["    indented", "plain"]);
  });

  it("去掉行尾空白与 \r", () => {
    expect(formatOutputLines("abc   \ndef\r\n")).toEqual(["abc", "def"]);
  });

  it("保留中间空行（输出里的段落分隔是有意义的）", () => {
    expect(formatOutputLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("末尾单独的换行不产生多余空行", () => {
    expect(formatOutputLines("a\n")).toEqual(["a"]);
    expect(formatOutputLines("a\n\n")).toEqual(["a", ""]);
  });

  it("空输出 → 空数组（不写任何行）", () => {
    expect(formatOutputLines("")).toEqual([]);
  });

  it("只有空白的行变成空行（而不是留着看不见的空格）", () => {
    expect(formatOutputLines("a\n   \nb")).toEqual(["a", "", "b"]);
  });
});
