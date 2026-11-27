// 监工（overseer）是本地新增的 agent 类型：不做事、不改代码，只观察 + 发消息。
// 这组测试锁住三件容易在后续改动中丢掉的事：它确实被注册、它拿不到编辑工具、
// 它的 system prompt 里那几条安全/流程约束还在。

import { describe, expect, it } from 'bun:test'
import { enableConfigs } from '../../../utils/config.js'

process.env.ANTHROPIC_API_KEY ||= 'test-key-for-overseer-agent'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
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

const { getBuiltInAgents } = await import('../builtInAgents.js')
const { OVERSEER_AGENT } = await import('./overseerAgent.js')

const prompt = OVERSEER_AGENT.getSystemPrompt({
  toolUseContext: { options: {} },
} as never)

describe('overseer agent', () => {
  it('注册在内置 agent 列表里（否则主 agent 选不到这个 subagent_type）', () => {
    const types = getBuiltInAgents().map(a => a.agentType)
    expect(types).toContain('overseer')
  })

  it('工具白名单只有观察与通信，没有任何编辑工具', () => {
    expect(OVERSEER_AGENT.tools).toEqual([
      'ToolSearch',
      'SendMessage',
      'ListAgents',
      'Read',
      'Grep',
      'Bash',
    ])
    for (const editTool of ['Edit', 'Write', 'NotebookEdit', 'Agent']) {
      expect(OVERSEER_AGENT.tools).not.toContain(editTool)
      expect(OVERSEER_AGENT.disallowedTools).toContain(editTool)
    }
  })

  it('system prompt 写明监察范围仅限 prompt 里给定的 id', () => {
    expect(prompt).toContain('only the agents named in your prompt')
    expect(prompt).toContain('Never inspect, poll, or message any other agent')
    expect(prompt).toContain('no target given')
  })

  it('system prompt 写明循环、死胡同判据与干预方式', () => {
    expect(prompt).toContain('sleep 60')
    expect(prompt).toContain('ListAgents')
    expect(prompt).toContain('3+ times')
    expect(prompt).toContain('SendMessage')
    expect(prompt).toContain('at most 2-3 times per target')
  })

  it('写明「反复打补丁、方法没换」这个最贵的死胡同形态', () => {
    // 用户 2026-11-27 的真实事故：子代理一小时都在用同一个思路打补丁重测，
    // 每次都是新错误，从未想过换路径。现有 "no progress" 判据抓不到它。
    expect(prompt).toContain('patching a losing approach')
    expect(prompt).toContain('Different error text each time is NOT progress')
    expect(prompt).toContain('never considered one')
    // 干预不能只是再给一个补丁，必须逼它陈述方法 + 给出替代路径
    expect(prompt).toContain('do not hand it another fix')
    expect(prompt).toContain('name one alternative path')
    expect(prompt).toContain('pick one and say which')
    // 轮次预算
    expect(prompt).toContain('roughly ten rounds')
  })

  it('system prompt 写明回报格式：最终状态 + 干预记录', () => {
    expect(prompt).toContain('Monitored: <agentId>')
    expect(prompt).toContain('Interventions:')
    expect(prompt).toContain('do not write files')
  })

  it('不把运行模式写死在定义里 —— 前台/后台由用户选', () => {
    // background: true 会让每次调用都被强制异步；这里必须留给 run_in_background。
    expect(OVERSEER_AGENT.background).not.toBe(true)
    expect(OVERSEER_AGENT.whenToUse).toContain('Ask the user which mode')
    expect(prompt).toContain('foreground (the caller is blocked waiting on you) or in the background')
  })
})

describe('主 agent 的 Agent 工具说明', () => {
  it('提到监工怎么派（否则模型不知道要与之配对，功能等于不存在）', async () => {
    const { getPrompt } = await import('../prompt.js')
    const text = await getPrompt(getBuiltInAgents())
    expect(text).toContain('Monitoring a background agent')
    expect(text).toContain('subagent_type: "overseer"')
    expect(text).toContain("run_in_background: true")
    expect(text).toContain('same parallel batch')
  })

  it('主 agent 必须先问用户前台还是后台，不能替用户定', async () => {
    const { getPrompt } = await import('../prompt.js')
    const text = await getPrompt(getBuiltInAgents())
    expect(text).toContain('Ask the user whether the overseer should run foreground or background')
    expect(text).toContain('wait for their answer')
    expect(text).toContain('Never choose silently')
    // 两种模式各自适用场景都要写，否则"推荐"没有依据
    expect(text).toContain('when the main session has other useful work')
    expect(text).toContain('when you have nothing else to do')
  })

  it('agent 列表里能查到 overseer 的 whenToUse', async () => {
    const { formatAgentLine } = await import('../prompt.js')
    const line = formatAgentLine(OVERSEER_AGENT)
    expect(line).toContain('overseer:')
    expect(line).toContain('agentId')
  })
})

describe('白名单工具名必须真实存在', () => {
  it('拼错工具名会静默变成「没有这个工具」——逐个核对', async () => {
    const { getAllBaseTools } = await import('../../../tools.js')
    const available = new Set(getAllBaseTools().map(t => t.name))
    for (const name of OVERSEER_AGENT.tools ?? []) {
      expect(available.has(name)).toBe(true)
    }
  })
})

describe('后台模式下的工具可用性', () => {
  it('后台运行时监工仍拿得到 SendMessage 与 ListAgents（否则没法干预）', async () => {
    const { getAllBaseTools } = await import('../../../tools.js')
    const { resolveAgentTools } = await import('../agentToolUtils.js')
    const resolved = resolveAgentTools(
      OVERSEER_AGENT as never,
      getAllBaseTools() as never,
      true, // isAsync = run_in_background: true
    )
    const names = resolved.resolvedTools.map(t => t.name)
    expect(names).toContain('SendMessage')
    expect(names).toContain('ListAgents')
    // 编辑工具任何时候都不该出现
    for (const editTool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(names).not.toContain(editTool)
    }
  })

  it('通配符不等于自动获得这两件 —— 别的后台 agent 没有', async () => {
    const { getAllBaseTools } = await import('../../../tools.js')
    const { resolveAgentTools } = await import('../agentToolUtils.js')
    const wildcardAgent = { tools: ['*'], source: 'built-in' as const }
    const resolved = resolveAgentTools(
      wildcardAgent as never,
      getAllBaseTools() as never,
      true,
    )
    const names = resolved.resolvedTools.map(t => t.name)
    expect(names).not.toContain('SendMessage')
    expect(names).not.toContain('ListAgents')
  })
})
