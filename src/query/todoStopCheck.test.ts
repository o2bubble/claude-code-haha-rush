import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetNudgeStateForTest,
  formatNudge,
  shouldNudge,
} from './todoStopCheck.js'
import type { TodoList } from '../utils/todo/types.js'

const todo = (content: string, status: TodoList[number]['status'] = 'pending') =>
  ({ content, status, activeForm: content })

beforeEach(() => _resetNudgeStateForTest())

describe('shouldNudge —— 同一批待办只提醒一次', () => {
  test('空列表不提醒（引擎在全部完成时本来就会清空）', () => {
    expect(shouldNudge('s1', [])).toBe(false)
  })

  test('有待办 → 提醒一次', () => {
    expect(shouldNudge('s1', [todo('a')])).toBe(true)
  })

  test('同一批待办再问一次 → 不再提醒（模型解释过就放行）', () => {
    const list = [todo('a'), todo('b')]
    expect(shouldNudge('s1', list)).toBe(true)
    expect(shouldNudge('s1', list)).toBe(false)
    expect(shouldNudge('s1', list)).toBe(false)
  })

  test('待办变了（做掉一项）→ 重新提醒', () => {
    expect(shouldNudge('s1', [todo('a'), todo('b')])).toBe(true)
    expect(shouldNudge('s1', [todo('b')])).toBe(true)
  })

  test('顺序变化不算变化（指纹按内容排序）', () => {
    expect(shouldNudge('s1', [todo('a'), todo('b')])).toBe(true)
    expect(shouldNudge('s1', [todo('b'), todo('a')])).toBe(false)
  })

  test('清空后再出现同样的待办 → 重新提醒（历史已忘掉）', () => {
    expect(shouldNudge('s1', [todo('a')])).toBe(true)
    expect(shouldNudge('s1', [])).toBe(false)
    expect(shouldNudge('s1', [todo('a')])).toBe(true)
  })

  test('不同会话互不干扰', () => {
    expect(shouldNudge('s1', [todo('a')])).toBe(true)
    expect(shouldNudge('s2', [todo('a')])).toBe(true)
  })

  test('清空某个会话不影响另一个会话的历史', () => {
    expect(shouldNudge('s1', [todo('a')])).toBe(true)
    expect(shouldNudge('s2', [todo('b')])).toBe(true)
    shouldNudge('s1', []) // 只清 s1
    expect(shouldNudge('s2', [todo('b')])).toBe(false) // s2 仍记得
  })
})

describe('formatNudge', () => {
  test('列出未完成项', () => {
    const msg = formatNudge([todo('写测试', 'in_progress'), todo('发布', 'pending')])
    expect(msg).toContain('「写测试」')
    expect(msg).toContain('「发布」')
  })

  test('超过 5 项只列前 5 条并给出总数', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(x => todo(x))
    const msg = formatNudge(list)
    expect(msg).toContain('「a」')
    expect(msg).toContain('「e」')
    expect(msg).not.toContain('「f」')
    expect(msg).toContain('等 7 项')
  })

  test('标明是引擎的检查，避免被当成用户发话', () => {
    expect(formatNudge([todo('a')])).toContain('引擎的收尾检查')
  })
})
