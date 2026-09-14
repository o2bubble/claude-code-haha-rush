// ── 切会话中断确认 ──
//
// 后端 handleResumeSession/handleNewSession 会在切换时 interruptCurrentTurn()，
// 打断正在跑的回合（token 已烧掉的部分不可恢复）。前端这里只做 UX 拦一层：
// 后端忙（isBackendBusy，权威信号）且目标是**别的**会话时，先弹确认框；
// 取消则什么都不做，确认才真正 switch。
//
// 纯函数便于单测：组件只负责弹框和调用动作。

/** 后端忙且目标是另一会话 → 需要弹窗确认。busy 用 isBackendBusy 的判定结果传入。 */
export function shouldConfirmSwitch(
  state: { backendBusy: boolean | undefined },
  currentSessionId: string | null | undefined,
  targetSessionId: string,
): boolean {
  if (state.backendBusy !== true) return false;
  if (!currentSessionId) return false;
  return currentSessionId !== targetSessionId;
}

export interface SwitchDialogActions {
  /** 关闭弹窗（两种情况都要关）。 */
  dismiss: boolean;
  /** 是否执行 switchSession(target)。 */
  switchToTarget: boolean;
}

export function switchDialogActions(confirmed: boolean): SwitchDialogActions {
  return { dismiss: true, switchToTarget: confirmed };
}
