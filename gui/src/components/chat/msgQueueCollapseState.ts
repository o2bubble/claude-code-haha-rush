// ── 消息队列收起/展开状态机（纯函数可测）──
// 内容驱动 + 手动临时收起:
//   空队列 → stub(小占位条, 可点击展开看完整空态); 非空 → expanded(默认)
//   用户点收起 → slim(细条); 新入队 → 重新 expanded

export type QueueDisplay = "stub" | "slim" | "expanded";

export interface CollapseState {
  display: QueueDisplay;
  /** 用户是否手动收起(临时, 新入队会重置) */
  userCollapsed: boolean;
  /** 上次看到的队列长度 — 用于检测"新入队"(count 增加) */
  lastCount: number;
}

export function createCollapseState(initialCount = 0): CollapseState {
  return {
    display: initialCount > 0 ? "expanded" : "stub",
    userCollapsed: false,
    lastCount: initialCount,
  };
}

/** 队列长度变化时推进状态机。 */
export function onCountChange(s: CollapseState, n: number): CollapseState {
  if (n === 0) {
    return { display: "stub", userCollapsed: s.userCollapsed, lastCount: 0 };
  }
  if (n > s.lastCount) {
    // 新入队 → 重新展开, 重置手动收起
    return { display: "expanded", userCollapsed: false, lastCount: n };
  }
  // 消化中或数量不变 → 按当前手动状态
  return { display: s.userCollapsed ? "slim" : "expanded", userCollapsed: s.userCollapsed, lastCount: n };
}

/** 点击占位条(stub) → 展开看完整界面(空态占位)。其他态无操作。 */
export function onClickStub(s: CollapseState): CollapseState {
  if (s.display !== "stub") return s;
  return { ...s, display: "expanded" };
}

/** 用户点收起: expanded → slim(非空) 或 stub(空)。其他态无操作。 */
export function onCollapse(s: CollapseState): CollapseState {
  if (s.display !== "expanded") return s;
  if (s.lastCount === 0) return { ...s, display: "stub" };
  return { ...s, display: "slim", userCollapsed: true };
}

/** 用户点展开: slim → expanded。其他态无操作。 */
export function onExpand(s: CollapseState): CollapseState {
  if (s.display !== "slim") return s;
  return { ...s, display: "expanded", userCollapsed: false };
}
