import { describe, expect, test } from 'bun:test'
import { enforceToolBlockOrdering } from './messages.js'

type Kind = 'text' | 'thinking' | 'tool_use' | 'tool_result'

function msg(role: 'user' | 'assistant', kinds: Kind[]) {
  return {
    type: role,
    uuid: Math.random().toString(36).slice(2),
    message: {
      role,
      content: kinds.map((t, i) => {
        if (t === 'tool_use') return { type: t, id: `tu${i}`, name: 'Bash', input: {} }
        if (t === 'tool_result') return { type: t, tool_use_id: `tu${i}`, content: 'ok' }
        if (t === 'thinking') return { type: t, thinking: 'x', signature: 's' }
        return { type: t, text: 'x' }
      }),
    },
  } as never
}

const kindsOf = (m: unknown): string =>
  (
    (m as { message: { content: { type: string }[] } }).message.content
  )
    .map(b => b.type)
    .join(',')

describe('enforceToolBlockOrdering', () => {
  test('assistant: tool_use already last → untouched', () => {
    const m = msg('assistant', ['thinking', 'text', 'tool_use'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('thinking,text,tool_use')
  })

  test('assistant: text after tool_use (2026-10-09 transcript incident) → moved to end', () => {
    const m = msg('assistant', ['thinking', 'tool_use', 'text'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('thinking,text,tool_use')
  })

  test('assistant: single tool_use → untouched', () => {
    const m = msg('assistant', ['tool_use'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('tool_use')
  })

  test('assistant: consecutive tool_uses stay grouped at end', () => {
    const m = msg('assistant', ['text', 'tool_use', 'tool_use'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('text,tool_use,tool_use')
  })

  test('user: tool_result already leading → untouched', () => {
    const m = msg('user', ['tool_result', 'text'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('tool_result,text')
  })

  test('user: text before tool_result → result hoisted to front', () => {
    const m = msg('user', ['text', 'tool_result'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('tool_result,text')
  })

  test('user: results split by text → all results first, stable within groups', () => {
    const m = msg('user', ['tool_result', 'text', 'tool_result'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('tool_result,tool_result,text')
  })

  test('user: only results → untouched', () => {
    const m = msg('user', ['tool_result', 'tool_result'])
    expect(kindsOf(enforceToolBlockOrdering([m])[0])).toBe('tool_result,tool_result')
  })

  test('string-content message passes through', () => {
    const m = { type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' } }
    expect(enforceToolBlockOrdering([m] as never)[0]).toEqual(m as never)
  })
})
