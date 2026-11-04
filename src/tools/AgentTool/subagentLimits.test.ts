import { describe, expect, it } from 'bun:test'
import {
  checkConcurrentLimit,
  checkDepthLimit,
  readLimitEnv,
} from './subagentLimits.js'

describe('readLimitEnv', () => {
  it('合法正整数原样返回', () => {
    expect(readLimitEnv('5')).toBe(5)
    expect(readLimitEnv('1')).toBe(1)
  })

  it('未设 / 空串 / 非法 / ≤0 一律当不限制（0）', () => {
    // 关键：0 和负数不能被当成"上限 0"，否则所有子代理都起不来
    expect(readLimitEnv(undefined)).toBe(0)
    expect(readLimitEnv('')).toBe(0)
    expect(readLimitEnv('abc')).toBe(0)
    expect(readLimitEnv('0')).toBe(0)
    expect(readLimitEnv('-3')).toBe(0)
  })
})

describe('checkConcurrentLimit', () => {
  it('未达上限放行', () => {
    expect(checkConcurrentLimit(0, 3).ok).toBe(true)
    expect(checkConcurrentLimit(2, 3).ok).toBe(true)
  })

  it('达到上限拒绝（>= 而非 >）', () => {
    const r = checkConcurrentLimit(3, 3)
    expect(r.ok).toBe(false)
    if (r.ok === false) {
      expect(r.message).toContain('3 subagents at once')
      expect(r.message).toContain('Do not retry')
      expect(r.message).toContain('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS')
    }
  })

  it('max=0 表示不限制，永不拒绝', () => {
    expect(checkConcurrentLimit(999, 0).ok).toBe(true)
  })
})

describe('checkDepthLimit', () => {
  it('未达上限放行；达到拒绝', () => {
    expect(checkDepthLimit(0, 2).ok).toBe(true)
    expect(checkDepthLimit(1, 2).ok).toBe(true)
    const r = checkDepthLimit(2, 2)
    expect(r.ok).toBe(false)
    if (r.ok === false) {
      expect(r.message).toContain('depth 2 of 2')
      expect(r.message).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH')
    }
  })

  it('max=0 表示不限制', () => {
    expect(checkDepthLimit(999, 0).ok).toBe(true)
  })
})
