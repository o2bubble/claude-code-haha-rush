import { describe, it, expect } from "vitest";
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
