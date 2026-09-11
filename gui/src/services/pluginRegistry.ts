// ── pluginRegistry — GUI 插件基础设施：manifest 解析 + 目录条目处理 ──
// 解析 %APPDATA%/claude-code-gui/plugins/<name>/ 下各 plugin.json，产出可注册的
// 插件贡献集 (panels/commands/events/processes)。GUI 进程自己发现插件，
// 不依赖 claude.exe 引擎的插件系统。schema 见 .scratch/gui-plugin-system/PRD.md §5。
//
// ⚠️ 本模块不 import node fs —— webview 运行时无 fs。目录读取由 Tauri(Rust/plugin-fs)
// 完成，把「插件名 → plugin.json 内容」的条目列表传给 scanPlugins(纯逻辑, 可测)。

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
  };

  // processes：缺 id/command 的 process 跳过（parse 层严格——坏 manifest 不静默生效）。
  // env 只保留字符串值（数字/数组等非 string 丢弃，避免 spawn 时脏数据）。
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

  return {
    ok: true,
    manifest: { pluginName, displayName, version, apiVersion, description, icon, contributes, processes, category, dependencies, installType, runtimes, platforms, settings },
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
    return [{
      id,
      title: String(c.title ?? ""),
      onInvoke: asString(c.onInvoke),
    }];
  });
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
  for (const m of manifests) {
    if (disabledNames.has(m.pluginName)) continue;
    for (const rt of m.runtimes ?? []) {
      const abs = `${pluginsBase.replace(/[\\/]+$/, "")}/${m.pluginName}/${rt.path}`.replace(/\\/g, "/");
      if (!dirExists(abs)) continue;
      if (!out.includes(abs)) out.push(abs);
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
export async function uninstallPlugin(pluginName: string): Promise<void> {
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
  await invoke("uninstall_plugin", { pluginName, processIds });
  await reloadPlugins();
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
  if (_reloading) return; // 防重入: PANEL_REGISTRY_CHANGED → FloatingApp reload 触发的连锁
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
    const { stopPluginEventForwarding, startPluginEventForwarding } = await import("./pluginCommandBridge");
    stopPluginEventForwarding();
    startPluginEventForwarding();
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
