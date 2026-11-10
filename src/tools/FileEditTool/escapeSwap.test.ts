import { describe, expect, it } from 'bun:test'
import {
  escapeSwapDirection,
  escapeUnicode,
  unescapeUnicode,
} from './utils.js'

describe('unescapeUnicode', () => {
  it('把字面 \\uXXXX 换成字符', () => {
    expect(unescapeUnicode('\\u4e2d\\u6587')).toBe('中文')
  })

  it('混合内容只换转义部分', () => {
    expect(unescapeUnicode('a\\u4e2db')).toBe('a中b')
  })

  it('没有转义时原样返回（=== 判等用得到）', () => {
    const s = 'plain text'
    expect(unescapeUnicode(s)).toBe(s)
  })

  it('非法转义不动（反斜杠 u 后面不是 4 位 hex）', () => {
    expect(unescapeUnicode('\\uZZZZ')).toBe('\\uZZZZ')
  })
})

describe('escapeUnicode', () => {
  it('非 ASCII 字符转成 \\uXXXX', () => {
    expect(escapeUnicode('中文')).toBe('\\u4e2d\\u6587')
  })

  it('ASCII 原样保留', () => {
    const s = 'abc 123!'
    expect(escapeUnicode(s)).toBe(s)
  })
})

describe('escapeSwapDirection', () => {
  it('含字面转义 → unescape', () => {
    expect(escapeSwapDirection('\\u4e2d')).toBe('unescape')
  })

  it('含非 ASCII → escape', () => {
    expect(escapeSwapDirection('中')).toBe('escape')
  })

  it('纯 ASCII 无可换 → null', () => {
    // 关键：返回 null 时调用方不该再拿原串试一遍
    expect(escapeSwapDirection('hello world')).toBeNull()
  })

  it('同时含两者时优先 unescape（与官方行为一致：先消转义）', () => {
    expect(escapeSwapDirection('\\u4e2d中')).toBe('unescape')
  })
})

// 端到端：真正的匹配入口是 applyEditToFile，不是 findActualString。
// 上一版把兜底只接在 FileEditTool 的 not-found 分支，实测完全没生效。
describe('applyEditToFile 的转义兜底', () => {
  it('old_string 是字面转义时也能命中真实字符', async () => {
    const { applyEditToFile } = await import('./utils.js')
    const file = '这是中文内容\n第二行\n'
    // String.raw：保留字面的「反斜杠 u 4e2d」，不被 TS 解析成真实字符
    const out = applyEditToFile(file, String.raw`这是\u4e2d\u6587内容`, '这是汉字内容')
    expect(out).toBe('这是汉字内容\n第二行\n')
  })

  it('命中后 new_string 也消转义（否则写进去的是字面反斜杠）', async () => {
    const { applyEditToFile } = await import('./utils.js')
    // 文件里是真实字符「中」；old/new 都用字面转义写法
    const out = applyEditToFile('a中b', String.raw`\u4e2d`, String.raw`\u5b57`)
    expect(out).toBe('a字b')
  })

  it('原样能匹配时不动用兜底（不改变正常行为）', async () => {
    const { applyEditToFile } = await import('./utils.js')
    expect(applyEditToFile('hello', 'hello', 'world')).toBe('world')
  })

  it('都匹配不上时保持原内容（调用方据此报 not found）', async () => {
    const { applyEditToFile } = await import('./utils.js')
    expect(applyEditToFile('hello', 'nonexistent', 'x')).toBe('hello')
  })
})
