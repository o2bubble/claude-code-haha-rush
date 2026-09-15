/**
 * Regression: stripping thinking from an assistant message must never leave an
 * empty content array.
 *
 * The API rejects empty content with
 *   `messages.N: all messages must have non-empty content`
 * and because the empty message is part of the conversation history, every
 * subsequent request fails the same way — the session is stuck.
 *
 * Why the existing guard does not cover this: normalizeMessagesForAPI's
 * ensureNonEmptyAssistantContent runs BEFORE the strip. At that point a
 * thinking-only message still holds [thinking] (length 1), so it looks
 * non-empty and passes. The strip then empties it, and nothing re-checks.
 *
 * Trigger observed in the wild: deepseek-v4-pro (a reasoning model) produced
 * 1038 thinking-only assistant messages in a single session; the same code on
 * deepseek-flash (715 thinking-only) never hit it. A thinking-only singleton is
 * normally a split sibling that gets merged with its text/tool_use partner —
 * when that merge does not happen, this path is reached alone.
 */

import { describe, expect, test } from 'bun:test'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { stripThinkingFromAssistantMessages } from './claude.js'
import { stripSignatureBlocks } from '../../utils/messages.js'

type Msg = { type: 'assistant'; message: { role: 'assistant'; content: any[]; id?: string } }

const assistant = (content: any[]): Msg => ({
  type: 'assistant',
  message: { role: 'assistant', content, id: 'msg_1' },
})

const thinking = () => ({ type: 'thinking', thinking: '...', signature: 'sig' })
const text = (t: string) => ({ type: 'text', text: t, citations: [] })
const toolUse = () => ({ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} })

/** content 是否非空，且不含空白的 text 块 */
function isSendable(content: any[]): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.some(b => {
    if (b.type !== 'text') return true
    return typeof b.text === 'string' && b.text.trim() !== ''
  })
}

describe('stripThinkingFromAssistantMessages', () => {
  test('thinking-only → 占位符，绝不留空数组', () => {
    const out = stripThinkingFromAssistantMessages([assistant([thinking()])] as any)
    const content = (out[0] as any).message.content
    expect(content.length).toBeGreaterThan(0)
    expect(isSendable(content)).toBe(true)
    expect(content[0].text).toBe(NO_CONTENT_MESSAGE)
  })

  test('thinking + text → 只留 text（不引入占位符）', () => {
    const out = stripThinkingFromAssistantMessages([
      assistant([thinking(), text('答案')]),
    ] as any)
    const content = (out[0] as any).message.content
    expect(content).toEqual([text('答案')])
  })

  test('thinking + tool_use → 只留 tool_use', () => {
    const out = stripThinkingFromAssistantMessages([
      assistant([thinking(), toolUse()]),
    ] as any)
    const content = (out[0] as any).message.content
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('tool_use')
  })

  test('无 thinking → 原样返回（同一对象引用，不做无谓复制）', () => {
    const input = [assistant([text('纯文本')])]
    const out = stripThinkingFromAssistantMessages(input as any)
    expect(out[0]).toBe(input[0])
  })

  test('多个 thinking-only → 每条都补占位符', () => {
    const out = stripThinkingFromAssistantMessages([
      assistant([thinking()]),
      assistant([thinking()]),
    ] as any)
    for (const m of out as any[]) {
      expect(isSendable(m.message.content)).toBe(true)
    }
  })
})

describe('stripSignatureBlocks', () => {
  test('thinking-only → 占位符，绝不留空数组', () => {
    const out = stripSignatureBlocks([assistant([thinking()])] as any)
    const content = (out[0] as any).message.content
    expect(content.length).toBeGreaterThan(0)
    expect(isSendable(content)).toBe(true)
  })

  test('thinking + text → 只留 text', () => {
    const out = stripSignatureBlocks([assistant([thinking(), text('保留')])] as any)
    expect((out[0] as any).message.content).toEqual([text('保留')])
  })

  test('非 assistant 消息不受影响', () => {
    const userMsg = { type: 'user', message: { role: 'user', content: 'hi' } }
    const out = stripSignatureBlocks([userMsg] as any)
    expect(out[0]).toBe(userMsg)
  })
})
