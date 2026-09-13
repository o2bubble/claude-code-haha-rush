// ── 快捷键全局分发器 ──
//
// 一个 window 级 keydown 监听，按有效绑定表匹配 → 执行命令。
// 取代原先散落各处的 `window.addEventListener("keydown", ...)`（命令面板那份）。
//
// ## 匹配规则
//   · **顺序即优先级**：表内靠前者先匹配，命中即停（`stopImmediatePropagation`
//     不调用 —— 让事件继续走，避免吃掉组件的局部按键处理）
//   · **不匹配就完全不干预**：不 preventDefault，事件照常冒泡给组件
//
// ## 何时跳过（避免打断用户输入）
//   焦点在输入框 / textarea / contenteditable / Monaco 内时跳过**纯字符键**，
//   但**功能键与带修饰键的组合照常生效** —— 否则用户在输入框里按 F1 打不开
//   命令面板、按 Ctrl+, 打不开设置，是很别扭的。
//
//   带修饰键的组合仍然跳过**单字母无修饰**的情况（那些本来就是打字）。
//
// ## 与 Monaco 的关系
//   Monaco 自带 F1 / Ctrl+Shift+P 打开**编辑器内**命令面板。分发器在 Monaco 内
//   对「打开命令面板」条目让位（**按条目 id 判断，不按按键字面量** —— 用户改键后
//   仍要正确让位）。见 `YIELD_TO_MONACO_IDS`。

import { commandRegistry } from "./windowBus";
import {
  DEFAULT_SHORTCUTS, resolveBindings, parseKeys, matchesEvent, normalizeKeys,
  type ShortcutEntry,
} from "./shortcuts";
import { isMacPlatform } from "../utils/platform";

// 兼容既有 import 路径：多个组件从这里取 isMacPlatform。
// 实现已移到 utils/platform（通用工具，不属于分发器）。
export { isMacPlatform };

/** 编辑器容器选择器 —— 焦点在其中时把 F1 / Ctrl+Shift+P 让给 Monaco。 */
const MONACO_SELECTOR = ".monaco-editor";

/** 富文本编辑器容器（笔记的 Milkdown/ProseMirror）。 */
const RICH_TEXT_SELECTOR = ".ProseMirror, [contenteditable='true']";

/** 焦点是否在可编辑区域内（输入框、富文本、Monaco）。 */
function isEditingContext(): { editing: boolean; inMonaco: boolean } {
  if (typeof document === "undefined") return { editing: false, inMonaco: false };
  const el = document.activeElement as HTMLElement | null;
  if (!el) return { editing: false, inMonaco: false };
  const inMonaco = !!el.closest(MONACO_SELECTOR);
  const editing =
    inMonaco ||
    !!el.closest(RICH_TEXT_SELECTOR) ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable;
  return { editing, inMonaco };
}

/**
 * 在 Monaco 内应让位给编辑器自己的处理的条目 id。
 *
 * **按 id 而非按键字面量**判断 —— 用户可以把"打开命令面板"改绑到别的键，
 * 按字面量匹配会在改键后失配（该让位的没让，或不该让的让了）。
 * Monaco 自带 F1 / Ctrl+Shift+P 打开**编辑器内**的命令面板，那是它的既有行为。
 */
const YIELD_TO_MONACO_IDS = new Set(["palette.open", "palette.openAlt"]);

/**
 * 判断这次按键在当前上下文是否应当由分发器处理。
 *
 * 抽成纯函数便于单测 —— 这里的条件分支是本模块最容易出错的部分
 * （"为什么我在输入框里按快捷键没反应"类问题都源于此）。
 *
 * @param id   条目 id（用于 Monaco 让位判断，见 `YIELD_TO_MONACO_IDS`）
 * @param keys 该条目当前生效的键位（规范化字符串）
 */
export function shouldDispatch(
  id: string,
  keys: string,
  ctx: { editing: boolean; inMonaco: boolean },
): boolean {
  const norm = normalizeKeys(keys);
  if (!norm) return false;

  // Monaco 内把命令面板键让给编辑器（按 id 判断，改键后仍正确）
  if (ctx.inMonaco && YIELD_TO_MONACO_IDS.has(id)) return false;

  // 输入上下文：只放行「带修饰键的组合」与「功能键」，其余视为打字不拦截。
  //
  // 规则统一在**这两条**上，不再维护"白名单键位集合"—— 那曾是第二份权威且已失效
  // （名单里每个键都能被这两条覆盖）。统一后语义也更一致：任何带修饰键的组合都
  // 不该被输入框吞掉（用户按 Ctrl+某键显然是命令意图，不是打字）。
  if (ctx.editing) {
    const p = parseKeys(norm);
    const hasModifier = p.mod || p.ctrl || p.alt;
    if (!hasModifier && !/^f\d+$/.test(p.key)) return false;
  }
  return true;
}

export interface DispatcherHandle {
  /** 卸载监听。 */
  dispose(): void;
}

function compile(list: ShortcutEntry[]) {
  return list
    .filter((e) => !e.contextual && e.keys) // 上下文型由各组件自己处理
    .map((e) => ({ entry: e, parsed: parseKeys(e.keys) }));
}

/**
 * 启动分发器。
 *
 * @param getOverrides 读取用户覆盖配置。**每次按键都会调用**，改键后立即生效、
 *                     无需重启或监听设置变更事件。
 *
 * 性能：按覆盖对象的**内容**缓存（JSON 化后的字符串），内容没变就复用上次的
 * 编译结果，不会每次按键都重新 resolve + parse。
 *
 * 为什么不按引用缓存：那要求调用方"每次改键都构造新对象"——一个隐式契约，
 * 将来有人原地改 `settings.shortcuts` 就会静默失效。按内容比较不依赖调用方习惯。
 * 覆盖表极小（十几条），`JSON.stringify` 的开销可忽略。
 */
export function startShortcutDispatcher(
  getOverrides: () => Record<string, string> | undefined,
): DispatcherHandle {
  const isMac = isMacPlatform();
  let cachedKey: string | null = null;
  let compiled: ReturnType<typeof compile> = [];

  const currentBindings = () => {
    const overrides = getOverrides();
    const key = JSON.stringify(overrides ?? null);
    if (key !== cachedKey) {
      cachedKey = key;
      compiled = compile(resolveBindings(DEFAULT_SHORTCUTS, overrides));
    }
    return compiled;
  };

  // 首次编译（同时把缓存键置上，避免第一次按键重复编译）
  currentBindings();

  const handler = (e: KeyboardEvent) => {
    const ctx = isEditingContext();
    for (const { entry, parsed } of currentBindings()) {
      if (!matchesEvent(e, parsed, isMac)) continue;
      if (!shouldDispatch(entry.id, entry.keys, ctx)) continue;

      // 命中：阻止默认行为（如 Ctrl+, 在浏览器里的行为），但不 stopPropagation
      // —— 让事件继续走，避免吃掉组件的局部按键处理
      e.preventDefault();

      if (entry.commandId) commandRegistry.execute(entry.commandId);
      else if (entry.run) {
        try { entry.run(); } catch (err) { console.error(`[Shortcut] ${entry.id}:`, err); }
      }
      // 命中即停 —— 表内顺序即优先级（靠前者赢）
      return;
    }
  };

  window.addEventListener("keydown", handler);

  return {
    dispose() {
      window.removeEventListener("keydown", handler);
    },
  };
}
