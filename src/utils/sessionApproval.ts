/**
 * 跨会话审批 —— 让"没有界面的会话"把审批请求转发给一个真正有人看的窗口。
 *
 * ## 为什么需要
 *
 * 无窗口唤醒的会话（`--ide-mode --resume`，没有前端连上）走到需要审批的工具时，
 * `broadcastToAll(control_request)` 是发给**零个接收者**的，然后干等 300 秒超时。
 * 不补这条路，唤醒的会话一碰 Bash/Edit 就废。
 *
 * ## 为什么复用信箱而不是新造通道
 *
 * `teammateMailbox` 已经有锁、有 `permission_request` / `permission_response`
 * 两种消息格式、有 `permission_updates`（支持"总是允许"写入 settings）。
 * teammate 那套审批已跑通，这里只是换个寻址方式。
 *
 * ## 三个环节
 *
 *  ① 请求方（无界面会话）：`waitForMailboxPermission()` 把请求写进 originator
 *     邮箱，然后轮询**自己的**信箱等 `permission_response`。
 *  ② 转发方（有界面的会话）：收到 `permission_request` → 转成前端的
 *     `control_request` 弹窗（复用现有审批 UI），并记下 request_id → 谁发的。
 *  ③ 回程：前端 `control_response` 回来 → 按记录把结果写回请求方邮箱。
 */

import { logForDebugging } from './debug.js'

/** 唤醒方把自己的地址放在这个环境变量里传进来。 */
export const ORIGINATOR_ENV = 'CLAUDE_CODE_SESSION_ORIGINATOR'

/** 请求方等审批的上限。比原来的 300s 短得多 —— 无面板时没人会来救。 */
export const MAILBOX_APPROVAL_TIMEOUT_MS = 120_000

/** 发起唤醒的会话地址（`session-<pid>`）；不是被唤醒的进程则为 null。 */
export function getSessionOriginator(): string | null {
  const v = process.env[ORIGINATOR_ENV]
  return v && /^session-\d+$/.test(v) ? v : null
}

// ── ① 请求方：等待结果 ──

type Waiter = {
  resolve: (allow: boolean, updatedInput?: Record<string, unknown>) => void
}

const waiters = new Map<string, Waiter>()

/**
 * 等一条 `permission_response` 落到**自己**的信箱。
 *
 * 超时按**拒绝**处理（而不是抛错）：拒绝让模型自己换条路，而抛错会把
 * 整个回合打死 —— 一个没人搭理的审批不该毁掉整轮工作。
 */
export function waitForMailboxPermission(
  requestId: string,
  timeoutMs = MAILBOX_APPROVAL_TIMEOUT_MS,
): Promise<{ allow: boolean; updatedInput?: Record<string, unknown> }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiters.delete(requestId)
      logForDebugging(
        `[sessionApproval] 审批超时（${timeoutMs}ms），按拒绝处理: ${requestId}`,
      )
      resolve({ allow: false })
    }, timeoutMs)

    waiters.set(requestId, {
      resolve: (allow, updatedInput) => {
        clearTimeout(timer)
        resolve({ allow, updatedInput })
      },
    })
  })
}

/**
 * 收到 `permission_response` 时调用。返回 true 表示确实有人在等这个 id
 * （false = 过期/重复的响应，忽略即可）。
 */
export function deliverMailboxPermission(
  requestId: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
): boolean {
  const w = waiters.get(requestId)
  if (!w) return false
  waiters.delete(requestId)
  w.resolve(allow, updatedInput)
  return true
}

/** 测试用：清空所有待等待项。 */
export function _resetSessionApprovalForTest(): void {
  waiters.clear()
  forwarded.clear()
}

// ── ② 转发方：记住这条审批是谁发来的 ──

const forwarded = new Map<string, { from: string; at: number }>()

/** 转发一条审批请求给前端时，记下它的来源。 */
export function rememberForwardedRequest(requestId: string, from: string): void {
  forwarded.set(requestId, { from, at: Date.now() })
}

/**
 * 取出（并删除）某条被转发请求的来源地址。
 *
 * 用 get-and-delete 而不是 get：前端回响应只有一次，重复回响应不该再发一条
 * 信箱消息出去。
 */
export function takeForwardedRequest(requestId: string): string | null {
  const v = forwarded.get(requestId)
  if (!v) return null
  forwarded.delete(requestId)
  return v.from
}

/** 丢弃一条转发记录（用户取消 / 请求方已死）。 */
export function forgetForwardedRequest(requestId: string): void {
  forwarded.delete(requestId)
}

/** 有多少条转发出去、还没等到前端响应的请求（调试/诊断用）。 */
export function pendingForwardCount(): number {
  return forwarded.size
}
