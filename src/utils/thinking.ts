// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

/**
 * `ANTHROPIC_BASE_URL` 指向非 Anthropic 官方域名 —— 即"中继/网关"端点，
 * 后面可能是任意第三方模型（DeepSeek / Qwen / GLM …）。
 *
 * 为什么必须单独判：`getAPIProvider()` 只看 BEDROCK/VERTEX/FOUNDRY 三个标志，
 * 自定义 base URL 一律报 `firstParty`。于是下面那些"Claude 4+ 都支持思考"的
 * 启发式会把**任意未知模型名**当成 Claude 原生模型。
 *
 * 2026-11-02 实测后果（DeepSeek /anthropic 端点，同一道难题，max_tokens=2000）：
 *
 * | 发出参数                        | out tokens | 思考字符 | 正文 |
 * |--------------------------------|-----------|---------|------|
 * | `thinking:{type:'disabled'}`    | 2000      | 0       | 3017 字 |
 * | `thinking:{type:'enabled'}`     | 2000      | 5288    | **0 字** |
 * | `enabled` + `budget_tokens:256` | 2000      | 5196    | 0 字 |
 * | `reasoning:{effort:'none'}`     | 2000      | 5372    | 0 字 |
 * | `reasoning:{effort:'high'}`     | 2000      | 5291    | 0 字 |
 *
 * 两处关键事实：
 * 1. **`budget_tokens` 和 `reasoning.effort` 都被忽略** —— 只有 `type` 有效。
 * 2. 思考会吃光 `max_tokens`，**正文 0 字** —— 用户看到的就是"半天没有输出、
 *    文件也没改，但账单很高"（推理 token 按 output 计费）。
 *
 * 所以中继端点必须**由 profile 显式声明**能力，不能靠猜。
 */
export function isRelayEndpoint(): boolean {
  return getAPIProvider() === 'firstParty' && !isFirstPartyAnthropicBaseUrl()
}

// TODO(inigo): add support for probing unknown models via API error detection
// Provider-aware thinking support detection (aligns with modelSupportsISP in betas.ts)
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // 中继端点：模型名不可信（`deepseek-flash` 之类），没有显式声明就不猜。
  if (isRelayEndpoint()) {
    return false
  }
  // IMPORTANT: Do not change thinking support without notifying the model
  // launch DRI and research. This can greatly affect model quality and bashing.
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P and Foundry: all Claude 4+ models (including Haiku 4.5)
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  // 3P (Bedrock/Vertex): only Opus 4+ and Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

/**
 * Whether a 3P model controls thinking via the `reasoning:{effort}` field
 * (e.g. DeepSeek) instead of Claude's `thinking` block. Enabled by a static
 * capability env flag: ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES=...,reasoning.
 * Defaults to false (Claude-native `thinking` block).
 */
export function modelSupportsReasoning(model: string): boolean {
  return get3PModelCapabilityOverride(model, 'reasoning') === true
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports adaptive thinking.
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  // 中继端点同上：未知模型名不得继承 4.6+ 的"无预算自适应思考"分支 ——
  // 那条分支根本不读 `budgetTokens`，会把调用方给的预算静默丢掉。
  if (isRelayEndpoint()) {
    return false
  }
  const canonical = getCanonicalName(model)
  // Supported by a subset of Claude 4 models
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
    return true
  }
  // Exclude any other known legacy models (allowlist above catches 4-6 variants first)
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // IMPORTANT: Do not change adaptive thinking support without notifying the
  // model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Newer models (4.6+) are all trained on adaptive thinking and MUST have it
  // enabled for model testing. DO NOT default to false for first party, otherwise
  // we may silently degrade model quality.

  // Default to true for unknown model strings on 1P and Foundry (because Foundry
  // is a proxy). Do not default to true for other 3P as they have different formats
  // for their model strings.
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}
