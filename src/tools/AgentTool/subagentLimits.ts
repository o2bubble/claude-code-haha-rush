/**
 * 子代理启动限额 —— 对齐官方 2.1.316 的两个环境变量：
 *   `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`  同时在跑的上限
 *   `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`  嵌套层数上限
 *
 * 为什么是"保护"而不是"节流"：一次并行几十个 agent 会瞬间烧掉大量 token，
 * 而用户往往并没有要求那个规模。超限直接拒绝（官方措辞带 "Do not retry"），
 * 让模型改用更小的批量，而不是反复重试撞墙。
 *
 * 抽成纯函数便于单测 —— 边界判断错了，要么误杀正常用法，要么形同虚设。
 */

/** 读一个正整数环境变量；未设 / 非法 / ≤0 一律当"不限制"（返回 0）。 */
export function readLimitEnv(raw: string | undefined): number {
  if (!raw) return 0
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export type LimitCheck = { ok: true } | { ok: false; message: string }

/** 并发上限检查。`max === 0` 表示不限制。 */
export function checkConcurrentLimit(
  runningCount: number,
  max: number,
): LimitCheck {
  if (max <= 0 || runningCount < max) return { ok: true }
  return {
    ok: false,
    message:
      `Concurrent subagent limit reached. You can run ${max} subagents at once. ` +
      `Do not retry. If the user wants more concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.`,
  }
}

/** 嵌套深度检查。`depth` 是**请求方**当前深度（顶层为 0）。 */
export function checkDepthLimit(depth: number, max: number): LimitCheck {
  if (max <= 0 || depth < max) return { ok: true }
  return {
    ok: false,
    message:
      `Subagent nesting limit reached (depth ${depth} of ${max}). ` +
      `Complete this task directly using your tools instead of spawning another agent. ` +
      `If the user explicitly requested deeper nesting, ask them to raise CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH.`,
  }
}
