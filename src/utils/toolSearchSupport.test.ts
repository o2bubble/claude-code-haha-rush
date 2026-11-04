// ── 延迟工具加载的 host 能力记忆（先试后记）──
//
// 背景：2026-11-02 逆向对比发现官方 2.1.316 只内联 14 个工具，其余（含 MCP）
// 走 ToolSearch 延迟加载。我们原来按 host 预判：非 Anthropic 域名一律关掉，
// 所有 MCP 工具内联（实测 DeepSeek 请求 64 个工具）。实测 DeepSeek 完全支持
// `defer_loading` 与 `tool_reference`，于是改成「先试后记」。
//
// 这组测试锁住三条：① 默认不再按 host 关；② 只有被明确拒绝过才关；
// ③ 拒绝识别不能误伤无关的 4xx（否则一次上下文超长就把功能永久关掉）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _isToolSearchMarkedUnsupportedForTests,
  _resetToolSearchSupportForTests,
  isToolSearchRejectionError,
  isToolSearchUnsupported,
  noteToolSearchRejected,
  toolSearchBaseUrlHost,
} from './toolSearchSupport.js'

const ORIGINAL_BASE_URL = process.env.ANTHROPIC_BASE_URL

beforeEach(() => {
  _resetToolSearchSupportForTests()
})
afterEach(() => {
  _resetToolSearchSupportForTests()
  if (ORIGINAL_BASE_URL === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = ORIGINAL_BASE_URL
})

describe('toolSearchBaseUrlHost', () => {
  test('从 ANTHROPIC_BASE_URL 取 host', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    expect(toolSearchBaseUrlHost()).toBe('api.deepseek.com')
  })

  test('未配置 → null', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(toolSearchBaseUrlHost()).toBeNull()
  })

  test('非法 URL → null（不抛）', () => {
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(toolSearchBaseUrlHost()).toBeNull()
  })
})

describe('host 能力记忆', () => {
  test('默认不认为任何 host 不支持（不再按域名预判）', () => {
    expect(isToolSearchUnsupported('api.deepseek.com')).toBe(false)
    expect(isToolSearchUnsupported('some-relay.example.com')).toBe(false)
  })

  test('记录被拒后，只有那个 host 被标记', () => {
    noteToolSearchRejected('api.deepseek.com')
    expect(_isToolSearchMarkedUnsupportedForTests('api.deepseek.com')).toBe(true)
    expect(isToolSearchUnsupported('other.example.com')).toBe(false)
  })

  test('null host 不记录（官方/未知端点永不被降级）', () => {
    noteToolSearchRejected(null)
    expect(isToolSearchUnsupported(null)).toBe(false)
  })
})

describe('isToolSearchRejectionError — 只认「延迟加载」相关的拒绝', () => {
  test('400 + tool_reference（下划线写法）→ 认', () => {
    expect(
      isToolSearchRejectionError({
        status: 400,
        message: "tool_reference block is not supported",
      }),
    ).toBe(true)
  })

  test('400 + tool reference（空格写法，DeepSeek 实测格式）→ 认', () => {
    // 实测报文：tool reference 'Beta' not found in available tools
    expect(
      isToolSearchRejectionError({
        status: 400,
        message: "tool reference 'Beta' not found in available tools",
      }),
    ).toBe(true)
  })

  test('422/501 + defer_loading → 认', () => {
    expect(
      isToolSearchRejectionError({ status: 422, message: 'defer_loading invalid' }),
    ).toBe(true)
    expect(
      isToolSearchRejectionError({ status: 501, message: 'defer loading unsupported' }),
    ).toBe(true)
  })

  test('与延迟加载无关的 400（上下文超长）→ 不认', () => {
    expect(
      isToolSearchRejectionError({
        status: 400,
        message: 'input length and `max_tokens` exceed context limit',
      }),
    ).toBe(false)
  })

  test('认证失败 401 → 不认', () => {
    expect(
      isToolSearchRejectionError({ status: 401, message: 'invalid api key' }),
    ).toBe(false)
  })

  test('5xx 即使提到 tool_reference → 不认（可能只是暂时故障）', () => {
    expect(
      isToolSearchRejectionError({ status: 500, message: 'tool_reference boom' }),
    ).toBe(false)
    expect(
      isToolSearchRejectionError({ status: 529, message: 'tool_reference overloaded' }),
    ).toBe(false)
  })

  test('非对象 / 缺 status → 不认，且不抛', () => {
    expect(isToolSearchRejectionError(null)).toBe(false)
    expect(isToolSearchRejectionError(undefined)).toBe(false)
    expect(isToolSearchRejectionError('tool_reference')).toBe(false)
    expect(isToolSearchRejectionError({ message: 'tool_reference' })).toBe(false)
  })
})
