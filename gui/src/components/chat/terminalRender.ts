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
