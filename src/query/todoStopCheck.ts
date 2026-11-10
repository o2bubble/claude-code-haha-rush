/**
 * 收尾检查：todo 列表还没做完就结束了吗？
 *
 * 干到一半开始收尾、忘了把 todo 标完成，是常见的收尾遗漏。影响不大，
 * 但用户每次看到一堆僵尸待办都别扭，所以在这里兜一道。
 *
 * ## 为什么判据是「appState.todos 非空」
 *
 * `TodoWriteTool` 在**全部完成时会把列表清空**（`allDone → []`），所以
 * 会话状态里剩下来的必然含未完成项 —— 不需要自己过滤 status，
 * 也不会误报"已经做完只是没清"的情况。
 *
 * ## 为什么不是 hook 脚本
 *
 * 这是引擎自身的行为，与 GUI 无关；写成外部脚本就要挑一个运行时
 * （python / bash / node），而纯命令行安装不一定有。做成内置检查：
 * 零依赖、零子进程、跟着二进制一起分发。
 */

import type { TodoList } from '../utils/todo/types.js'

/** 一次提醒里最多列几项 —— 太长会淹没真正要说的那句话。 */
const MAX_LISTED = 5

/** 已经提醒过的待办组合（`todoKey + 内容指纹`）。 */
const nudged = new Set<string>()

/** 内容指纹：只看未完成项的文案，不看顺序与 activeForm。 */
function signature(todos: TodoList): string {
  return todos
    .map(t => t.content.trim())
    .filter(Boolean)
    .sort()
    .join('\u0000')
}

/**
 * 该不该就这批待办提醒一次。
 *
 * 同一批待办**只提醒一次** —— 模型解释清楚（"用户说剩下的不做了"）之后再收尾
 * 就放行，下一轮也不会重复唠叨。待办变了（做掉一项、加了新项）才会再提醒，
 * 那时确实又有新信息。
 *
 * @param todoKey 会话/子代理标识（同 TodoWriteTool 的口径）
 */
export function shouldNudge(
  todoKey: string,
  todos: TodoList,
): boolean {
  if (todos.length === 0) {
    // 清空了 —— 忘掉历史，下次再有待办会重新提醒
    forget(todoKey)
    return false
  }
  const key = `${todoKey}\u0001${signature(todos)}`
  if (nudged.has(key)) return false
  nudged.add(key)
  return true
}

/** 清掉某个会话的提醒历史（清空 todo 时调用）。 */
function forget(todoKey: string): void {
  const prefix = `${todoKey}\u0001`
  for (const key of nudged) {
    if (key.startsWith(prefix)) nudged.delete(key)
  }
}

/** 组给模型看的提醒文案。 */
export function formatNudge(todos: TodoList): string {
  const pending = todos.filter(t => t.status !== 'completed')
  const listed = pending.slice(0, MAX_LISTED).map(t => `「${t.content}」`)
  const more = pending.length > MAX_LISTED ? ` 等 ${pending.length} 项` : ''
  return (
    'TodoWrite 里还有没标完成的项：' +
    listed.join('、') +
    more +
    '。请确认这些是否真的做完了 —— 做完了就更新 todo 状态，' +
    '没做完就说明还剩什么。（这是引擎的收尾检查，不是用户说的）'
  )
}

/** 仅供测试：清空全局状态。 */
export function _resetNudgeStateForTest(): void {
  nudged.clear()
}
