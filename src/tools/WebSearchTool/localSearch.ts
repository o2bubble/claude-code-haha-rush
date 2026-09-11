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

export type LocalSearchHit = { title: string; url: string }

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
  if (!res.ok) throw new Error(`search request failed: HTTP ${res.status}`)
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
  const attempts: Array<(signal: AbortSignal) => Promise<LocalSearchHit[]>> = [
    (signal) => queryBing(query, signal),
    (signal) => queryDuckDuckGo(query, signal),
  ]
  for (const attempt of attempts) {
    const { signal, cleanup } = createCombinedAbortSignal(opts.signal, {
      timeoutMs: LOCAL_SEARCH_TIMEOUT_MS,
    })
    try {
      const filtered = filterAndDedupe(
        await attempt(signal),
        opts.allowed_domains,
        opts.blocked_domains,
      )
      if (filtered.length > 0) return filtered
    } catch (e) {
      logError(e)
    } finally {
      cleanup()
    }
  }
  throw new Error(
    'Both Bing and DuckDuckGo search returned no results (unreachable or empty).',
  )
}
