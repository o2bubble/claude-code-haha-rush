// ── 技能更新状态（跨标签共享）──
//
// 技能面板有两个标签页：
//   · 「已安装」—— 本机技能列表
//   · 「市场」  —— 线上技能包
//
// 两个页面都要显示「可更新」提示，但**不该各算一遍哈希**（那很贵：
// ppt-master 一个技能就上万个文件）。所以把结果放这里共享。
//
// 数据流：
//   ① 拉线上 /api/packages（带 skill_hashes + hash_exclude）
//   ② 只对"线上有哈希、本地也确实装了"的技能算本地哈希
//   ③ 两边比对 → {技能名: "outdated" | "up-to-date" | "unknown"}

import { skillUpdateState, type SkillUpdateState } from "../utils/skillUpdate";
import { skillMarketplace, type PackageSummary } from "../services/skillMarketplace";

/** 技能名 → 更新状态（只有"线上市场里有"的技能才会出现在这里） */
let states: Record<string, SkillUpdateState> = {};
/** 最近一次拉到的市场包列表（两个标签页共用，避免各拉一遍） */
let packages: PackageSummary[] = [];
let lastComputed = 0;
let loading = false;
let error = "";
/** 进行中的请求（并发调用复用同一个） */
let inflight: Promise<void> | null = null;

const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** 从包列表里收集要算哈希的技能名与排除目录 */
function collectWanted(pkgs: PackageSummary[]) {
  const wanted = new Set<string>();
  const excludes = new Set<string>();
  for (const p of pkgs) {
    for (const name of Object.keys(p.skill_hashes ?? {})) wanted.add(name);
    for (const d of p.hash_exclude ?? []) excludes.add(d);
  }
  return { wanted, excludes };
}

/**
 * 算本地哈希。
 *
 * 返回 `null` 表示**计算失败**（与"没有任何技能"区分开）——
 * 失败时叫方应保留旧状态，而不是把空对象当成"全都没装"。
 * （踩过：返回 {} 会让所有已装技能显示成 "not-installed"，比"无法判断"更误导。）
 */
async function computeLocal(pkgs: PackageSummary[]): Promise<Record<string, string> | null> {
  const { wanted, excludes } = collectWanted(pkgs);
  if (!wanted.size) return {};
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (
      (await invoke<Record<string, string>>("local_skill_hashes", {
        skills: Array.from(wanted),
        exclude: Array.from(excludes),
      })) ?? {}
    );
  } catch {
    return null;
  }
}

/**
 * 拉线上市场包列表 + 算本地哈希 + 广播更新状态。
 *
 * 抽到 store 的原因（2026-10-26 用户反馈）：
 *   「首次进入技能面板时，无论是否切到线上库页签，都应该请求一次并展示更新信息」
 * 之前 `fetchPackages` 在 `MarketplaceTab` 组件内部，而面板默认停在「已安装」页，
 * 那个组件压根没挂载 → 不切过去就永远不知道有没有更新。
 */
async function load(): Promise<void> {
  if (inflight) return inflight;
  loading = true;
  error = "";
  emit();

  inflight = (async () => {
    try {
      const list = await skillMarketplace.listPackages();
      const local = await computeLocal(list);
      if (local === null) {
        // 本地哈希算失败 → 保留旧的更新状态（别用空对象覆盖成"全都没装"）
        packages = list;
        emit();
      } else {
        skillUpdateStore.recompute(list, local);
      }
    } catch (e: any) {
      error = e?.message ?? "Unknown error";
      emit();
    } finally {
      loading = false;
      inflight = null;
      emit();
    }
  })();

  return inflight;
}

export const skillUpdateStore = {
  get(): Record<string, SkillUpdateState> {
    return states;
  },

  /** 最近一次拉到的市场包列表（市场标签页直接用，不必自己再拉） */
  getPackages(): PackageSummary[] {
    return packages;
  },

  isLoading(): boolean {
    return loading;
  },

  getError(): string {
    return error;
  },

  /** 拉线上数据并算更新状态（并发调用复用同一个请求） */
  load,

  /**
   * 安装/更新完成后重算 —— **不重新拉线上列表**，只重算本地哈希。
   *
   * 用户反馈「更新后徽标还在」：之前装完只调了 `refreshInstalled()`
   * 刷新目录列表，`states` 还是旧的，所以徽标不会消失。
   */
  async refreshLocal(): Promise<void> {
    if (!packages.length) return;
    const local = await computeLocal(packages);
    if (local === null) return; // 算失败 → 保留旧状态
    this.recompute(packages, local);
  },

  /** 上一次计算的时间戳（ms），0 = 从未算过 */
  getLastComputed(): number {
    return lastComputed;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * 用线上包列表 + 本地哈希，重算所有技能的更新状态。
   *
   * @param pkgs   线上包列表（含 skill_hashes / hash_exclude）
   * @param local  本地技能哈希（`local_skill_hashes` 命令的返回）
   */
  recompute(pkgs: PackageSummary[], local: Record<string, string>) {
    packages = pkgs;
    const next: Record<string, SkillUpdateState> = {};
    for (const p of pkgs) {
      const remote = p.skill_hashes;
      if (!remote) continue;
      for (const [name, remoteHash] of Object.entries(remote)) {
        // 同一技能可能出现在多个包里（极少），只要有一处过期就算过期
        const s = skillUpdateState(local[name], remoteHash);
        if (!(name in next) || s === "outdated") next[name] = s;
      }
    }
    states = next;
    lastComputed = Date.now();
    emit();
  },

  /** 测试/重置用 */
  reset() {
    states = {};
    packages = [];
    lastComputed = 0;
    loading = false;
    error = "";
    inflight = null;
    emit();
  },
};
