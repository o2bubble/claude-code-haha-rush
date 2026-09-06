// ── pluginRegistry — GUI 插件基础设施：manifest 解析 + 目录条目处理 ──
// 解析 %APPDATA%/claude-code-gui/plugins/<name>/ 下各 plugin.json，产出可注册的
// 插件贡献集 (panels/commands/events/processes)。GUI 进程自己发现插件，
// 不依赖 claude.exe 引擎的插件系统。schema 见 .scratch/gui-plugin-system/PRD.md §5。
//
// ⚠️ 本模块不 import node fs —— webview 运行时无 fs。目录读取由 Tauri(Rust/plugin-fs)
// 完成，把「插件名 → plugin.json 内容」的条目列表传给 scanPlugins(纯逻辑, 可测)。

// ─── 类型（PRD §5 plugin.json）───

export type PanelKind = "in-main" | "floating";

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

export interface PluginManifest {
  pluginName: string;
  displayName: string;
  version: string;
  apiVersion?: string;
  description?: string;
  icon?: string;
  contributes: PluginContributes;
  processes: PluginProcess[];
}

export type ParseResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

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

  return {
    ok: true,
    manifest: { pluginName, displayName, version, apiVersion, description, icon, contributes, processes },
  };
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
    });
  }
  return panels;
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
