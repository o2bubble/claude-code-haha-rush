// ── Provider 侧的网页抓取（DeepSeek `/v1/tools/fetch`）──
//
// ## 为什么要这个（2026-10-30 用户需求）
//
// `WebFetch` 一直是**纯本地**实现：axios 抓 HTML → turndown 转 markdown →
// 小模型按 prompt 提炼。本地抓取的短板是遇到反爬、需要 JS 渲染、或网络到不了
// 的站点就直接失败。
//
// DeepSeek 在 Anthropic 兼容端点之外还提供原生 `/v1/tools/fetch`，返回干净
// 的 markdown 正文。用户要求：**优先走它，走不通再回退本地**。
//
// ## 与 WebSearch 的差别
//
// 搜索用的是 Anthropic 协议里的服务端工具（`web_search_20250305`），发一次
// messages 请求就带回来了。fetch **不是**协议内工具 —— 它是 DeepSeek 自家的
// REST 接口，得单独发 HTTP 请求。所以这里不走 `queryModelWithStreaming`。
//
// ## 端点推导
//
// `ANTHROPIC_BASE_URL` 形如 `https://api.deepseek.com/anthropic`，
// 去掉 path 取 origin，再拼 `/v1/tools/fetch`。
// 官方端点（`api.anthropic.com`）没有这个接口 → 直接判 failed，走本地。
//
// ## 这个模块不写日志
//
// 刻意不 import `utils/log.ts`：那个模块依赖 `bun:bundle`，把纯判定逻辑绑在
// 一起就没法在普通 node 测试环境里跑。失败原因通过返回值交给调用方记录。

/** 服务端抓取的结果。**永远不抛**（调用方中断除外）。
 *
 *  ⚠️ 判别式用**字符串**而不是布尔：本仓库 tsconfig 没开 `strictNullChecks`，
 *  布尔字面量在那之前会退化成 `boolean`，`if (x.ok)` 就不会窄化——实测报
 *  "Property 'reason' does not exist"。字符串判别式不受此限。 */
export type ServerFetchOutcome =
  | { status: 'ok'; content: string; title: string }
  | { status: 'failed'; reason: string }

/** 单次请求超时。抓取比搜索慢，给宽一点但仍要有上限。 */
const SERVER_FETCH_TIMEOUT_MS = 30_000

/** 正文上限 —— 与本地路径的 MAX_HTTP_CONTENT_LENGTH 同量级，防跑飞。 */
const MAX_CONTENT_CHARS = 10 * 1024 * 1024

/** 已被证明没有 fetch 接口的 host（进程内，同 search 的记法）。 */
const unsupportedHosts = new Set<string>()

/** 仅供测试：清空进程内记忆。 */
export function _resetServerFetchSupportForTests(): void {
  unsupportedHosts.clear()
}

/** 仅供测试：查看某 host 是否在名单里。 */
export function _isMarkedUnsupportedForTests(host: string): boolean {
  return unsupportedHosts.has(host)
}

/** 从 `ANTHROPIC_BASE_URL` 推导 fetch 端点；官方端点或非法配置返回 null。
 *
 *  返回 null 的三种情况都表示"没有可用的服务端 fetch"：
 *   · 没配 base URL（= 官方 Anthropic，没有这个接口）
 *   · base URL 指向 `*.anthropic.com`（同上）
 *   · URL 解析失败 */
export function serverFetchEndpoint(): { url: string; host: string } | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return null
  try {
    const parsed = new URL(baseUrl)
    const host = parsed.hostname
    if (!host || host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
      return null
    }
    return { url: `${parsed.origin}/v1/tools/fetch`, host }
  } catch {
    return null
  }
}

/** 这个 host 是否已被证明没有 fetch 接口。 */
export function isServerFetchKnownUnsupported(host: string | null): boolean {
  return host !== null && unsupportedHosts.has(host)
}

/** 标记该 host 没有 fetch 接口（只该在 405/501 这种"方法未实现"时调用）。 */
export function noteServerFetchUnavailable(host: string | null): void {
  if (host) unsupportedHosts.add(host)
}

/** 取鉴权 token —— 与 API 请求走同一套（Bearer）。
 *
 *  `ANTHROPIC_AUTH_TOKEN` 优先（本项目环境的配置方式），没有再问 apiKeyHelper。
 *  helper 走**动态导入**：它是重型模块（会拉 auth/oauth 一整条链），只有真的
 *  需要时才加载；导入失败也只当"没有 token"，不影响这次抓取回退本地。 */
async function resolveToken(isNonInteractiveSession: boolean): Promise<string | null> {
  const envToken = process.env.ANTHROPIC_AUTH_TOKEN
  if (envToken) return envToken
  try {
    const { getApiKeyFromApiKeyHelper } = await import('../../utils/auth.js')
    return (await getApiKeyFromApiKeyHelper(isNonInteractiveSession)) || null
  } catch {
    return null
  }
}

/** 走 provider 的 fetch 接口抓取 `url`。
 *
 *  **`ok: false` 一律表示"这条路不通，请用本地"**（端点不存在、鉴权缺失、
 *  站点取不到正文等）—— 不抛异常，因为抓取失败不该变成工具报错，
 *  本地还有一次机会。
 *
 *  唯一会抛的情况是调用方主动中断（`signal.aborted`）：那必须原样抛出，
 *  否则用户按 Esc 会被我们偷偷换成一次本地抓取。 */
export async function fetchViaServer(
  url: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<ServerFetchOutcome> {
  const endpoint = serverFetchEndpoint()
  if (!endpoint) return { status: 'failed', reason: 'no-endpoint' }
  if (isServerFetchKnownUnsupported(endpoint.host)) {
    return { status: 'failed', reason: 'host-marked-unsupported' }
  }

  const token = await resolveToken(isNonInteractiveSession)
  if (!token) return { status: 'failed', reason: 'no-token' }

  // 超时与调用方中断任一触发都要停 —— 用 AbortSignal.any 合并
  // （Bun 与 node 18+ 都支持）。
  const combined = AbortSignal.any([signal, AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS)])

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url }),
      signal: combined,
    })

    if (!res.ok) {
      // 只有 405 / 501 能证明**接口本身不存在**（方法未实现）。
      //
      // ⚠️ 404 不能用来判定：DeepSeek 文档写明「页面没有可提取的正文」也返回
      // 404 —— 那是**这个 URL** 的问题，记下来就等于一个坏链接把整个功能关掉。
      if (res.status === 405 || res.status === 501) {
        noteServerFetchUnavailable(endpoint.host)
      }
      return { status: 'failed', reason: `http-${res.status}` }
    }

    const data = (await res.json()) as { content?: unknown; title?: unknown }
    const content = typeof data.content === 'string' ? data.content : ''
    if (!content.trim()) return { status: 'failed', reason: 'empty-content' }

    return {
      status: 'ok',
      content:
        content.length > MAX_CONTENT_CHARS
          ? content.slice(0, MAX_CONTENT_CHARS)
          : content,
      title: typeof data.title === 'string' ? data.title : '',
    }
  } catch (e) {
    // 调用方中断：原样抛出让上层处理，不能悄悄回退
    if (signal.aborted) throw e
    // 超时 / 网络错误 / JSON 解析失败 —— 都只是"这次走不通"
    return { status: 'failed', reason: `error:${(e as Error)?.message ?? e}` }
  }
}
