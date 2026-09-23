import { describe, it, expect, beforeEach, vi } from "vitest";

// ── 桥接：订阅匹配 + 窗口角色判定 ──
//
// 这两块是 2026-09-22 引入聊天挂件时改动的部分：
//
// 1. **角色判定**：挂件必须被判为 leaf。漏判的后果很隐蔽 —— 它会被当成 hub
//    （发 hello 的那一侧），于是既拿不到镜像数据、上行命令也没人接。
// 2. **订阅匹配**：桥接把数据推给"订阅了该 topic 的 leaf"。这里锁住匹配规则，
//    防止误发给没订阅的窗口（挂件只订阅 chat.* + settings，不该收到 files/desktop）。
//
// ⚠️ 有一个行为**不在单测覆盖范围内**：`bridgeOut` 必须用 `emitTo`（定向）而非
// `emit`（广播）—— 因为 `emit` 会广播给所有窗口，而 bridgeOut 本来就按 leaf 循环，
// 有 ≥2 个 leaf 时每个都会收到 N 份（对累加的 chat.delta.text 就是文本重复）。
// 那行依赖模块私有的 leaf 表 + Tauri 事件系统，端到端难以在单测里可靠驱动，
// 故靠**人工回归**：同时开一个浮窗 + 挂件，确认 AI 输出不重复。

const emit = vi.fn().mockResolvedValue(undefined);
const emitTo = vi.fn().mockResolvedValue(undefined);
/** 捕获 leaf 侧注册的 bridge 事件处理器 —— 测试靠它模拟 hub 下发 init/data。 */
let bridgeHandler: ((e: { payload: unknown }) => void) | null = null;
const listen = vi.fn().mockImplementation((_evt: string, h: (e: { payload: unknown }) => void) => {
  bridgeHandler = h;
  return Promise.resolve(() => {});
});

vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: unknown[]) => emit(...a),
  emitTo: (...a: unknown[]) => emitTo(...a),
  listen: (...a: unknown[]) => listen(...a),
}));

/** 让 bridge 认为自己是某个窗口（角色判定读 label / hash）。 */
function setWindow(label: string, hash = "") {
  (globalThis as any).window = {
    location: { hash },
    __TAURI_INTERNALS__: { webview: { label } },
  };
}

async function roleFor(label: string, hash = "") {
  vi.resetModules();
  setWindow(label, hash);
  const mod = await import("./bridge");
  return mod.bridge.getRole();
}

describe("bridge — 窗口角色判定（挂件必须是 leaf）", () => {
  it("widget- 前缀 → leaf", async () => {
    expect(await roleFor("widget-main")).toBe("leaf");
  });

  it("#widget/ hash → leaf（窗口复用时 label 之外的第二条依据）", async () => {
    expect(await roleFor("some-other-label", "#widget/main")).toBe("leaf");
  });

  it("主窗仍是 hub", async () => {
    expect(await roleFor("main")).toBe("hub");
  });

  it("既有类型不受影响：float- / #floating/ 仍是 leaf", async () => {
    expect(await roleFor("float-chat--abc")).toBe("leaf");
    expect(await roleFor("x", "#floating/sessions/t/float-sessions--xyz")).toBe("leaf");
  });
});

describe("bridge — pickBridgeTargets（按订阅挑投递目标）", () => {
  const leaf = (windowId: string, subscriptions: string[]) => ({ windowId, subscriptions });

  it("只挑订阅了该 topic 的 leaf", async () => {
    vi.resetModules();
    setWindow("main");
    const { pickBridgeTargets } = await import("./bridge");
    const leafs = [
      leaf("float-a", ["chat.*"]),
      leaf("widget-main", ["chat.*", "settings"]),
      leaf("float-b", ["files.*", "desktop.*"]),
    ];
    expect(pickBridgeTargets("chat.streaming", leafs)).toEqual(["float-a", "widget-main"]);
  });

  it("通配 *. 匹配前缀与其自身", async () => {
    vi.resetModules();
    setWindow("main");
    const { pickBridgeTargets } = await import("./bridge");
    expect(pickBridgeTargets("settings", [leaf("w", ["settings.*"])])).toEqual(["w"]);
    expect(pickBridgeTargets("settings.navigate", [leaf("w", ["settings.*"])])).toEqual(["w"]);
    // 前缀不同名的不该命中（settingsX 不是 settings 的子主题）
    expect(pickBridgeTargets("settingsX", [leaf("w", ["settings.*"])])).toEqual([]);
  });

  it("精确 topic 匹配", async () => {
    vi.resetModules();
    setWindow("main");
    const { pickBridgeTargets } = await import("./bridge");
    expect(pickBridgeTargets("settings", [leaf("w", ["settings"])])).toEqual(["w"]);
    expect(pickBridgeTargets("settings.other", [leaf("w", ["settings"])])).toEqual([]);
  });

  it("无订阅者 → 空（不误发）", async () => {
    vi.resetModules();
    setWindow("main");
    const { pickBridgeTargets } = await import("./bridge");
    expect(pickBridgeTargets("widget.history", [leaf("float-a", ["chat.*"])])).toEqual([]);
  });
});

// ── Leaf 启动的幂等性（StrictMode 双挂载导致的"增量应用两遍"）──
//
// 2026-09-22 用户实测：挂件里 AI 回复**词内重复**（「看起来起来起来起来」）。
// 根因不是内容发错，而是 `startLeaf` **没有幂等守卫** —— React StrictMode 把 effect
// 跑两遍（mount→unmount→mount），每次都 `listen` 注册一个新监听器，于是同一份 payload
// 被处理两次，叶子端的增量被追加两遍。
// （对比：startHub 有 _hubStarted、crossWindowBusLeaf 有 _started，唯独它漏了。
//   浮窗也中招，只是没人盯着浮窗看流式输出。）
describe("bridge.startLeaf — 幂等（StrictMode 双挂载只注册一次监听）", () => {
  beforeEach(() => {
    emit.mockClear();
    emitTo.mockClear();
    listen.mockClear();
  });

  it("连续调用两次 → listen 只注册一次、hello 只发一次", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");

    await bridge.startLeaf(["chat.*"]);
    await bridge.startLeaf(["chat.*"]); // StrictMode 的第二次

    expect(listen.mock.calls.filter((c) => c[0] === "bridge")).toHaveLength(1);
    expect(emit.mock.calls.filter((c) => (c[1] as { type?: string })?.type === "hello")).toHaveLength(1);
  });

  it("并发调用（都在 await 处挂起）也只注册一次", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");

    // 不 await 第一个，立刻发第二个 —— 模拟两次 effect 交错
    const p1 = bridge.startLeaf(["chat.*"]);
    const p2 = bridge.startLeaf(["chat.*"]);
    await Promise.all([p1, p2]);

    expect(listen.mock.calls.filter((c) => c[0] === "bridge")).toHaveLength(1);
  });
});

// ── onLeafReady：消除"请求跑在注册之前"的竞态 ──
//
// 2026-09-22 用户实测："退出挂件再进来，消息列表是空的"。
// 竞态：挂件 JS 一挂载就发 widget.history.request，但 hub 是在处理 `hello` 时才把
// 本窗注册进 `_leafs` 的 —— 请求若跑在前面，hub 遍历 leaf 表找不到本窗，
// **应答发不出去**，窗口永远是空的（间歇性，取决于时序）。
//
// 修法：hub 在注册**之后**才发 init，所以"收到 init"就是"可以安全上行"的信号。
describe("bridge.onLeafReady — 桥接就绪信号", () => {
  beforeEach(() => {
    emit.mockClear();
    emitTo.mockClear();
    listen.mockClear();
  });

  it("init 到达前注册的回调，在 init 到达时才执行（不是立即）", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    await bridge.startLeaf(["chat.*"]);

    const fired: string[] = [];
    bridge.onLeafReady(() => fired.push("a"));
    expect(fired).toEqual([]); // 还没 init → 不该执行

    // 模拟 hub 发来 init
    bridgeHandler!({ payload: { type: "init", snapshots: {} } });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toEqual(["a"]);
  });

  it("init 已到达后再注册 → **立即**执行（调用方不必关心时序）", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    await bridge.startLeaf(["chat.*"]);
    bridgeHandler!({ payload: { type: "init", snapshots: {} } });
    await new Promise((r) => setTimeout(r, 0));

    const fired: string[] = [];
    bridge.onLeafReady(() => fired.push("late"));
    expect(fired).toEqual(["late"]); // 立即，不等
  });

  it("多个回调都会触发，且只触发一次", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    await bridge.startLeaf(["chat.*"]);

    const fired: number[] = [];
    bridge.onLeafReady(() => fired.push(1));
    bridge.onLeafReady(() => fired.push(2));
    bridgeHandler!({ payload: { type: "init", snapshots: {} } });
    await new Promise((r) => setTimeout(r, 0));
    // 再来一次 init（不该重复触发）
    bridgeHandler!({ payload: { type: "init", snapshots: {} } });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toEqual([1, 2]);
  });
});

// ── resetLeaf：让"关掉再开"能重新初始化 ──
//
// 2026-09-22 用户实测："退出挂件再进来，消息列表是空的"。
// 根因：同进程内所有窗口共享一个 WebView2 数据目录（EBWebView-{PID}），窗口关闭
// **不会**清模块级状态 —— 幂等守卫（_leafStart）留在 true/null 之外，第二次
// startLeaf 直接 return，监听器与 hello 都不再注册 → 新窗口收不到任何数据。
// 浮窗同理（关掉再开也空白），只是没人注意。
describe("bridge.resetLeaf — 关掉再开能重新初始化", () => {
  beforeEach(() => {
    emit.mockClear();
    emitTo.mockClear();
    listen.mockClear();
  });

  it("不重置 → 第二次 startLeaf 不注册监听（复现 bug）", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    await bridge.startLeaf(["chat.*"]);
    expect(listen.mock.calls.filter((c) => c[0] === "bridge")).toHaveLength(1);

    // 模拟"窗口关闭"但**不调 resetLeaf**
    await bridge.startLeaf(["chat.*"]);
    expect(listen.mock.calls.filter((c) => c[0] === "bridge")).toHaveLength(1); // 还是 1 —— 没注册
  });

  it("调了 resetLeaf → 模拟重开窗口时能重新注册并重发 hello", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    await bridge.startLeaf(["chat.*"]);
    expect(emit.mock.calls.filter((c) => (c[1] as { type?: string })?.type === "hello")).toHaveLength(1);

    bridge.resetLeaf(); // ← 窗口关闭时的清理
    await bridge.startLeaf(["chat.*"]);

    expect(listen.mock.calls.filter((c) => c[0] === "bridge")).toHaveLength(2); // 重新注册了
    expect(emit.mock.calls.filter((c) => (c[1] as { type?: string })?.type === "hello")).toHaveLength(2);
  });

  it("resetLeaf 后 onLeafReady 回到'等信号'状态（不会拿旧的就绪态误判）", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    await bridge.startLeaf(["chat.*"]);
    bridgeHandler!({ payload: { type: "init", snapshots: {} } });
    await new Promise((r) => setTimeout(r, 0));

    // 此时是"已就绪"，新回调会立即执行
    const before: string[] = [];
    bridge.onLeafReady(() => before.push("x"));
    expect(before).toEqual(["x"]);

    bridge.resetLeaf();
    // 重置后应回到"等信号"—— 新回调不该立即执行（否则会在 hub 未注册本窗前就发请求）
    const after: string[] = [];
    bridge.onLeafReady(() => after.push("y"));
    expect(after).toEqual([]);
  });
});

// ── init 幂等：重复 init 不能重放快照 ──
//
// StrictMode 双挂载 → startLeaf 调两次 → hub 收两次 hello → 回两次 init。
// 若第二次原样重放全部 sticky 快照，对**累加型**数据（chat.delta.text）就是重复追加
// —— 这正是用户看到的「看起来起来起来起来」的来源之一。
describe("bridge — init 只应用一次（重复 init 必须忽略）", () => {
  beforeEach(() => {
    emit.mockClear();
    emitTo.mockClear();
    listen.mockClear();
  });

  it("第二次 init **不会重复应用快照**（这才是重复文本的来源）", async () => {
    // ⚠️ 第一版测试写错了：只检查"回调不重复"，而那已被 _leafReadyCbs 清空兜住，
    // 与 init 守卫无关（红验证照样通过）。真正要锁的是**快照不重复应用**。
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    const { crossWindowBus } = await import("./crossWindowBus");
    await bridge.startLeaf(["chat.*"]);

    // 统计 delta 被应用了几次
    let deltaApplications = 0;
    crossWindowBus.subscribe("chat.delta.text", () => { deltaApplications++; });

    const snap = { type: "init", snapshots: { "chat.delta.text": { text: "你好", index: 0 } } };
    bridgeHandler!({ payload: snap });
    await new Promise((r) => setTimeout(r, 0));
    expect(deltaApplications).toBe(1);

    // 第二次 init（StrictMode）—— 同样的快照不该再应用一遍（否则文本重复）
    bridgeHandler!({ payload: { type: "init", snapshots: { "chat.delta.text": { text: "你好", index: 0 } } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(deltaApplications).toBe(1); // 仍是 1
  });

  it("resetLeaf 后 init 又能应用（关窗重开场景）", async () => {
    vi.resetModules();
    setWindow("widget-main");
    const { bridge } = await import("./bridge");
    await bridge.startLeaf(["chat.*"]);
    bridgeHandler!({ payload: { type: "init", snapshots: {} } });
    await new Promise((r) => setTimeout(r, 0));

    bridge.resetLeaf(); // 关窗
    await bridge.startLeaf(["chat.*"]); // 重开

    const fired: string[] = [];
    bridge.onLeafReady(() => fired.push("reopened"));
    bridgeHandler!({ payload: { type: "init", snapshots: {} } });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toEqual(["reopened"]);
  });
});

// ── 订阅面缺失 → 投递被静默丢弃（2026-09-22 挂件历史回填的真因）──
//
// 桥接的定向投递会**先按 leaf 的订阅 pattern 过滤**（bridgeOut → shouldForwardTo），
// 没订阅的 topic 根本不发。挂件要 `widget.history`（历史回填的应答），但订阅面
// 只有 `["chat.*", "settings", "worker*"]` —— 一个都不匹配 → 应答被丢掉。
//
// 表现极具误导性：hub 侧日志显示"发出条数 4"（它以为发了），挂件一条没收到。
// 排查时容易往"投递机制坏了"方向查，实际是**订阅面漏了 topic**。
describe("bridge — 订阅面必须覆盖要收的 topic（否则静默丢弃）", () => {
  const leaf = (windowId: string, subscriptions: string[]) => ({ windowId, subscriptions });

  it("只订阅 chat.*/settings 的 leaf **收不到** widget.history（复现 bug）", async () => {
    vi.resetModules();
    setWindow("main");
    const { pickBridgeTargets } = await import("./bridge");
    const oldSubs = leaf("widget-main", ["chat.*", "settings", "worker*"]);
    expect(pickBridgeTargets("widget.history", [oldSubs])).toEqual([]); // ← 被丢弃
  });

  it("订阅里加上 widget.* 后能收到", async () => {
    vi.resetModules();
    setWindow("main");
    const { pickBridgeTargets } = await import("./bridge");
    const fixedSubs = leaf("widget-main", ["chat.*", "settings", "widget.*"]);
    expect(pickBridgeTargets("widget.history", [fixedSubs])).toEqual(["widget-main"]);
  });

  it("`worker*` 是无效 pattern（缺 `.*`），永远匹配不上任何 topic", async () => {
    vi.resetModules();
    setWindow("main");
    const { pickBridgeTargets } = await import("./bridge");
    // 注意别把 pattern 本身当 topic（精确匹配会成立）—— 只测真实 topic
    for (const t of ["worker", "workers", "workers.status"]) {
      expect(pickBridgeTargets(t, [leaf("w", ["worker*"])])).toEqual([]);
    }
  });
});
