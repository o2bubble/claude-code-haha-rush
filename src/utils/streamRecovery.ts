/**
 * 流看门狗「正在自救」的通知通道。
 *
 * ## 为什么需要
 *
 * 看门狗触发后（首字节前 300s / 流中途 120s 无数据），引擎会 abort 并改走
 * 非流式重试 —— 这是好事。但界面上**什么都看不到**：后端既没有流事件、
 * 心跳也还在照常发，前端只知道"没内容"。
 *
 * 用户看到的就是"卡死了"，而实际上系统已经在自救了。
 *
 * ## 为什么用模块级 setter 而不是逐层传回调
 *
 * 触发点在 `services/api/claude.ts`，接收方在 `entrypoints/ideMode.ts`，
 * 中间隔着 `QueryEngine` / `query.ts`。逐层透传要改 4 个文件的签名，而且
 * 回调发生在 async generator 内部 —— 没法直接 yield 出去，只能等下一次
 * 迭代，通知会被推迟到重试出结果之后（正好失去意义）。
 *
 * 模块级 setter 能**立即**触发，且与 `utils/file.ts` 的 `setOnFileWritten`
 * 是同一套写法，不引入新机制。
 */

export type StreamRecoveryInfo = {
  /** `midstream-idle` = 已经收到过数据后静默；`no-first-chunk` = 一直没等到首块 */
  reason: 'midstream-idle' | 'no-first-chunk'
  /** 静默了多久才判定超时 */
  waitedMs: number
}

let handler: ((info: StreamRecoveryInfo) => void) | null = null

/** 注册通知接收方（ideMode 用它广播给 GUI）。传 null 取消。 */
export function setOnStreamRecovering(
  fn: ((info: StreamRecoveryInfo) => void) | null,
): void {
  handler = fn
}

/** 看门狗触发、准备改走非流式重试时调用。 */
export function notifyStreamRecovering(info: StreamRecoveryInfo): void {
  // 也记一行 stderr：GUI 只把 stderr 常驻写进 claude-code-gui.log，
  // 排查时能直接看到"这次超时是看门狗救回来的，不是用户中断"。
  // 只在真正触发超时时打（每次恢复一条，不是噪声）。
  console.error(
    `[stream] recovering: ${info.reason}, waited ${Math.round(info.waitedMs / 1000)}s` +
      (handler ? '' : ' (no GUI attached)'),
  )
  handler?.(info)
}
