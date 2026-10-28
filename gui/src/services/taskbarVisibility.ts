// ── 隐藏任务栏图标：把设置真正下发到窗口 ──
//
// 设置项 `hideTaskbarIcon`（设置 → 高级）。它有两个来源要处理：
//
// 1. **本实例的开关**（SettingsPanel 点击）—— 立即生效
// 2. **其他实例的改动**：设置存全局文件，A 改了之后 server 广播
//    `DbChanged{entity:"settings"}` → B/C 调 reloadSettings() → 事件
//    SETTINGS_CHANGED 到达本实例。**以前这里没人接管**，所以 B/C 的窗口
//    仍带着任务栏图标，用户以为"开关没生效 / 又跑回来了"
//    （2026-10-28 用户反馈，他自己猜到"是不是没下发给所有实例"）。
//
// 去重很重要：SETTINGS_CHANGED 是 sticky 且触发频繁（任何设置变化都会发），
// 每次 IPC 都会让 Rust 侧检查/改样式，白费且可能闪烁。

import { invoke } from "@tauri-apps/api/core";

/**
 * 上一次真正下发给 Rust 的值。
 *
 * `undefined` = 还没下发过。首次同步**一定要发**：Rust 侧启动时按设置建窗，
 * 但若前端启动早期设置尚未加载完，这里发一次能纠正。
 * 且 Rust 侧只在样式真的不符时才动手（见 apply_taskbar_visibility），
 * 所以多发的代价是零。
 */
let applied: boolean | undefined;

/**
 * 请求让窗口的任务栏图标与 `hidden` 一致。
 *
 * 幂等 + 去重：值没变就完全不发 IPC。Rust 侧再兜一层"样式已正确就不碰窗口"，
 * 所以重复调用安全（不会闪）。
 */
export async function applyTaskbarVisibility(hidden: boolean): Promise<void> {
  if (applied === hidden) return;
  applied = hidden;
  try {
    await invoke("set_main_window_taskbar", { hidden });
  } catch {
    // 失败就回滚去重状态，让下次同步能重试（比如窗口还没建好）
    if (applied === hidden) applied = undefined;
  }
}

/** 从设置对象同步（`undefined` 视为关，与 Rust 侧缺省一致）。 */
export function syncTaskbarFromSettings(hideTaskbarIcon: boolean | undefined): void {
  void applyTaskbarVisibility(hideTaskbarIcon ?? false);
}

/** 仅测试用：重置去重状态。 */
export function __resetTaskbarVisibilityCache(): void {
  applied = undefined;
}
