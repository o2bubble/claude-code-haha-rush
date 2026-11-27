import { afterEach, describe, expect, it } from 'bun:test'
import {
  _resetSessionApprovalForTest,
  MAILBOX_APPROVAL_TIMEOUT_MS,
  ORIGINATOR_ENV,
  deliverMailboxPermission,
  forgetForwardedRequest,
  getSessionOriginator,
  pendingForwardCount,
  rememberForwardedRequest,
  takeForwardedRequest,
  waitForMailboxPermission,
} from './sessionApproval.js'

afterEach(() => {
  _resetSessionApprovalForTest()
  delete process.env[ORIGINATOR_ENV]
})

describe('getSessionOriginator', () => {
  it('没设 → null（普通会话不是被唤醒的）', () => {
    expect(getSessionOriginator()).toBeNull()
  })

  it('合法地址 → 原样返回', () => {
    process.env[ORIGINATOR_ENV] = 'session-1234'
    expect(getSessionOriginator()).toBe('session-1234')
  })

  it('不合法的值 → null（不能拿它当收件人，会投错地方）', () => {
    for (const bad of ['', '1234', 'session-abc', 'session-12x', 'bridge:xyz']) {
      process.env[ORIGINATOR_ENV] = bad
      expect(getSessionOriginator()).toBeNull()
    }
  })
})

describe('waitForMailboxPermission / deliverMailboxPermission', () => {
  it('收到允许 → resolve(allow)', async () => {
    const p = waitForMailboxPermission('req-1')
    expect(deliverMailboxPermission('req-1', true)).toBe(true)
    expect(await p).toEqual({ allow: true, updatedInput: undefined })
  })

  it('收到拒绝 → resolve(deny)', async () => {
    const p = waitForMailboxPermission('req-2')
    deliverMailboxPermission('req-2', false)
    expect((await p).allow).toBe(false)
  })

  it('带回 updatedInput（用户在审批弹窗里改了参数）', async () => {
    const p = waitForMailboxPermission('req-3')
    deliverMailboxPermission('req-3', true, { command: 'ls -la' })
    expect((await p).updatedInput).toEqual({ command: 'ls -la' })
  })

  it('无人等待的响应 → 返回 false（过期/重复，不该崩）', () => {
    expect(deliverMailboxPermission('nobody', true)).toBe(false)
  })

  it('同一条响应只送达一次（避免重复 resolve 后又被删）', async () => {
    const p = waitForMailboxPermission('req-4')
    expect(deliverMailboxPermission('req-4', true)).toBe(true)
    await p
    expect(deliverMailboxPermission('req-4', true)).toBe(false)
  })

  it('超时按**拒绝**处理，而不是抛错', async () => {
    // 一条没人搭理的审批不该把整个回合打死 —— 拒绝让模型自己换条路。
    const r = await waitForMailboxPermission('req-timeout', 30)
    expect(r.allow).toBe(false)
    // 超时清理后，迟到的响应不该再找人
    expect(deliverMailboxPermission('req-timeout', true)).toBe(false)
  })

  it('超时默认值足够长（人工审批需要时间），但不能长到像卡死', () => {
    expect(MAILBOX_APPROVAL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    expect(MAILBOX_APPROVAL_TIMEOUT_MS).toBeLessThanOrEqual(300_000)
  })
})

describe('转发记录（request_id → 谁发来的）', () => {
  it('记住再取出 → 拿到来源地址', () => {
    rememberForwardedRequest('r1', 'session-42')
    expect(takeForwardedRequest('r1')).toBe('session-42')
  })

  it('take 是"取走"：第二次拿到 null（前端只回一次，不该重复写信箱）', () => {
    rememberForwardedRequest('r1', 'session-42')
    takeForwardedRequest('r1')
    expect(takeForwardedRequest('r1')).toBeNull()
  })

  it('没记过的 → null', () => {
    expect(takeForwardedRequest('unknown')).toBeNull()
  })

  it('forget 后取不到（用户取消 / 请求方已死）', () => {
    rememberForwardedRequest('r2', 'session-1')
    forgetForwardedRequest('r2')
    expect(takeForwardedRequest('r2')).toBeNull()
  })

  it('pendingForwardCount 反映未回应的转发数', () => {
    expect(pendingForwardCount()).toBe(0)
    rememberForwardedRequest('a', 'session-1')
    rememberForwardedRequest('b', 'session-2')
    expect(pendingForwardCount()).toBe(2)
    takeForwardedRequest('a')
    expect(pendingForwardCount()).toBe(1)
  })
})
