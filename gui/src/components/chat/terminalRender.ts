// ── xterm 重绘调度 ──
//
// 问题：xterm 的 write()/writeln() 是**异步**的（官方文档：data is processed
// asynchronously），而 reset() 是同步清屏。流式输出时每个进度事件都触发一次
// 「reset + 全量重写」，此时上一轮的写入还排在 xterm 内部队列里 —— reset 清完
// 屏，队列里两份内容依次被处理，画面就出现两整份（用户实测：当前标签重复，
// 切一下标签又正常，因为切标签时输出已停、队列排空）。
//
// 解法：不排队写入，改为**合并重绘**。每次请求重绘只标记 dirty，在一个微任务
// 里只跑最后一轮渲染 —— 无论触发多少次，同一帧内至多一次 reset + 一次写入，
// 队列里永远不会堆积多份内容。
//
// 渲染函数由调用方提供（TerminalPanel 里是 renderEntry），便于单测注入假实现。

export interface RenderScheduler {
  /** 请求一次重绘（去重 —— 同一帧内多次调用只会执行一次渲染）。 */
  request(): void;
  /** 立即同步渲染（跳过调度，用于挂载时首帧）。 */
  flush(): void;
  /** 取消挂起的重绘（卸载时调用）。 */
  cancel(): void;
}

/**
 * @param render 实际渲染逻辑（内部应自备 reset/清屏）
 * @param schedule 调度器；默认微任务。测试可注入同步实现。
 */
export function createRenderScheduler(
  render: () => void,
  schedule: (fn: () => void) => void = defaultSchedule,
): RenderScheduler {
  let pending = false;
  let cancelled = false;
  // 代际标记：flush() 立即渲染后，队列里那个已排期的回调必须失效，
  // 否则 drain 时会再渲染一次（测试抓到的重复渲染）。
  let generation = 0;

  const run = (gen: number) => {
    if (cancelled || gen !== generation) return;
    pending = false;
    render();
  };

  return {
    request() {
      if (pending || cancelled) return;
      pending = true;
      const gen = generation;
      schedule(() => run(gen));
    },
    flush() {
      if (cancelled) return;
      generation++;
      pending = false;
      render();
    },
    cancel() {
      cancelled = true;
      pending = false;
      generation++;
    },
  };
}

/**
 * 默认调度：微任务。
 *
 * 用微任务而非 rAF —— 流式输出时进度事件密集，微任务能在同一事件循环内
 * 合并掉连续多次请求；rAF 会跨帧，队列里仍可能堆积一轮以上。
 */
function defaultSchedule(fn: () => void): void {
  Promise.resolve().then(fn);
}

// ── 文本行格式化（终端面板回显）──
//
// 为什么需要（用户反馈 2026-10-28「终端面板排版看着费劲」）：
// 面板把**多行命令**整条塞进一次 `writeln`，而命令里的换行是裸 `\n`。
// xterm 默认 `convertEol: false`（"\n 只下移、不回车"），于是每一行都从
// 上一行结束的那一列开始 —— 阶梯状错位，真实换行和自动换行完全分不清。
//
// 两道防线：
//   1. Terminal 开 `convertEol: true`（源数据不是 PTY，官方文档就说该开）
//   2. 命令按行拆开、逐行 `writeln`，续行缩进对齐 —— 顺带去掉行尾空白，
//      否则行尾一堆空格会把本来放得下的内容挤到下一行

/** 行尾空白（含残留的 `\r`）。行首缩进是有意义的，不能动。 */
const TRAILING_WS = /[ \t\r]+$/;

/**
 * 命令行回显：首行 `$ `，续行缩进对齐到命令起始列。
 *
 * 多行命令（heredoc / 多行脚本）很常见，整条一次写入必然错位，所以这里拆行。
 * 首尾的空行去掉 —— 多行命令常以换行起止，留着只会让终端里多出空档。
 */
export function formatCommandLines(command: string): string[] {
  const lines = command.split("\n").map((l) => l.replace(TRAILING_WS, ""));
  while (lines.length > 1 && lines[0] === "") lines.shift();
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l, i) => {
    if (i === 0) return `$ ${l}`;
    // 空行保持空 —— 给它补两格缩进等于凭空造行尾空白（见 TRAILING_WS 的说明）
    return l ? `  ${l}` : "";
  });
}

/**
 * 输出行：去掉行尾空白，保留行首缩进（缩进本身是内容的一部分）。
 *
 * 行尾空白对阅读全是坏处：看不见，却会让本来刚好放得下的一行被自动换行
 * 拆成两行，看起来像是多了个空行。
 */
export function formatOutputLines(output: string): string[] {
  if (!output) return [];
  const raw = output.split("\n");
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((l) => l.replace(TRAILING_WS, ""));
}
