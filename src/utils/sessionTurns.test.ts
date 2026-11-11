import { describe, expect, test } from 'bun:test'
import {
  deleteTurns,
  groupTurns,
  isTurnStart,
  validateAfterDelete,
  type TranscriptEntry,
} from './sessionTurns.js'

/** 造一条链式记录。 */
const e = (
  type: string,
  uuid: string,
  parentUuid: string | null,
  content?: unknown,
): TranscriptEntry => ({
  type,
  uuid,
  parentUuid,
  ...(content !== undefined
    ? { message: { content } }
    : {}),
})

const userText = (uuid: string, parent: string | null, text: string) =>
  e('user', uuid, parent, text)
const assistantText = (uuid: string, parent: string | null, text: string) =>
  e('assistant', uuid, parent, [{ type: 'text', text }])
const toolResultUser = (uuid: string, parent: string | null) =>
  e('user', uuid, parent, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])

describe('isTurnStart —— 区分「人打的字」和「工具返回」', () => {
  test('纯文本 user 消息是轮起点', () => {
    expect(isTurnStart(userText('u1', null, '帮我改个 bug'))).toBe(true)
  })

  test('全是 tool_result 的 user 消息不是轮起点', () => {
    expect(isTurnStart(toolResultUser('u2', 'a1'))).toBe(false)
  })

  test('isMeta / 压缩摘要 / 仅记录用 都不是轮起点', () => {
    expect(isTurnStart({ ...userText('u3', null, 'x'), isMeta: true })).toBe(false)
    expect(isTurnStart({ ...userText('u4', null, 'x'), isCompactSummary: true })).toBe(false)
    expect(isTurnStart({ ...userText('u5', null, 'x'), isVisibleInTranscriptOnly: true })).toBe(false)
  })

  test('空内容不是轮起点', () => {
    expect(isTurnStart(userText('u6', null, '   '))).toBe(false)
  })

  test('assistant 永远不是轮起点', () => {
    expect(isTurnStart(assistantText('a1', null, 'hi'))).toBe(false)
  })
})

describe('groupTurns', () => {
  const entries: TranscriptEntry[] = [
    // 轮前的附件（不可删）
    e('attachment', 'att1', null),
    userText('u1', 'att1', '第一个问题'),
    assistantText('a1', 'u1', '回答一'),
    e('user', 'tr1', 'a1', [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }]),
    assistantText('a2', 'tr1', '回答二'),
    userText('u2', 'a2', '第二个问题'),
    assistantText('a3', 'u2', '回答三'),
  ]

  test('按真实用户输入切分，工具返回归入上一轮', () => {
    const turns = groupTurns(entries)
    expect(turns).toHaveLength(2)
    expect(turns[0].id).toBe('u1')
    expect(turns[0].uuids).toEqual(['u1', 'a1', 'tr1', 'a2'])
    expect(turns[1].id).toBe('u2')
    expect(turns[1].uuids).toEqual(['u2', 'a3'])
  })

  test('预览取用户输入的文本', () => {
    expect(groupTurns(entries)[0].preview).toBe('第一个问题')
  })

  test('没有任何用户输入 → 零轮', () => {
    expect(groupTurns([e('attachment', 'x', null)])).toHaveLength(0)
  })
})

describe('deleteTurns —— 删中间一轮并修复链表', () => {
  const entries: TranscriptEntry[] = [
    userText('u1', null, '第一轮'),
    assistantText('a1', 'u1', '答一'),
    userText('u2', 'a1', '第二轮'),
    assistantText('a2', 'u2', '答二'),
    userText('u3', 'a2', '第三轮'),
    assistantText('a3', 'u3', '答三'),
  ]

  test('删中间一轮后，后续条目的 parentUuid 指向被删轮的父', () => {
    const r = deleteTurns(entries, ['u2'])
    expect(r.removedCount).toBe(2)
    expect(r.rejected).toEqual([])
    // 剩下 u1, a1, u3, a3
    const byUuid = new Map(r.entries.map(x => [x.uuid!, x]))
    expect(byUuid.has('u2')).toBe(false)
    expect(byUuid.get('u3')!.parentUuid).toBe('a1')
    expect(r.repairedCount).toBe(1)
  })

  test('删完仍然是一条完整链（每个 parentUuid 都能找到）', () => {
    const r = deleteTurns(entries, ['u2'])
    expect(validateAfterDelete(r.entries)).toEqual({ ok: true })
  })

  test('连续删两轮（中间夹着）→ 链式解析到最近幸存祖先', () => {
    const r = deleteTurns(entries, ['u2', 'u3'])
    expect(r.removedCount).toBe(4)
    expect(validateAfterDelete(r.entries)).toEqual({ ok: true })
    // 只剩 u1 + a1，a1 的父不变
    expect(r.entries.map(x => x.uuid)).toEqual(['u1', 'a1'])
  })

  test('删最后一轮不影响前面的链', () => {
    const r = deleteTurns(entries, ['u3'])
    expect(r.repairedCount).toBe(0)
    expect(r.entries.map(x => x.uuid)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  test('未知 turn id 被拒绝', () => {
    const r = deleteTurns(entries, ['nope'])
    expect(r.rejected).toEqual(['nope'])
    expect(r.removedCount).toBe(0)
  })

  test('不改动传入的数组（纯函数）', () => {
    const snapshot = JSON.stringify(entries)
    deleteTurns(entries, ['u2'])
    expect(JSON.stringify(entries)).toBe(snapshot)
  })

  test('保留非链条目（摘要、元数据）', () => {
    const withMeta: TranscriptEntry[] = [
      ...entries,
      { type: 'custom-title', customTitle: '标题', sessionId: 's' },
      { type: 'summary', summary: '摘要', leafUuid: 'a3' },
    ]
    const r = deleteTurns(withMeta, ['u2'])
    expect(r.entries.some(x => x.type === 'custom-title')).toBe(true)
    expect(r.entries.some(x => x.type === 'summary')).toBe(true)
  })
})

describe('validateAfterDelete —— 挡住"删完打不开"', () => {
  test('全删光 → 拒绝', () => {
    expect(validateAfterDelete([])).toEqual({
      ok: false,
      reason: '删完就没有任何消息了，这条会话会打不开',
    })
  })

  test('链没有根（所有 parentUuid 都非空）→ 拒绝', () => {
    const orphan: TranscriptEntry[] = [
      { type: 'user', uuid: 'u1', parentUuid: 'gone', message: { content: 'x' } },
    ]
    const r = validateAfterDelete(orphan)
    expect(r.ok).toBe(false)
  })

  test('链完整 → 通过', () => {
    const ok: TranscriptEntry[] = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'x' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'y' } },
    ]
    expect(validateAfterDelete(ok)).toEqual({ ok: true })
  })
})
