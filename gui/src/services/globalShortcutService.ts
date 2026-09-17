// ── globalShortcutService — OS 级全局热键（GUI 失焦也生效）──
//
// 快捷键表的唯一真相源仍是 `shortcuts.ts` + `settings.shortcuts`；本模块只负责把
// `scope === "os"` 的条目**注册到操作系统**。注册由前端发起（而非 Rust）的理由：
// 在 Rust 再建一份「键位 → 动作」映射会立刻产生两份会漂移的真相。
//
// ## 两个必须做对的地方
//
// 1. **差集增量更新，不用 `unregisterAll` + 全量重注册** —— 后者在重注册的间隙里
//    键位是失效的（用户按了没反应），且拿不到"是哪个键注册失败"的粒度。
// 2. **失败必须上报** —— Windows 的 `RegisterHotKey` 是**进程级独占**：多开的第二个
//    GUI 实例、微信的 Alt+A、QQ、输入法等都会占键。静默失败的话，用户只会觉得
//    "这个快捷键时灵时不灵"，无从排查。

import { commandRegistry } from "./windowBus";
import {
  buildPluginShortcutEntries,
  resolveBindings,
  toAccelerator,
  isGlobalHotkeyBindable,
  DEFAULT_SHORTCUTS,
  type ShortcutEntry,
} from "./shortcuts";
import { getActiveManifests, collectPluginHotkeys } from "./pluginRegistry";
import { getSettings } from "../stores/settingsStore";
import { isMacPlatform } from "./shortcutDispatcher";

/**
 * 单个热键的**状态**。三态而非"成功/失败"两态，因为三者对用户的意义完全不同：
 *
 * - `ok`        已注册，全局生效（失焦也能按）
 * - `disabled`  **用户主动关闭**了本实例的全局热键（设置里的开关）——
 *               是选择，不是故障，界面不该标红
 * - `taken`     尝试注册但键被占。再看 `takenBy` 决定要不要用户行动：
 *               `instance` = 另一个 GUI 实例（多开的正常现象，无需处理）
 *               `other`    = 其它软件占用（需要换键）
 */
export type HotkeyState = "ok" | "disabled" | "taken";

/** 单个热键的注册结果（供设置面板显示"已生效 / 已关闭 / 被占用"）。 */
export interface HotkeyStatus {
  id: string;
  /** 显示名（插件条目无 i18n 键，用其自带 label） */
  label: string;
  /** 规范化键位 */
  keys: string;
  /** 转出的 accelerator（null = 该键位无法表达，未注册） */
  accelerator: string | null;
  registered: boolean;
  state: HotkeyState;
  /** `state === "taken"` 时区分占用来源 */
  takenBy?: "instance" | "other";
  /** 失败原因（注册被拒时为 OS 的错误信息） */
  error?: string;
}

export interface GlobalShortcutHandle {
  dispose(): void;
  /** 当前注册状态（设置面板读它显示徽标） */
  getStatus(): HotkeyStatus[];
  /**
   * 立刻重算一遍（重新尝试注册）。
   *
   * 用于「关掉另一个实例的全局热键后，本实例想接管」—— 跨实例没有通知机制，
   * 所以给用户一个显式的重试入口，而不是搞轮询/自动接管那套（不可预测）。
   */
  retry(): void;
}

// ── 模块级状态订阅 ──
//
// 设置面板需要显示"这个全局热键到底注册上没有" —— 注册失败是**静默的**
// （键被别的软件占用时没有任何其它反馈），没有这块 UI 用户只会觉得
// "快捷键时灵时不灵"，无从排查。故把最近一次结果留在模块级供面板读取。

let _status: HotkeyStatus[] = [];
const _listeners = new Set<(s: HotkeyStatus[]) => void>();

function setStatus(next: HotkeyStatus[]): void {
  _status = next;
  for (const fn of _listeners) fn(next);
}

/** 读最近一次注册结果（空数组 = 尚未跑过 / 没有 os 条目）。 */
export function getGlobalHotkeyStatus(): HotkeyStatus[] {
  return _status;
}

/** 订阅注册结果变化，返回退订函数。 */
export function subscribeGlobalHotkeyStatus(fn: (s: HotkeyStatus[]) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** 某个条目在当前平台是否该注册为全局热键。 */
function appliesHere(e: ShortcutEntry, isMac: boolean): boolean {
  if (e.scope !== "os") return false;
  if (e.contextual) return false;
  if (!e.keys) return false;
  // `os` 字段是平台限定；未声明 = 全平台
  if (e.os === "win" && isMac) return false;
  if (e.os === "mac" && !isMac) return false;
  return true;
}

/** 收集当前应注册的全部全局热键（内置 + 插件）。导出供单测。 */
export function collectGlobalHotkeys(
  overrides: Record<string, string> | undefined,
  pluginEntries: ShortcutEntry[],
  isMac: boolean,
): HotkeyStatus[] {
  const all = [
    ...resolveBindings(DEFAULT_SHORTCUTS, overrides),
    ...resolveBindings(pluginEntries, overrides),
  ];
  return all.filter((e) => appliesHere(e, isMac)).map((e) => ({
    id: e.id,
    label: e.label ?? e.id,
    keys: e.keys,
    accelerator: isGlobalHotkeyBindable(e.keys) ? toAccelerator(e.keys) : null,
    registered: false,
    // 占位 = "ok"（**尚未判定，不报警**）。真正状态由 reconcile 填。
    // 用 "taken" 当占位会让面板在启动瞬间闪一下"被占用"再变正常。
    state: "ok" as HotkeyState,
    ...(isGlobalHotkeyBindable(e.keys) ? {} : { error: "键位不满足全局热键要求" }),
  }));
}

/** 本实例是否参与全局热键注册（缺省 = 参与，未设开关的老用户行为不变）。 */
export function hotkeysEnabled(): boolean {
  return getSettings().globalHotkeysEnabled !== false;
}

/** 已启动实例的 retry —— 供设置面板的「重新检测」按钮直接调用。 */
let _retry: (() => void) | null = null;

/** 立刻重算全局热键注册（跨实例无通知机制，故给用户一个显式重试入口）。 */
export function retryGlobalShortcuts(): void {
  _retry?.();
}

/**
 * 由「本机同款实例数」判断热键被谁占了（纯函数，可测）。
 *
 * - 多于一个实例 → 归因给另一个实例。多开场景下这是最常见的原因；即便归错
 *   （其实是微信占的），用户也能从"关掉另一个实例后仍不行"自行发现。
 * - 只有一个实例（= 只有自己）却注册失败 → **一定是别的软件**。这个判断很准，
 *   不该含糊成"可能被占用" —— 那时用户需要的是"换键"这个明确动作。
 */
export function classifyTakenBy(siblingInstances: number): "instance" | "other" {
  return siblingInstances > 1 ? "instance" : "other";
}

/**
 * 本机有几个同款 GUI 实例（含自己），用于区分"被另一个实例占"与"被其它软件占"。
 *
 * 失败/非 Tauri 环境回落 1（= 不声称有多实例）—— 宁可少说，不要把
 * "微信占了你的键"误报成"被另一个实例占了"（那会让用户放弃处理）。
 */
async function siblingInstanceCount(): Promise<number> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const n = await invoke<number>("count_gui_instances");
    return typeof n === "number" && n >= 1 ? n : 1;
  } catch {
    return 1;
  }
}

/**
 * 启动全局热键注册，并在设置/插件变化时**增量**同步。
 *
 * @returns handle；`dispose()` 注销全部并停掉订阅。
 */
export function startGlobalShortcuts(
  onStatusChange?: (s: HotkeyStatus[]) => void,
): GlobalShortcutHandle {
  const isMac = isMacPlatform();
  /** accelerator → 已注册的条目 id */
  const live = new Map<string, string>();
  let status: HotkeyStatus[] = [];
  let disposed = false;

  const publish = () => {
    setStatus([...status]);
    onStatusChange?.([...status]);
  };

  /** 此刻应当注册的全部全局热键（内置 + 插件，已按平台过滤）。 */
  const desired = (): HotkeyStatus[] =>
    collectGlobalHotkeys(
      getSettings().shortcuts,
      buildPluginShortcutEntries(collectPluginHotkeys(getActiveManifests())),
      isMac,
    );

  // ⚠️ **串行化**：reconcile 会在三处被触发（启动、设置变更、插件重扫），它们
  // 可能重叠。重叠的两次都会看到某个 accelerator "尚未注册" → 都去 register →
  // 第二次拿到 `HotKey already registered`，于是状态被错误标记为"被占用"。
  // 这在启动时尤其容易发生（SETTINGS_CHANGED 是 sticky，挂载即触发）。
  let running = false;
  let dirty = false;

  const reconcile = async () => {
    if (running) { dirty = true; return; }
    running = true;
    try {
      do {
        dirty = false;
        await reconcileOnce();
      } while (dirty && !disposed);
    } finally {
      running = false;
    }
  };

  const reconcileOnce = async () => {
    if (disposed) return;
    let mod: typeof import("@tauri-apps/plugin-global-shortcut");
    try {
      mod = await import("@tauri-apps/plugin-global-shortcut");
    } catch (e) {
      // 插件未安装/权限缺失：整体记失败，不静默。
      // state 必须显式给 —— 沿用占位的 "ok" 会让面板**什么都不显示**，
      // 而这时候热键其实完全没工作（静默失败正是本模块开头注释要避免的）。
      status = desired().map((w) => ({
        ...w, registered: false, state: "taken" as HotkeyState,
        error: "全局热键不可用（插件未加载）",
      }));
      publish();
      return;
    }

    const want = desired();
    const wantAccels = new Map<string, string>(); // accel → id
    for (const w of want) if (w.accelerator) wantAccels.set(w.accelerator, w.id);

    // ⓪ 本实例被主动关闭了全局热键（设置开关）→ 注销已注册的，且不再尝试。
    //    与"让位"不同：这是**用户的选择**，界面不该显示成故障。
    if (!hotkeysEnabled()) {
      for (const accel of [...live.keys()]) {
        try { await mod.unregister(accel); } catch { /* 已不在也无所谓 */ }
        live.delete(accel);
      }
      status = want.map((w) => ({ ...w, registered: false, state: "disabled" as HotkeyState, error: undefined }));
      publish();
      return;
    }

    // ① 注销：已注册但不再需要（条目被删/改键/解绑/插件卸载）
    for (const [accel, id] of [...live.entries()]) {
      if (wantAccels.get(accel) === id) continue;
      try {
        await mod.unregister(accel);
      } catch {
        /* 已经不在了也无所谓 */
      }
      live.delete(accel);
    }

    // ② 注册新增（差集 —— 未变的不动，避免瞬时失效）
    //    实例数只在**确实有注册失败**时才查（避免每次 reconcile 都读一遍进程表）。
    let siblings = 0;   // 0 = 尚未查询
    const results = new Map<string, { ok: boolean; error?: string; state: HotkeyState; takenBy?: "instance" | "other" }>();
    for (const w of want) {
      if (!w.accelerator) {
        results.set(w.id, { ok: false, error: "键位无法转为全局热键", state: "taken" });
        continue;
      }
      if (live.get(w.accelerator) === w.id) {
        results.set(w.id, { ok: true, state: "ok" }); // 已在注册状态，跳过
        continue;
      }
      const onFire = (event: unknown) => {
        // 按下与抬起都会回调 —— 只认 Pressed，否则一次按键触发两次
        const state = typeof event === "string" ? "Pressed" : (event as { state?: string })?.state;
        if (state !== "Pressed") return;
        commandRegistry.execute(w.id);
      };
      try {
        // 逐个注册：批量注册时一个失败会拖垮整批，且无法定位是哪个键被占用
        await mod.register(w.accelerator, onFire);
        live.set(w.accelerator, w.id);
        results.set(w.id, { ok: true, state: "ok" });
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? e);
        // 「已被注册」有两种来源，必须区分：
        //  ① **我们自己**的残留 —— 页面 reload / HMR 会销毁 JS 上下文但**不会**调
        //     dispose()，而 OS 热键注册是**进程级**的，于是旧注册还在。此时
        //     unregister 会成功，重注册即可自愈。
        //  ② 别的进程占着 —— unregister 对**不属于本进程**的注册会失败。
        //     这里再分两种，因为它们对用户的含义完全不同：
        //       · 另一个 GUI 实例 → 多开的正常现象，**无需处理**（界面标"已让位"，不标红）
        //       · 其它软件（微信/QQ/输入法）→ 用户**需要换键**
        //       OS 只给一句 "already registered"，不区分这两者 → 自己数实例数来判断。
        let recovered = false;
        try {
          await mod.unregister(w.accelerator);
          await mod.register(w.accelerator, onFire);
          live.set(w.accelerator, w.id);
          recovered = true;
        } catch {
          /* ① 不成立 → 是 ②，保持失败 */
        }
        if (recovered) {
          results.set(w.id, { ok: true, state: "ok" });
        } else {
          if (siblings === 0) siblings = await siblingInstanceCount();
          results.set(w.id, {
            ok: false, error: msg, state: "taken",
            takenBy: classifyTakenBy(siblings),
          });
        }
      }
    }

    status = want.map((w) => {
      const r = results.get(w.id);
      return {
        ...w,
        registered: r?.ok ?? false,
        state: r?.state ?? ("taken" as HotkeyState),
        ...(r?.takenBy ? { takenBy: r.takenBy } : {}),
        ...(r?.error ? { error: r.error } : {}),
      };
    });
    publish();
  };

  _retry = () => void reconcile();
  void reconcile();

  // 设置变化（改键 / 解绑）与插件重扫（装/卸带热键的插件）都要重算。
  // 用动态 import：本模块在启动早期被引用，静态引入 windowBus/events 会拉进
  // 一整条依赖链（与项目里其它 service 的惯例一致）。
  const unsubs: Array<() => void> = [];
  void (async () => {
    const { windowBus } = await import("./windowBus");
    const { Events } = await import("./events");
    unsubs.push(windowBus.on(Events.SETTINGS_CHANGED, () => void reconcile()));
    // 插件注册表变化 —— 新装/卸载带热键的插件后要立即反映
    unsubs.push(windowBus.on(Events.PANEL_REGISTRY_CHANGED, () => void reconcile()));
  })();

  return {
    getStatus: () => [...status],
    retry: () => void reconcile(),
    dispose() {
      disposed = true;
      for (const un of unsubs) un();
      unsubs.length = 0;
      setStatus([]);
      void import("@tauri-apps/plugin-global-shortcut")
        .then((m) => {
          for (const accel of live.keys()) void m.unregister(accel).catch(() => {});
          live.clear();
        })
        .catch(() => {});
    },
  };
}
