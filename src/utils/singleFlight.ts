/**
 * 单飞（single-flight）：同一时刻只允许一个任务在跑，期间的重复调用**复用**同一个
 * Promise（而不是排队再跑一次）。
 *
 * 用途：**可能被并发触发、但重复执行没有意义**的后台刷新类操作。典型场景是会话
 * 切换时的 MCP 刷新 —— 用户快速连切几次会话会连着触发多次，而每次刷新都要遍历
 * 连接所有 MCP server；并发跑不仅浪费，还可能因为"读快照 → 追加"的写法把同一批
 * 工具重复并进列表。
 *
 * 语义：
 *   · 任务进行中 → 后来者拿到同一个 Promise（不会启动第二个任务）
 *   · 任务结束后 → 标记清空，下次调用重新执行（**不是**永久缓存结果）
 *   · 任务抛错 → 错误原样传给这次的所有调用方，并清空标记（后续可重试）
 *
 * 与 memoize 的区别：memoize 缓存**结果**（同参数不再执行）；本函数只合并
 * **进行中**的调用，完成后不保留任何状态。
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (inFlight) return inFlight
    const p = run().finally(() => {
      // 比对身份再清：极端情况下（任务同步 reject 后又有人立刻发起）避免误清新任务的标记
      if (inFlight === p) inFlight = null
    })
    inFlight = p
    return p
  }
}
