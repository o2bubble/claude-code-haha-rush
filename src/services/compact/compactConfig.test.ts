import { expect, test } from 'bun:test'
import {
  DEFAULT_EXTRACT_SCRIPT,
  mergeExtractOutputIntoSummary,
  parseCompactExtractScript,
  parseCustomCompactPrompt,
  RAW_DATA_PLACEHOLDER,
  resolveCompactExtractScript,
} from './compactConfig.ts'

test('parseCustomCompactPrompt: 完整配置 append 模式', () => {
  expect(parseCustomCompactPrompt({ mode: 'append', text: '  focus on decisions  ' })).toEqual(
    { mode: 'append', text: 'focus on decisions' },
  )
})

test('parseCustomCompactPrompt: replace 模式', () => {
  expect(parseCustomCompactPrompt({ mode: 'replace', text: 'custom body' })).toEqual(
    { mode: 'replace', text: 'custom body' },
  )
})

test('parseCustomCompactPrompt: mode 非法值回退 append', () => {
  expect(parseCustomCompactPrompt({ mode: 'banana', text: 'hi' })).toEqual(
    { mode: 'append', text: 'hi' },
  )
})

test('parseCustomCompactPrompt: text 空/非字符串返回 null', () => {
  expect(parseCustomCompactPrompt({ mode: 'append', text: '   ' })).toBeNull()
  expect(parseCustomCompactPrompt({ mode: 'append', text: 42 })).toBeNull()
  expect(parseCustomCompactPrompt(null)).toBeNull()
  expect(parseCustomCompactPrompt('not object')).toBeNull()
  expect(parseCustomCompactPrompt(undefined)).toBeNull()
})

test('parseCompactExtractScript: 路径字符串直接返回', () => {
  expect(parseCompactExtractScript('C:\\scripts\\x.py')).toBe(
    'C:\\scripts\\x.py',
  )
})

test('parseCompactExtractScript: 空/非字符串/未配置返回空（不跑脚本）', () => {
  expect(parseCompactExtractScript('')).toBe('')
  expect(parseCompactExtractScript('   ')).toBe('')
  expect(parseCompactExtractScript(123)).toBe('')
  expect(parseCompactExtractScript(undefined)).toBe('')
  expect(parseCompactExtractScript(null)).toBe('')
})

test('resolveCompactExtractScript: 未配置(键不存在)回退到打包脚本预设', () => {
  expect(resolveCompactExtractScript(undefined)).toBe(DEFAULT_EXTRACT_SCRIPT)
  expect(resolveCompactExtractScript(null)).toBe(DEFAULT_EXTRACT_SCRIPT)
})

test('resolveCompactExtractScript: 显式留空保持"不跑"逻辑', () => {
  expect(resolveCompactExtractScript('')).toBe('')
  expect(resolveCompactExtractScript('   ')).toBe('')
})

test('resolveCompactExtractScript: 配置了路径按路径返回', () => {
  expect(resolveCompactExtractScript('C:\\x\\s.py')).toBe('C:\\x\\s.py')
})

test('DEFAULT_EXTRACT_SCRIPT 指向 handoff 脚本', () => {
  expect(DEFAULT_EXTRACT_SCRIPT).toContain('handoff-compact')
  expect(DEFAULT_EXTRACT_SCRIPT.endsWith('handoff_extract.py')).toBe(true)
})

test('mergeExtractOutputIntoSummary: 含占位符则替换', () => {
  const summary = `My summary\n\n${RAW_DATA_PLACEHOLDER}\n\nend`
  expect(
    mergeExtractOutputIntoSummary(summary, '## RAW CONTENT'),
  ).toBe('My summary\n\n## RAW CONTENT\n\nend')
})

test('mergeExtractOutputIntoSummary: 占位符多次出现全部替换', () => {
  const summary = `a ${RAW_DATA_PLACEHOLDER} b ${RAW_DATA_PLACEHOLDER} c`
  expect(mergeExtractOutputIntoSummary(summary, 'X')).toBe('a X b X c')
})

test('mergeExtractOutputIntoSummary: 无占位符追加到末尾', () => {
  expect(mergeExtractOutputIntoSummary('My summary', '## RAW')).toBe(
    'My summary\n\n## RAW',
  )
})

test('mergeExtractOutputIntoSummary: 产物为空原样返回', () => {
  expect(mergeExtractOutputIntoSummary('My summary', '   ')).toBe('My summary')
  expect(mergeExtractOutputIntoSummary('My summary', '')).toBe('My summary')
})

test('mergeExtractOutputIntoSummary: 产物为空时剥掉残留占位符', () => {
  expect(
    mergeExtractOutputIntoSummary(`a ${RAW_DATA_PLACEHOLDER} b`, ''),
  ).toBe('a  b')
  expect(
    mergeExtractOutputIntoSummary(`${RAW_DATA_PLACEHOLDER}end`, '   '),
  ).toBe('end')
})
