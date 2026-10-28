// ── 输入框（contentEditable）的撤销 / 重做栈 ──
//
// 为什么不用浏览器原生 undo（用户反馈 2026-10-28：「Ctrl+Z 撤销结果乱七八糟，
// 根本不是返回编辑的上一步结果」）：
//
//   composer 的 DOM 有大量**代码直接写入**——引用 chip（contentEditable=false 的
//   嵌套 span）、粘贴、面板「发送到聊天」、斜杠命令补全（两次 innerHTML=""）、
//   发送后清空。这些程序化写入不进 Chromium 的 undo 栈，而它自己的栈里还留着
//   改动前的旧快照。两者一混，Ctrl+Z 就会拼出「半截 chip + 文本错位 + 光标乱跳」。
//
// 改成**快照式**：把 innerHTML + 光标偏移存进自己的栈，Ctrl+Z 直接恢复上一份
// 快照。DOM 是唯一事实来源 —— 存什么就能一模一样地还原什么，不依赖浏览器
// 内部对 contentEditable 的编辑推测。
//
// 本文件只放纯逻辑（不碰 DOM），便于单测；DOM 部分在 InputArea 里。

export interface ComposerSnapshot {
  /** 容器 innerHTML（含 chip 的内联样式与 data-ref，可原样还原） */
  html: string;
  /** 光标在「文本字符 + chip 引用长度」坐标系里的偏移；-1 = 未记录 */
  caret: number;
}

/**
 * 一次快照的成因。
 *
 * - `typing`：用户连续键入 —— **按时间合并**成一步（否则 Ctrl+Z 一次只退一个字符）
 * - `edit`：结构性改动（chip / 粘贴 / 命令补全 / 面板插入）—— 永远独立成步，
 *   绝不与键入合并
 */
export type SnapshotKind = "typing" | "edit";

export interface ComposerUndo {
  /** 记录当前状态。`now` 由调用方传入（便于测试注入时钟）。 */
  record(snap: ComposerSnapshot, kind: SnapshotKind, now: number): void;
  /** 撤销一步；没有可撤销的返回 null */
  undo(): ComposerSnapshot | null;
  /** 重做一步；没有可重做的返回 null */
  redo(): ComposerSnapshot | null;
  /** 清空整段历史（发送后调用 —— 已发出去的内容不该再被撤销回输入框） */
  reset(snap?: ComposerSnapshot): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 当前（最新）快照；空栈时为 null */
  current(): ComposerSnapshot | null;
}

export interface UndoOptions {
  /** 最多保留多少步（超出丢最旧的） */
  limit?: number;
  /** 连续键入在这个间隔内合并成一步 */
  coalesceMs?: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_COALESCE_MS = 800;

export function createComposerUndo(opts: UndoOptions = {}): ComposerUndo {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;

  /** 历史状态（不含 current）：末尾是"最近一次被替换掉的旧状态" */
  let past: ComposerSnapshot[] = [];
  /** 重做栈 */
  let future: ComposerSnapshot[] = [];
  let current: ComposerSnapshot | null = null;

  /** 上一次 record 的成因与时刻 —— 仅用于判断能否与这次键入合并 */
  let lastKind: SnapshotKind | null = null;
  let lastAt = 0;
  /**
   * 当前这轮键入是否**已经**把"键入前状态"压进 past。
   *
   * 合并的前提是：past 里已有这段键入开始前的样子。基线那次 record
   * （lastKind 可能也是 typing）并没有压栈 —— 若不当心把它也算作"可合并"，
   * 第一段键入会整段丢失，Ctrl+Z 什么也退不回去（写测试时抓到的）。
   */
  let runOpen = false;

  const pushPast = (s: ComposerSnapshot) => {
    past.push(s);
    // 超限丢最旧的：用户按 Ctrl+Z 时最想回到的是"刚才"，不是"今天早上"
    if (past.length > limit) past = past.slice(past.length - limit);
  };

  return {
    record(snap, kind, now) {
      if (current === null) {
        // 第一次记录：只当作基线，不产生"可撤销的一步"
        current = snap;
        lastKind = kind;
        lastAt = now;
        runOpen = false;
        return;
      }
      if (snap.html === current.html) {
        // 内容没变（可能只是光标动了）—— 不记步，也不刷新合并窗口：
        // 刷新会让"停顿一会儿再打字"仍然并进上一段，与时间分组相悖。
        return;
      }

      // 连续键入合并：不把 current 压进 past，直接推进 current ——
      // 于是整段键入只对应 past 里的**一个**旧状态。
      const canMerge =
        kind === "typing" && lastKind === "typing" && runOpen && now - lastAt <= coalesceMs;

      if (!canMerge) {
        pushPast(current);
        future = []; // 新分支 → 丢弃重做栈（与所有编辑器一致）
      }
      current = snap;
      // 只有"这步是键入、且它的前状态已入栈"时，后续键入才能继续并进来
      runOpen = kind === "typing";
      lastKind = kind;
      lastAt = now;
    },

    undo() {
      if (past.length === 0 || current === null) return null;
      future.push(current);
      const prev = past.pop()!;
      current = prev;
      // 撤销后光标往往不在编辑器里，下一次键入必须**另起一步**
      lastKind = null;
      runOpen = false;
      return prev;
    },

    redo() {
      if (future.length === 0 || current === null) return null;
      pushPast(current);
      const next = future.pop()!;
      current = next;
      lastKind = null;
      runOpen = false;
      return next;
    },

    reset(snap) {
      past = [];
      future = [];
      current = snap ?? null;
      lastKind = null;
      lastAt = 0;
      runOpen = false;
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    current: () => current,
  };
}
