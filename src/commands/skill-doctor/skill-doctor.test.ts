import { describe, expect, it } from 'bun:test'
import { classifySkills } from './skill-doctor.js'

const NOW = 1_700_000_000_000
const DAY = 86_400_000

function row(name: string, tokens: number, usageCount: number, daysAgo: number | null) {
  return { name, tokens, usageCount, lastUsedAt: daysAgo === null ? null : NOW - daysAgo * DAY }
}

describe('classifySkills', () => {
  it('未使用过的一律进 neverUsed，按 token 降序', () => {
    const { neverUsed } = classifySkills(
      [row('small', 20, 0, null), row('big', 300, 0, null), row('mid', 100, 0, null)],
      NOW,
    )
    expect(neverUsed.map(r => r.name)).toEqual(['big', 'mid', 'small'])
  })

  it('用过但超过 30 天进 stale；恰好 30 天也算', () => {
    const { stale } = classifySkills(
      [row('edge30', 50, 1, 30), row('old', 60, 2, 100), row('recent', 70, 1, 29)],
      NOW,
    )
    expect(stale.map(r => r.name)).toEqual(['old', 'edge30'])
  })

  it('近期在用的按使用次数降序（最常用的排前面）', () => {
    const { active } = classifySkills(
      [row('rare', 100, 1, 5), row('hot', 20, 30, 1), row('mid', 50, 8, 3)],
      NOW,
    )
    expect(active.map(r => r.name)).toEqual(['hot', 'mid', 'rare'])
  })

  it('三档互斥且覆盖全部 —— 一个技能只能出现在一处', () => {
    const rows = [
      row('a', 10, 0, null),
      row('b', 20, 1, 60),
      row('c', 30, 5, 1),
    ]
    const { neverUsed, stale, active } = classifySkills(rows, NOW)
    const all = [...neverUsed, ...stale, ...active].map(r => r.name).sort()
    expect(all).toEqual(['a', 'b', 'c'])
  })

  it('空输入返回三个空数组', () => {
    const r = classifySkills([], NOW)
    expect(r).toEqual({ neverUsed: [], stale: [], active: [] })
  })
})
