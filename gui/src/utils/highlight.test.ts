import { describe, it, expect } from "vitest";
import { highlightCode } from "./highlight";

// 2026-09-21 性能事故的回归锁。
//
// 背景：用户报"切换会话要等好几秒，以前很快"。根因是 highlightCode 在语言缺失时
// 回退到 `hljs.highlightAuto()` —— 它要对全部 192 个已注册语言各试一遍。
// 实测同一段 1026 字符代码：指定语言 11ms，highlightAuto 322ms（慢 29 倍）。
// 一个大会话 135 个 Edit/Write 块里 22 个落进 auto → 多花约 7 秒。
//
// 这里用**耗时断言**锁住"不许再出现 300ms 级的单次高亮"——因为行为断言挡不住
// 有人把 auto 加回来（加回来输出依然"正确"，只是慢）。

const CODE = `export function resolvePaste(input) {
  const refs = [];
  for (const f of input.files) {
    if (f.path) refs.push(f.path);
  }
  return refs;
}
`.repeat(6);

describe("highlightCode — 性能与安全", () => {
  it("未知语言不做自动检测（单次必须在 50ms 内）", () => {
    const t0 = performance.now();
    highlightCode(CODE, "");
    highlightCode(CODE, "not-a-real-language");
    const elapsed = performance.now() - t0;
    // 走 highlightAuto 时单次就 ~320ms；这里两次合计给足余量仍远低于它
    expect(elapsed).toBeLessThan(50);
  });

  it("已知语言正常高亮", () => {
    const html = highlightCode("const a = 1;", "typescript");
    expect(html).toContain("hljs-keyword"); // const 被着色
    expect(html).not.toContain("<script"); // 不产生可执行标签
  });

  it("未知语言 = 纯转义（防注入）", () => {
    const html = highlightCode(`<img src=x onerror="alert(1)">`, "");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("空代码返回空串", () => {
    expect(highlightCode("", "typescript")).toBe("");
  });

  it("命中缓存：重复调用不再计算", () => {
    const big = CODE.repeat(4);
    const t0 = performance.now();
    const first = highlightCode(big, "typescript");
    const tFirst = performance.now() - t0;
    const t1 = performance.now();
    const again = highlightCode(big, "typescript");
    const tAgain = performance.now() - t1;
    expect(again).toBe(first);          // 结果一致
    expect(tAgain).toBeLessThan(tFirst); // 第二次走缓存
  });

  it("缓存按 (lang, code) 分键 —— 同代码不同语言不串味", () => {
    const a = highlightCode("SELECT 1", "sql");
    const b = highlightCode("SELECT 1", "python");
    expect(a).not.toBe(b);
  });
});
