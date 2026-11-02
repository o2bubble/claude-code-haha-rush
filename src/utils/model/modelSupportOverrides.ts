import memoize from 'lodash-es/memoize.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'
  | 'reasoning'
  /**
   * 推理强度通过 **`output_config.effort`** 表达（而不是 `reasoning:{effort}`
   * 或顶层 `reasoning_effort`）。
   *
   * DeepSeek 的 Anthropic 兼容文档明确：`thinking.budget_tokens` 被忽略、
   * 强度只看 `output_config.effort`（2026-11-02 实测：effort=low 让思考量
   * 从 3879 字降到 2318 字，而 `reasoning_effort` 无效）。
   *
   * 与 `reasoning` 互斥：声明 `reasoning` 时后端会把思考开关也一起交给
   * `reasoning:{effort}`，而该字段 DeepSeek 不认 → 等于关不掉思考。
   */
  | 'output_config_effort'

const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars.
 */
export const get3PModelCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    // NOTE: no getAPIProvider() === 'firstParty' gate here. Base-url relays
    // (e.g. api.deepseek.com/anthropic) report as 'firstParty' yet are 3P —
    // the user opts into an override by setting ANTHROPIC_DEFAULT_*_MODEL +
    // ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES on their profile. Model
    // capability env is honored for ANY pinned model, standard first-party
    // profiles simply never set these vars.
    const m = model.toLowerCase()
    for (const tier of TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== pinned.toLowerCase()) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => `${model.toLowerCase()}:${capability}`,
)
