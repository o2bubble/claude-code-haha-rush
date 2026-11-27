/**
 * PDF 内联数据不被支持的端点 —— 运行时探测 + 降级。
 *
 * ## 问题（2026-11-13 用户实测）
 *
 * 读 PDF 时 `FileReadTool` 会构造一个 `type:'document'` 的 content block，
 * 数据以 `source.type: 'base64'` 内联在请求里。官方 Anthropic API 接受这种写法，
 * 但**部分 Anthropic 兼容端点不接受**，直接 400：
 *
 *     messages.403.content.1.source: only file and text document sources
 *     are supported; upload the document through the Files API ...
 *
 * 而 `isPDFSupported()`（pdfUtils.ts）只排除了 `claude-3-haiku`，所以任何
 * 第三方模型都会走到这条路上。更糟的是那个 block 进了**对话历史**：
 * 之后每次请求都会把它重发一遍 → 每次都 400 → 整个会话卡死。
 *
 * ## 为什么是「反应式」而不是「按模型预判」
 *
 * 不能看模型名猜（`lesson_try_before_predict`：别按 host 预判 provider 能力）。
 * 同一个中转可能今天不支持、明天换个后端就支持了；反过来也会变。
 * 所以：先按原样发，**只有真的撞上这个错误**才降级，并记忆到进程结束。
 *
 * ## 降级之后 AI 怎么办
 *
 * 把 document 块替换成一段说明文字，告诉模型「这个 PDF 内容在这里拿不到，
 * 改用其它方式读」—— 模型会自己去用 pdftotext / python 之类的手段，
 * 而不是继续硬磕这个已经证实走不通的通道。
 */

import type {
  BetaContentBlockParam,
  BetaRequestDocumentBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/**
 * 只在**本进程**内记忆。不做持久化：
 * 换个端点/换台机器就该重新试一次，把一次失败固化到磁盘会让用户在
 * 支持的环境里也被永久降级。
 */
let documentSourceUnsupported = false

export function isDocumentSourceUnsupported(): boolean {
  return documentSourceUnsupported
}

export function markDocumentSourceUnsupported(): void {
  documentSourceUnsupported = true
}

/** 仅测试用：重置进程内状态。 */
export function resetDocumentSourceSupportForTest(): void {
  documentSourceUnsupported = false
}

/**
 * 这个 400 是不是「端点不支持 base64 document source」？
 *
 * 报错文本由官方 API 生成，措辞可能变；用几个稳定的片段做匹配，
 * 避免因为一处措辞调整就漏判（那会让用户继续卡在死循环里）。
 */
export function isDocumentSourceUnsupportedError(error: unknown): boolean {
  const e = error as { status?: number; message?: string } | null
  if (!e || e.status !== 400) return false
  const msg = String(e.message ?? '')
  return (
    msg.includes('document sources are supported') ||
    (msg.includes('source') && msg.includes('files-api')) ||
    msg.includes('only file and text document sources')
  )
}

/** 降级后塞进历史里的说明文字。 */
export const PDF_OMITTED_PLACEHOLDER =
  '[PDF omitted — this API endpoint does not accept inline PDF data. ' +
  'The document above could not be sent. To read its contents, use another ' +
  'route: run a shell command such as `pdftotext <file> -` (poppler), or a ' +
  "short Python script (pypdf/pdfplumber) to extract the text, then read that. " +
  'Do not retry reading the PDF the same way — it will fail again.]'

function downgradeBlock(block: BetaContentBlockParam): BetaContentBlockParam {
  if (
    block.type === 'document' &&
    (block as BetaRequestDocumentBlock).source?.type === 'base64'
  ) {
    return { type: 'text', text: PDF_OMITTED_PLACEHOLDER }
  }
  return block
}

/**
 * 把所有「内联 base64 的 document 块」替换成文本占位。
 *
 * 也处理嵌在 `tool_result.content` 里的情况 —— 读文件的结果通常是那样回来的，
 * 只处理顶层会漏掉最常见的形态。
 *
 * 不带标记时原样返回（零开销、不复制数组），所以可以无条件调用。
 */
export function downgradeDocumentBlocks<T extends { message: { content: unknown } }>(
  messages: T[],
): T[] {
  if (!documentSourceUnsupported) return messages

  return messages.map(msg => {
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    let changed = false
    const next = content.map((block: BetaContentBlockParam) => {
      const replaced = downgradeBlock(block)
      if (replaced !== block) {
        changed = true
        return replaced
      }
      // tool_result 里嵌套的媒体块
      if (
        block.type === 'tool_result' &&
        Array.isArray((block as { content?: unknown[] }).content)
      ) {
        const inner = (block as { content: BetaContentBlockParam[] }).content
        let innerChanged = false
        const innerNext = inner.map(b => {
          const r = downgradeBlock(b)
          if (r !== b) innerChanged = true
          return r
        })
        if (innerChanged) {
          changed = true
          return { ...block, content: innerNext } as BetaContentBlockParam
        }
      }
      return block
    })

    if (!changed) return msg
    return { ...msg, message: { ...msg.message, content: next } }
  })
}
