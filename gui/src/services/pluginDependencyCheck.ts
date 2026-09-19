// ── 插件依赖检查（安装 / 启用前）──
//
// ## 为什么需要
//
// `dependencies` 此前只做两件事：**卸载反查**（有人依赖 → 拒绝卸载）与
// **AI 代装时的存在性校验**。而"依赖能不能**用**"从没检查过 —— 于是有这条假象链：
//
//     nodejs 已装（市场安装只放文档骨架）但 runtime 未下载
//       → 此时装 git-viewer（依赖 nodejs，进程 command: "node"）
//       → 进程起不来
//       → 用户看到「Git 查看器坏了」，而真因是「依赖没装完」
//
// 本模块把"依赖是否可用"变成可查询的事实，供安装/启用流程在**动手之前**提示用户。
//
// ## "就绪"怎么判定
//
// | 依赖类型 | 就绪条件 |
// |---|---|
// | `standard` | 装了即就绪（包自带一切） |
// | `ai-guided` | `aiStatus === "ready"` **或** 其 `runtimes[].path` 目录存在 |
//
// ⚠️ 为什么 ai-guided 要加"**或** runtimes 目录存在"：
// `aiStatus` 是**内存态**（GUI 重启即清空，见 pluginStatusStore 注释）——
// 只看它的话，每次重启后 nodejs 都会被误判成"未就绪"，提示就没意义了。
// 而 runtime 目录存在是**硬证据**（那正是 ai-guided 插件"完成安装"的产物）。

import type { PluginManifest } from "./pluginRegistry";

export interface DependencyCheckResult {
  /** 未安装的依赖（需要先装） */
  missing: string[];
  /** 已安装但**未就绪**（如 ai-guided 插件还没完成环境安装） */
  notReady: Array<{ name: string; reason: string }>;
  /** 全部可用 */
  ok: boolean;
}

/** 从已启用的 manifest 里按 pluginName 找。 */
async function findManifest(name: string): Promise<PluginManifest | undefined> {
  const { getActiveManifests } = await import("./pluginRegistry");
  return getActiveManifests().find((m) => m.pluginName === name);
}

/**
 * 🔹 **纯判定**：给定 manifest 与外部事实，返回"未就绪的原因"（null = 就绪）。
 *
 * 抽成不碰 IO 的纯函数是为了能直接测 —— 取数据（读 aiStatus / 查目录）留给
 * `whyNotReady`。依赖关系判定出错的后果是"误报未就绪"（提示噪音）或
 * "漏报"（用户装了跑不起来的插件），两种情况都该被测试钉住。
 *
 * @param facts.aiStatus          AI 上报的状态（内存态，重启后为 undefined）
 * @param facts.anyRuntimeDirExists 是否**至少有一个**声明的 runtime 目录存在
 */
export function decideDependencyReadiness(
  manifest: { pluginName: string; installType?: string; runtimes?: Array<{ path: string }> },
  facts: { aiStatus?: string; anyRuntimeDirExists: boolean },
): string | null {
  // standard：装了即就绪（包自带一切，没有"后续安装步骤"）
  if (manifest.installType !== "ai-guided") return null;

  // ai-guided：先看 AI 上报的状态（最直接）
  if (facts.aiStatus === "ready") return null;
  if (facts.aiStatus === "error") return "环境安装失败（可在插件设置里让 AI 重试）";

  // not_ready / undefined（GUI 重启后清空）→ 用**硬证据**判断：
  // 声明的 runtime 目录是否存在（那正是 ai-guided 插件"装好了"的产物）。
  // ⚠️ 必须有这层兜底 —— 否则每次重启后 nodejs 都会被误判成未就绪。
  if ((manifest.runtimes?.length ?? 0) > 0) {
    return facts.anyRuntimeDirExists ? null : "尚未完成环境安装（缺运行时，需让 AI 按插件文档安装）";
  }

  // ai-guided 且没有 runtimes 声明（如 playwright-mcp 这类"纯配置型"）：
  // 只能依赖 aiStatus —— 而它此刻不是 ready
  return "尚未完成环境安装（需让 AI 按插件文档配置）";
}

/** 取外部事实，然后调纯判定。 */
async function whyNotReady(manifest: PluginManifest): Promise<string | null> {
  if (manifest.installType !== "ai-guided") return null;   // 早退：不碰 IO

  const { getPluginAiStatus } = await import("./pluginStatusStore");
  const aiStatus = getPluginAiStatus(manifest.pluginName)?.status;

  // 只在"需要硬证据"时才去查目录（aiStatus 明确时省一次 IO）
  let anyRuntimeDirExists = false;
  const rts = manifest.runtimes ?? [];
  if (aiStatus !== "ready" && aiStatus !== "error" && rts.length > 0) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const base = await invoke<string>("get_plugins_base_dir");
      const baseClean = String(base).replace(/[\\/]+$/, "");
      for (const rt of rts) {
        const abs = `${baseClean}/${manifest.pluginName}/${rt.path}`.replace(/\\/g, "/");
        if (await invoke<boolean>("path_exists", { path: abs }).catch(() => false)) {
          anyRuntimeDirExists = true;
          break;
        }
      }
    } catch { /* 查不到就按"不存在" —— 宁可提示也不静默放过 */ }
  }

  return decideDependencyReadiness(manifest, { aiStatus, anyRuntimeDirExists });
}

/**
 * 检查一组依赖是否可用。
 *
 * @param deps          依赖的 pluginName 列表（manifest.dependencies）
 * @param opts.includeDisabled  已装但**被禁用**是否算问题（默认算 —— 禁用等于不可用）
 */
export async function checkPluginDependencies(
  deps: string[],
  opts: { includeDisabled?: boolean } = {},
): Promise<DependencyCheckResult> {
  const wantDisabledCheck = opts.includeDisabled !== false;
  if (!deps.length) return { missing: [], notReady: [], ok: true };

  const { getInstalledPluginEntries } = await import("./pluginRegistry");
  const installed = await getInstalledPluginEntries();

  let disabled = new Set<string>();
  if (wantDisabledCheck) {
    try {
      const { getSettings } = await import("../stores/settingsStore");
      disabled = new Set(getSettings().disabledPlugins ?? []);
    } catch { /* 读不到设置就按"没禁用"处理（宁可少报也别误报） */ }
  }

  const missing: string[] = [];
  const notReady: Array<{ name: string; reason: string }> = [];

  for (const dep of deps) {
    if (dep === "" || typeof dep !== "string") continue;
    if (!installed.has(dep)) {
      missing.push(dep);
      continue;
    }
    if (disabled.has(dep)) {
      notReady.push({ name: dep, reason: "已被禁用（依赖需要处于启用状态）" });
      continue;
    }
    const m = await findManifest(dep);
    if (!m) continue;   // 装了但没进 manifest 列表（如刚装上还没重扫）→ 不误报
    const why = await whyNotReady(m);
    if (why) notReady.push({ name: dep, reason: why });
  }

  return { missing, notReady, ok: missing.length === 0 && notReady.length === 0 };
}

/** 把检查结果拼成一句给用户看的话（空 = 无问题）。 */
export function describeDependencyIssues(r: DependencyCheckResult): string {
  const parts: string[] = [];
  if (r.missing.length) parts.push(`未安装：${r.missing.join("、")}`);
  if (r.notReady.length) {
    parts.push(r.notReady.map((x) => `${x.name}（${x.reason}）`).join("；"));
  }
  return parts.join("\n");
}
