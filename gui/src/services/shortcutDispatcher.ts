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
    // 上下文型由各组件自己处理
    // `scope: "os"` 走 OS 级全局热键（见 globalShortcutService），**不能**在这里
    // 也匹配一遍 —— 否则 GUI 聚焦时同一次按键会触发两次（应用内 + 全局各一次）。
    // 不依赖"OS 热键会吞掉按键"这个平台行为：实测在部分输入法/远程桌面下不可靠。
    .filter((e) => !e.contextual && e.scope !== "os" && e.keys)
    .map((e) => ({ entry: e, parsed: parseKeys(e.keys) }));
}

/**
 * 编译缓存的**键**（纯函数，导出供单测）。
 *
 * 覆盖配置与动态条目都要进键：前者管"用户改了键"，后者管"插件装/卸/改了声明"。
 * 漏掉后者的话，装完插件快捷键表**永不刷新**（要重启才生效），卸了的插件命令
 * 还会继续被触发 —— 这是加动态条目时最容易漏的一处，故单独抽出来锁住。
 *
 * 只取决定匹配行为的字段（id/keys/scope/os），不整个 JSON 化 —— 避免 run 闭包
 * 等无关字段变化造成无意义的重新编译。
 */
export function bindingCacheKey(
  overrides: Record<string, string> | undefined,
  extra: ShortcutEntry[],
): string {
  // `undefined` 与 `{}` 语义相同（都是"没有覆盖"）—— 归一化，避免用户点
  // "全部恢复默认"（写入 `{}`）时白做一次重新编译。
  const ov = overrides && Object.keys(overrides).length > 0 ? overrides : null;
  return `${JSON.stringify(ov)}|${JSON.stringify(
    extra.map((e) => [e.id, e.keys, e.scope ?? "app", e.os ?? ""]),
  )}`;
}

/**
 * 启动分发器。
 *
 * @param getOverrides 读取用户覆盖配置。**每次按键都会调用**，改键后立即生效、
 *                     无需重启或监听设置变更事件。
 * @param getExtraEntries 读取**动态条目**（插件命令）。默认无。
 *
 * 性能：按「覆盖配置 + 动态条目」的**内容**缓存（JSON 化后的字符串），内容没变就
 * 复用上次的编译结果，不会每次按键都重新 resolve + parse。
 *
 * 为什么不按引用缓存：那要求调用方"每次改键都构造新对象"——一个隐式契约，
 * 将来有人原地改 `settings.shortcuts` 就会静默失效。按内容比较不依赖调用方习惯。
 * 两张表都极小（十几条），`JSON.stringify` 的开销可忽略。
 *
 * ⚠️ **动态条目必须进缓存键**：只按 overrides 缓存的话，装/卸插件不会改变
 * overrides → 编译结果**永不刷新** → 新插件的快捷键要重启才生效、卸载的插件
 * 快捷键继续触发。这是加动态条目时最容易漏的一处。
 *
 * 优先级：内置条目在前、动态条目追加在后 —— 与 `DEFAULT_SHORTCUTS` 的
 * 「顺序即优先级」一致，保证插件**不能**抢掉 F1 / Ctrl+R 这类内置键。
 */
export function startShortcutDispatcher(
  getOverrides: () => Record<string, string> | undefined,
  getExtraEntries?: () => ShortcutEntry[],
): DispatcherHandle {
  const isMac = isMacPlatform();
  let cachedKey: string | null = null;
  let compiled: ReturnType<typeof compile> = [];

  const currentBindings = () => {
    const overrides = getOverrides();
    const extra = getExtraEntries?.() ?? [];
    // 两段一起进键：overrides 变了要重编，动态条目变了（装/卸插件）同样要。
    const key = bindingCacheKey(overrides, extra);
    if (key !== cachedKey) {
      cachedKey = key;
      // extra 也要过 `resolveBindings` —— 否则用户给插件改的键不生效
      // （resolveBindings 的合并方向是 defaults.map，插件条目必须当 defaults 传进去）
      compiled = compile([
        ...resolveBindings(DEFAULT_SHORTCUTS, overrides),
        ...resolveBindings(extra, overrides),
      ]);
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
