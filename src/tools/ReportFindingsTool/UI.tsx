import type { ToolCall } from '../../types/tool.js'

export function renderToolUseMessage(_input: unknown, _context: unknown): string | null {
  return null
}

export function renderToolResultMessage(
  _data: unknown,
  _toolUseID: string,
  _call: ToolCall,
): string | null {
  return null
}
