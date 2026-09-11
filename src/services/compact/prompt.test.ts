import { expect, test } from 'bun:test'
import {
  getCompactPrompt,
  getPartialCompactPrompt,
} from './prompt.ts'

const NO_TOOLS_LEAD = 'CRITICAL: Respond with TEXT ONLY'
const NO_TOOLS_TAIL = 'REMINDER: Do NOT call any tools'
const BUILTIN_MARKER = 'Your task is to create a detailed summary of the conversation'

test('getCompactPrompt: 无配置返回内置提示词（含护栏）', () => {
  const p = getCompactPrompt()
  expect(p.includes(BUILTIN_MARKER)).toBe(true)
  expect(p.includes(NO_TOOLS_LEAD)).toBe(true)
  expect(p.includes(NO_TOOLS_TAIL)).toBe(true)
  expect(p.includes('Additional Instructions')).toBe(false)
})

test('getCompactPrompt: customInstructions 追加为 Additional Instructions', () => {
  const p = getCompactPrompt('my extra notes', { mode: 'append', text: 'x' })
  expect(p.includes(BUILTIN_MARKER)).toBe(true)
  expect(p.includes('Additional Instructions:\nmy extra notes')).toBe(true)
})

test('getCompactPrompt: append 模式保留内置主体 + 追加配置文本', () => {
  const p = getCompactPrompt(undefined, { mode: 'append', text: 'focus decisions' })
  expect(p.includes(BUILTIN_MARKER)).toBe(true)
  expect(p.includes('Additional Instructions:\nfocus decisions')).toBe(true)
})

test('getCompactPrompt: replace 模式替换主体、保留护栏、不追加配置文本', () => {
  const p = getCompactPrompt(undefined, { mode: 'replace', text: 'MY FULL CUSTOM BODY' })
  expect(p.includes('MY FULL CUSTOM BODY')).toBe(true)
  expect(p.includes(BUILTIN_MARKER)).toBe(false)
  expect(p.includes(NO_TOOLS_LEAD)).toBe(true)
  expect(p.includes(NO_TOOLS_TAIL)).toBe(true)
  expect(p.includes('Additional Instructions')).toBe(false)
})

test('getCompactPrompt: replace 模式 + 命令 customInstructions 仍追加', () => {
  const p = getCompactPrompt('/compact 用户指令', {
    mode: 'replace',
    text: 'MY BODY',
  })
  expect(p.includes('MY BODY')).toBe(true)
  expect(p.includes('Additional Instructions:\n/compact 用户指令')).toBe(true)
})

test('getCompactPrompt: replace 但无 customText 回退内置', () => {
  const p = getCompactPrompt(undefined, { mode: 'replace' })
  expect(p.includes(BUILTIN_MARKER)).toBe(true)
})

test('getPartialCompactPrompt: replace 模式替换局部主体', () => {
  const p = getPartialCompactPrompt(undefined, 'from', {
    mode: 'replace',
    text: 'PARTIAL CUSTOM BODY',
  })
  expect(p.includes('PARTIAL CUSTOM BODY')).toBe(true)
  expect(p.includes(NO_TOOLS_LEAD)).toBe(true)
  expect(p.includes(NO_TOOLS_TAIL)).toBe(true)
})

test('getPartialCompactPrompt: 无配置返回内置局部提示词', () => {
  const p = getPartialCompactPrompt(undefined, 'up_to')
  expect(p.includes('recent messages') || p.includes('continuing session')).toBe(true)
  expect(p.includes(NO_TOOLS_LEAD)).toBe(true)
})
