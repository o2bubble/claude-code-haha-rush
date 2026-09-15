import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { logError } from '../../utils/log.js'

// Local web-search fallback used when the API provider doesn't implement
// Anthropic's server-side `web_search_20250305` tool (common with third-party
// relays/中转). Queries DuckDuckGo HTML first, then Bing — both keyless — so
// customers on networks that can't reach api.anthropic.com still get real hits
// instead of the placeholder shells a relay may fabricate.

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'
const BING_SEARCH_URL = 'https://www.bing.com/search'
const LOCAL_SEARCH_TIMEOUT_MS = 15_000
const MAX_RESULTS = 8
// 每个源最多试 2 次（首次 + 1 次重试）。只重试**暂时性**失败 —— 网络错误与
// 429/5xx；「页面取到了但解析不出结果」不重试，同样的请求重发一遍大概率
// 还是同一个页面。
const MAX_ATTEMPTS_PER_SOURCE = 2
const RETRY_DELAY_MS = 600
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504])

export type LocalSearchHit = { title: string; url: string }

// HTTP 状态失败单独成类：报错时才能给出「返回了 503」而不是笼统的「不可达」，
// 也才谈得上判断该不该重试（429/5xx 是暂时性的，4xx 重试没意义）。
class SearchHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

const cleanText = (s: string): string =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#0183;/g, '·')
    .replace(/&#183;/g, '·')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim()

// DuckDuckGo wraps organic results in a redirect URL — extract the real target
// and decode HTML entities that survive in direct (non-redirect) hrefs.
function decodeDdgHref(href: string): string | null {
  try {
    const u = new URL(href.replace(/&amp;/g, '&'), DDG_HTML_URL)
    const target = u.searchParams.get('uddg')
    return (target ?? u.href).replace(/&amp;/g, '&')
  } catch {
    return null
  }
}

// Each result is a <div class="result ..."> block containing a result__a anchor
// (title + redirect href) and a result__snippet anchor.
function parseDdg(html: string): LocalSearchHit[] {
  const hits: LocalSearchHit[] = []
  for (const block of html.split(/(?=<div class="result )/)) {
    const a = block.match(
      /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")(?=[^>]*\bhref="([^"]*)")[^>]*>([\s\S]*?)<\/a>/i,
    )
    if (!a) continue
    const title = cleanText(a[2])
    const url = decodeDdgHref(a[1])
    if (!title || !url) continue
    const snippet = block.match(
      /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i,
    )
    const suffix = snippet ? ` — ${cleanText(snippet[1])}` : ''
    hits.push({ title: title + suffix, url })
  }
  return hits
}

// Bing hits are <li class="b_algo"><h2><a href="..">Title</a></h2>…[<p>snippet</p>] —
// each <li> block parsed independently so results without a snippet aren't lost.
function parseBing(html: string): LocalSearchHit[] {
  const hits: LocalSearchHit[] = []
  for (const block of html.split(/(?=<li class="b_algo)/)) {
    const a = block.match(
      /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i,
    )
    if (!a) continue
    const title = cleanText(a[2])
    if (!title || !a[1]) continue
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const suffix = snippet ? ` — ${cleanText(snippet[1])}` : ''
    hits.push({ title: title + suffix, url: a[1] })
  }
  return hits
}

function matchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\.+/, '')
  return host === d || host.endsWith('.' + d)
}

function domainAllowed(
  host: string,
  allowed?: string[],
  blocked?: string[],
): boolean {
  if (allowed?.length) return allowed.some(d => matchesDomain(host, d))
  if (blocked?.length) return !blocked.some(d => matchesDomain(host, d))
  return true
}

function filterAndDedupe(
  hits: LocalSearchHit[],
  allowed?: string[],
  blocked?: string[],
): LocalSearchHit[] {
  const seen = new Set<string>()
  const out: LocalSearchHit[] = []
  for (const h of hits) {
    let host: string
    try {
      host = new URL(h.url).hostname
    } catch {
      continue
    }
    if (seen.has(h.url)) continue
    if (!domainAllowed(host, allowed, blocked)) continue
    seen.add(h.url)
    out.push(h)
  }
  return out.slice(0, MAX_RESULTS)
}

async function fetchHtml(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': getWebFetchUserAgent(), Accept: 'text/html' },
  })
  if (!res.ok) throw new SearchHttpError(res.status)
  return await res.text()
}

async function queryDuckDuckGo(
  query: string,
  signal: AbortSignal,
): Promise<LocalSearchHit[]> {
  const url = `${DDG_HTML_URL}?${new URLSearchParams({ q: query })}`
  return parseDdg(await fetchHtml(url, signal))
}

async function queryBing(
  query: string,
  signal: AbortSignal,
): Promise<LocalSearchHit[]> {
  const url = `${BING_SEARCH_URL}?${new URLSearchParams({
    q: query,
    count: String(MAX_RESULTS),
    setlang: 'en',
  })}`
  return parseBing(await fetchHtml(url, signal))
}

type SearchFailure = {
  source: string
  kind: 'network' | 'http' | 'empty'
  detail: string
}

// 「压根没连上」和「连上了但没解析出结果」的处置完全不同 —— 前者该查网络/代理，
// 后者该换查询说法。旧实现把两者都报成 "no results"，无从判断该修哪个。
function describeFailures(failures: SearchFailure[]): string {
  const detail = failures
    .map(f => {
      if (f.kind === 'http') return `${f.source} 返回 ${f.detail}`
      if (f.kind === 'network') return `${f.source} 不可达（${f.detail}）`
      return `${f.source} 可达但无结果（${f.detail}）`
    })
    .join('；')
  // 提示按「用户该做什么」分岔：服务端报错等一会儿，解析不出来换说法，
  // 全不可达才是网络/代理的问题。
  const hint = failures.some(f => f.kind === 'http')
    ? '搜索源返回错误（可能被限流或暂时故障）—— 稍后重试。'
    : failures.some(f => f.kind === 'empty')
      ? '搜索源可达但没解析出结果 —— 换个查询说法，或稍后重试。'
      : '搜索源全部不可达 —— 检查网络或代理设置。'
  return `本地网络搜索失败 — ${detail}。${hint}`
}

// 重试前的等待。外部取消时立刻返回 —— 下一轮循环开头的 aborted 检查会终止。
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export async function localSearch(
  query: string,
  opts: {
    allowed_domains?: string[]
    blocked_domains?: string[]
    signal?: AbortSignal
  } = {},
): Promise<LocalSearchHit[]> {
  // 每个 source 独立 signal——上一个失败/超时不传染给下一个。此前 DDG 不可达会 abort
  // 共享 signal，把本来可达的 Bing 也 abort 了 → 两个全失败、报"no results"。
  // 优先 Bing（此网络区域可达、cn.bing 解析稳定），DDG 兜底。
  const sources = [
    { name: 'Bing', run: queryBing },
    { name: 'DuckDuckGo', run: queryDuckDuckGo },
  ]
  const failures: SearchFailure[] = []
  // 同一源只保留最后一次失败 —— 重试的每次失败各记一条会让报错里
  // 出现「Bing 返回 HTTP 503；Bing 返回 HTTP 503」，纯噪音。
  const record = (f: SearchFailure) => {
    const i = failures.findIndex(x => x.source === f.source)
    if (i >= 0) failures[i] = f
    else failures.push(f)
  }

  for (const { name, run } of sources) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SOURCE; attempt++) {
      // 外部取消（用户中断）不是搜索失败：不记 failures、不再换源。
      // createCombinedAbortSignal 对已 abort 的 signal 会直接返回 aborted 信号，
      // 不先检查就会白发一次请求。
      if (opts.signal?.aborted) throw new Error('本地网络搜索已取消。')

      const { signal, cleanup } = createCombinedAbortSignal(opts.signal, {
        timeoutMs: LOCAL_SEARCH_TIMEOUT_MS,
      })
      try {
        const raw = await run(query, signal)
        const filtered = filterAndDedupe(
          raw,
          opts.allowed_domains,
          opts.blocked_domains,
        )
        if (filtered.length > 0) return filtered

        // 页面拿到了但没结果 —— 重试无用，直接换下一个源。
        record({
          source: name,
          kind: 'empty',
          detail: raw.length > 0 ? `${raw.length} 条全被域名过滤` : '未解析出结果',
        })
        break
      } catch (e) {
        logError(e)
        const isHttp = e instanceof SearchHttpError
        record(
          isHttp
            ? { source: name, kind: 'http', detail: e.message }
            : { source: name, kind: 'network', detail: (e as Error).message },
        )
        const retryable = isHttp
          ? RETRYABLE_HTTP_STATUS.has(e.status)
          : true
        if (!retryable || attempt === MAX_ATTEMPTS_PER_SOURCE) break
        await sleep(RETRY_DELAY_MS, opts.signal)
      } finally {
        cleanup()
      }
    }
  }

  throw new Error(describeFailures(failures))
}
