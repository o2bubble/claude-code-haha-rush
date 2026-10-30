// ── host 能力记忆 ──
//
// 背景（2026-10-30 用户反馈）：DeepSeek 的 Anthropic 兼容端点**完整实现了**
// 服务端 `web_search_20250305`，但旧实现按 host 一刀切判定"中转 = 不支持"，
// 一次都没试过，永远走本地 DuckDuckGo/Bing。
//
// 改法：总是先试，只记忆「被证明做不到」的 host。这里锁住那套判定 ——
// 尤其是"别因为一次偶发失败就把一个能用的 host 永久降级"。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  SILENT_MISS_LIMIT,
  _isMarkedUnsupportedForTests,
  _resetServerSearchSupportForTests,
  isKnownUnsupported,
  isToolRejectionError,
  noteNoSearchPerformed,
  noteSearchSucceeded,
  noteToolRejected,
} from './serverSearchSupport.js'

const HOST = 'api.deepseek.com'

beforeEach(() => _resetServerSearchSupportForTests())

describe('isToolRejectionError — 只有「明确拒绝了这个工具」才算', () => {
  it('400 且报文提到 web_search → 是', () => {
    expect(
      isToolRejectionError({
        status: 400,
        message: 'unsupported tool type: web_search_20250305',
      }),
    ).toBe(true)
  })

  it('422 且报文提到 tool → 是', () => {
    expect(
      isToolRejectionError({ status: 422, message: 'unknown parameter: tools' }),
    ).toBe(true)
  })

  it('与工具无关的 400（上下文超长）→ 不是 —— 绝不能因此永久降级', () => {
    expect(
      isToolRejectionError({ status: 400, message: 'prompt is too long' }),
    ).toBe(false)
  })

  it('5xx / 429 / 网络错误 → 不是（那可能是暂时的）', () => {
    expect(isToolRejectionError({ status: 500, message: 'tool broke' })).toBe(false)
    expect(isToolRejectionError({ status: 429, message: 'tool rate limit' })).toBe(false)
    expect(isToolRejectionError(new Error('socket hang up'))).toBe(false)
  })

  it('null / 非对象 → 不是', () => {
    expect(isToolRejectionError(null)).toBe(false)
    expect(isToolRejectionError(undefined)).toBe(false)
    expect(isToolRejectionError('boom')).toBe(false)
  })
})

describe('host 能力记忆', () => {
  it('明确拒绝 → 立即记为不支持', () => {
    expect(isKnownUnsupported(HOST)).toBe(false)
    noteToolRejected(HOST)
    expect(isKnownUnsupported(HOST)).toBe(true)
  })

  it('一次 200 无结果**不**降级（可能只是模型这次没搜）', () => {
    noteNoSearchPerformed(HOST)
    expect(isKnownUnsupported(HOST)).toBe(false)
  })

  it('连续 SILENT_MISS_LIMIT 次无结果 → 降级', () => {
    for (let i = 0; i < SILENT_MISS_LIMIT; i++) noteNoSearchPerformed(HOST)
    expect(isKnownUnsupported(HOST)).toBe(true)
    expect(_isMarkedUnsupportedForTests(HOST)).toBe(true)
  })

  it('中途成功一次 → 计数清零，之前的未命中不算数', () => {
    noteNoSearchPerformed(HOST)
    noteSearchSucceeded(HOST)
    noteNoSearchPerformed(HOST)
    expect(isKnownUnsupported(HOST)).toBe(false)
  })

  it('不同 host 互不影响', () => {
    noteToolRejected(HOST)
    expect(isKnownUnsupported('api.anthropic.com')).toBe(false)
  })

  it('host 为 null（未配置 base URL）时永远不降级', () => {
    noteToolRejected(null)
    noteNoSearchPerformed(null)
    noteNoSearchPerformed(null)
    expect(isKnownUnsupported(null)).toBe(false)
  })

  it('进程内记忆：重置后回到未标记状态', () => {
    noteToolRejected(HOST)
    expect(isKnownUnsupported(HOST)).toBe(true)
    _resetServerSearchSupportForTests()
    expect(isKnownUnsupported(HOST)).toBe(false)
  })
})

describe('baseUrlHost', () => {
  const saved = process.env.ANTHROPIC_BASE_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = saved
  })

  it('从 ANTHROPIC_BASE_URL 取出 hostname', async () => {
    const { baseUrlHost } = await import('./serverSearchSupport.js')
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    expect(baseUrlHost()).toBe('api.deepseek.com')
  })

  it('未配置 → null（官方端点不该被记忆）', async () => {
    const { baseUrlHost } = await import('./serverSearchSupport.js')
    delete process.env.ANTHROPIC_BASE_URL
    expect(baseUrlHost()).toBe(null)
  })

  it('非法 URL → null（不抛）', async () => {
    const { baseUrlHost } = await import('./serverSearchSupport.js')
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(baseUrlHost()).toBe(null)
  })
})
