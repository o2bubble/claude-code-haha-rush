import { describe, expect, it } from 'bun:test'
import { normalizeMcpInputSchema } from './normalizeInputSchema.js'

describe('normalizeMcpInputSchema', () => {
  it('正常的 object schema 原样返回（同一个引用，不做拷贝）', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    expect(normalizeMcpInputSchema(schema, 'srv', 'tool')).toBe(schema)
  })

  it('type 不是 object → 换成宽松 object schema', () => {
    // 官方 2.1.330 修的正是这个：这类 schema 会被第三方 provider 静默丢弃，
    // 表现为"工具不存在"，很难排查。
    for (const bad of [
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      { properties: {} }, // 漏了 type
      {},
    ]) {
      const out = normalizeMcpInputSchema(bad, 'srv', 'tool')
      expect(out?.type).toBe('object')
      expect((out as any).additionalProperties).toBe(true)
    }
  })

  it('schema 缺失 / null / 非对象 → 同样给宽松 object schema', () => {
    for (const bad of [undefined, null, 'not-a-schema', 42, []]) {
      const out = normalizeMcpInputSchema(bad, 'srv', 'tool')
      expect(out?.type).toBe('object')
      expect((out as any).additionalProperties).toBe(true)
    }
  })

  it('宽松 schema 里 properties 是空对象（不是 undefined）', () => {
    // 有些 provider 对 properties 缺失比 properties:{} 更敏感
    const out = normalizeMcpInputSchema(null, 'srv', 'tool') as any
    expect(out.properties).toEqual({})
  })
})
