// ── Which API hosts actually implement Anthropic's server-side web_search? ──
//
// ## History (2026-10-30 用户反馈)
//
// 原来这里是一个粗暴的 `isRelayProvider()`：只要 `ANTHROPIC_BASE_URL` 的 host
// 不是 `*.anthropic.com` 就判定为"中转"，**一次都不试**服务端工具，直接走本地
// DuckDuckGo/Bing。这在"所有中转都不支持"的年代是安全的优化，但把能用的实现
// 一起牺牲掉了 —— DeepSeek 的 Anthropic 兼容端点**完整实现了**
// `web_search_20250305`（实测返回真实结果），我们却从来没试过。
//
// ## 现在的策略
//
// **总是先试服务端**，只把「已被证明做不到」的 host 记下来，之后才直连本地：
//
//   · 4xx 明确拒绝（报文里提到 tool / web_search）  → 立即记为不支持
//   · 连续 N 次 200 却一次搜索都没发生              → 记为不支持
//
// 为什么不"失败一次就记"：`200 但没搜索` 也可能只是模型这次选择直接回答，
// 连记两次才判定，避免一次模型自由发挥就把一个能用的 host 永久降级。
//
// 记忆是**进程内**的（模块级状态）。一个会话（CLI 的 TUI / GUI 的 `--ide-mode`
// 后端）通常活几小时到一整天，最多白跑 N 次，之后就稳定走本地。
// 不落盘：下次启动重新探测 —— 中转商补了功能应该自动生效，不该被旧结论钉死。

/** 连续多少次「200 但没搜索」才判定该 host 不支持服务端搜索。 */
export const SILENT_MISS_LIMIT = 2

/** 已被证明不支持服务端搜索的 host（进程内）。 */
const unsupportedHosts = new Set<string>()

/** host → 连续「200 但没搜索」的次数。 */
const silentMisses = new Map<string, number>()

/** 当前 `ANTHROPIC_BASE_URL` 的 host；未配置或不可解析时返回 null。
 *
 *  null 表示"走官方/未知端点" —— 永远不去记忆它（不能因为一次失败就把
 *  官方端点降级）。 */
export function baseUrlHost(): string | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).hostname || null
  } catch {
    return null
  }
}

/** 这个 host 是否已被证明不支持服务端搜索（应在发起任何请求前先问）。 */
export function isKnownUnsupported(host: string | null): boolean {
  return host !== null && unsupportedHosts.has(host)
}

/** 4xx 是否是「不认识这个工具」的拒绝。
 *
 *  只认 400 / 422 / 501，且报文必须提到 tool 或 web_search —— 一个与工具无关
 *  的 400（上下文超长、参数非法）绝不能拿来永久禁用服务端搜索。 */
export function isToolRejectionError(
  error: unknown,
): error is { status: number; message?: string } {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  if (status !== 400 && status !== 422 && status !== 501) return false
  const msg = String((error as { message?: unknown }).message ?? '').toLowerCase()
  return msg.includes('web_search') || msg.includes('tool')
}

/** 服务端真跑了一次搜索 → 清掉该 host 的连续未命中计数。 */
export function noteSearchSucceeded(host: string | null): void {
  if (host) silentMisses.delete(host)
}

/** 一次 200 但**没有任何搜索发生**（模型直接答了，或 provider 编了段假文本）。
 *
 *  连续到阈值 → 判定该 host 不支持，后续直接走本地。 */
export function noteNoSearchPerformed(host: string | null): void {
  if (!host) return
  const n = (silentMisses.get(host) ?? 0) + 1
  if (n >= SILENT_MISS_LIMIT) {
    unsupportedHosts.add(host)
    silentMisses.delete(host)
  } else {
    silentMisses.set(host, n)
  }
}

/** 请求被明确拒绝（4xx 提到工具）→ 立即判定不支持。 */
export function noteToolRejected(host: string | null): void {
  if (host) unsupportedHosts.add(host)
}

/** 仅供测试：清空进程内记忆。 */
export function _resetServerSearchSupportForTests(): void {
  unsupportedHosts.clear()
  silentMisses.clear()
}

/** 仅供测试：查看某 host 是否在名单里。 */
export function _isMarkedUnsupportedForTests(host: string): boolean {
  return unsupportedHosts.has(host)
}
