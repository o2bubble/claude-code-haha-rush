import { describe, expect, it } from 'bun:test'
import type { AssistantMessage, Message as MessageType } from '../../types/message.js'
import { isTransientApiErrorMessage } from './transientApiError.js'

function apiErrorMessage(fields: {
  content: string
  error?: AssistantMessage['error']
  isApiErrorMessage?: boolean
}): MessageType {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: fields.content }],
    },
    isApiErrorMessage: fields.isApiErrorMessage ?? true,
    error: fields.error,
  } as unknown as MessageType
}

describe('isTransientApiErrorMessage', () => {
  it('timeout text is transient (no error enum)', () => {
    const m = apiErrorMessage({ content: 'API Error: The operation timed out.' })
    expect(isTransientApiErrorMessage(m)).toBe(true)
  })

  it('rate_limit enum is transient regardless of text', () => {
    const m = apiErrorMessage({ content: 'API Error: whatever', error: 'rate_limit' })
    expect(isTransientApiErrorMessage(m)).toBe(true)
  })

  it('server_error enum is transient', () => {
    const m = apiErrorMessage({ content: 'API Error: 500', error: 'server_error' })
    expect(isTransientApiErrorMessage(m)).toBe(true)
  })

  it('auth failure is NOT transient', () => {
    const m = apiErrorMessage({ content: 'API Error: invalid api key', error: 'authentication_failed' })
    expect(isTransientApiErrorMessage(m)).toBe(false)
  })

  it('billing error is NOT transient', () => {
    const m = apiErrorMessage({ content: 'Credit balance is too low', error: 'billing_error' })
    expect(isTransientApiErrorMessage(m)).toBe(false)
  })

  it('invalid_request is NOT transient', () => {
    const m = apiErrorMessage({ content: 'API Error: 400 bad request', error: 'invalid_request' })
    expect(isTransientApiErrorMessage(m)).toBe(false)
  })

  it('non-error assistant message is NOT transient', () => {
    const m = apiErrorMessage({ content: 'The operation timed out', isApiErrorMessage: false })
    expect(isTransientApiErrorMessage(m)).toBe(false)
  })

  it('user message is NOT transient', () => {
    const m = { type: 'user', message: { role: 'user', content: 'timed out' } } as unknown as MessageType
    expect(isTransientApiErrorMessage(m)).toBe(false)
  })
})
