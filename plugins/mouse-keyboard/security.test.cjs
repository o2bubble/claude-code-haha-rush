// ── mouse-keyboard 安全核心单测 ──
//
// 运行: node security.test.cjs（node:test, 无外部依赖 —— 插件包独立，不挂 vitest）
//     或 MK_TEST=1 node --test security.test.cjs
//
// 测什么：**"锁 / 租约 / 逃生键 / 输入来源判定"** 这几块纯逻辑。
// 为什么只测这些：它们的失败后果是"**用户被锁死**"或"**锁形同虚设**" ——
// 前者让用户键鼠失灵，后者让 AI 的独占声明变成纸糊的。这两类错误在开发期
// 极难察觉（都是"看起来正常"），必须有回归测试兜着。
//
// 不测什么：真实钩子安装/吞事件/注入放行 —— 那些要么需要真人按键，要么需要
// 真装钩子（会干扰当前桌面）。它们由实测覆盖（见 AI_NOTES 第 0 节的验证手法）。
//
// ⚠️ 本文件的**每条用例都对应一个真实踩过的坑或一条安全底线**，注释里写了是哪条。
// 改实现时如果这些用例红了，先想清楚是不是把某条底线弄丢了，再改测试。

const test = require("node:test");
const assert = require("node:assert");

// MK_TEST=1 → server.cjs 不启动 HTTP 监听、只导出纯函数（见其文件尾的守卫）
process.env.MK_TEST = "1";
const s = require("./server.cjs");

// ─────────────────────────────────────────────────────────────────
// ① 锁定范围校验
// ─────────────────────────────────────────────────────────────────
// 底线：**非法输入绝不能意外锁住用户**。宁可"不锁"（AI 白声明一次），
// 也不能"乱锁"（用户键鼠突然失灵且不知为何）。

test("normalizeLockScope — 三个合法值原样返回", () => {
  assert.strictEqual(s.normalizeLockScope("keyboard"), "keyboard");
  assert.strictEqual(s.normalizeLockScope("mouse"), "mouse");
  assert.strictEqual(s.normalizeLockScope("both"), "both");
});

test("normalizeLockScope — 布尔 true 等价于 both（AI 常这么写）", () => {
  assert.strictEqual(s.normalizeLockScope(true), "both");
});

test("normalizeLockScope — 大小写与空白归一化", () => {
  assert.strictEqual(s.normalizeLockScope("KEYBOARD"), "keyboard");
  assert.strictEqual(s.normalizeLockScope("  Both  "), "both");
});

test("normalizeLockScope — 非法值一律 none（绝不意外锁住）", () => {
  // ⚠️ 这条是底线：任何没预料到的输入都必须是"不锁"
  for (const bad of ["bogus", "", " ", "key", "keyboard2", "mouse+keyboard", null, undefined, 0, 1, 123, {}, [], NaN, false]) {
    assert.strictEqual(s.normalizeLockScope(bad), "none", `输入 ${JSON.stringify(bad)} 应得 none`);
  }
});

// ─────────────────────────────────────────────────────────────────
// ② 输入来源判定（物理 vs 注入）—— 决定"吞谁、放行谁"
// ─────────────────────────────────────────────────────────────────
// 底线：**只吞物理、必须放行注入**。吞了注入 = AI 把自己锁在外面（功能直接不可用）；
// 放行了物理 = 锁形同虚设。

test("isPhysicalEvent — 键盘：无注入标志 = 物理（该吞）", () => {
  assert.strictEqual(s.isPhysicalEvent(0x00, s.LLKHF_INJECTED), true);
  // 其它常见标志位（extended/altdown 等）不该被误判成注入
  assert.strictEqual(s.isPhysicalEvent(0x01, s.LLKHF_INJECTED), true);   // LLKHF_EXTENDED
  assert.strictEqual(s.isPhysicalEvent(0x20, s.LLKHF_INJECTED), true);   // LLKHF_ALTDOWN
});

test("isPhysicalEvent — 键盘：带注入标志 = 注入（必须放行）", () => {
  assert.strictEqual(s.isPhysicalEvent(0x10, s.LLKHF_INJECTED), false);
  // 注入 + 其它标志组合也要认出来
  assert.strictEqual(s.isPhysicalEvent(0x10 | 0x01, s.LLKHF_INJECTED), false);
});

test("isPhysicalEvent — 鼠标：用鼠标的注入位（0x01）", () => {
  assert.strictEqual(s.isPhysicalEvent(0x00, s.LLMHF_INJECTED), true);
  assert.strictEqual(s.isPhysicalEvent(0x01, s.LLMHF_INJECTED), false);
});

test("🔴 两个注入标志不能混用（键盘 0x10 ≠ 鼠标 0x01）", () => {
  // 键盘的 0x10 拿去判鼠标 会**把鼠标注入放行当物理吞掉**（AI 点不动）
  // 鼠标的 0x01 拿去判键盘 会把"扩展键"误当注入放行（锁形同虚设）
  assert.notStrictEqual(s.LLKHF_INJECTED, s.LLMHF_INJECTED);
  assert.strictEqual(s.LLKHF_INJECTED, 0x10);
  assert.strictEqual(s.LLMHF_INJECTED, 0x01);
  // 键盘事件带 0x01（扩展标志）仍是物理；鼠标事件带 0x10 仍是物理
  assert.strictEqual(s.isPhysicalEvent(0x01, s.LLKHF_INJECTED), true);
  assert.strictEqual(s.isPhysicalEvent(0x10, s.LLMHF_INJECTED), true);
});

// ─────────────────────────────────────────────────────────────────
// ③ 租约 —— "忘了解锁自动解开"的底线
// ─────────────────────────────────────────────────────────────────
// 底线：**锁必须是限时的，且不能被无凭据地续期**。
// 出现过真 bug：续期曾挂在只读接口 /activity 上 → 指示窗每 250ms 轮询 → 租约
// 永远不过期（实测 remaining 恒为 10000ms）→ 兜底失效。

test("LOCK_LEASE_MS — 有限且合理（不能是永久锁）", () => {
  assert.ok(Number.isFinite(s.LOCK_LEASE_MS), "租约必须是有限值");
  assert.ok(s.LOCK_LEASE_MS > 0, "租约必须为正");
  assert.ok(s.LOCK_LEASE_MS <= 60000, `租约不该超过 1 分钟（当前 ${s.LOCK_LEASE_MS}ms）—— 用户被锁死的上限`);
});

test("renewLock — 未锁定时拒绝续期（不能凭空续）", () => {
  const saved = { ...s.lockState };
  try {
    s.lockState.active = false;
    s.lockState.expiresAt = 0;
    assert.strictEqual(s.renewLock(), false, "未锁定时 renewLock 应返回 false");
    assert.strictEqual(s.lockState.expiresAt, 0, "未锁定时不该改动 expiresAt");
  } finally { Object.assign(s.lockState, saved); }
});

test("renewLock — 锁定时把到期时间推后一个租约", () => {
  const saved = { ...s.lockState };
  try {
    s.lockState.active = true;
    s.lockState.scope = "both";
    s.lockState.expiresAt = Date.now() - 5000;   // 假装已经过期
    assert.strictEqual(s.renewLock(), true);
    const remain = s.lockState.expiresAt - Date.now();
    assert.ok(remain > s.LOCK_LEASE_MS - 1000, `续期后剩余应接近 ${s.LOCK_LEASE_MS}ms，实为 ${remain}ms`);
  } finally { Object.assign(s.lockState, saved); }
});

test("lockSnapshot — 未锁定时 locked=false 且剩余为 0", () => {
  const saved = { ...s.lockState };
  try {
    s.lockState.active = false;
    const snap = s.lockSnapshot();
    assert.strictEqual(snap.locked, false);
    assert.strictEqual(snap.lockRemainMs, 0);
    assert.strictEqual(snap.escapeKey, "Ctrl+Q", "逃生键提示必须是 Ctrl+Q");
  } finally { Object.assign(s.lockState, saved); }
});

test("lockSnapshot — 锁定时剩余时间不超租约、且不为负", () => {
  const saved = { ...s.lockState };
  try {
    s.lockState.active = true;
    s.lockState.scope = "keyboard";
    s.lockState.since = Date.now();
    s.lockState.expiresAt = Date.now() + s.LOCK_LEASE_MS;
    const snap = s.lockSnapshot();
    assert.strictEqual(snap.locked, true);
    assert.strictEqual(snap.lockScope, "keyboard");
    assert.ok(snap.lockRemainMs > 0 && snap.lockRemainMs <= s.LOCK_LEASE_MS);

    // 已过期的状态（看门狗还没来得及跑）也不能报负数 —— 指示窗会显示"剩 -3s"
    s.lockState.expiresAt = Date.now() - 1000;
    assert.strictEqual(s.lockSnapshot().lockRemainMs, 0, "过期后剩余应钳到 0（不能负数）");
  } finally { Object.assign(s.lockState, saved); }
});

// ─────────────────────────────────────────────────────────────────
// ④ 逃生键（Ctrl+Q）—— 锁定期间**唯一**能救用户的东西
// ─────────────────────────────────────────────────────────────────
// 底线：**必须能触发**（用户被锁死时只有它），且**不能误触发**（正常打字按到 Ctrl 就接管会很烦）。
// 出现过真 bug：早期用 GetAsyncKeyState 判定 → 被吞的键读不到 → 锁定期间必然失效。

test("trackCtrl — 三个 Ctrl VK 都要认（左/右 Ctrl 的 vk 不同）", () => {
  s.ctrlDown.clear();
  // 用户键盘可能给 0x11（通用）/ 0xA2（左）/ 0xA3（右）
  for (const vk of [s.VK_CONTROL, 0xA2, 0xA3]) {
    s.trackCtrl(vk, true);
    assert.strictEqual(s.escapeComboDownInHook(), true, `VK 0x${vk.toString(16)} 按下后应视为 Ctrl 按下`);
    s.trackCtrl(vk, false);
    assert.strictEqual(s.escapeComboDownInHook(), false, `VK 0x${vk.toString(16)} 松开后应清空`);
  }
  s.ctrlDown.clear();
});

test("trackCtrl — 非 Ctrl 键不影响逃生组合判定", () => {
  s.ctrlDown.clear();
  for (const vk of [0x41 /*A*/, 0x51 /*Q*/, 0x10 /*Shift*/, 0x12 /*Alt*/, 0x5B /*Win*/]) {
    s.trackCtrl(vk, true);
  }
  assert.strictEqual(s.escapeComboDownInHook(), false, "只按 A/Q/Shift/Alt/Win 不该算 Ctrl 按下");
  s.ctrlDown.clear();
});

test("ctrlDown 同时按多个 Ctrl VK 时，松开其一仍视为按下", () => {
  s.ctrlDown.clear();
  s.trackCtrl(0xA2, true);
  s.trackCtrl(0xA3, true);
  s.trackCtrl(0xA2, false);   // 只松开左 Ctrl
  assert.strictEqual(s.escapeComboDownInHook(), true, "还有一个 Ctrl 按着 → 仍应视为按下");
  s.trackCtrl(0xA3, false);
  assert.strictEqual(s.escapeComboDownInHook(), false);
  s.ctrlDown.clear();
});

test("CTRL_VKS 含且仅含三个 Ctrl 变体", () => {
  assert.strictEqual(s.CTRL_VKS.size, 3);
  for (const vk of [0x11, 0xA2, 0xA3]) assert.ok(s.CTRL_VKS.has(vk), `应含 0x${vk.toString(16)}`);
});

test("ESCAPE_VK 是 Q（0x51）—— 与文档/工具描述里的 Ctrl+Q 一致", () => {
  assert.strictEqual(s.ESCAPE_VK, 0x51);
});

// ─────────────────────────────────────────────────────────────────
// ⑤ 动作描述 —— 指示窗列表里显示给人看的内容
// ─────────────────────────────────────────────────────────────────
// 底线：**不能抛异常**（它在渲染路径上，一抛整个窗口就白屏），
// 且**不能泄露超长内容**（AI 可能输入几千字，列表要截断）。

test("describeStep — 各动作生成可读描述", () => {
  assert.strictEqual(s.describeStep("move", { x: 100, y: 200 }), "移动 (100,200)");
  assert.strictEqual(s.describeStep("move", { dx: 5, dy: -3 }), "移动 +(5,-3)");
  assert.strictEqual(s.describeStep("click", { x: 1, y: 2 }), "点击 (1,2)");
  assert.strictEqual(s.describeStep("click", { double: true }), "点击 当前处（双击）");
  assert.strictEqual(s.describeStep("scroll", { dy: 3 }), "滚动 (0,3)");
  assert.strictEqual(s.describeStep("key", { key: "a", modifiers: ["ctrl"] }), "按键 ctrl+a");
  assert.strictEqual(s.describeStep("key", { key: "a", hold: true }), "按键 a（按住）");
  assert.strictEqual(s.describeStep("drag", { fromX: 1, fromY: 2, toX: 3, toY: 4 }), "拖拽 (1,2)→(3,4)");
  assert.strictEqual(s.describeStep("screen_info", {}), "读取屏幕信息");
  assert.strictEqual(s.describeStep("move_indicator", {}), "移动指示窗");
});

test("describeStep — 长文本被截断（列表里不该出现几千字）", () => {
  const long = "文".repeat(500);
  const out = s.describeStep("type", { text: long });
  assert.ok(out.length < 40, `描述应被截断，实际长度 ${out.length}`);
  assert.ok(out.includes("…"), "截断处应有省略号");
  assert.ok(out.startsWith("输入「"), "应保留动作语义前缀");
});

test("🔴 describeStep — 任何 *JSON 可达* 的输入都不抛（渲染路径不能崩）", () => {
  // 指示窗每次渲染都会调它；AI 传什么奇怪参数都不该让窗口白屏。
  //
  // ⚠️ **范围限定为"JSON 可达"**：`args` 来自 `JSON.parse(http body)`，
  // 只可能是纯数据（string/number/bool/null/数组/对象），**不可能带自定义方法**。
  // 所以"带恶意 toString 的对象"这类输入不在防护范围内 —— 为不可达的场景加
  // try/catch 是徒增代码（试过，`String(a.text)` 会抛那个构造的 toString）。
  const weird = [
    ["move", undefined], ["move", null], ["move", {}],
    ["click", { x: NaN, y: Infinity }],          // JSON 里 NaN 不可达，但数字边界该稳
    ["key", { key: undefined }], ["key", { key: 123, modifiers: "ctrl" }],   // modifiers 不是数组
    ["key", { modifiers: [] }], ["key", {}],
    ["type", { text: null }], ["type", { text: undefined }], ["type", { text: 12345 }],
    ["type", { text: ["a", "b"] }], ["type", { text: { nested: 1 } }],
    ["drag", {}], ["scroll", {}], ["未知动作", {}], ["", {}],
    ["move", { x: "100", y: "200" }],            // 字符串坐标（AI 有时这么写）
  ];
  for (const [action, args] of weird) {
    assert.doesNotThrow(() => {
      const r = s.describeStep(action, args);
      assert.strictEqual(typeof r, "string", `describeStep(${action}) 应返回字符串`);
    }, `describeStep(${JSON.stringify(action)}, ${JSON.stringify(args)}) 不该抛`);
  }
});

// ─────────────────────────────────────────────────────────────────
// ⑥ 测试守卫自身
// ─────────────────────────────────────────────────────────────────
// 防止"测试模式失效" —— 若守卫坏了，测试进程会真的监听端口/装钩子（污染桌面）。

test("测试模式生效（require 不启动监听、不装钩子）", () => {
  assert.strictEqual(s.TEST_MODE, true, "MK_TEST=1 时应处于测试模式");
  assert.strictEqual(s.lockState.active, false, "加载后不该是锁定态");
  assert.strictEqual(s.ctrlDown.size, 0, "加载后 Ctrl 跟踪应为空");
});
