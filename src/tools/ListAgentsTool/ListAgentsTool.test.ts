// ListAgents 必须标出「调用者自己」那一行。
//
// 2026-11-27 实锤事故：监工子代理被派去盯两个实施子代理。实施代理 09:05 就
// completed 了，监工却每轮 sleep 60 一直睡到 09:07+。原因是 ListAgents 会把它
// **自己**也列出来（状态永远 running），它把那一行当成了未完成的目标 ——
// 于是「所有目标都结束」永远不成立，它在等自己。
//
// 这里只测纯函数部分（call 需要完整的 AppState）；工具的渲染在
// mapToolResultToToolResultBlockParam 里，断言 isSelf 行带出显眼标记。

import { describe, expect, it } from 'bun:test'
import { ListAgentsTool } from './ListAgentsTool.js'

const OUTPUT = {
  agents: [
    { name: 'a57c2694', kind: 'subagent' as const, status: 'completed', description: '实施 ticket 01' },
    { name: 'a9920a3a', kind: 'subagent' as const, status: 'running', description: '监视 01/03 两个实施子代理', isSelf: true },
  ],
  sessions: [],
}

describe('ListAgents 输出渲染', () => {
  const rendered = (() => {
    const r = ListAgentsTool.mapToolResultToToolResultBlockParam(OUTPUT as never, 'tool-1')
    const block = Array.isArray(r.content) ? r.content[0] : r.content
    return typeof block === 'string' ? block : ((block as { text?: string })?.text ?? '')
  })()

  it('自己那一行带显眼标记，别行不带', () => {
    expect(rendered).toContain('this is you, ignore it')
    // 只有一行带标记
    expect(rendered.split('this is you').length - 1).toBe(1)
    // 标记必须落在自己那行（描述含「监视」）
    const selfLine = rendered.split('\n').find(l => l.includes('this is you'))!
    expect(selfLine).toContain('监视')
  })

  it('没有 isSelf 时（主会话调用）不出现标记', () => {
    const r = ListAgentsTool.mapToolResultToToolResultBlockParam(
      { agents: [OUTPUT.agents[0]], sessions: [] } as never,
      'tool-2',
    )
    const block = Array.isArray(r.content) ? r.content[0] : r.content
    const text = typeof block === 'string' ? block : ((block as { text?: string })?.text ?? '')
    expect(text).not.toContain('this is you')
  })
})
