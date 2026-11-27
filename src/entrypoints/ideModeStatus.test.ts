import { describe, expect, it } from 'bun:test'
import { mapIdeStatus, formatCrossSessionMessage } from './ideMode.js'
import { CROSS_SESSION_MESSAGE_TAG } from '../constants/xml.js'

// ideMode 的状态词 → PID 文件里的 SessionStatus。
//
// 这条映射存在的理由：GUI/IDE 会话不渲染 REPL，REPL 里那段写状态的逻辑
// 在它们身上根本不执行，导致 ListAgents 里所有 GUI 会话状态永远是「未知」。
describe('mapIdeStatus', () => {
  it('ready → idle（等用户输入）', () => {
    expect(mapIdeStatus('ready')).toBe('idle')
  })

  it('thinking / compacting / interrupting → busy', () => {
    for (const s of ['thinking', 'compacting', 'interrupting']) {
      expect(mapIdeStatus(s)).toBe('busy')
    }
  })

  it('空值不猜（返回 null，调用方据此跳过写入）', () => {
    expect(mapIdeStatus(null)).toBeNull()
    expect(mapIdeStatus(undefined)).toBeNull()
    expect(mapIdeStatus('')).toBeNull()
  })

  it('没见过的状态词也不猜', () => {
    // 新增状态时会被漏掉 —— 宁可显示「未知」，也不要错报成"空闲"，
    // 那会让别的会话以为可以随便打断它。
    expect(mapIdeStatus('some-new-state')).toBeNull()
  })
})

// ── 跨会话消息包装 ──
//
// `SendMessage` 的 prompt 承诺消息会包成 `<cross-session-message from="...">`，
// 但格式化函数原本**不存在**（只有个没人用的常量）。收件端按这个形状识别，
// 所以包装格式是对外契约，不能随手改。
describe('formatCrossSessionMessage', () => {
  it('包成 XML，带上发件人地址', () => {
    expect(formatCrossSessionMessage('session-123', 'hi')).toContain(
      'from="session-123"',
    )
  })

  it('原文完整保留（包括换行和特殊字符）', () => {
    const text = '第一行\n第二行 <tag> & stuff'
    expect(formatCrossSessionMessage('session-1', text)).toContain(text)
  })

  it('标签名与常量一致', () => {
    expect(formatCrossSessionMessage('session-1', 'x')).toContain(
      `<${CROSS_SESSION_MESSAGE_TAG}`,
    )
  })
})
