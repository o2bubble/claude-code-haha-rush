// ── Which API hosts actually implement deferred tool loading? ──
//
// ## History (2026-11-02, 2.1.316 逆向对比)
//
// 原来 `isToolSearchEnabledOptimistic()` 里有一段硬判断：只要
// `ANTHROPIC_BASE_URL` 不是官方 host，就**一次都不试**，直接把 tool search 关掉，
// 所有 MCP 工具全部内联进每次请求。依据是上游 issue（gh-30912/31936）里
// "某些中转会拒 tool_reference"。
//
// 这和当年被删掉的 `isRelayProvider()`（WebSearch）是**同一类错误**：按 host 猜
// 能力。实测（DeepSeek `api.deepseek.com/anthropic`）：
//
//   · `defer_loading: true` 的工具定义      → 200
//   · `tool_reference` 内容块（工具已声明） → 200
//   · 带不带 `advanced-tool-use` beta 头     → 都 200
//
// 也就是说它完全支持，却被预判永久关掉了 —— 每次请求白白多带几十个工具定义。
//
// ## 现在的策略（与 serverSearchSupport.ts 一致）
//
// **总是先试**，只把「已被明确拒绝」的 host 记下来，之后才退回内联：
//
//   · 4xx（400/422/501）且报文提到 tool_reference / defer_loading / tool search
//     → 记为不支持，本次请求**重试一次**（下一次就不会再发这些字段）
//
// 记忆是**进程内**的：中转商补了能力，下次启动自动重新探测。

/** 已被证明不支持延迟工具加载的 host（进程内）。 */
const unsupportedHosts = new Set<string>()

/** 当前 `ANTHROPIC_BASE_URL` 的 host；未配置/不可解析 → null。
 *
 *  null 表示"官方或未知端点" —— 永远不去记忆它（不能因为一次失败就把官方降级）。 */
export function toolSearchBaseUrlHost(): string | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).hostname || null
  } catch {
    return null
  }
}

/** 这个 host 是否已被证明不支持延迟工具加载。 */
export function isToolSearchUnsupported(host: string | null): boolean {
  return host !== null && unsupportedHosts.has(host)
}

/** 4xx 是否是「不认识延迟工具机制」的拒绝。
 *
 *  只认 400 / 422 / 501，并且报文必须点到延迟加载相关的字样 —— 与它无关的
 *  400（上下文超长、参数非法）绝不能拿来永久关掉 tool search。
 *
 *  ⚠️ 返回 `boolean` 而不是类型谓词：调用方的 `error` 已经是 `APIError`，
 *  谓词会把类型收窄成 `APIError & {status:number}`，与 `APIError` 里
 *  `status?: number` 冲突 → 收窄成 `never`，后面整段全报错。 */
export function isToolSearchRejectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  if (status !== 400 && status !== 422 && status !== 501) return false
  const msg = String((error as { message?: unknown }).message ?? '').toLowerCase()
  return (
    // ⚠️ 两种写法都要认：Anthropic 用下划线（tool_reference），而中转的报错
    // 常写成自然语言 —— DeepSeek 实测是 "tool reference 'X' not found in
    // available tools"（空格）。只认下划线会漏掉它，host 记不上，每次请求都重撞。
    msg.includes('tool_reference') ||
    msg.includes('tool reference') ||
    msg.includes('defer_loading') ||
    msg.includes('defer loading') ||
    msg.includes('tool search') ||
    msg.includes('tool_search') ||
    msg.includes('advanced-tool-use')
  )
}

/** 请求被明确拒绝 → 记为不支持，后续请求退回内联模式。 */
export function noteToolSearchRejected(host: string | null): void {
  if (host) unsupportedHosts.add(host)
}

/** 仅供测试：清空进程内记忆。 */
export function _resetToolSearchSupportForTests(): void {
  unsupportedHosts.clear()
}

/** 仅供测试：查看某 host 是否在名单里。 */
export function _isToolSearchMarkedUnsupportedForTests(host: string): boolean {
  return unsupportedHosts.has(host)
}
