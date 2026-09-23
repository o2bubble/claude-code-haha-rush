import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { reconcileDirty, type AppSettings } from "./settingsStore";

// reconcileDirty —— 多实例"僵尸写回"的修复。
//
// 背景（用户实测，两例）：
//   A 实例关闭会话文件夹 → 磁盘写 false；
//   B 实例的设置面板里，该字段的**待保存值（dirty）**还是旧值 true；
//   B 保存任何别的设置时（handleSave 写的是 {...dirty}）→ 把 true 又写回磁盘。
//   表现为"A 关了又自己开、重启后还在"。
//
// 规则：外部同步到达时，dirty 里与权威值**不一致**的字段 = 已被外部改过 →
// 移除（外部赢）；一致的保留（本地 update 的回声，值必然一致，不受影响）。

// 测试只关心被比较的字段，其余用最小骨架 + 断言时忽略
const mkSettings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({ workDir: "", ...over } as AppSettings);

describe("reconcileDirty — 待保存字段随外部同步收敛", () => {
  it("空 dirty → 原引用返回（不制造无谓的新对象）", () => {
    const dirty = {};
    const out = reconcileDirty(dirty, mkSettings());
    expect(out).toBe(dirty);
  });

  it("dirty 值 === 权威值（本地 update 的回声）→ 保留", () => {
    const out = reconcileDirty(
      { sessionFolders: true },
      mkSettings({ sessionFolders: true }),
    );
    expect(out).toEqual({ sessionFolders: true });
  });

  it("dirty 值 ≠ 权威值（被外部改过）→ 移除，外部赢", () => {
    // 本实例待存 true，但权威值已是 false（别的实例刚关掉）
    const out = reconcileDirty(
      { sessionFolders: true },
      mkSettings({ sessionFolders: false }),
    );
    expect(out).toEqual({});
  });

  it("只收敛被外部改过的字段，未被改的保留", () => {
    const out = reconcileDirty(
      { sessionFolders: true, msgQueuePosition: "right" },
      mkSettings({ sessionFolders: false, msgQueuePosition: "right" }),
    );
    expect(out).toEqual({ msgQueuePosition: "right" });
  });

  it("对象字段按值比较（sessionFolderTree 被外部改过 → 移除）", () => {
    const out = reconcileDirty(
      { sessionFolderTree: { folders: [{ id: "a", name: "旧" }], assignments: {} } },
      mkSettings({ sessionFolderTree: { folders: [], assignments: {} } }),
    );
    expect(out).toEqual({});
  });

  it("对象字段值相同 → 保留（深比较）", () => {
    const tree = { folders: [{ id: "a", name: "n" }], assignments: { s1: "a" } };
    const out = reconcileDirty(
      { sessionFolderTree: { folders: [...tree.folders], assignments: { ...tree.assignments } } },
      mkSettings({ sessionFolderTree: tree }),
    );
    expect(out).toEqual({
      sessionFolderTree: { folders: [{ id: "a", name: "n" }], assignments: { s1: "a" } },
    });
  });

  it("外部改过一半、另一半是自己刚改的 → 各自处理", () => {
    const out = reconcileDirty(
      { a: 1, b: 2 } as unknown as Partial<AppSettings>,
      { a: 1, b: 99 } as unknown as AppSettings,
    );
    expect(out).toEqual({ a: 1 });
  });
});

// ── saveSettings 的广播链路 ──
//
// 「设置里改一项，界面上立刻反映」靠的是：saveSettings 存盘后**自己 emit**
// SETTINGS_CHANGED，订阅方（App.tsx 的窗口标题、各面板的 useEvent）据此更新。
// 这条链断了的话，用户会以为"改了没生效、要重启"——正是用户问过的那个问题
// （2026-09-21：「设置里修改后是立即生效，还是要重新触发什么？」）。
describe("saveSettings — 保存后广播新值（改动即时生效的基础）", () => {
  // settingsStore 的 isTauri() 读 window.__TAURI_INTERNALS__，而测试跑在 node
  // （无 jsdom）。stub 一个最小 window → isTauri() 返回 false → 走 localStorage
  // 分支，广播链路照常可验。真实 GUI 里 window 必然存在，故这不是代码问题。
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  const origWindow = g.window;
  const origLocalStorage = g.localStorage;
  beforeAll(() => {
    const store = new Map<string, string>();
    g.window = { __TAURI_INTERNALS__: undefined }; // → isTauri() 为 false，走 localStorage 分支
    // saveSettings 用的是**裸 localStorage**（非 window.localStorage），故两处都铺
    const fake = {
      setItem: (k: string, v: string) => void store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
    };
    g.localStorage = fake;
    (g.window as { localStorage: unknown }).localStorage = fake;
  });
  afterAll(() => {
    if (origWindow === undefined) delete g.window; else g.window = origWindow;
    if (origLocalStorage === undefined) delete g.localStorage; else g.localStorage = origLocalStorage;
  });

  it("emit 的 settings 里带着刚保存的字段", async () => {
    const { saveSettings } = await import("./settingsStore");
    const { windowBus } = await import("../services/windowBus");
    const { Events } = await import("../services/events");

    // 用数组收（而不是 `let received = null`）：TS 的控制流分析看不到闭包内赋值，
    // 会把 let 变量收窄成 never，读它的属性直接编译报错。
    const received: Array<{ settings?: AppSettings }> = [];
    const off = windowBus.on(Events.SETTINGS_CHANGED, (d) => {
      received.push(d as { settings?: AppSettings });
    });
    try {
      await saveSettings({ windowTitleOrder: "session-first" }, "global");
      // ⚠️ 断言用 some 而不是 received[0]：SETTINGS_CHANGED 是 **sticky** 的，
      // 订阅时会立刻回放上一次的值（所以 [0] 是旧值、不是本次保存的）。
      // 这反而说明 sticky 回放也在工作；这里只关心"本次保存的新值有没有广播出去"。
      expect(received.some((r) => r.settings?.windowTitleOrder === "session-first")).toBe(true);
    } finally {
      off();
    }
  });

  it("浏览器环境（无 Tauri）也照常广播 —— 走 localStorage 分支", async () => {
    const { saveSettings } = await import("./settingsStore");
    const { windowBus } = await import("../services/windowBus");
    const { Events } = await import("../services/events");

    const received: Array<{ settings?: AppSettings }> = [];
    const off = windowBus.on(Events.SETTINGS_CHANGED, (d) => {
      received.push(d as { settings?: AppSettings });
    });
    try {
      await saveSettings({ windowTitleOrder: "workspace-first" }, "global");
      expect(received.some((r) => r.settings?.windowTitleOrder === "workspace-first")).toBe(true);
    } finally {
      off();
    }
  });
});
