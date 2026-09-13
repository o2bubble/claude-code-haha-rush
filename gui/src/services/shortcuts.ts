// ── 快捷键系统 ──
//
// ## 定位
// 应用级快捷键的**唯一真相源**。只管「无论在哪个面板都生效」的键；
// 对话框里的 Esc/Enter、列表上下键等局部交互键不纳入（它们的语义强依赖
// 上下文，纳入会让冲突检测失去意义）。
//
// ## 三种类型（决定能否被用户修改）
//   1. **全局** —— 任何地方生效（命令面板、硬刷新）。可改。
//   2. **命令型** —— 走 commandRegistry 的功能（面板切换、设置）。可改。
//   3. **上下文型** —— 依赖焦点/挂载状态（笔记 Ctrl+N/K/E、文件树 Ctrl+C/V）。
//      **标 `contextual: true`，设置面板只读展示**：改了键也可能因条件不满足
//      而不生效，让用户改反而是误导。
//
// ## 存储格式：规范化字符串
// `"mod+shift+p"` —— 小写、修饰键顺序固定（mod → ctrl → alt → shift → 键名）。
// 内存里解析成结构化对象使用。**`mod` 抽象是必需的**：它表示「Ctrl（Win/Linux）
// 或 Cmd（mac）」，让「切换左面板」这类概念在两平台用同一份配置表达。
//
// ## B（OS 级全局热键）的预留
// 每条带 `scope` 与可选 `os` 字段。将来接 Tauri global-shortcut 时，
// 筛选 `scope === "os"` 的条目即可直接注册（该插件要的正是「键 + 作用域」）。
// **本期不实现** —— 只保证数据形状够用。

import { Commands } from "./commands";

/** 修饰键。`mod` = Ctrl（Win/Linux）/ Cmd（mac），渲染时按平台展开。 */
export type Modifier = "mod" | "ctrl" | "alt" | "shift";

/** 解析后的键位（结构化，供匹配与 OS 注册使用）。 */
export interface ParsedKey {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** `KeyboardEvent.key` 的小写值（如 "p" / "f1" / "arrowup"） */
  key: string;
}

/** 条目作用域。本期只产出 `app`；`os` 为 B 预留。 */
export type ShortcutScope = "app" | "os";

export interface ShortcutEntry {
  /** 功能 ID —— 表内唯一，也是用户覆盖配置的 key */
  id: string;
  /** 默认键位（规范化字符串）。空字符串 = 默认无绑定 */
  keys: string;
  /** 走命令分发时的命令 ID */
  commandId?: string;
  /**
   * 不经命令分发、直接执行的行为（如硬刷新）。
   * `commandId` 与 `run` 二选一 —— 前者走 commandRegistry（可被多处复用/
   * 上下文路由），后者用于没有"命令"语义的一次性动作。
   */
  run?: () => void;
  scope: ShortcutScope;
  /** 平台限定（B 预留）：如 "win" 表示仅 Windows 注册 */
  os?: "win" | "mac";
  /** 上下文型：有额外生效条件，设置面板只读展示 */
  contextual?: boolean;
  /** i18n 键（用于设置面板显示） */
  labelKey: string;
  /** 分组（设置面板分类显示） */
  group: string;
}

// ── 键位解析 / 格式化 ──

/**
 * 解析规范化字符串。无法识别的部分忽略（容错优于抛错 —— 配置可手改，
 * 手抖写错一个键不该让整个快捷键系统失效）。
 */
export function parseKeys(s: string): ParsedKey {
  const out: ParsedKey = { mod: false, ctrl: false, alt: false, shift: false, key: "" };
  if (!s) return out;
  for (const raw of s.split("+")) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (t === "mod") out.mod = true;
    else if (t === "ctrl" || t === "control") out.ctrl = true;
    else if (t === "alt" || t === "option") out.alt = true;
    else if (t === "shift") out.shift = true;
    // `+` 本身是分隔符，写成 `plus` —— 否则 "mod++" 按 + 切分后键名丢失
    else if (t === "plus") out.key = "+";
    else out.key = t; // 最后一段视为键名（含 f1 / arrowup / delete 等）
  }
  return out;
}

/** 修饰键的规范顺序 —— 保证 `"shift+mod+p"` 与 `"mod+shift+p"` 归一成同一个串。 */
const MOD_ORDER: Modifier[] = ["mod", "ctrl", "alt", "shift"];

/** 结构化 → 规范化字符串（归一化：固定顺序、小写）。 */
export function formatKeys(k: ParsedKey): string {
  const parts: string[] = [];
  for (const m of MOD_ORDER) if (k[m]) parts.push(m);
  // `+` 必须写成 `plus` —— 直接 push "+" 会产出 "mod++"，再解析时按 + 切分
  // 会把它当成空片段丢掉，键名静默消失（往返有损）。
  if (k.key === "+") parts.push("plus");
  else if (k.key) parts.push(k.key);
  return parts.join("+");
}

/** 归一化一个手写字符串（供配置读取时统一）。 */
export function normalizeKeys(s: string): string {
  return formatKeys(parseKeys(s));
}

/**
 * 结构化 → 人类可读显示（平台感知）。
 * Win/Linux: `Ctrl+Shift+P`；mac: `⌘⇧P`。
 */
export function displayKeys(s: string, isMac: boolean): string {
  const k = parseKeys(s);
  if (isMac) {
    // mac 惯例：符号、无分隔、固定顺序 ⌃⌥⇧⌘
    return (
      (k.ctrl ? "⌃" : "") +
      (k.alt ? "⌥" : "") +
      (k.shift ? "⇧" : "") +
      (k.mod ? "⌘" : "") +
      keyLabel(k.key, true)
    );
  }
  const parts: string[] = [];
  if (k.mod || k.ctrl) parts.push("Ctrl");
  if (k.alt) parts.push("Alt");
  if (k.shift) parts.push("Shift");
  if (k.key) parts.push(keyLabel(k.key, false));
  return parts.join("+");
}

/** 键名 → 显示名（f1 → F1，arrowup → ↑，其余大写）。 */
function keyLabel(key: string, isMac: boolean): string {
  if (!key) return "";
  const special: Record<string, string> = {
    arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
    escape: "Esc", enter: "Enter", " ": "Space", delete: "Del",
    backspace: "⌫", tab: "Tab",
  };
  if (special[key]) return isMac && key === "backspace" ? "⌫" : special[key];
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * 判断一次键盘事件是否命中该键位。
 *
 * `isMac` 决定 `mod` 映射到 meta 还是 ctrl；其余修饰键严格匹配（多按了不算命中）。
 */
export function matchesEvent(e: KeyboardEventLike, parsed: ParsedKey, isMac: boolean): boolean {
  const wantCtrl = parsed.ctrl || (parsed.mod && !isMac);
  const wantMeta = parsed.mod && isMac;
  if (!!e.ctrlKey !== wantCtrl) return false;
  if (!!e.metaKey !== wantMeta) return false;
  if (!!e.altKey !== parsed.alt) return false;
  if (!!e.shiftKey !== parsed.shift) return false;
  if (!parsed.key) return false;
  return e.key.toLowerCase() === parsed.key;
}

/** 匹配所需的最小事件形状（便于单测构造，不依赖真实 KeyboardEvent）。 */
export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * 取某功能的**当前生效键位**（结构化）。用于「组件自己处理按键」的场景
 * （上下文型：FileTree 的复制/粘贴要跟着选中项走，不能走全局分发）。
 *
 * 组件应当用 `matchesEvent(e, entryKeysOf(id), isMac)` 判断命中，而不是硬编码
 * `e.ctrlKey && e.key === "c"` —— 否则设置面板显示的键位会与实际行为悄悄脱节。
 *
 * @param overrides 用户覆盖表（可直接传 `getSettings().shortcuts`）
 */
export function entryKeysOf(
  id: string,
  overrides?: Record<string, string>,
  defaults: ShortcutEntry[] = DEFAULT_SHORTCUTS,
): ParsedKey {
  const e = resolveBindings(defaults, overrides).find((x) => x.id === id);
  return parseKeys(e?.keys ?? "");
}

// ── 可绑定性判定 ──

/**
 * 不允许被绑定为**应用级快捷键**的键。
 *
 * 这些是「局部交互键」—— 它们的语义强依赖上下文（对话框里的确认/取消、
 * 列表导航、输入框里的换行…），绑成全局快捷键会让冲突检测失去意义，
 * 且 `preventDefault()` 会破坏各处的正常交互。
 *
 * 用户若在录制时按下这些键，应当被**拒绝**并给出提示，而不是静默吞掉。
 */
const NON_BINDABLE_KEYS = new Set([
  "enter", "escape", "tab",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
  "backspace", "delete",
  " ", "space", "spacebar",
]);

/** 纯修饰键 —— 单按不算一个组合，录制时应忽略（等用户按实际键）。 */
export const BARE_MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * 该键位能否用作应用级快捷键。
 * 返回 false 的两种情况：空键位、以及局部交互键（见 `NON_BINDABLE_KEYS`）。
 */
export function isBindableKeys(keys: string): boolean {
  const p = parseKeys(keys);
  if (!p.key) return false;
  return !NON_BINDABLE_KEYS.has(p.key);
}

// ── 冲突检测 ──

export interface ShortcutConflict {
  /** 冲突的键位（规范化） */
  keys: string;
  /** 占用该键的条目（按表内顺序） */
  ids: string[];
}

/**
 * 找出**不同功能绑到同一键**的情况。
 *
 * **软冲突**：允许存在，UI 提示 + 标注，不阻止保存。运行时**顺序靠前者优先**
 * —— 与注册时机解耦（注册顺序受组件挂载影响，不确定；表内顺序用户可见）。
 *
 * 上下文型条目**不参与**冲突检测：它们的生效条件互斥（笔记面板 vs 文件树），
 * 报冲突是噪声。
 */
export function findConflicts(
  entries: Array<{ id: string; keys: string; contextual?: boolean }>,
): ShortcutConflict[] {
  const byKeys = new Map<string, string[]>();
  for (const e of entries) {
    if (e.contextual) continue;
    const k = normalizeKeys(e.keys);
    if (!k) continue;
    const list = byKeys.get(k);
    if (list) list.push(e.id);
    else byKeys.set(k, [e.id]);
  }
  const out: ShortcutConflict[] = [];
  for (const [keys, ids] of byKeys) {
    if (ids.length > 1) out.push({ keys, ids });
  }
  return out;
}

// ── 有效绑定表（默认表 + 用户覆盖 → 合并） ──

/**
 * 合并默认表与用户覆盖，产出有效绑定表。
 *
 * 规则：
 *   · 用户值是**规范化字符串**；空字符串表示**显式解绑**（用户清掉了这个键）
 *   · 用户覆盖里出现但默认表没有的 id 忽略（可能是旧版本残留）
 *   · 上下文型条目**不接受用户覆盖**（只读展示）
 */
export function resolveBindings(
  defaults: ShortcutEntry[],
  overrides: Record<string, string> | undefined,
): ShortcutEntry[] {
  if (!overrides) return defaults;
  return defaults.map((e) => {
    if (e.contextual) return e;
    const v = overrides[e.id];
    if (v === undefined) return e;
    // 空串 = 显式解绑；否则用归一化后的用户键位
    return { ...e, keys: v === "" ? "" : normalizeKeys(v) };
  });
}

// ── 默认表 ──
//
// ⚠️ 数组顺序 = 冲突时的优先级（靠前者优先）。调整顺序即调整优先级。
// 新增快捷键时：先想清楚它属于哪一类（全局 / 命令型 / 上下文型），
// 上下文型必须标 `contextual: true`。

export const DEFAULT_SHORTCUTS: ShortcutEntry[] = [
  // ── 全局 ──
  // 两个键都开命令面板（F1 与 Ctrl+Shift+P 并存是惯例）。
  // 动作由 useCommandPalette 注册到 commandRegistry —— 它持有 `open` 状态，
  // 能正确处理"已打开时不重复触发"。
  {
    id: "palette.open",
    keys: "f1",
    commandId: Commands.PALETTE_OPEN,
    scope: "app",
    labelKey: "shortcuts.item.paletteOpen",
    group: "global",
  },
  {
    id: "palette.openAlt",
    keys: "mod+shift+p",
    commandId: Commands.PALETTE_OPEN,
    scope: "app",
    labelKey: "shortcuts.item.paletteOpenAlt",
    group: "global",
  },
  {
    id: "app.hardRefresh",
    keys: "mod+r",
    scope: "app",
    labelKey: "shortcuts.item.hardRefresh",
    group: "global",
    run: () => window.location.reload(),
  },

  // ── 命令型（走 commandRegistry）──
  // ⚠️ 本期**没有**命令型条目 —— 面板切换/打开设置等快捷键属于「新增键位」，
  //    按共识留待下一轮逐个拍板（见 docs/gui/shortcuts.md 的待办）。
  //    用户仍可在设置里为将来新增的条目改键。

  // ── 上下文型（只读展示，生效条件在各自组件里）──
  {
    id: "notes.create",
    keys: "mod+n",
    scope: "app",
    contextual: true,
    labelKey: "shortcuts.item.notesCreate",
    group: "notes",
  },
  {
    id: "notes.search",
    keys: "mod+k",
    scope: "app",
    contextual: true,
    labelKey: "shortcuts.item.notesSearch",
    group: "notes",
  },
  {
    id: "notes.toggleRaw",
    keys: "mod+e",
    scope: "app",
    contextual: true,
    labelKey: "shortcuts.item.notesToggleRaw",
    group: "notes",
  },
  {
    id: "files.copyPath",
    keys: "mod+c",
    scope: "app",
    contextual: true,
    labelKey: "shortcuts.item.filesCopyPath",
    group: "files",
  },
  {
    id: "files.paste",
    keys: "mod+v",
    scope: "app",
    contextual: true,
    labelKey: "shortcuts.item.filesPaste",
    group: "files",
  },
];
