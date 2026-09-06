import type { Message as MessageType } from '../../types/message.js'
import { extractTextContent } from '../../utils/messages.js'

export const TRANSIENT_API_ERROR_PATTERN = /\btimed?\s*out\b/i

/** Pure: is this synthetic API-error message the transient kind (timeout /
 * rate limit / server error) that a single in-process retry may clear?
 * Auth, billing, invalid-request and max-output-tokens errors are
 * deterministic — retrying them won't help, so they skip the retry. */
export function isTransientApiErrorMessage(msg: MessageType): boolean {
  if (msg.type !== 'assistant' || !msg.isApiErrorMessage) return false
  if (msg.error === 'rate_limit' || msg.error === 'server_error') return true
  const text = extractTextContent(msg.message.content, '\n')
  return !!text && TRANSIENT_API_ERROR_PATTERN.test(text)
}
