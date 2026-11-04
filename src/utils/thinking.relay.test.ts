// ── 中继端点不得继承 Claude 原生模型的能力假设 ──
//
// 背景（2026-11-02 用户反馈 + 实测）：
//   用户报「AI 半天没什么输出、文件也没改，但输出费用很高」。
//   日志里请求全是 `thinking=enabled budget=-`。
//
// 根因链：
//   1. `getAPIProvider()` 只看 BEDROCK/VERTEX/FOUNDRY，自定义 ANTHROPIC_BASE_URL
//      一律报 `firstParty`；
//   2. 于是 `modelSupportsThinking('deepseek-flash')` 走 "Claude 4+ 都支持思考"
//      的启发式 → true；
//   3. `modelSupportsAdaptiveThinking` 对未知模型名默认 true → 进入"自适应思考"
//      分支，该分支**不读 budgetTokens**，把 ideMode 传的 16000 静默丢弃；
//   4. DeepSeek 实测：`budget_tokens` 与 `reasoning.effort` 全被忽略，
//      `thinking:{type:'enabled'}` 会吃光 max_tokens，正文 0 字；而推理 token
//      按 output 计费 → 贵且看不到产出。
//
// 修复：中继端点必须由 profile 显式声明能力，不再靠模型名猜。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  isRelayEndpoint,
  modelSupportsAdaptiveThinking,
  modelSupportsReasoning,
  modelSupportsThinking,
} from './thinking'
import { modelSupportsOutputConfigEffort } from './effort'

const SAVED: Record<string, string | undefined> = {}
const KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'USER_TYPE',
]

beforeEach(() => {
  for (const k of KEYS) SAVED[k] = process.env[k]
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

describe('isRelayEndpoint', () => {
  test('自定义 base URL = 中继', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    expect(isRelayEndpoint()).toBe(true)
  })

  test('Anthropic 官方端点 / 未设置 = 不是中继', () => {
    expect(isRelayEndpoint()).toBe(false)
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isRelayEndpoint()).toBe(false)
  })
})

describe('中继未显式声明能力时不得猜', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  })

  test('未声明 → 不支持思考（否则会发无上限 thinking）', () => {
    expect(modelSupportsThinking('relay-unknown-a')).toBe(false)
  })

  test('未声明 → 不支持自适应思考（该分支会丢弃 budgetTokens）', () => {
    expect(modelSupportsAdaptiveThinking('relay-unknown-b')).toBe(false)
  })
})

describe('output_config_effort 能力位（DeepSeek 官方做法）', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    // TIERS 按 OPUS → SONNET → HAIKU 顺序取第一个命中，宿主机可能已设置
    // OPUS/HAIKU 同模型名 → 会遮蔽这里设的 SONNET 能力，先清空。
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-flash'
  })

  test('声明 output_config_effort → 强度走 output_config.effort，且不走 reasoning', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'effort,max_effort,thinking,output_config_effort'
    expect(modelSupportsOutputConfigEffort('deepseek-flash')).toBe(true)
    // 关键：不能再声明 reasoning —— 否则后端会把开关也塞进 reasoning:{effort}
    expect(modelSupportsReasoning('deepseek-flash')).toBe(false)
    expect(modelSupportsThinking('deepseek-flash')).toBe(true)
  })

  test('GLM 式端点仍可只用 reasoning，互不影响', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'thinking,reasoning'
    expect(modelSupportsReasoning('glm-5')).toBe(true)
    expect(modelSupportsOutputConfigEffort('glm-5')).toBe(false)
  })
})

describe('profile 显式声明后恢复支持', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'relay-declared'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      'effort,thinking'
  })

  test('声明了 thinking → 支持', () => {
    expect(modelSupportsThinking('relay-declared')).toBe(true)
  })

  test('没声明 adaptive_thinking → 仍然不走自适应分支', () => {
    expect(modelSupportsAdaptiveThinking('relay-declared')).toBe(false)
  })
})
