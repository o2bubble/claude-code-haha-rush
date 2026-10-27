// ── 指示窗「本次 N 个动作 · Xs」的计时语义 ──
//
// 运行: MK_TEST=1 node activity.test.cjs
//
// ## 为什么单独拎出来测
//
// 这里曾经量的是**进程运行时长**（`Date.now() - sessionStart`），标签却写成
// 「累计 5 个动作 · 31m57s」—— 用户读到的是"这 5 个动作花了 32 分钟"，而实际
// 那 32 分钟是插件进程活了多久（`workspace_bound`，随工作区常驻）。
// 用户实测反馈：「有时计时都是几十分钟啊 代表的啥意思」。
//
// 这类错误**不会让任何功能失败**，只会持续输出让人困惑的数字 —— 所以必须有
// 回归测试钉住语义：数字要跟"眼前这批操作"对得上。

const test = require("node:test");
const assert = require("node:assert");

// MK_TEST=1 → server.cjs 不启动 HTTP 监听、只导出纯函数
process.env.MK_TEST = "1";
const s = require("./server.cjs");

const T0 = 1_000_000_000;
const GAP = s.RUN_GAP_MS;

test("第一个动作 → 新一轮，计数为 1", () => {
  const r = s.nextRunState({ runStartedAt: 0, runCount: 0, lastActivityAt: 0 }, T0);
  assert.deepStrictEqual(r, { runStartedAt: T0, runCount: 1 });
});

test("连续动作（间隔小于阈值）→ 同一轮，起点不变、计数累加", () => {
  let st = s.nextRunState({ runStartedAt: 0, runCount: 0, lastActivityAt: 0 }, T0);
  st = s.nextRunState({ ...st, lastActivityAt: T0 }, T0 + GAP - 1);
  assert.strictEqual(st.runStartedAt, T0, '起点不能变（变了就成了「距上次动作」而不是「本轮时长」）');
  assert.strictEqual(st.runCount, 2);
});

test("静默超过阈值 → 翻篇，起点重置为本条动作", () => {
  const first = s.nextRunState({ runStartedAt: 0, runCount: 0, lastActivityAt: 0 }, T0);
  const later = T0 + GAP + 5_000;
  const r = s.nextRunState({ ...first, lastActivityAt: T0 }, later);
  assert.deepStrictEqual(r, { runStartedAt: later, runCount: 1 });
});

test("恰好等于阈值 → 仍算同一轮（边界取「超过」而非「达到」）", () => {
  const first = s.nextRunState({ runStartedAt: 0, runCount: 0, lastActivityAt: 0 }, T0);
  const r = s.nextRunState({ ...first, lastActivityAt: T0 }, T0 + GAP);
  assert.strictEqual(r.runCount, 2);
});

test("阈值与指示窗的自动关闭时长一致（窗口关掉再开 = 天然新一轮）", () => {
  // indicator.html 的 IDLE_CLOSE_MS。两处不一致会出现"窗口新开的、计时却接着上一轮"。
  assert.strictEqual(GAP, 30_000);
});

test("时间只影响「本轮」，不影响进程级累计（后者是诊断数据）", () => {
  // 这条防的是"顺手把 runCount 也改成进程级"——那正是原来那个 bug 的形态。
  const a = s.nextRunState({ runStartedAt: 0, runCount: 0, lastActivityAt: 0 }, T0);
  assert.strictEqual(a.runCount, 1);
  // 隔了很久再来一个 → 仍是 1（新一轮），而不是 2
  const b = s.nextRunState({ ...a, lastActivityAt: T0 }, T0 + GAP * 10);
  assert.strictEqual(b.runCount, 1);
});

// ── 集成：noteActivity 的记账路径 ──
// 纯函数测的是"怎么算"，这里测"算出来的东西真的接到状态上了"。

test("noteActivity 记一笔 → runCount 从 0 变 1，runMs 是毫秒级而非几十万毫秒", () => {
  const before = s.runSnapshot();
  assert.strictEqual(before.runCount, 0, "初始应为 0（本轮还没操作过）");
  assert.strictEqual(before.runMs, 0, "没操作过时不该有计时 —— 旧实现这里会是进程运行时长");

  s.noteActivity("click", { x: 100, y: 200 });
  const after = s.runSnapshot();

  assert.strictEqual(after.runCount, 1);
  // 关键断言：刚记完就是"0 秒上下"。若退回"进程运行时长"，这个值会是分钟级。
  assert.ok(after.runMs >= 0 && after.runMs < 1000,
    `runMs 应为毫秒级（刚记录），实得 ${after.runMs}ms —— 是不是又变回进程运行时长了？`);
  assert.ok(after.total >= 1);
  assert.ok(after.activities >= 1);
});

test("noteActivity 连续记账 → 同一轮累加", () => {
  s.noteActivity("click", { x: 1, y: 1 });
  const a = s.runSnapshot();
  s.noteActivity("key", { key: "enter" });
  const b = s.runSnapshot();
  assert.strictEqual(b.runCount, a.runCount + 1);
});
