// ── 终端标签栏 · 是否滚动到最新标签的判定 ──
// 无 DOM 依赖。两种情况应滚动到最右显示最新标签：
//   1. 挂载期间新增标签（数量增长）
//   2. 首次挂载时已存在标签 —— 面板隐藏期间 agent 命令仍会堆积标签,
//      重新显示面板时若只在「增长」时滚动, 新标签会停在视野右侧外。

export function shouldScrollTabBar(prevCount: number, count: number, hasMounted: boolean): boolean {
  return count > prevCount || (!hasMounted && count > 0);
}
