// ── 已安装插件的自动更新 ──
//
// 用户诉求（2026-10-29）：「很多人可能都忘记更新插件，一直是很老的版本，
// 干脆弄个自动更新的功能，默认勾选」。
//
// ## 只更新「官方 + 非 AI 指导类」
//
// 三条**同时**满足才动：
//   ① 市场上有更新的版本（版本号比较，见 isPluginUpdateAvailable）
//   ② **官方签名验证通过** —— 这是"官方"的唯一可信判据。
//      不能看 `author` 字段：那是发布者自己填的字符串，谁都能写「官方」。
//      自动下载并执行代码这件事，绝不能建立在自述之上。
//   ③ `installType !== "ai-guided"` —— AI 指导类没有运行时，它的"安装"是
//      AI 按文档一步步配出来的状态；自动覆盖会冲掉已经调好的东西，
//      而且没有可回滚的运行时。
//
// ## 为什么默认开
//
// 绝大多数人不会主动去升级插件。默认关掉，等于这个功能不存在。
// 风险由「②官方签名」兜住 —— 只自动装我们自己发布并签名过的包。
//
// ## 并发
//
// 多实例是核心用法（常常同时开好几个）。多个实例同时跑自动更新会**写同一个
// 临时目录**（`install_plugin_package` 按包名建 `.tmp_plugin_<name>`，没有
// 进程间互斥），有把插件目录写坏的风险。所以用**锁文件**做跨进程互斥：
// `create_new` 是原子的，抢到才干活；抢不到说明别的实例在更新，本次跳过。

import { t } from "../i18n";
import { addStatusMessage } from "../stores/statusMsgStore";
import { getSettings } from "../stores/settingsStore";
import {
  getGuiPlatform,
  getInstalledPluginEntries,
  isPluginUpdateAvailable,
  parsePluginManifest,
  pluginSupportsPlatform,
  reloadPlugins,
  type GuiPlatform,
  type PluginInstallType,
} from "./pluginRegistry";
import { skillMarketplace, type PackageSummary } from "./skillMarketplace";

/** 本实例每会话只跑一次。 */
let _ranThisSession = false;
/** 正在跑（防重入）。 */
let _running = false;

/** 参与判定的已装插件信息（纯数据，便于单测）。 */
export interface InstalledPluginInfo {
  /** plugin.json 的 pluginName —— 同时是市场 slug 与目录名 */
  name: string;
  version: string;
  installType: PluginInstallType;
  platforms: string[];
}

export interface UpdateCandidate {
  slug: string;
  fromVersion: string;
  toVersion: string;
}

/** pickUpdateCandidates 需要的最小市场字段集。 */
export interface MarketEntry {
  slug: string;
  version: string;
  installType?: PluginInstallType;
}

/**
 * 纯函数：算出**候选更新列表**（不含签名校验 —— 那一步需要异步调 Rust）。
 *
 * 只做内存里能判断的部分：非 ai-guided / 平台支持 / 市场有该包 / 版本更新。
 * 官方签名由调用方逐个校验后再安装。
 *
 * 保持纯函数：单测直接喂数据，不必碰磁盘与网络。
 */
export function pickUpdateCandidates(
  installed: InstalledPluginInfo[],
  market: MarketEntry[],
  platform: GuiPlatform,
): UpdateCandidate[] {
  const marketBySlug = new Map(market.map((p) => [p.slug, p]));
  const out: UpdateCandidate[] = [];

  for (const inst of installed) {
    // ③ AI 指导类：永不自动更新
    if (inst.installType === "ai-guided") continue;
    // 本机平台不支持的：不更新（装了也跑不起来）
    if (!pluginSupportsPlatform(inst.platforms, platform)) continue;

    const m = marketBySlug.get(inst.name);
    if (!m) continue;
    // 市场侧标了 ai-guided 的也跳过 —— 本地 manifest 可能还是旧的（例如它刚
    // 从 standard 改成 ai-guided），以市场为准更安全。
    if (m.installType === "ai-guided") continue;
    // ① 版本
    if (!isPluginUpdateAvailable(inst.version, m.version)) continue;

    out.push({ slug: inst.name, fromVersion: inst.version, toVersion: m.version });
  }
  return out;
}

/**
 * 官方签名验证。
 *
 * 只走零下载路径（服务端下发的 `sha256 + signature` 元数据 →
 * `verify_plugin_digest`）。**缺元数据就直接判不官方**，不回退到"下载 zip 再验"：
 *  · 自动更新是后台静默跑的，为每个候选多下一份包不值当；
 *  · 元数据缺失说明对面服务端版本老，这条信任链本身就不完整 —— 保守跳过。
 * 用户在插件市场里手动更新不受影响（那条路径有完整回退 + 人工确认）。
 */
async function verifyOfficial(sig: PackageSummary["signature"] | undefined): Promise<boolean> {
  if (!sig?.signed || !sig.sha256 || !sig.signature) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const r = await invoke<{ trusted: boolean }>("verify_plugin_digest", {
      digestHex: sig.sha256,
      signatureB64: sig.signature,
    });
    return !!r?.trusted;
  } catch {
    return false;
  }
}

// ── 跨实例锁 ──

const LOCK_FILE = ".plugin-autoupdate.lock";
/** 锁的过期时间：持有者崩溃不会永久卡住后续实例。 */
const LOCK_STALE_MS = 10 * 60 * 1000;

async function acquireLock(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("plugin_autoupdate_lock", {
      file: LOCK_FILE,
      staleMs: LOCK_STALE_MS,
    });
  } catch {
    // 命令不可用（非 Tauri 环境）→ 不阻塞功能，按"抢到"处理
    return true;
  }
}

async function releaseLock(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin_autoupdate_unlock", { file: LOCK_FILE });
  } catch {
    /* 忽略：锁有 stale 兜底 */
  }
}

// ── 主流程 ──

/**
 * 启动时调用一次：自动更新已安装的官方插件。
 *
 * 静默执行 —— **只在真的更新了**的时候弹一条状态消息。否则插件行为突然变了，
 * 用户会莫名其妙。没有更新 / 市场不可达就什么都不说。
 */
export async function runAutoUpdatePlugins(): Promise<void> {
  if (_ranThisSession || _running) return;
  if (!(getSettings().autoUpdatePlugins ?? true)) return;

  _ranThisSession = true;
  _running = true;
  try {
    await runInner();
  } catch (e) {
    console.warn("[pluginAutoUpdate] 失败：", e);
  } finally {
    _running = false;
  }
}

/** 仅供测试：重置"本会话已跑过"的标记。 */
export function _resetAutoUpdateStateForTests(): void {
  _ranThisSession = false;
  _running = false;
}

async function runInner(): Promise<void> {
  // 1) 已装插件（读 manifest，坏包自动跳过）
  const entries = await getInstalledPluginEntries();
  if (entries.size === 0) return;

  const installed: InstalledPluginInfo[] = [];
  for (const e of entries.values()) {
    if (!e.manifestJson) continue;
    const parsed = parsePluginManifest(e.manifestJson, e.name);
    if (!parsed.ok) continue;
    const m = parsed.manifest;
    installed.push({
      name: m.pluginName,
      version: m.version,
      installType: m.installType,
      platforms: m.platforms,
    });
  }
  if (installed.length === 0) return;

  // 2) 市场列表（失败安静退出 —— 断网不该在启动路径上报错）
  let market: PackageSummary[];
  try {
    market = await skillMarketplace.listPlugins();
  } catch (e) {
    console.info("[pluginAutoUpdate] 市场不可达，跳过：", e);
    return;
  }
  const plugins = market.filter((p) => !p.type || p.type === "plugin");

  // 3) 候选
  const platform = await getGuiPlatform();
  const candidates = pickUpdateCandidates(installed, plugins, platform);
  if (candidates.length === 0) return;

  // 4) 跨实例互斥
  if (!(await acquireLock())) {
    console.info("[pluginAutoUpdate] 另一个实例正在更新，本次跳过");
    return;
  }

  try {
    const bySlug = new Map(plugins.map((p) => [p.slug, p]));
    const updated: UpdateCandidate[] = [];

    for (const c of candidates) {
      const pkg = bySlug.get(c.slug);
      if (!pkg) continue;

      // ② 官方签名 —— 不通过就绝不自动装
      if (!(await verifyOfficial(pkg.signature))) {
        console.info(`[pluginAutoUpdate] ${c.slug} 签名不可验证，跳过（不自动装非官方包）`);
        continue;
      }

      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("install_plugin_package", {
          zipUrl: skillMarketplace.getPackageDownloadUrl(c.slug),
          packageName: c.slug,
        });
        updated.push(c);
      } catch (e) {
        console.warn(`[pluginAutoUpdate] 更新 ${c.slug} 失败：`, e);
      }
    }

    if (updated.length === 0) return;

    // 5) 重扫插件，让新版本生效
    try {
      await reloadPlugins();
    } catch (e) {
      console.warn("[pluginAutoUpdate] 重扫插件失败：", e);
    }

    // 6) 告知用户
    const list = updated.map((u) => `${u.slug} ${u.fromVersion}→${u.toVersion}`).join("，");
    addStatusMessage(t("pluginAutoUpdate.done", { list }), "success");
    console.info("[pluginAutoUpdate] 已更新：", list);
  } finally {
    await releaseLock();
  }
}
