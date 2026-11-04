// ── provider 侧抓取（DeepSeek `/v1/tools/fetch`）──
//
// 用户需求（2026-10-30）：本地抓取遇到反爬 / JS 渲染站点会失败，
// 希望优先走 provider 的抓取接口，走不通再回退本地。
//
// 这里锁住两件最容易出错的事：
//  ① 端点推导 —— 官方 Anthropic 没有这个接口，必须返回 null（否则每次抓取
//     都往 api.anthropic.com 发一个必然 404 的请求）
//  ② 失败返回 null 而不是抛异常 —— 抛了就变成工具报错，本地那一次机会没了

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _isMarkedUnsupportedForTests,
  _resetServerFetchSupportForTests,
  fetchViaServer,
  isServerFetchKnownUnsupported,
  noteServerFetchUnavailable,
  serverFetchEndpoint,
} from './serverFetch.js'

describe('serverFetchEndpoint', () => {
  const saved = process.env.ANTHROPIC_BASE_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = saved
  })

  it('DeepSeek：origin + /v1/tools/fetch', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    expect(serverFetchEndpoint()).toEqual({
      url: 'https://api.deepseek.com/v1/tools/fetch',
      host: 'api.deepseek.com',
    })
  })

  it('带子路径/baseUrl 也按 origin 拼', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://relay.example.com/api/anthropic/'
    expect(serverFetchEndpoint()?.url).toBe(
      'https://relay.example.com/v1/tools/fetch',
    )
  })

  it('未配置 base URL → failed（官方没这个接口）', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(serverFetchEndpoint()).toBe(null)
  })

  it('官方 anthropic.com → failed', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(serverFetchEndpoint()).toBe(null)
  })

  it('非法 URL → failed（不抛）', () => {
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(serverFetchEndpoint()).toBe(null)
  })
})

describe('host 记忆', () => {
  beforeEach(() => _resetServerFetchSupportForTests())

  it('标记后视为不支持', () => {
    expect(isServerFetchKnownUnsupported('x.test')).toBe(false)
    noteServerFetchUnavailable('x.test')
    expect(isServerFetchKnownUnsupported('x.test')).toBe(true)
    expect(_isMarkedUnsupportedForTests('x.test')).toBe(true)
  })

  it('null host 永远不算不支持', () => {
    noteServerFetchUnavailable(null)
    expect(isServerFetchKnownUnsupported(null)).toBe(false)
  })
})

describe('fetchViaServer — 失败一律返回 null（交给本地兜底）', () => {
  const savedBase = process.env.ANTHROPIC_BASE_URL
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN
  beforeEach(() => _resetServerFetchSupportForTests())
  afterEach(() => {
    vi.unstubAllGlobals()
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = savedBase
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = savedToken
  })

  it('没有可用的端点 → failed，且不发起任何请求', async () => {
    delete process.env.ANTHROPIC_BASE_URL
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect((await fetchViaServer('https://a.test', new AbortController().signal, false)).status).toBe('failed')
    expect(spy).not.toHaveBeenCalled()
  })

  it('没有 token → failed', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    delete process.env.ANTHROPIC_AUTH_TOKEN
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    // apiKeyHelper 在本测试环境未配置 → resolveToken 返回 null
    expect((await fetchViaServer('https://a.test', new AbortController().signal, false)).status).toBe('failed')
    expect(spy).not.toHaveBeenCalled()
  })

  it('200 + 正文 → 返回内容；请求体是 {url}，鉴权是 Bearer', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: any) => {
      calls.push({ u, init })
      return new Response(JSON.stringify({ title: 'T', content: '# hi' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))

    const r = await fetchViaServer('https://a.test/page', new AbortController().signal, false)
    expect(r).toEqual({ status: 'ok', title: 'T', content: '# hi' })
    expect(calls[0].u).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body)).toEqual({ url: 'https://a.test/page' })
  })

  it('200 但正文为空 → failed（视为取不到）', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ title: '', content: '   ' }), { status: 200 })))
    expect((await fetchViaServer('https://a.test', new AbortController().signal, false)).status).toBe('failed')
  })

  it('404 → failed，但**不**记 host 不支持（可能只是这个 URL 没正文）', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    expect((await fetchViaServer('https://a.test', new AbortController().signal, false)).status).toBe('failed')
    expect(isServerFetchKnownUnsupported('api.deepseek.com')).toBe(false)
  })

  it('405 → failed，且记 host 不支持（接口不存在）', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 405 })))
    expect((await fetchViaServer('https://a.test', new AbortController().signal, false)).status).toBe('failed')
    expect(isServerFetchKnownUnsupported('api.deepseek.com')).toBe(true)
  })

  it('网络异常 → failed（不抛）', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))
    expect((await fetchViaServer('https://a.test', new AbortController().signal, false)).status).toBe('failed')
  })

  it('调用方主动中断 → 原样抛出（不能悄悄换成一次本地抓取）', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
    const ac = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      ac.abort()
      throw new Error('aborted')
    }))
    await expect(fetchViaServer('https://a.test', ac.signal, false)).rejects.toThrow()
  })
})
