// ── 推理强度字段的落点：output_config.effort / reasoning_effort / 不发送 ──
//
// 三种端点各有各的约定，混用会导致 400 或"思考流消失"：
//   · `output_config_effort` 能力位 → `output_config.effort`（DeepSeek 官方）
//   · 声明 thinking 但不声明 reasoning → 顶层 `reasoning_effort`（GLM 系列）
//   · 其余（Claude 原生） → `output_config.effort`
//
// 这个测试直接盯 `configureEffortParams` 的产出，因为它是「能力位 → 实际
// 发出的字段」的唯一转换点，并且没有别的测试覆盖到。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { configureEffortParams } from './claude'

const SAVED: Record<string, string | undefined> = {}
const KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

beforeEach(() => {
  for (const k of KEYS) SAVED[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  // TIERS 顺序是 OPUS → SONNET → HAIKU，三者都指向同一模型时只有 OPUS 生效；
  // 宿主机可能已设置它们，所以统一在测试里显式控制。
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'm'
})

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

// `get3PModelCapabilityOverride` 是 memoize 的（键 = model:capability），
// 同一模型名在不同用例间会命中旧缓存 → 每个用例用独立模型名。
let seq = 0
function run(capabilities: string | undefined, effortValue: string | undefined) {
  const model = `t-relay-${++seq}`
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
  if (capabilities !== undefined) {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      capabilities
  }
  const outputConfig: Record<string, unknown> = {}
  const extraBody: Record<string, unknown> = {}
  const betas: string[] = []
  configureEffortParams(
    effortValue as never,
    outputConfig as never,
    extraBody,
    betas,
    model,
    true, // thinkingOn
  )
  return { outputConfig, extraBody, betas }
}

describe('configureEffortParams', () => {
  test('output_config_effort → 落进 output_config.effort（DeepSeek 官方）', () => {
    const r = run('effort,thinking,output_config_effort', 'low')
    expect(r.outputConfig.effort).toBe('low')
    expect(r.extraBody.reasoning_effort).toBeUndefined()
  })

  test('只声明 thinking → 落进顶层 reasoning_effort（GLM 式），不进 output_config', () => {
    const r = run('effort,thinking', 'high')
    expect(r.extraBody.reasoning_effort).toBe('high')
    expect(r.outputConfig.effort).toBeUndefined()
  })

  test('medium 在 GLM 式端点被映射为 high（该端点不认 medium）', () => {
    const r = run('effort,thinking', 'medium')
    expect(r.extraBody.reasoning_effort).toBe('high')
  })

  test('output_config_effort 保留 medium 原值（DeepSeek 实测接受）', () => {
    const r = run('effort,output_config_effort', 'medium')
    expect(r.outputConfig.effort).toBe('medium')
  })

  test('模型不支持 effort → 两个字段都不发', () => {
    // 用带 haiku 的名字让 modelSupportsEffort 的模型名启发式返回 false
    const model = `t-relay-haiku-${++seq}`
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking'
    const outputConfig: Record<string, unknown> = {}
    const extraBody: Record<string, unknown> = {}
    const betas: string[] = []
    configureEffortParams('low' as never, outputConfig as never, extraBody, betas, model, true)
    const r = { outputConfig, extraBody, betas }
    expect(r.outputConfig.effort).toBeUndefined()
    expect(r.extraBody.reasoning_effort).toBeUndefined()
  })

  test('thinking 关闭时 GLM 式端点不发 reasoning_effort（没东西可评级）', () => {
    const model = `t-relay-noturn-${++seq}`
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'effort,thinking'
    const outputConfig: Record<string, unknown> = {}
    const extraBody: Record<string, unknown> = {}
    const betas: string[] = []
    configureEffortParams(
      'low' as never,
      outputConfig as never,
      extraBody,
      betas,
      model,
      false, // thinkingOn = false
    )
    expect(extraBody.reasoning_effort).toBeUndefined()
  })
})
