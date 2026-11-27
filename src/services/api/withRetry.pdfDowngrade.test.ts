/**
 * 端到端：撞上「不支持内联 PDF」的 400 → 降级标记打开 → 重试。
 *
 * 单测 pdfDocumentSupport 只证明「能清理历史」；这里证明**接线通了** ——
 * withRetry 真的会在那个错误上设标记并重发（而不是直接抛出 CannotRetryError）。
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { APIError } from '@anthropic-ai/sdk'
import {
  isDocumentSourceUnsupported,
  resetDocumentSourceSupportForTest,
} from '../../utils/pdfDocumentSupport.js'
import { withRetry } from './withRetry.js'

const PDF_ERROR_BODY = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      "messages.403.content.1.source: only file and text document sources are supported; upload the document through the Files API (purpose 'user_data') and reference its file_id",
  },
}

/** 把 SDK 的 APIError 造出来 —— 用真实构造器，保证 status/message 形态一致。 */
function pdfRejection(): APIError {
  return new APIError(
    400,
    PDF_ERROR_BODY,
    PDF_ERROR_BODY.error.message,
    new Headers(),
  )
}

/** 假 client：withRetry 只把它透传给 operation，这里用不到它的方法。 */
const fakeClient = {} as never
const getClient = async () => fakeClient

async function drain<T>(gen: AsyncGenerator<unknown, T>): Promise<T> {
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return r.value
}

describe('withRetry · PDF 降级', () => {
  beforeEach(() => resetDocumentSourceSupportForTest())

  it('400 → 设标记并重试；第二次成功返回', async () => {
    let calls = 0
    const result = await drain(
      withRetry(
        getClient,
        async () => {
          calls++
          if (calls === 1) throw pdfRejection()
          return { ok: true }
        },
        { model: 'some-relay-model', thinkingConfig: { type: 'disabled' } },
      ),
    )

    expect(calls).toBe(2) // 真的重发了
    expect(result).toEqual({ ok: true })
    expect(isDocumentSourceUnsupported()).toBe(true) // 标记留下，后续请求都会降级
  })

  it('降级后仍然失败 → 不再无限重试（标记只设一次）', async () => {
    let calls = 0
    await expect(
      drain(
        withRetry(
          getClient,
          async () => {
            calls++
            throw pdfRejection()
          },
          { model: 'some-relay-model', thinkingConfig: { type: 'disabled' } },
        ),
      ),
    ).rejects.toThrow()

    // 第一次降级重试 + 剩余的正常重试，绝不该因为同一个错误反复进入降级分支
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(calls).toBeLessThanOrEqual(12)
  })

  it('无关的 400 不触发降级', async () => {
    let calls = 0
    await expect(
      drain(
        withRetry(
          getClient,
          async () => {
            calls++
            throw new APIError(400, {}, 'invalid x-api-key', new Headers())
          },
          { model: 'some-relay-model', thinkingConfig: { type: 'disabled' } },
        ),
      ),
    ).rejects.toThrow()

    expect(calls).toBe(1) // 400 一般不重试
    expect(isDocumentSourceUnsupported()).toBe(false)
  })
})
