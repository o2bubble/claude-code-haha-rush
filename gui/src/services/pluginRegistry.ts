// ── pluginRegistry — GUI 插件基础设施：manifest 解析 + 目录条目处理 ──
// 解析 %APPDATA%/claude-code-gui/plugins/<name>/ 下各 plugin.json，产出可注册的
// 插件贡献集 (panels/commands/events/processes)。GUI 进程自己发现插件，
// 不依赖 claude.exe 引擎的插件系统。schema 见 .scratch/gui-plugin-system/PRD.md §5。
//
// ⚠️ 本模块不 import node fs —— webview 运行时无 fs。目录读取由 Tauri(Rust/plugin-fs)
// 完成，把「插件名 → plugin.json 内容」的条目列表传给 scanPlugins(纯逻辑, 可测)。

// 类型专用导入（shortcuts 不反向依赖本模块，无环）
import type { PluginHotkeyDecl } from "./shortcuts";

// ─── 类型（PRD §5 plugin.json）───

export type PanelKind = "in-main" | "floating";

export interface PluginContent {
  /** 内容类型: 仅 html（iframe 加载插件目录内静态文件）。将来扩展其它类型。 */
  type: "html";
  /** 插件目录内相对路径（禁绝对路径/`..` 穿越, 渲染时拼接协议 URL） */
  src: string;
}

export interface PluginPanelView {
  id: string;
  title: string;
  entry?: string;
  process?: string;
}

export interface PluginPanel {
  id: string;
  title: string;
  panelKind: PanelKind;
  views: PluginPanelView[];
  userManaged?: boolean;
  /** 内容源声明: 面板 load 插件目录内 src 文件（iframe 沙箱渲染）。
   *  undefined = 默认声明式占位组件（插件信息页）。 */
  content?: PluginContent;
  /** 关联的后台进程 id（manifest processes[].id）——iframe URL 注入 ?port=<进程端口> */
  process?: string;
}

export interface PluginCommand {
  id: string;
  title: string;
  onInvoke?: string;
  /** 建议的默认键位（未归一化，如 `"mod+shift+a"`）。只是默认值，用户可改/可解绑。 */
  hotkey?: string;
  /** 键位作用域：`app`（默认，GUI 有焦点才生效）| `os`（全局热键，失焦也生效） */
  scope?: "app" | "os";
  /** 平台限定（`os` 作用域下可选）：只在该平台注册 */
  os?: "win" | "mac";
}

export interface PluginProcess {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  portProtocol?: string;
  startOn?: "workspace_bound";
}

export interface PluginContributes {
  panels: PluginPanel[];
  commands: PluginCommand[];
  events: string[];
  mcpTools: PluginMcpTool[];
  /** 插件附带的 skill（链接进 ~/.claude/skills，见 sync_plugin_skill_links）。 */
  skills: PluginSkillDecl[];
}

/**
 * 插件贡献的 skill —— 只是"把插件里某个目录链接进技能目录"，**没有任何注册机制**
 * （skill 就是 `SKILL.md` + 附属文件的目录，AI 侧只扫 `~/.claude/skills`）。
 *
 * 宿主把 `path` 拼成绝对路径后交给 Rust 建链接，于是**插件目录是唯一来源**：
 * 改插件里的 skill 文件立刻生效，不会出现"技能目录里还是旧副本"。
 */
export interface PluginSkillDecl {
  /** 目标目录名：`~/.claude/skills/<name>`（须含 SKILL.md 的目录会链到那里） */
  name: string;
  /** 插件目录内的相对路径（如 `"skill"`） */
  path: string;
}

/**
 * 插件贡献的 MCP 工具 —— 让 GUI 里的 AI 能直接调用插件能力（无 UI）。
 *
 * 调用契约**固定**，插件不能自定义 endpoint / method：宿主一律
 * `POST http://127.0.0.1:<插件进程端口>/__mcp`，body `{ tool, args, settings }`。
 * 不让插件填 URL 是为了收窄攻击面（路径拼接、SSRF）—— 与 `/__command` 同心智，
 * 但**不复用** `/__command`（那个返回的是 host actions 语义）。
 *
 * AI 看到的工具名是 `plugin_<pluginName>_<name>`（宿主拼），插件无法覆盖宿主工具。
 */
export interface PluginMcpTool {
  /** 工具短名（插件内唯一）。完整名由宿主加命名空间前缀。 */
  name: string;
  description: string;
  /** JSON Schema（会被白名单化：只放行 type/properties/required/enum/items/description）。 */
  inputSchema: Record<string, unknown>;
  /** 处理它的后台进程 id（必须在本插件 processes[] 里声明过）。缺省 = 该插件唯一进程。 */
  process?: string;
  /** 结果形态。`image` = 端点会返回图片，宿主据此注入 image content 块
   *  （而不是把 base64 当文本塞进上下文 —— 那会白白烧掉几十万 token）。 */
  resultKind?: "text" | "image";
}

/** 内置分类（稳定展示+翻译）。作者可声明任意自定义分类字符串——原样透传,
 *  市场筛选 chips 动态并入（内置 4 类 + 市场出现过的自定义类）。缺省 "tool"。 */
export type PluginCategory =
  | "component" | "tool" | "guide" | "integration"
  | (string & {});
/** 安装形态: standard=zip 有可执行物(GUI 装) | ai-guided=纯指导文档(只有 AI 能装/卸)。 */
export type PluginInstallType = "standard" | "ai-guided";

/** 插件声明的运行时目录（plugin-nodejs-runtime PRD）。path 为插件目录内相对路径;
 *  平台把已启用插件的存在目录聚合后注入插件进程与 AI Bash 的程序内部 PATH。 */
export interface PluginRuntime {
  id: string;
  path: string;
}

export interface PluginManifest {
  pluginName: string;
  displayName: string;
  version: string;
  apiVersion?: string;
  description?: string;
  icon?: string;
  contributes: PluginContributes;
  processes: PluginProcess[];
  /** 分类，缺省 "tool" */
  category: PluginCategory;
  /** 依赖的其它插件（pluginName 列表），安装时校验提示 */
  dependencies: string[];
  /** 安装形态，缺省 "standard"；ai-guided 插件无运行时，只能 AI 按指导装/卸 */
  installType: PluginInstallType;
  /** 声明的运行时目录（相对插件根），缺省 [] */
  runtimes: PluginRuntime[];
  /** 支持的平台（windows/macos/linux）。缺省 [] = 未声明 = 全平台（兼容旧 manifest）。
   *  非法值（非三枚举/非字符串）忽略。GUI 按编译结果判断是否支持并展示。 */
  platforms: string[];
  /** 插件设置声明——设置面板按插件分组渲染。缺省 {} = 无设置。 */
  settings: PluginSettingsDecl;
  /**
   * 卸载前要执行的清理脚本（相对插件根的路径，如 "cleanup.cjs"）。
   *
   * 用途：插件在**插件目录之外**留下的东西（外部数据、系统资源、要通知的外部服务）
   * 宿主无从知晓，只能由插件自己声明怎么清。
   *
   * 由宿主执行（插件进程那时可能已经死了）：`.js/.cjs/.mjs` 用 **bun**、
   * `.py` 用 **python** —— 两者都是 GUI 安装包自带的运行时（零前置条件）。
   * 参数经环境变量传入（`CLAUDE_PLUGIN_NAME` / `_DIR` / `_DATA_DIR` / `_WORKSPACE`）。
   *
   * ⚠️ **失败绝不阻断卸载**（只记 warn 并在结果里回报）—— 不能让 hook 写错就卸不掉。
   */
  beforeUninstall?: string;
  /**
   * 卸载后是否需要重启 GUI 才完全生效（如 hook 改了 PATH/环境变量、清了宿主进程
   * 已加载的资源）。**只有声明了才提示用户** —— 大多数插件不需要，别打扰。
   */
  needsRestart?: boolean;
}

export type ParseResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

// ─── 插件设置声明（lightweight JSON Schema, VS Code contributes.configuration 心智）───

export type PluginSettingType = "boolean" | "string" | "number" | "select";

export interface PluginSetting {
  type: PluginSettingType;
  /** 显示名（设置面板组件标题） */
  title: string;
  description?: string;
  default?: string | number | boolean;
  /** 仅 select: 选项列表（value + label） */
  options?: Array<{ value: string; label: string }>;
  /** 仅 number: 范围约束（可留空） */
  min?: number;
  max?: number;
}

/** settings 声明: 键 = 设置 id（manifest 内唯一, 持久化时作为字段） */
export type PluginSettingsDecl = Record<string, PluginSetting>;

/** 解析 settings 声明——容错: 非数组/字段缺 type 或 title 的条目跳过, 不整 manifest 失败。 */
export function parsePluginSettings(raw: unknown): PluginSettingsDecl {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: PluginSettingsDecl = {};
  for (const [id, def] of Object.entries(raw)) {
    if (!isRecord(def)) continue;
    const type = def.type;
    if (type !== "boolean" && type !== "string" && type !== "number" && type !== "select") continue;
    if (!asString(def.title)) continue;
    const setting: PluginSetting = { type, title: asString(def.title)! };
    const desc = asString(def.description);
    if (desc) setting.description = desc;
    if (typeof def.default === "string" || typeof def.default === "number" || typeof def.default === "boolean") {
      setting.default = def.default;
    }
    if (Array.isArray(def.options)) {
      const opts: Array<{ value: string; label: string }> = [];
      for (const o of def.options) {
        if (isRecord(o) && typeof o.value === "string" && typeof o.label === "string") {
          opts.push({ value: o.value as string, label: o.label as string });
        }
      }
      if (opts.length > 0) setting.options = opts;
    }
    if (typeof def.min === "number") setting.min = def.min;
    if (typeof def.max === "number") setting.max = def.max;
    out[id] = setting;
  }
  return out;
}

// ─── parsePluginManifest（纯函数，无 I/O，可单测）───

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** 解析一个 plugin.json 的内容字符串 → 强类型 PluginManifest。错误时返回 {ok:false}，
 * 由调用方容错跳过（一个坏插件不拖垮 GUI 启动）。 */
export function parsePluginManifest(json: string, sourceDir: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e: any) {
    return { ok: false, error: `[${sourceDir}] plugin.json JSON 解析失败: ${e?.message ?? e}` };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: `[${sourceDir}] plugin.json 顶层必须是对象` };
  }
  const pluginName = asString(raw.pluginName);
  if (!pluginName) return { ok: false, error: `[${sourceDir}] 缺少 pluginName` };
  const version = asString(raw.version);
  if (!version) return { ok: false, error: `[${sourceDir}] 缺少 version` };

  // 可选字段
  const displayName = asString(raw.displayName) ?? pluginName;
  const apiVersion = asString(raw.apiVersion);
  const description = asString(raw.description);
  const icon = asString(raw.icon);

  // processes：缺 id/command 的 process 跳过（parse 层严格——坏 manifest 不静默生效）。
  // env 只保留字符串值（数字/数组等非 string 丢弃，避免 spawn 时脏数据）。
  // ⚠️ 必须在 contributes 之前解析：mcpTools 要拿它校验 process 声明是否存在。
  const processes: PluginProcess[] = Array.isArray(raw.processes)
    ? (raw.processes as unknown[]).filter(isRecord).flatMap((p) => {
        const id = asString(p.id);
        const command = asString(p.command);
        if (!id || !command) return []; // 必需字段缺失 → 跳过该 process
        const env = isRecord(p.env)
          ? Object.fromEntries(Object.entries(p.env).filter(([, v]) => typeof v === "string"))
          : undefined;
        return [{
          id,
          command,
          args: Array.isArray(p.args) ? (p.args as unknown[]).map((a) => String(a)) : undefined,
          env: env as Record<string, string> | undefined,
          portProtocol: asString(p.portProtocol),
          startOn: p.startOn === "workspace_bound" ? "workspace_bound" : undefined,
        }];
      })
    : [];

  // contributes：缺省时归一化为空
  const contributesRaw = isRecord(raw.contributes) ? raw.contributes : {};
  const panels = parsePanels(contributesRaw.panels);
  if (panels === null) return { ok: false, error: `[${pluginName}] contributes.panels 含非法 panel（id/title/panelKind）` };
  const contributes: PluginContributes = {
    panels,
    commands: parseCommands(contributesRaw.commands),
    events: Array.isArray(contributesRaw.events)
      ? (contributesRaw.events as unknown[]).filter((e): e is string => typeof e === "string")
      : [],
    mcpTools: parseMcpTools(contributesRaw.mcpTools, processes),
    skills: parsePluginSkills(contributesRaw.skills),
  };

  // 可选扩展字段（T8）: 分类/依赖/安装形态——容错解析, 缺省回落默认。
  // category 作者可自定义: 任意非空字符串原样透传(市场筛选 chips 动态并入);
  // 空/缺失才回落 "tool"（不设枚举白名单——避免作者自定义被静默吞掉）。
  const category = (asString(raw.category) ?? "tool") as PluginCategory;
  const dependencies = Array.isArray(raw.dependencies)
    ? (raw.dependencies as unknown[]).filter((d): d is string => typeof d === "string" && !!d.trim())
    : [];
  const installType = (raw.installType === "ai-guided" ? "ai-guided" : "standard") as PluginInstallType;
  const runtimes = parseRuntimes(raw.runtimes);
  // platforms 支持列表: 只认三枚举值, 非法/非字符串过滤; 缺失/空 = 全平台。
  const PLATFORM_VALUES = new Set(["windows", "macos", "linux"]);
  const platforms = Array.isArray(raw.platforms)
    ? (raw.platforms as unknown[]).filter((p): p is string => typeof p === "string" && PLATFORM_VALUES.has(p))
    : [];
  // 插件设置声明（VS Code contributes.configuration 心智, 设置面板按插件分组渲染）
  const settings = parsePluginSettings(raw.settings);
  // 卸载 hook：只认"相对路径且不含 .. 穿越"的脚本名（与 runtimes.path 同款校验）。
  // 非字符串/空/绝对路径/穿越 → 忽略（宁可不跑，也不让 manifest 指向插件目录之外）。
  const rawHook = asString(raw.beforeUninstall);
  const looksAbsolute =
    !!rawHook && (rawHook.startsWith("/") || rawHook.startsWith("\\") || /^[a-zA-Z]:/.test(rawHook));
  const hasTraversal = !!rawHook && rawHook.split(/[/\\]/).includes("..");
  const beforeUninstall = rawHook && !looksAbsolute && !hasTraversal ? rawHook : undefined;
  const needsRestart = raw.needsRestart === true;

  return {
    ok: true,
    manifest: { pluginName, displayName, version, apiVersion, description, icon, contributes, processes, category, dependencies, installType, runtimes, platforms, settings, beforeUninstall, needsRestart },
  };
}

/** 解析 runtimes 声明——容错: 非数组/元素缺 id 或 path/path 非相对(绝对路径或
 *  `..` 穿越)的条目跳过, 不整 manifest 失败。 */
function parseRuntimes(raw: unknown): PluginRuntime[] {
  if (!Array.isArray(raw)) return [];
  const out: PluginRuntime[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const id = asString(r.id);
    const path = asString(r.path);
    if (!id || !path) continue;
    if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) continue; // 绝对路径拒绝
    if (path.split(/[\\/]/).includes("..")) continue;      // 目录穿越拒绝
    out.push({ id, path });
  }
  return out;
}

/** 解析 panels——任一 panel 缺 id/title 或 panelKind 非法 → 返回 null（整 manifest 失败，
 *  坏插件跳过而非部分生效）。无 panels 字段 → 空数组。 */
function parsePanels(raw: unknown): PluginPanel[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const panels: PluginPanel[] = [];
  for (const p of raw) {
    if (!isRecord(p)) return null;
    const id = asString(p.id);
    const title = asString(p.title);
    const panelKind = asString(p.panelKind);
    if (!id || !title) return null;
    if (panelKind !== "in-main" && panelKind !== "floating") return null;
    panels.push({
      id,
      title,
      panelKind,
      views: Array.isArray(p.views)
        ? (p.views as unknown[]).filter(isRecord).map((v) => ({
            id: asString(v.id) ?? `${id}.view`,
            title: asString(v.title) ?? "",
            entry: asString(v.entry),
            process: asString(v.process),
          }))
        : [],
      userManaged: typeof p.userManaged === "boolean" ? p.userManaged : undefined,
      content: parseContent(p.content),
      process: asString(p.process),
    });
  }
  return panels;
}

/** 解析 content 声明——仅支持 { type: "html", src } 且 src 为插件目录内相对路径
 *  （禁绝对路径/`..`/反斜杠倒置——防路径穿越, 渲染时拼协议 URL 有二次防线）。
 *  非法/缺失 → undefined（回落占位组件, 不拖垮 manifest）。 */
function parseContent(raw: unknown): PluginContent | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type !== "html") return undefined;
  const src = asString(raw.src);
  if (!src) return undefined;
  // 路径安全: 必须是相对路径——禁开头的 / 与盘符, 禁空段/`..`/反斜杠
  if (src.startsWith("/") || /^[A-Za-z]:/.test(src) || /\\/.test(src)) return undefined;
  const segments = src.split("/");
  if (segments.some((s) => s === ".." || s === "")) return undefined;
  return { type: "html", src };
}

function parseCommands(raw: unknown): PluginCommand[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(isRecord).flatMap((c) => {
    const id = asString(c.id);
    if (!id) return []; // 缺 id 的坏 command 跳过（可选贡献，不拖垮 manifest）
    const scope = c.scope === "os" ? "os" : c.scope === "app" ? "app" : undefined;
    const os = c.os === "win" || c.os === "mac" ? c.os : undefined;
    return [{
      id,
      title: String(c.title ?? ""),
      onInvoke: asString(c.onInvoke),
      hotkey: asString(c.hotkey),
      scope,
      os,
    }];
  });
}

/** inputSchema 允许保留的键 —— 白名单，防止插件塞 `$ref`/`$defs` 之类
 *  让 AI 或校验方去解析外部引用的结构。schema 会被原样交给模型，故收窄。 */
const SCHEMA_KEY_WHITELIST = new Set([
  "type", "properties", "required", "description", "enum", "items", "default",
]);

/** 递归白名单化 JSON Schema（只留简单结构，深度也限一层嵌套）。
 *  返回值**总是**带 type —— 没有类型的 schema 对模型没有意义（它据此判断参数形状）。 */
function sanitizeSchema(raw: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(raw) || depth > 4) return { type: "object" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!SCHEMA_KEY_WHITELIST.has(k)) continue;
    if (k === "properties" && isRecord(v)) {
      // properties 的值是「字段名 → 子 schema」，**字段名本身不受白名单约束**
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = sanitizeSchema(pv, depth + 1);
      out.properties = props;
    } else if (k === "items") {
      out.items = sanitizeSchema(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  // 没有 type 的 schema 对模型没有意义，补一个 object 兜底
  if (!("type" in out)) out.type = "object";
  return out;
}

/** 工具名 / 进程 id 允许的字符 —— 它们会被拼进工具名与 URL，收窄到安全集。 */
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * 解析 `contributes.mcpTools`。
 *
 * 容错策略与 parseCommands 一致：**坏条目跳过而非拖垮整个 manifest**（可选贡献）。
 * 但下面这些是**硬性拒绝**（跳过该条 + 记 warning），因为它们要么会造成工具名
 * 劫持/歧义，要么让宿主无法定位进程：
 *   · name 缺失 / 含非法字符
 *   · name 与宿主已有工具同名（宿主工具**永远优先**，插件不得覆盖）
 *   · process 声明了但不在本插件 processes[] 内（拼不出来就是死工具）
 *
 * 注：插件**之间**的重名在聚合层处理（需要看到全部插件，见 collectPluginMcpTools）。
 */
/**
 * 解析 `contributes.skills`。
 * 容错：非数组/元素非法（缺 name 或 path、名字含非法字符、path 绝对或穿越）→ 跳过该条，
 * 不整个 manifest 失败（与 parseMcpTools / parseRuntimes 同心智）。
 */
export function parsePluginSkills(raw: unknown): PluginSkillDecl[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PluginSkillDecl[] = [];
  for (const s of raw as unknown[]) {
    if (!isRecord(s)) continue;
    const name = asString(s.name);
    const path = asString(s.path);
    // 名字：只允许字母/数字/-/_/.（与 Rust 侧 sanitize_skill_name 同规则；
    // 两边都校验 —— 前端挡住明显错的，Rust 是最终防线）
    if (!name || !/^[A-Za-z0-9._-]{1,64}$/.test(name) || name === "." || name === "..") {
      console.warn("[plugin] skills: 跳过非法 name", name);
      continue;
    }
    if (seen.has(name)) {
      console.warn(`[plugin] skills: 跳过重复 name "${name}"`);
      continue;
    }
    // path：插件内相对路径，禁绝对与穿越。
    // ⚠️ 拆成两个布尔量而不是写成一长串条件 —— 那个路径分隔符字符类
    // （`[/\\]` 形态）在多层转义里极易被写坏，而且写坏后看起来仍像对的。
    const pathAbsolute =
      !!path && (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path));
    const pathTraversal = !!path && path.split(/[/\\]/).includes("..");
    if (!path || pathAbsolute || pathTraversal) {
      console.warn(`[plugin] skills: 跳过非法 path "${path}"（${name}）`);
      continue;
    }
    seen.add(name);
    out.push({ name, path });
  }
  return out;
}

export function parseMcpTools(raw: unknown, processes: PluginProcess[]): PluginMcpTool[] {
  if (!Array.isArray(raw)) return [];
  const processIds = new Set(processes.map((p) => p.id));
  const seen = new Set<string>();
  const out: PluginMcpTool[] = [];
  for (const t of raw as unknown[]) {
    if (!isRecord(t)) continue;
    const name = asString(t.name);
    if (!name || !SAFE_ID_RE.test(name)) {
      console.warn("[plugin] mcpTools: 跳过非法 name", name);
      continue;
    }
    if (seen.has(name)) {
      console.warn(`[plugin] mcpTools: 跳过重复 name "${name}"`);
      continue;
    }
    const description = asString(t.description);
    if (!description) {
      console.warn(`[plugin] mcpTools: "${name}" 缺 description，跳过（模型需要它判断何时调用）`);
      continue;
    }
    const proc = asString(t.process);
    if (proc && !processIds.has(proc)) {
      console.warn(`[plugin] mcpTools: "${name}" 声明的 process "${proc}" 不在本插件 processes[] 内，跳过`);
      continue;
    }
    seen.add(name);
    out.push({
      name,
      description,
      inputSchema: sanitizeSchema(t.inputSchema),
      ...(proc ? { process: proc } : {}),
      ...(t.resultKind === "image" ? { resultKind: "image" as const } : {}),
    });
  }
  return out;
}

/** 收集活动插件声明的快捷键（供 `buildPluginShortcutEntries` 转成条目）。
 *  独立成函数是因为它被两处消费：快捷键分发器（运行时）与设置面板（展示）。 */
export function collectPluginHotkeys(manifests: PluginManifest[]): PluginHotkeyDecl[] {
  return manifests.flatMap((m) =>
    (m.contributes?.commands ?? [])
      .filter((c) => c.hotkey?.trim())
      .map((c) => ({
        pluginName: m.pluginName,
        commandId: c.id,
        title: c.title || c.id,
        hotkey: c.hotkey!,
        scope: c.scope,
        os: c.os,
      })),
  );
}

// ─── scanPlugins — 处理插件目录条目（纯逻辑，容错）───

/** 插件目录条目——由 Tauri(plugin-fs/Rust) 从磁盘读好后传入。name=插件名, manifestJson=plugin.json 内容。 */
export interface PluginDirEntry {
  name: string;
  manifestJson?: string;
  /** 可选包根 README.md 内容（详情页正文, list_plugin_manifests 顺带返回） */
  readme?: string | null;
  /** 可选包根 AI_NOTES.md 内容（AI 排查文档, MCP plugin_docs 本地优先源） */
  aiNotes?: string | null;
}

/** 拉取已装插件原始条目（list_plugin_manifests）。非 Tauri 环境返回空 Map。
 *  MCP plugin_list/plugin_get 与市场面板共用——数据源单一。 */
export async function getInstalledPluginEntries(): Promise<Map<string, PluginDirEntry>> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const entries = (await invoke<PluginDirEntry[]>("list_plugin_manifests")) ?? [];
    return new Map(entries.map((e) => [e.name, e]));
  } catch {
    return new Map();
  }
}

// ─── 平台支持判断（GUI 按编译结果, Rust get_platform 同源）───

export type GuiPlatform = "windows" | "macos" | "linux";

let _cachedPlatform: GuiPlatform | null = null;

/** 当前 GUI 运行平台（缓存）。非 Tauri 环境回落 Navigator 探测, 再回落 linux。 */
export async function getGuiPlatform(): Promise<GuiPlatform> {
  if (_cachedPlatform) return _cachedPlatform;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    _cachedPlatform = (await invoke<string>("get_platform")) as GuiPlatform;
  } catch {
    const p = typeof navigator !== "undefined"
      ? (navigator.platform || navigator.userAgent).toLowerCase()
      : "";
    _cachedPlatform = p.includes("win") ? "windows" : p.includes("mac") ? "macos" : "linux";
  }
  return _cachedPlatform;
}

/** manifest 声明的 platforms 是否支持当前平台（纯函数, 可测）：
 *  空/未声明 = 全平台（兼容旧 manifest）→ true。 */
export function pluginSupportsPlatform(platforms: string[], platform: GuiPlatform): boolean {
  if (!platforms || platforms.length === 0) return true;
  return platforms.includes(platform);
}

// ─── 插件 MCP 工具（contributes.mcpTools）───

/** 插件 MCP 工具在 AI 侧的名字前缀（`plugin_<插件名>_<工具名>`）。 */
export const PLUGIN_MCP_PREFIX = "plugin_";

/** 聚合后的插件 MCP 工具 —— 带上归属与进程定位信息，供 mcpBridge 转发用。 */
export interface CollectedMcpTool extends PluginMcpTool {
  pluginName: string;
  /** AI 看到的完整工具名（含命名空间）。 */
  fullName: string;
  /** 处理它的进程 id（`process` 缺省时由宿主补为该插件唯一进程）。 */
  processId: string;
}

/**
 * 汇总所有**启用**插件贡献的 MCP 工具。
 *
 * 调用方传进来的 `manifests` 已经过滤掉禁用插件（见 `getActiveManifests`），
 * 这里再做两道收口：
 *
 * 1. **平台过滤** —— 插件声明了 platforms 且不含当前平台 → 它的工具不暴露
 *    （否则 AI 会看到一个注定失败的工具）。
 * 2. **命名空间 + 冲突消解** —— 工具名一律加 `plugin_` 前缀，插件**结构上**
 *    无法覆盖宿主工具（否则插件声明个 `note_delete` 就能劫持）。插件之间重名时
 *    后者让位并记 warning。
 *
 * `process` 缺省 = 该插件唯一进程；声明了多个进程又没指明 → 跳过（宿主无法定位，
 * 暴露出去只会是死工具）。
 *
 * ⚠️ 本函数**不抛异常**（逐插件 try/catch）：聚合失败会让整个 tools/list 失败，
 * 而 claude 遇到 tools/list 失败会判定该 server 损坏 → **宿主全部工具一起消失**。
 * 单个插件坏掉最多丢它自己的工具。
 */
export function collectPluginMcpTools(
  manifests: PluginManifest[],
  platform: GuiPlatform,
): CollectedMcpTool[] {
  const out: CollectedMcpTool[] = [];
  const taken = new Set<string>();
  for (const m of manifests) {
    try {
      const tools = m.contributes?.mcpTools ?? [];
      if (tools.length === 0) continue;
      if (!pluginSupportsPlatform(m.platforms, platform)) continue;

      const procIds = m.processes.map((p) => p.id);
      for (const t of tools) {
        let processId = t.process;
        if (!processId) {
          if (procIds.length !== 1) {
            console.warn(`[plugin] ${m.pluginName}/${t.name}: 未指明 process 且本插件有 ${procIds.length} 个进程，跳过`);
            continue;
          }
          processId = procIds[0];
        }
        const fullName = `${PLUGIN_MCP_PREFIX}${m.pluginName}_${t.name}`;
        if (taken.has(fullName)) {
          console.warn(`[plugin] MCP 工具名冲突，跳过 ${fullName}`);
          continue;
        }
        taken.add(fullName);
        out.push({ ...t, processId, pluginName: m.pluginName, fullName });
      }
    } catch (e) {
      console.warn(`[plugin] ${m.pluginName} 的 MCP 工具聚合失败，已跳过`, e);
    }
  }
  return out;
}

/** semver 比较（≥ 返回 true）——插件版本号(0.1.0/0.1.1, 可带 v 前缀/预发布)。纯函数可测。
 *  解析失败(非数字段) → false(不误判需更新)。 */
function semverAtLeast(a: string, b: string): boolean {
  const norm = (v: string) =>
    v.trim().replace(/^v/i, "").split(/[.+-]/).map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n));
  const A = norm(a), B = norm(b);
  if (A.length === 0 || B.length === 0) return false;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true; // 相等
}

/** 已装插件是否需要更新: 已装 version < 市场 version → true。
 *  已装无版本/市场无版本 → false(保守, 不让"更新"误出)。 */
export function isPluginUpdateAvailable(installedVersion: string | undefined, marketVersion: string | undefined): boolean {
  if (!installedVersion || !marketVersion) return false;
  return semverAtLeast(marketVersion, installedVersion) && marketVersion.trim() !== installedVersion.trim();
}

/**
 * 处理目录读取好的插件条目，逐插件解析容错：
 * - 缺/坏 manifestJson 的插件跳过（console.warn），不拖垮 GUI 启动。
 * - 只读声明（manifest），不校验资源真实存在（entry/process 缺失由运行时容错）。
 * 纯逻辑 —— 磁盘读取由调用方(Tauri)完成，本模块无 I/O 依赖，webview 安全可测。
 */
export function scanPlugins(entries: PluginDirEntry[]): PluginManifest[] {
  const result: PluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.manifestJson) {
      console.warn(`[pluginRegistry] ${entry.name}: plugin.json 缺失，跳过`);
      continue;
    }
    const parsed = parsePluginManifest(entry.manifestJson, entry.name);
    if (!parsed.ok) {
      console.warn(`[pluginRegistry] ${entry.name}: ${parsed.error}`);
      continue;
    }
    result.push(parsed.manifest);
  }
  return result;
}

// ─── aggregateRuntimePaths — 运行时目录聚合（纯函数，PATH 注入契约层）───

/**
 * 聚合已启用插件声明的 runtime 目录为绝对路径列表（plugin-nodejs-runtime PRD）。
 * GUI spawn 插件进程 / GUI 推送 claude / claude 启动自扫三方共用此契约——
 * 各消费方不得各自实现，避免 PATH 语义漂移。
 *
 * 规则: 禁用插件的 runtime 排除（与面板/命令/事件同规则）; 目录不存在（运行时
 * 未真正安装）跳过; 重复目录按 manifest 顺序保留（PATH 段顺序 = 声明顺序）。
 *
 * @param manifests   活动 manifest 列表（调用方已按 disabledPlugins 过滤亦可，
 *                    本函数再按 disabledNames 排除一次——幂等防御）
 * @param disabledNames 禁用的 pluginName 集合
 * @param dirExists   目录存在性检查（注入以保持纯函数可测; 生产传 fs.existsSync）
 * @param pluginsBase 插件根目录（runtime 相对路径拼接基准）
 */
export function aggregateRuntimePaths(
  manifests: PluginManifest[],
  disabledNames: ReadonlySet<string>,
  dirExists: (absPath: string) => boolean,
  pluginsBase: string,
): string[] {
  const out: string[] = [];
  const push = (p: string) => { if (!out.includes(p)) out.push(p); };

  for (const m of manifests) {
    if (disabledNames.has(m.pluginName)) continue;
    for (const rt of m.runtimes ?? []) {
      const abs = `${pluginsBase.replace(/[\\/]+$/, "")}/${m.pluginName}/${rt.path}`.replace(/\\/g, "/");
      if (!dirExists(abs)) continue;

      // 声明目录 + 其 `bin/` 子目录**都注入**，让 node/npm/npx 在两种布局下都能解析：
      //   · Windows 发行版：node.exe 直接在解压根          → `${abs}/node.exe` ✓
      //   · mac/Linux 发行版：Unix 惯例放在 `bin/`          → `${abs}/bin/node` ✓
      // 设计意图本就是「一个 runtime 声明覆盖 node/npm/npx，不为每个命令单加 PATH 条目」
      // （见 plugins/nodejs/AI_NOTES.md）。早先只注入 `${abs}`，于是 mac 上
      // node/npm/npx 全部 not found —— 文档把它记成了"macOS 已知限制"，实为实现缺陷：
      // 连带弄坏了 playwright-mcp（"command": "npx" 解析不到；且即便用绝对路径跑
      // npx-cli.js，npx 拉起的子进程 shebang `#!/usr/bin/env node` 仍会因 PATH 缺 node 而失败）。
      // Windows 侧 `${abs}/bin` 不存在 → 不注入，行为不变。
      push(abs);
      // 声明本身已指向 bin（如 path: "runtime/bin"）→ 不再追加，否则得到 `.../bin/bin`
      if (!abs.endsWith("/bin")) {
        const bin = `${abs}/bin`;
        if (dirExists(bin)) push(bin);
      }
    }
  }
  return out;
}

// ─── Active manifests — 单一真相（App 注册后供命令桥/进程桥/面板桥共享读）───

let activeManifests: PluginManifest[] = [];

/** 设置当前活动的插件清单（App 扫描后调用一次） */
export function setActiveManifests(manifests: PluginManifest[]): void {
  activeManifests = manifests;
}

/** 读取当前活动的插件清单 */
export function getActiveManifests(): PluginManifest[] {
  return activeManifests;
}

/** 清空（插件目录变化/重扫时先清再设） */
export function clearActiveManifests(): void {
  activeManifests = [];
}

/** 插件贡献面板的注册 id（前缀防撞——T2 起, 与命令/事件 id 的前缀约定集中在此处） */
export function pluginPanelId(pluginName: string, panelId: string): string {
  return `plugin:${pluginName}:${panelId}`;
}

/** 插件贡献命令的注册 id（前缀防撞，同 pluginPanelId） */
export function pluginCommandId(pluginName: string, commandId: string): string {
  return `plugin:${pluginName}:${commandId}`;
}

/** 插件命令的跨窗发布 topic（浮窗经 crossWindowBus 收，命名空间 plugin.<name>.* 由 T0 预留） */
export function pluginCommandTopic(pluginName: string, commandId: string): string {
  return `plugin.${pluginName}.command.${commandId}`;
}

/** 插件订阅 GUI 事件经 Hub 转发后的跨窗 topic */
export function pluginEventTopic(pluginName: string, event: string): string {
  return `plugin.${pluginName}.event.${event}`;
}

// ─── uninstallPlugin — 卸载单一入口（依赖反查门，GUI 面板与 MCP 工具共用）───

/**
 * 卸载插件（plugin-nodejs-runtime T5）：先做依赖反查（其它**已启用**插件的
 * dependencies 引用它 → 拒绝并列清单，禁用的 dependent 不阻止——与 PATH 聚合
 * 排除规则一致），通过后调 Rust 删除目录并重扫。所有卸载路径（市场面板/详情
 * 面板/MCP plugin_uninstall）必须走本函数，保证反查判定单一。
 * @throws Error 反查命中时（message 列出 dependents），调用方按普通失败展示
 */
/** 卸载结果 —— 调用方据此决定是否提示"需要重启"。 */
export interface UninstallResult {
  removed: boolean;
  /** 插件声明了 needsRestart → 提示用户（用户可以拒绝，那就下次自己重启） */
  needsRestart: boolean;
  /** beforeUninstall hook 没跑成（不阻断卸载，但要如实告诉用户"清理可能不完整"） */
  hookWarning?: string;
}

export async function uninstallPlugin(pluginName: string): Promise<UninstallResult> {
  const { getSettings } = await import("../stores/settingsStore");
  const disabled = new Set(getSettings().disabledPlugins ?? []);
  const dependents = activeManifests
    .filter((m) => m.pluginName !== pluginName && !disabled.has(m.pluginName))
    .filter((m) => (m.dependencies ?? []).includes(pluginName))
    .map((m) => ({ pluginName: m.pluginName, displayName: m.displayName }));
  if (dependents.length > 0) {
    const list = dependents.map((d) => `${d.displayName} (${d.pluginName})`).join(", ");
    throw new Error(`'${pluginName}' is depended on by: ${list}. Uninstall them first.`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  // 进程 id 从 manifest 取（裸名, 与 registry 注册一致）——Rust 先杀再删目录,
  // 否则 node 进程持有文件句柄 → Windows「另一个程序正在使用此文件」删目录失败（用户实测）。
  const manifest = activeManifests.find((m) => m.pluginName === pluginName);
  const processIds = (manifest?.processes ?? []).map((p) => p.id);
  // 两个声明由前端从 manifest 读出后传给 Rust（Rust 不解析 manifest —— 那时目录即将被删）
  const out = await invoke<UninstallResult>("uninstall_plugin", {
    pluginName,
    processIds,
    beforeUninstallHook: manifest?.beforeUninstall ?? null,
    needsRestart: manifest?.needsRestart ?? false,
  });
  await reloadPlugins();
  return out ?? { removed: true, needsRestart: false };
}

/**
 * 把插件声明的 skill 链接进 `~/.claude/skills/`，并清掉不再需要的链接。
 *
 * 为什么要**每次重扫都同步**（而不是安装时做一次）：
 * 链接是外部状态，会漂 —— 用户手删了、插件被手工挪走、卸载后留下悬空链接。
 * 幂等同步能让这些情况在下次重扫时自愈；一次性动作则漂了就没人管。
 *
 * 失败只 `console.warn`：skill 不可用不该影响插件本身可用。
 */
async function syncPluginSkillLinks(manifests: PluginManifest[]): Promise<void> {
  // 诊断记录 —— 本函数有**三个静默失败点**（base 为空 / invoke reject / 返回 errors），
  // 而前端 `console.*` **不进 GUI 日志**（实测：日志里查不到任何前端输出，
  // Tauri 侧也没有 webview console 转发的机制）。所以排查只能靠"自己写文件"。
  //
  // 写入位置：`<appdata>/plugins-settings/__skill_diag.json`（复用 save_plugin_settings）。
  // 排查完可删掉这个文件。**这不是临时调试代码** —— 前端无日志是长期事实，
  // 保留它能省掉下次同样的"零线索排查"。
  const diag: Record<string, unknown> = { at: new Date().toISOString(), steps: [] as string[] };
  const note = (s: string) => (diag.steps as string[]).push(s);
  const flushDiag = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = JSON.stringify(diag, null, 2);
    // 主路径：`<appdata>/skill-diag.json` —— 我（排查者）能直接读。
    // ⚠️ 用 `save_file` 而不是 `save_plugin_settings`：后者 `scope` 缺省是
    // `"workspace"`，而 workspace scope 在**未绑定工作区时会直接报错** ——
    // 诊断工具本身不能有这么脆的前置条件。
    try {
      const base = await invoke<string>("get_plugins_base_dir");
      const appdata = String(base).replace(/[\\/]plugins[\\/]?$/, "");
      await invoke("save_file", { path: `${appdata}/skill-diag.json`, content: text });
      return;
    } catch { /* 落到下面的兜底 */ }
    // 兜底：插件设置目录（显式 global scope）
    try {
      await invoke("save_plugin_settings", { plugin: "__skill_diag", patch: diag, scope: "global" });
    } catch { /* 诊断自身失败就算了 */ }
  };

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    diag.manifestCount = manifests.length;
    diag.manifestsWithSkills = manifests
      .filter((m) => (m.contributes?.skills?.length ?? 0) > 0)
      .map((m) => `${m.pluginName}:${m.contributes.skills.map((s) => s.name).join(",")}`);

    // 插件根目录（`get_plugins_base_dir`）——Rust 侧的最终防线也要求 source 在此之下
    const base = await invoke<string>("get_plugins_base_dir").catch((e) => {
      note(`get_plugins_base_dir 失败: ${e}`);
      return "";
    });
    diag.base = base;
    if (!base) { note("base 为空 → 提前返回"); await flushDiag(); return; }
    const baseClean = base.replace(/[\\/]+$/, "").replace(/\\/g, "/");

    const specs: Array<{ name: string; source: string }> = [];
    for (const m of manifests) {
      for (const sk of m.contributes?.skills ?? []) {
        // 拼绝对路径交给 Rust（宿主不解析插件 manifest，与其它 contributes 一致）
        const rel = sk.path.replace(/\\/g, "/").replace(/^\/+/, "");
        specs.push({ name: sk.name, source: `${baseClean}/${m.pluginName}/${rel}` });
      }
    }
    diag.specs = specs;

    const out = await invoke<{ linked: string[]; errors: string[] }>(
      "sync_plugin_skill_links",
      { specs },
    ).catch((e) => {
      note(`sync_plugin_skill_links 失败: ${e}`);
      return null;
    });
    diag.result = out;
    if (out?.errors?.length) note(`Rust 返回 ${out.errors.length} 个错误`);
    for (const e of out?.errors ?? []) console.warn("[plugin] skill link:", e);
  } catch (e) {
    note(`异常: ${e}`);
    console.warn("[plugin] syncPluginSkillLinks 失败（skill 可能不可用）:", e);
  } finally {
    await flushDiag();
  }
}

// ─── reloadPlugins — 插件重扫单一入口（App / FloatingApp / 插件市场共用）───

/**
 * 重扫插件目录（list_plugin_manifests → scanPlugins → setActiveManifests
 * → registerPluginPanels → 事件转发重启 → refreshPluginProcesses）。
 * 安装/卸载/目录变更后调用一次，面板/命令/事件即活（进程下次 WORKSPACE_BOUND 启动）。
 * 非 Tauri 环境 / 命令缺失时静默降级（调用方无需 try）。
 * 动态 import 桥模块——本模块被各桥引用，静态 import 会成循环依赖。
 */
let _reloading = false;

export async function reloadPlugins(): Promise<void> {
  if (_reloading) {
    // ⚠️ 防重入的**静默跳过**是排查黑洞：外部看到的是"插件装了但效果没出现"。
    // 记一笔到诊断文件（见 syncPluginSkillLinks 的说明），否则无从区分
    // "没跑" 与 "跑了但被跳过"。
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_plugin_settings", {
        plugin: "__skill_diag",
        patch: { at: new Date().toISOString(), skipped: "reloadPlugins 被防重入跳过（另一次重扫在进行）" },
      });
    } catch { /* 诊断自身失败就算了 */ }
    return;
  }
  _reloading = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const entries = (await invoke<{ name: string; manifestJson?: string }[]>("list_plugin_manifests")) ?? [];
    // 禁用过滤: settings.disabledPlugins 里的插件不挂面板/命令/事件/进程(目录不动)。
    // scanPlugins 保持纯函数, 过滤在组装层做。
    const { getSettings } = await import("../stores/settingsStore");
    const disabled = new Set(getSettings().disabledPlugins ?? []);
    const manifests = scanPlugins(entries).filter((m) => !disabled.has(m.pluginName));
    // 对比旧 manifests: 消失(卸载)或被禁用的插件 → 注销其面板(注册表+布局树+浮窗),
    // 否则面板定义/已开实例残留(图标栏仍显示、布局还挂着)。
    const prevManifests = getActiveManifests();
    const nextNames = new Set(manifests.map((m) => m.pluginName));
    const gone = prevManifests.map((m) => m.pluginName).filter((name) => !nextNames.has(name));
    setActiveManifests(manifests);
    if (gone.length > 0) {
      const { unregisterPluginPanels } = await import("./pluginPanelBridge");
      for (const name of gone) unregisterPluginPanels(name);
    }
    const { registerPluginPanels } = await import("./pluginPanelBridge");
    registerPluginPanels(manifests);
    // 插件贡献的 skill → 链接进 ~/.claude/skills（**幂等**：缺了补、悬空清）。
    // 放在每次重扫里而不是"安装时建一次"—— 用户手删了链接、插件被手工挪走，
    // 下次重扫都会自愈。失败只告警：skill 不可用不该阻断插件本身。
    await syncPluginSkillLinks(manifests);
    const {
      stopPluginEventForwarding, startPluginEventForwarding, registerPluginCommands,
    } = await import("./pluginCommandBridge");
    stopPluginEventForwarding();
    startPluginEventForwarding();
    // 命令注册必须跟着重扫走：否则卸载/禁用的插件会留下幽灵命令（快捷键仍能触发
    // 一个已不存在的插件），而新装的插件命令绑了键也点不动。
    registerPluginCommands();
    const { refreshPluginProcesses, syncPluginProcesses, stopPluginProcessesFor } = await import("./pluginProcessBridge");
    await refreshPluginProcesses();
    // 消失(卸载/禁用)的插件: 其后台进程要停——它们在活动清单里已不存在, 不处理会
    // 一直跑到 GUI 退出（占端口 + cwd 钉住插件目录, 阻碍重装/删除）。
    if (gone.length > 0) {
      const ids = prevManifests
        .filter((m) => gone.includes(m.pluginName))
        .flatMap((m) => (m.processes ?? []).map((p) => p.id));
      if (ids.length > 0) await stopPluginProcessesFor(ids);
    }
    // 重扫即活（补齐文档承诺的生命周期）: 已绑定工作区时, 启动"声明了但没在跑"的进程。
    // 装完插件无需等下次重启 GUI —— 面板/命令/进程同一次重扫齐活。
    await syncPluginProcesses();
    // 通道 B（plugin-nodejs-runtime T3）: 重扫后把最新 runtime 聚合推给运行中的
    // claude.exe——当前会话下一条 Bash 即生效（A 通道启动自扫作兜底）。失败静默。
    try {
      const { aggregateRuntimeDirs } = await import("./pluginProcessBridge");
      const dirs = await aggregateRuntimeDirs();
      // **只在非空时推送**。空值一律不推 —— claude 侧 `applyPluginPathPrepend([])`
      // 会删除 A 通道（启动自扫）刚写入的正确值。「空」有两种来源（真的没装 /
      // 聚合前 manifest 未就绪），前端分不清，推空即可能误清正确配置。
      // 代价：卸载/禁用 runtime 插件后本会话 PATH 会留残影（指向已删目录，
      // bash 自动忽略），会话重启即清 —— 远小于「装了插件却用不上」。
      if (dirs && dirs.length > 0) {
        const { chatSession } = await import("../chat/chatSession");
        chatSession.send("set_plugin_runtime_paths", { dirs });
      }
    } catch { /* 无运行中会话/通道不可用 */ }
    // 广播重扫完成——市场面板等订阅者刷新已装快照（MCP 路径的装/卸不经过面板自身）
    const { windowBus } = await import("./windowBus");
    const { Events } = await import("./events");
    windowBus.emit(Events.PLUGINS_RESCANNED, { plugins: manifests.map((m) => m.pluginName) });
  } catch (e) {
    console.warn("[pluginRegistry] reloadPlugins 失败(非 Tauri 环境/命令缺失):", e);
  } finally {
    _reloading = false;
  }
}
