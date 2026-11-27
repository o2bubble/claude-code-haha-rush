/**
 * PDF 内联数据降级。
 *
 * 背景：第三方 Anthropic 兼容端点可能不接受 base64 document source，
 * 直接 400。那个 block 进了对话历史后，**每次请求都会重发**，整个会话卡死。
 * 这里的测试锁定「撞上错误后能把历史清理干净」这件事。
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  PDF_OMITTED_PLACEHOLDER,
  downgradeDocumentBlocks,
  isDocumentSourceUnsupported,
  isDocumentSourceUnsupportedError,
  markDocumentSourceUnsupported,
  resetDocumentSourceSupportForTest,
} from './pdfDocumentSupport.js'

/** 用户实际收到的报错（2026-11-13）。 */
const REAL_ERROR = {
  status: 400,
  message:
    "messages.403.content.1.source: only file and text document sources are supported; upload the document through the Files API (purpose 'user_data') and reference its file_id",
}

const pdfBlock = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
}

const textBlock = { type: 'text', text: 'hello' }

const msg = (content: unknown[]) => ({ message: { content } })

describe('错误识别', () => {
  it('识别真实的 400', () => {
    expect(isDocumentSourceUnsupportedError(REAL_ERROR)).toBe(true)
  })

  it('只看 400，其它状态码不认', () => {
    expect(isDocumentSourceUnsupportedError({ ...REAL_ERROR, status: 500 })).toBe(false)
    expect(isDocumentSourceUnsupportedError({ ...REAL_ERROR, status: 429 })).toBe(false)
  })

  it('无关的 400 不误判', () => {
    expect(
      isDocumentSourceUnsupportedError({ status: 400, message: 'invalid x-api-key' }),
    ).toBe(false)
  })

  it('null / 非对象不炸', () => {
    expect(isDocumentSourceUnsupportedError(null)).toBe(false)
    expect(isDocumentSourceUnsupportedError(undefined)).toBe(false)
    expect(isDocumentSourceUnsupportedError('oops')).toBe(false)
  })
})

describe('降级', () => {
  beforeEach(() => resetDocumentSourceSupportForTest())

  it('没标记时原样返回（同一个数组引用，零开销）', () => {
    const msgs = [msg([pdfBlock])]
    expect(downgradeDocumentBlocks(msgs)).toBe(msgs)
  })

  it('标记后把顶层 document 换成文字占位', () => {
    markDocumentSourceUnsupported()
    const out = downgradeDocumentBlocks([msg([textBlock, pdfBlock])])
    const content = out[0].message.content as any[]
    expect(content[1]).toEqual({ type: 'text', text: PDF_OMITTED_PLACEHOLDER })
    expect(content[0]).toBe(textBlock) // 其它块不动
  })

  it('嵌在 tool_result 里的也降级（读文件的常见形态）', () => {
    markDocumentSourceUnsupported()
    const nested = { type: 'tool_result', tool_use_id: 't1', content: [pdfBlock] }
    const out = downgradeDocumentBlocks([msg([nested])])
    const inner = (out[0].message.content as any[])[0].content
    expect(inner[0].type).toBe('text')
    expect(inner[0].text).toBe(PDF_OMITTED_PLACEHOLDER)
  })

  it('多个 PDF 全部降级', () => {
    markDocumentSourceUnsupported()
    const out = downgradeDocumentBlocks([msg([pdfBlock, pdfBlock, pdfBlock])])
    const content = out[0].message.content as any[]
    expect(content.every((c: any) => c.type === 'text')).toBe(true)
  })

  it('非 base64 的 document（url/file 源）不碰', () => {
    markDocumentSourceUnsupported()
    const urlDoc = { type: 'document', source: { type: 'url', url: 'x' } }
    const out = downgradeDocumentBlocks([msg([urlDoc])])
    expect((out[0].message.content as any[])[0]).toBe(urlDoc)
  })

  it('content 不是数组的消息原样保留', () => {
    markDocumentSourceUnsupported()
    const plain = { message: { content: 'just a string' } }
    const out = downgradeDocumentBlocks([plain])
    expect(out[0]).toBe(plain)
  })

  it('占位文字明确告诉模型别再硬磕', () => {
    // 这条不是形式主义：模型看到 "Do not retry ... it will fail again"
    // 才会转去用 pdftotext / python，而不是反复 Read 同一个 PDF。
    expect(PDF_OMITTED_PLACEHOLDER).toMatch(/Do not retry/i)
    expect(PDF_OMITTED_PLACEHOLDER).toMatch(/pdftotext|python/i)
  })
})

describe('进程内记忆', () => {
  beforeEach(() => resetDocumentSourceSupportForTest())

  it('初始为 false，标记后为 true', () => {
    expect(isDocumentSourceUnsupported()).toBe(false)
    markDocumentSourceUnsupported()
    expect(isDocumentSourceUnsupported()).toBe(true)
  })

  it('重复标记不会出错', () => {
    markDocumentSourceUnsupported()
    markDocumentSourceUnsupported()
    expect(isDocumentSourceUnsupported()).toBe(true)
  })
})
