// 结构契约：顶层小节对齐官方 2.1.316（Harness / Session-specific guidance /
// Memory / Environment / Context management），且合并时没有丢规则。
//
// 为什么要有这条测试：这次改动的价值全在「结构变了、规则还在」，而两者都
// 不会被任何类型检查发现 —— 少一句规则照样编译通过、照样跑。

import { describe, expect, it } from 'bun:test'
import { enableConfigs } from '../utils/config.js'

// 构建提示词会经 getCommands() 走到登录态探测；给它一个占位 key，
// 测试不联网、也不读用户的真实凭据。
process.env.ANTHROPIC_API_KEY ||= 'test-key-for-prompt-structure'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
// 正常由 preload.ts 注入；测试环境没有 preload，补一份最小值。
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: 'test',
  PACKAGE_URL: '',
  NATIVE_PACKAGE_URL: '',
  BUILD_TIME: 'test',
  FEEDBACK_CHANNEL: 'local',
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: '',
}
enableConfigs()

const { getAllBaseTools } = await import('../tools.js')
const { getSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import('./prompts.js')

const tools = getAllBaseTools().filter(tool => {
  try {
    return tool.isEnabled()
  } catch {
    return true
  }
})
const parts = await getSystemPrompt(tools as never, 'structure-test-model')

const harness = parts.find(part => part.startsWith('# Harness'))
const harnessIndex = parts.findIndex(part => part.startsWith('# Harness'))

describe('system prompt 结构', () => {
  it('静态前缀是单个 # Harness，不再有旧的平级小节', () => {
    expect(harness).toBeDefined()
    const topLevel = harness!
      .split('\n')
      .filter(line => line.startsWith('# '))
      .map(line => line.slice(2).trim())
    expect(topLevel).toEqual(['Harness'])
  })

  it('Harness 内部保留 Doing tasks 与 Communicating 两个子块', () => {
    expect(harness).toContain('\n## Doing tasks\n')
    expect(harness).toContain('\n## Communicating with the user\n')
  })

  it('Harness 位于动态边界之前（静态前缀仍可全局缓存）', () => {
    const boundaryIndex = parts.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    if (boundaryIndex === -1) return // 未启用全局缓存作用域时不设边界
    expect(harnessIndex).toBeGreaterThanOrEqual(0)
    expect(harnessIndex).toBeLessThan(boundaryIndex)
  })

  it('合并后规则没有丢 —— 抽样断言每条规则的锚点句', () => {
    const anchors = [
      'Build exactly what was asked',
      'Default to no comments',
      "Don't remove existing comments",
      'Before reporting a task complete, verify it',
      'Report outcomes faithfully',
      'Never introduce security vulnerabilities',
      'Do not propose changes to code you haven\'t read',
      'diagnose why before switching tactics',
      'Defer to user judgement',
      'use they/them',
      'confirm first',
      'Prefer the dedicated file/search tools',
      'Reference code as `file_path:line_number`',
      'Only use emojis if the user explicitly requests',
      'Do not use a colon before tool calls',
    ]
    for (const anchor of anchors) {
      expect(harness).toContain(anchor)
    }
  })
})
