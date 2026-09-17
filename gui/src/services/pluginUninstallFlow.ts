// ── 卸载后的收尾提示（"需要重启" / "清理未完全"）──
//
// 抽成共用函数的原因：卸载有三个入口（市场面板、详情面板、AI 代卸），
// 而**重启提示必须都存在**（否则用户从某条路径卸载就得不到提示）。
//
// 设计要点：
//   · **只有插件声明 `needsRestart` 才提示** —— 大多数插件（清设置、删目录）不需要
//     重启，每次卸载都弹"请重启"会很烦，也会让用户对提示脱敏。
//   · hook 没跑成时**如实告知但不阻断** —— 卸载已经成功了，只是清理可能不完整；
//     瞒着用户更糟（他会以为清干净了）。
//   · 重启要用户**明确同意**（confirm）—— 重启会中断当前 AI 会话，不能替他决定。

import type { UninstallResult } from "./pluginRegistry";
import type { StatusMessage } from "../stores/statusMsgStore";

/**
 * 处理卸载结果：弹必要的提示，用户同意则重启。
 * @param result  `uninstallPlugin` 的返回值
 * @param i18nT   翻译函数（调用方传入，避免本模块依赖 i18n 上下文）
 */
export async function handleUninstallResult(
  result: UninstallResult,
  i18nT: (key: string, params?: Record<string, string | number>) => string,
  addStatusMessage: (text: string, level?: StatusMessage["level"]) => void,
): Promise<void> {
  // ① hook 没跑成：如实告知，但**不阻断**（卸载已经成功了）
  if (result.hookWarning) {
    addStatusMessage(
      i18nT("pluginMarket.uninstallHookWarning", { reason: result.hookWarning }),
      "warn",
    );
  }

  // ② 插件声明了"需要重启" → 问用户（他可以拒绝，那就下次自己重启）
  if (!result.needsRestart) return;
  const go = confirm(i18nT("pluginMarket.uninstallNeedsRestart"));
  if (!go) {
    addStatusMessage(i18nT("pluginMarket.uninstallRestartLater"), "info");
    return;
  }
  // 重启 = spawn 新实例 + 退出当前进程（与 AI 用的 app_relaunch 同一个命令）
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("app_relaunch");
  } catch (e) {
    // 重启失败不该让用户以为"卸载失败" —— 卸载早已完成
    addStatusMessage(`${i18nT("pluginMarket.uninstallRestartFailed")}: ${e}`, "error");
  }
}
