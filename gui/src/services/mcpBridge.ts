/**
 * MCP Bridge — connects the Rust HTTP MCP server to the JS desktop store.
 *
 * Architecture:
 *   Rust TCP server → emits "mcp-request" Tauri event → this bridge
 *   → dispatches to store functions → calls "mcp_response" Tauri command
 *
 * The bridge is started once on app init. MCP tool names map 1:1 to store functions.
 */

import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  getDesktops,
  getDesktopItems,
  getDesktopItem,
  searchItems,
  addItem,
  updateItem,
  removeItem,
  moveItem,
  resizeItem,
  addConnection,
  removeConnection,
  createDesktop,
  deleteDesktop,
  undoHistory,
  redoHistory,
  getActiveDesktop,
  forceSaveDesktop,
} from "../stores/desktopStore";
import { computeDesktopSummary } from "./desktopSummary";
import { PLUGIN_DOCS } from "./pluginDocs";
import { getPluginAiStatus } from "./pluginStatusStore";
import { addStatusMessage } from "../stores/statusMsgStore";
import { windowBus } from "./windowBus";
import { Events } from "./events";
import type { CollectedMcpTool } from "./pluginRegistry";

// ─── Types ───

interface McpRequest {
  requestId: string;
  body: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

// ─── Tool dispatch ───

async function handleMcpRequest(req: McpRequest): Promise<void> {
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    await respond(req.requestId, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return;
  }

  const { id, method, params } = parsed;
  const toolName = extractToolName(method, params);

  try {
    // For tools/call, unwrap arguments from protocol envelope
    const toolArgs = method === "tools/call"
      ? (params?.arguments as Record<string, unknown> | undefined) ?? {}
      : (params ?? {});
    const result = await dispatchTool(toolName, toolArgs);

    // 桌面变异成功后确保落盘 —— MCP 响应必须意味着 "on disk" 而非 "in memory"，
    // 否则 create_item 类假成功复现（响应先于真实写回）。不在此维护"哪些 tools
    // 改了桌面"的名单（会随新工具腐化）：forceSaveDesktop 是幂等的，只 flush 已被
    // store 标脏的桌面（desktopStore._dirtyDesktops 是 dirty 真相源），干净时 no-op，
    // 所以无条件 await 即可 —— durability 语义归属 store，调用点零判断。
    await forceSaveDesktop();

    // Notify NotesPanel if a note was mutated. note_create is two-phase: the
    // pre-check returns conflict_detected having written nothing, so emitting
    // there would make the panel reload its list for no reason.
    const NOTE_MUTATIONS = new Set(["note_create","note_update","note_delete","note_associate","note_disassociate","note_normalize_tags","note_apply_tag_mapping"]);
    const notePhaseWroteNothing = toolName === "note_create" &&
      typeof result === "object" && result !== null &&
      ["conflict_detected", "skipped", "rejected"].includes((result as { status?: string }).status ?? "");
    if (NOTE_MUTATIONS.has(toolName) && !notePhaseWroteNothing) windowBus.emit(Events.NOTES_CHANGED, {});

    // MCP protocol: tools/call responses must be wrapped in { content: [...] }
    // 图片类工具（插件声明 resultKind:"image"）额外附一个 image content 块 —— 见 buildToolContent
    let isImageTool = false;
    if (method === "tools/call") {
      const pt = (await getPluginTools()).find((t) => t.fullName === toolName);
      isImageTool = pt?.resultKind === "image";
    }
    const responsePayload = method === "tools/call"
      ? buildToolContent(result, isImageTool)
      : result;
    await respond(req.requestId, { jsonrpc: "2.0", result: responsePayload, id });
  } catch (err: any) {
    await respond(req.requestId, { jsonrpc: "2.0", error: { code: -32603, message: err?.message ?? String(err) }, id });
  }
}

function extractToolName(method: string, params?: Record<string, unknown>): string {
  if (method === "tools/list") return "tools/list";
  if (method === "initialize") return "initialize";
  if (method === "tools/call") return (params?.name as string) ?? "";
  return "";
}

// ── git-viewer 工具 helpers ──

/** git-viewer 插件进程端口 —— 从插件进程 store 找正在运行的 port（进程 id 裸名）。
 *  无 port = 进程未运行/未启动 → 返回 undefined, 调用方报明确错误。 */
async function getGitViewerPort(): Promise<number | undefined> {
  try {
    const { getPluginProcesses } = await import("./pluginProcessBridge");
    const p = getPluginProcesses().find((x) => x.processId === "git-viewer-server");
    return typeof p?.port === "number" ? p.port : undefined;
  } catch {
    return undefined;
  }
}

/** MCP 数值参数 clamp（可选 number, 非数字/超界落到默认） */
function clampMcpInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : NaN;
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ── 插件贡献的 MCP 工具（contributes.mcpTools）──

/** MCP 工具声明的形状（宿主工具与插件工具共用）。 */
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 当前启用插件贡献的 MCP 工具。
 *
 * **每次现算**（不缓存）：插件可能刚装上/卸载/启用，缓存会让 AI 的工具表过期。
 * 聚合本身是纯内存遍历（插件数量级是个位到几十），`getGuiPlatform` 另有缓存，
 * 所以成本可忽略。
 *
 * 失败**不抛异常**：工具表构建失败会让整个 `tools/list` 失败，而 claude 遇到
 * tools/list 失败会判定该 server 损坏 → **宿主自己的工具也一起消失**。
 * 丢插件工具是小事，丢宿主工具是事故。
 */
async function getPluginTools(): Promise<CollectedMcpTool[]> {
  try {
    const { getActiveManifests, collectPluginMcpTools, getGuiPlatform } =
      await import("./pluginRegistry");
    return collectPluginMcpTools(getActiveManifests(), await getGuiPlatform());
  } catch (e) {
    console.warn("[mcp] 插件工具聚合失败，本次不暴露", e);
    return [];
  }
}

/**
 * 调用插件贡献的 MCP 工具 —— `POST 127.0.0.1:<插件进程端口>/__mcp`。
 *
 * 契约固定（`{tool, args, settings}` → `{ok, ...}`），插件不能自定义路径 ——
 * 收窄攻击面（见 pluginRegistry 的 PluginMcpTool 注释）。
 *
 * `settings` 必须带上：插件进程读不到宿主的设置存储，而它的行为（存哪、送哪去）
 * 取决于用户配置。宿主本来就有，顺手给它（与 forwardToPluginProcess 一致）。
 */
async function callPluginMcpTool(
  tool: CollectedMcpTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { getPluginProcesses } = await import("./pluginProcessBridge");
  const proc = getPluginProcesses().find(
    (p) => p.processId === tool.processId && p.status === "running" && p.port,
  );
  if (!proc?.port) {
    throw new Error(
      `插件「${tool.pluginName}」的后台进程未运行（${tool.processId}）。` +
      `该进程在工作区绑定时自动启动 —— 若刚启用插件，请稍候重试或重开会话。`,
    );
  }
  const { getCachedPluginSettings } = await import("./pluginSettingsStore");
  const resp = await fetch(`http://127.0.0.1:${proc.port}/__mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: tool.name,
      args: args ?? {},
      settings: getCachedPluginSettings(tool.pluginName),
    }),
  });
  if (!resp.ok) {
    throw new Error(`插件工具 ${tool.fullName} 调用失败 (HTTP ${resp.status})`);
  }
  const data = (await resp.json()) as { ok?: boolean; error?: string } | null;
  if (!data?.ok) {
    throw new Error(data?.error || `插件工具 ${tool.fullName} 执行失败`);
  }
  return data;
}

/**
 * 把工具结果包成 MCP content 数组。
 *
 * `resultKind === "image"` 的工具会返回 `{ ..., image: { data, mimeType } }`：
 *   · 图片单独作为一个 image content 块 —— 模型**能直接看到画面**
 *   · **base64 必须从文本块里剥掉** —— 否则同一份数据以文本形式再进一次上下文。
 *     1920×1080 的 PNG base64 约 30 万字符 ≈ 数十万 token，会瞬间撑爆预算，
 *     而模型从文本里也读不出图像内容（纯浪费）。
 *
 * 声明了 image 却没拿到图（插件出错/取消）→ 退回纯文本，并如实带上状态。
 */
export function buildToolContent(result: unknown, isImageTool: boolean): { content: unknown[] } {
  const asText = { content: [{ type: "text", text: JSON.stringify(result) }] };
  if (!isImageTool) return asText;
  const r = result as { image?: { data?: unknown; mimeType?: unknown } } | null | undefined;
  const img = r && typeof r === "object" ? r.image : undefined;
  const data = img && typeof img.data === "string" ? img.data : "";
  if (!data) return asText;   // 没图（插件报错/取消）→ 文本里已有原因
  const { image: _drop, ...meta } = r as Record<string, unknown>;
  return {
    content: [
      { type: "image", data, mimeType: typeof img!.mimeType === "string" ? img!.mimeType : "image/png" },
      { type: "text", text: JSON.stringify(meta) },
    ],
  };
}

/**
 * 跑一次 `run_cli_print` 并把 CLI 输出解析成 JSON。
 *
 * ⚠️ `run_cli_print` 是**两段式**契约，不是同步返回值：
 *   ① `invoke("run_cli_print", { prompt, workDir })` 立即返回一个 `request_id`
 *      （Rust 侧 spawn 后台线程跑 CLI，不阻塞）
 *   ② CLI 结果经 `cli-translate-result` Tauri 事件回传，用 `request_id` 匹配
 *
 * 早先这里写成 `const result = await invoke("run_cli_print", { prompt })` 直接用
 * 返回值 —— 两个错误叠在一起：缺必填的 `workDir`（invoke 直接报错），且即便补上，
 * 拿到的也只是 request_id 而非输出。表现即 `note_normalize_tags` 必现失败
 * （"missing required key workDir"）。
 *
 * @param wantKey 期望的顶层键名；缺失即报错（防模型返回别的 JSON 结构时静默拿到空对象）
 * @param timeoutMs 超时保护 —— CLI 可能因无 profile / 网络问题一直不回事件
 */
async function runCliPrintForJson<T extends object>(
  prompt: string,
  wantKey: string,
  timeoutMs = 120000,
): Promise<T> {
  const { getSettings } = await import("../stores/settingsStore");
  const workDir = getSettings().workDir;
  if (!workDir) throw new Error("工作区未绑定，无法调用 CLI");

  type CliPayload = { request_id: string; ok: boolean; output?: string; error?: string };
  const payload = await new Promise<CliPayload>((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    let settled = false;
    let wantId: string | null = null;   // invoke resolve 后填入
    let early: CliPayload | null = null; // invoke 返回前先到的事件（极少见，防御性）

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`CLI 超时（${Math.round(timeoutMs / 1000)}s 无响应）`))),
      timeoutMs,
    );

    // 收到事件时的统一处理：id 未知就先存着（**只存第一个**，避免被后续陈旧事件覆盖），
    // 已知则比对 —— 比对是必需的：上一次调用超时后遗留的迟到事件不能算到这一次头上。
    const onEvent = (p: CliPayload) => {
      if (settled) return;
      if (wantId === null) { if (!early) early = p; return; }
      if (p.request_id !== wantId) return;
      finish(() => resolve(p));
    };
    const drainEarly = () => {
      if (early && wantId !== null && early.request_id === wantId) {
        const p = early;
        finish(() => resolve(p));
      }
    };

    // **先挂监听再 invoke**：CLI 极快完成时事件可能早于 invoke 的 resolve 到达
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<CliPayload>("cli-translate-result", (e) => onEvent(e.payload)))
      .then((un) => {
        unlisten = un;
        if (settled) { un(); return; }  // 监听挂上前已解决 → 立刻注销，防泄漏
        drainEarly();
      })
      .catch((e) => finish(() => reject(e)));

    invoke<string>("run_cli_print", { prompt, workDir }).then(
      (rid) => {
        wantId = rid;
        if (settled) return;
        drainEarly();
      },
      (e) => finish(() => reject(e)),
    );
  });

  if (!payload.ok) throw new Error(payload.error || "CLI 调用失败");
  const text = payload.output || "";

  // 从输出里抓第一个 JSON 对象（模型常带前后说明文字）
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("CLI 输出中未找到 JSON");
  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

  const value = parsed[wantKey];
  if (value === undefined) throw new Error(`CLI 输出缺少 "${wantKey}" 字段`);
  return value as T;
}

/** diff 截断: AI 上下文预算保护 —— 超 40K 字符截断并注记（可调 context 再看） */
const DIFF_LIMIT = 40_000;
function truncateDiff(diff: string): string {
  if (diff.length <= DIFF_LIMIT) return diff;
  return diff.slice(0, DIFF_LIMIT) + `\n… [diff 已截断: ${diff.length} 字符, 超出 ${DIFF_LIMIT} 上限]\n(可用 git_view_diff(file, context=较小编号) 看更小片段)`;
}

async function dispatchTool(name: string, params: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-code-haha-desktop", version: "1.0.0" },
      };

    case "tools/list": {
      // 显式类型：不加的话 TS 会把下面的字面量数组推断成一个巨大的联合类型，
      // 后面 push 插件工具（宽类型）就会报"缺少属性"。
      const base: { tools: McpToolDef[] } = {
        tools: [
          { name: "desktop_summary", description: "Get lightweight summary of all desktops and items (no content payloads)", inputSchema: { type: "object", properties: { viewportW: { type: "number" }, viewportH: { type: "number" } } } },
          { name: "desktop_get_items", description: "Get full content of specific items by ID", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
          { name: "desktop_search", description: "Search items by keyword (label + content text)", inputSchema: { type: "object", properties: { query: { type: "string" }, desktopId: { type: "string" } }, required: ["query"] } },
          { name: "desktop_list", description: "List all desktops", inputSchema: { type: "object", properties: {} } },
          { name: "desktop_create", description: "Create a new desktop", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
          { name: "desktop_delete", description: "Delete a desktop by ID", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
          { name: "desktop_create_item", description: "Create an item on a desktop.\nType choices:\n- text: markdown note. content={type:'text',format:'plain'|'markdown',text:'...'}\n- table: editable spreadsheet. content={type:'table',columns:[{id,name,width?,children?,pinned?}],rows:[{id,cells:{colId:'value'}}],cellStyles?,formats?}. 多级表头: 列组用 children 树(组不承载数据,叶子列是数据列), e.g. columns=[{id:'g1',name:'华东',children:[{id:'q1',name:'Q1'},{id:'q2',name:'Q2'}]},{id:'t',name:'总计'}]. 单元格样式: cellStyles={\"rowId:colId\":{color?,bgColor?,bold?,italic?,align?('left'|'center'|'right'),colSpan?}} (colSpan=N 该格向右合并 N 列, 1=不合并). 数字格式: formats={colId:'0,0.00'(千分位两位小数)|'0,0'(千分位整数)|'0%'(百分比)}. 列冻结: 列加 pinned:'left'|'right'. NOT supported: rowSpan(跨行合并)/条件着色(算好静态色写 cellStyles)/公式(算好结果写值).\n- drawing: vector art. content={type:'drawing',svg:'<svg>...</svg>',width:W,height:H, elements?[...]}. svg=view mode; elements=editable strokes (optional). Element shapes: rect{x,y,w,h,color,strokeWidth,fillColor|null,opacity}, circle{cx,cy,r,...}, line{x1,y1,x2,y2,...}, arrow{x1,y1,x2,y2,...}, text{x,y,text,color,fontSize,opacity}, freehand{points:[{x,y}],color,strokeWidth,opacity}. All elements need {id,type}.\n- chart: data visualization (ECharts). content={type:'chart', title:'...'} with THREE data channels, priority: (a) option=full ECharts option object (all types: line/bar/pie/scatter/radar/gauge/funnel/heatmap/tree/treemap/sankey/boxplot/candlestick/graph/sunburst/... and components gadget zoom/visualMap). (b) series=array of raw ECharts series (any type, built-in tooltip/legend added). (c) data+chartType simple form for basic cases: data={labels:[...],datasets:[{label,data:[...]}]} with chartType 'bar'|'line'|'pie'|'scatter'|'area'|'radar'|'funnel'|'gauge'; config optional bar{stack:true}, pie{donut:true}. Pick (a) for complex, (c) for quick bar/line/pie.\n- graphic: Mermaid diagram (recommended) OR structured flowchart/mindmap. content={type:'graphic',mermaid:'Mermaid code'}, e.g. {type:'graphic',mermaid:'graph TD;\n  A-->B'} — supports all Mermaid types (flowchart/sequenceDiagram/mindmap/stateDiagram/gantt/pie/...). Legacy structured (optional): content={type:'graphic',subType:'flowchart'|'mindmap',nodes:[{id,label,x,y,width,height}],edges:[{id,from,to,label?}]}\n- ref: @ref links. content={type:'ref',references:[{type,path,label?}]}\n- filegroup: file list. content={type:'file-group',files:[{type,path,label?}]}\n- image: image display. content={type:'image',path:'...',width?,height?}\n- form: editable form. content={type:'form',fields:[{id,name,type,value,...}]}\nIMPORTANT: match type= to content.type= exactly.", inputSchema: { type: "object", properties: { desktopId: { type: "string" }, type: { type: "string", enum: ["text", "chart", "graphic", "ref", "filegroup", "image", "form", "drawing", "table"] }, label: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, content: { type: "object" } }, required: ["desktopId", "type", "label"] } },
          { name: "desktop_update_item", description: "Update an item's properties (e.g. partial.content.mermaid to change a Mermaid graphic's code; for tables: partial.content={...full table content} — cellStyles/formats/columns.children 语法见 desktop_create_item 的 table 说明)", inputSchema: { type: "object", properties: { itemId: { type: "string" }, partial: { type: "object" } }, required: ["itemId"] } },
          { name: "desktop_delete_items", description: "Delete items by ID", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
          { name: "desktop_move_item", description: "Move an item to new canvas coordinates", inputSchema: { type: "object", properties: { itemId: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["itemId", "x", "y"] } },
          { name: "desktop_resize_item", description: "Resize an item", inputSchema: { type: "object", properties: { itemId: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, required: ["itemId", "width", "height"] } },
          { name: "desktop_connect", description: "Create a connection between two item anchors", inputSchema: { type: "object", properties: { desktopId: { type: "string" }, from: { type: "object" }, to: { type: "object" }, label: { type: "string" } }, required: ["desktopId", "from", "to"] } },
          { name: "desktop_disconnect", description: "Remove a connection by ID", inputSchema: { type: "object", properties: { connectionId: { type: "string" } }, required: ["connectionId"] } },
          { name: "desktop_undo", description: "Undo the last operation on a desktop", inputSchema: { type: "object", properties: { desktopId: { type: "string" } }, required: ["desktopId"] } },
          { name: "desktop_redo", description: "Redo the last undone operation", inputSchema: { type: "object", properties: { desktopId: { type: "string" } }, required: ["desktopId"] } },
          // ── Notes tools ──
          { name: "note_create", description: "Create a note (two-phase). WITHOUT `action`: the server checks for similar notes and either stores directly ({status:'stored'}) or returns {status:'conflict_detected', candidates:[...]} WITHOUT persisting — then re-call with action=store|update|merge|skip plus target_ids/merged_content. Ignoring a conflict_detected response leaves the note unstored. Scope: global (default), domain:<name>, or project:<name>.", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, scope: { type: "string" }, tags: { type: "array", items: { type: "string" } }, action: { type: "string", enum: ["store", "update", "merge", "skip"], description: "Decision action, used to resolve a conflict_detected response. store=create anyway; update=overwrite target; merge=fold targets into the first and delete the rest; skip=nothing persisted" }, target_ids: { type: "array", items: { type: "string" }, description: "Target note ids for update/merge (required for both)" }, merged_content: { type: "string", description: "Content for update/merge; defaults to `content`" } }, required: ["title", "content"] } },
          { name: "note_update", description: "Update a note. Only provided fields are changed. tags replaces all tags.", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" }, scope: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["id"] } },
          { name: "note_delete", description: "Delete a note by ID", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
          { name: "note_get", description: "Get full note content + tags + associations", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
          { name: "note_list", description: "List notes, optionally filtered by scope or tag", inputSchema: { type: "object", properties: { scope: { type: "string" }, tag: { type: "string" }, limit: { type: "number" } } } },
          { name: "note_search", description: "Search notes by text (FTS5 + jieba word segmentation, BM25-ranked). Chinese queries match sub-words, so shorter distinctive terms work well; synonyms spread across separate calls are more effective than one long phrase. Each result carries `strategy` ('fts' or 'like') reporting which retrieval path ran. scope narrows to a scope, or a prefix when it ends with '*'.", inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
          { name: "note_associate", description: "Link two notes. related_to / contradicts / supports are symmetric and derived_from is directed (source was learned from target). A single edge is already visible from both endpoints — do NOT create the mirror edge by swapping source/target, that renders the relation twice.", inputSchema: { type: "object", properties: { source_id: { type: "string" }, target_id: { type: "string" }, weight: { type: "number" }, type: { type: "string", enum: ["related_to","derived_from","contradicts","supports"] } }, required: ["source_id", "target_id"] } },
          { name: "note_tags", description: "List all tags with usage counts", inputSchema: { type: "object", properties: { scope: { type: "string" } } } },
          { name: "note_normalize_tags", description: "Normalize tags by grouping similar ones via LLM. Returns mapping of old→canonical tags.", inputSchema: { type: "object", properties: { dry_run: { type: "boolean" } } } },
          // ── Plugin tools ──
          { name: "plugin_list", description: "List installed GUI plugins: name + enabled/disabled + manifest summary (panels/commands/events/processes counts + category/dependencies/installType). Use to check what is installed before debugging.", inputSchema: { type: "object", properties: {} } },
          { name: "plugin_get", description: "Get one plugin's full plugin.json manifest (parsed JSON) by pluginName.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
          { name: "plugin_docs", description: "Plugin documentation for AI. Without 'name': plugin system guide (directory layout, plugin.json schema, lifecycle, troubleshooting checklist) — call before writing or debugging plugins. With 'name': that plugin's AI_NOTES.md (author-written, plugin-specific failure modes / log locations / diagnostics), falling back to the general guide when unavailable.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Optional pluginName — return that plugin's AI_NOTES.md troubleshooting doc" } } } },
          { name: "plugin_install", description: "Install a GUI plugin from the marketplace by slug (downloads zip, extracts, rescans — panels/commands become live). Only for standard plugins; ai-guided plugins have no runtime — read their docs and perform the guided steps yourself instead. Returns {installed, pluginName} or dependency error.", inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } },
          { name: "plugin_uninstall", description: "Uninstall a GUI plugin by pluginName. DANGEROUS — only call with confirm:true AFTER the user explicitly agreed in conversation. Refused when other installed plugins depend on it (uninstall them first). Kills the plugin's processes and deletes its directory (for ai-guided runtime plugins this also removes the downloaded runtime). ai-guided plugins: follow their uninstall guidance instead when applicable.", inputSchema: { type: "object", properties: { name: { type: "string" }, confirm: { type: "boolean" } }, required: ["name", "confirm"] } },
          { name: "plugin_set_status", description: "Report an AI-verified environment status for an ai-guided plugin (e.g. after manually installing a runtime per its AI_NOTES guidance). status: ready | not_ready | error. In-memory only (cleared on GUI restart — re-verify then). Reference info for later debugging: plugin_list/plugin_get expose it as aiStatus; the GUI does not act on it.", inputSchema: { type: "object", properties: { name: { type: "string" }, status: { type: "string", enum: ["ready", "not_ready", "error"] }, detail: { type: "object", description: "Optional free-form details: version, verify command output, error reason, etc." } }, required: ["name", "status"] } },
          // ── git-viewer 只读工具（经插件进程 HTTP API 转接; AI 不经过面板直读）──
          { name: "git_view_diff", description: "Read the diff of a working-tree file (uncommitted changes) for the bound workspace repo. Read-only; the git-viewer plugin process must be running (auto-starts on workspace bind). Pass file as repo-relative path (e.g. 'gui/src/App.tsx'). Optional context: lines of context around changes (default 3, max 60).", inputSchema: { type: "object", properties: { file: { type: "string" }, context: { type: "number" } }, required: ["file"] } },
          { name: "git_history", description: "Read the recent commit history (git log, read-only) for the bound workspace repo. Optional limit: max commits to return (default 20, max 200).", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
          { name: "git_branches", description: "Read the branch list (git branch, read-only) for the bound workspace repo.", inputSchema: { type: "object", properties: {} } },
          { name: "app_relaunch", description: "Restart the GUI application (spawns a fresh instance, then exits — the current AI session ends with it). DANGEROUS: only call with confirm:true AFTER the user explicitly agreed in conversation. Use as the LAST step of an installation flow (e.g. after an ai-guided plugin registered an MCP server that needs a session reload). All unsaved session state is preserved on disk by the backend; the new instance starts fresh.", inputSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] } },
          { name: "chat_send_command", description: "Pre-fill a command or prompt (e.g. a slash command like '/mcp-refresh') into the chat input box for the user to review and send with one keystroke — the user stays in control (this is the confirmation itself: nothing is sent automatically). Use when a GUI-side action needs the user to trigger a slash command but you want to spare them typing it. The text is placed at the start of the input box and highlighted by focus; tell the user to press Enter to send.", inputSchema: { type: "object", properties: { text: { type: "string", description: "Command/prompt text to pre-fill (e.g. '/mcp-refresh')" } }, required: ["text"] } },
        ],
      };

      // ── 插件贡献的工具（contributes.mcpTools）──
      // 工具名已由 collectPluginMcpTools 加上 `plugin_<插件名>_` 前缀，插件**结构上**
      // 无法覆盖上面任何一个宿主工具。描述里标注来源，便于 AI 与用户辨别出处。
      for (const t of await getPluginTools()) {
        base.tools.push({
          name: t.fullName,
          description: `[plugin: ${t.pluginName}] ${t.description}`,
          inputSchema: t.inputSchema,
        });
      }
      return base;
    }

    // ── Query tools ──

    case "desktop_summary":
      return computeDesktopSummary({
        viewportW: params.viewportW as number | undefined,
        viewportH: params.viewportH as number | undefined,
      });

    case "desktop_get_items":
      // 容忍 @ref 的 `type/<uuid>` 路径形式(剥掉首段)：item id 是裸 UUID 无 "/"，
      // 传 `text/<uuid>` 也正确解析, 避免"用 UUID 查不到内容"的坑。
      return getDesktopItems((params.ids as string[]).map((id) => {
        const i = id.indexOf("/");
        return i > 0 ? id.slice(i + 1) : id;
      }));

    case "desktop_search":
      return searchItems(params.query as string, params.desktopId as string | undefined);

    case "desktop_list":
      return getDesktops();

    // ── Mutation tools ──

    case "desktop_create":
      return createDesktop(params.name as string);

    case "desktop_delete": {
      deleteDesktop(params.id as string);
      return { success: true };
    }

    case "desktop_create_item": {
      const dId = params.desktopId as string;
      const itemType = (params.type as string) || "text";
      const rawContent = (params.content as any) ?? {};
      // Ensure content has a type discriminator matching the item type
      if (!rawContent.type) {
        rawContent.type = itemType === "file-group" ? "file-group" :
          itemType === "drawing" ? "drawing" :
          itemType === "chart" ? "chart" :
          itemType === "graphic" ? "graphic" :
          itemType === "ref" ? "ref" :
          itemType === "image" ? "image" :
          itemType === "form" ? "form" :
          itemType === "table" ? "table" :
          "text";
        if (itemType === "text" && !rawContent.format) rawContent.format = "plain";
        if (itemType === "text" && !rawContent.text) rawContent.text = "";
        if (itemType === "table" && !rawContent.columns) rawContent.columns = [];
        if (itemType === "table" && !rawContent.rows) rawContent.rows = [];
      }
      // graphic 无内容时给默认 Mermaid 示例，避免建出空白图
      if (itemType === "graphic" && !rawContent.mermaid && !Array.isArray(rawContent.nodes) && !Array.isArray(rawContent.edges)) {
        rawContent.mermaid = "graph TD;\n  A-->B;";
      }
      return addItem(dId, {
        x: (params.x as number) ?? 100,
        y: (params.y as number) ?? 100,
        width: (params.width as number) ?? 300,
        height: (params.height as number) ?? 200,
        content: rawContent,
        label: (params.label as string) ?? "New Item",
      });
    }

    case "desktop_update_item": {
      const partial = { ...(params.partial as any) };
      // Merge content shallowly so the type discriminator survives
      if (partial.content && typeof partial.content === "object") {
        const existing = getDesktopItem(params.itemId as string);
        if (existing?.content) {
          partial.content = { ...existing.content, ...partial.content };
        }
      }
      updateItem(params.itemId as string, partial);
      return { success: true };
    }

    case "desktop_delete_items": {
      for (const id of params.ids as string[]) {
        removeItem(id);
      }
      return { success: true };
    }

    case "desktop_move_item": {
      moveItem(params.itemId as string, params.x as number, params.y as number);
      return { success: true };
    }

    case "desktop_resize_item": {
      resizeItem(params.itemId as string, params.width as number, params.height as number);
      return { success: true };
    }

    case "desktop_connect": {
      return addConnection(params.desktopId as string, {
        from: params.from as any,
        to: params.to as any,
        label: params.label as string | undefined,
      });
    }

    case "desktop_disconnect": {
      removeConnection(params.connectionId as string);
      return { success: true };
    }

    case "desktop_undo": {
      return undoHistory(params.desktopId as string);
    }

    case "desktop_redo": {
      return redoHistory(params.desktopId as string);
    }

    // ── Notes tools ──

    case "note_create":
      return invoke("note_create", { input: {
        title: params.title as string,
        content: params.content as string,
        scope: (params.scope as string) || "global",
        tags: (params.tags as string[]) || [],
        action: params.action as string | undefined,
        target_ids: params.target_ids as string[] | undefined,
        merged_content: params.merged_content as string | undefined,
      }});

    case "note_update":
      return invoke("note_update", {
        id: params.id as string,
        input: {
          title: params.title,
          content: params.content,
          scope: params.scope,
          tags: params.tags,
        },
      });

    case "note_delete":
      return invoke("note_delete", { id: params.id as string });

    case "note_get":
      return invoke("note_get", { id: params.id as string });

    case "note_list":
      return invoke("note_list", {
        scope: params.scope || undefined,
        tag: params.tag || undefined,
        limit: (params.limit as number) || undefined,
      });

    case "note_search":
      return invoke("note_search", {
        query: params.query as string,
        scope: params.scope || undefined,
        limit: (params.limit as number) || undefined,
      });

    case "note_associate":
      return invoke("note_associate", { input: {
        source_id: params.source_id as string,
        target_id: params.target_id as string,
        weight: (params.weight as number) ?? 0.5,
        type: (params.type as string) || "related_to",
        bidirectional: !!(params.bidirectional),
      }});

    case "note_tags":
      return invoke("note_tags", { scope: params.scope || undefined });

    case "note_normalize_tags": {
      const dryRun = !!(params.dry_run);
      const tagNames: string[] = await invoke("note_get_all_tag_names");
      if (tagNames.length === 0) return { mappings: {}, merged_count: 0, dry_run: dryRun };

      const prompt = `Group the following tags by semantic similarity. Two tags should be merged if they refer to the same concept (e.g. "rust" and "rust-lang", "js" and "javascript", "ai" and "artificial-intelligence"). For each group, pick the shortest lowercase tag as the canonical form.

Tags: ${JSON.stringify(tagNames)}

Return ONLY valid JSON (no markdown, no explanation):
{"mappings": {"old_tag": "canonical_tag", ...}}

Only include tags that need to be renamed. Tags that are already canonical should NOT appear in the mappings.`;

      try {
        const mappings = await runCliPrintForJson<Record<string, string>>(prompt, "mappings");

        if (!dryRun && Object.keys(mappings).length > 0) {
          await invoke("note_apply_tag_mapping", { mappings });
        }

        return {
          mappings,
          merged_count: Object.keys(mappings).length,
          dry_run: dryRun,
        };
      } catch (e: any) {
        throw new Error(`Tag normalization failed: ${e?.message || e}`);
      }
    }

    // ── Plugin tools ──

    case "plugin_list": {
      const { getInstalledPluginEntries: getInstalledPlugins } = await import("./pluginRegistry");
      const { getSettings } = await import("../stores/settingsStore");
      const disabled = new Set(getSettings().disabledPlugins ?? []);
      const installed = await getInstalledPlugins();
      const out: Array<Record<string, unknown>> = [];
      for (const [name, entry] of installed) {
        let summary: Record<string, unknown> = { name };
        if (entry.manifestJson) {
          try {
            const m = JSON.parse(entry.manifestJson);
            summary = {
              name,
              displayName: m.displayName ?? name,
              version: m.version,
              enabled: !disabled.has(name),
              panels: (m.contributes?.panels ?? []).map((p: any) => p.id),
              commands: (m.contributes?.commands ?? []).map((c: any) => c.id),
              events: m.contributes?.events ?? [],
              processes: (m.processes ?? []).map((p: any) => p.id),
              category: m.category ?? "tool",
              dependencies: m.dependencies ?? [],
              installType: m.installType ?? "standard",
              hasReadme: !!entry.readme,
              aiStatus: getPluginAiStatus(name)?.status,
            };
          } catch {
            summary = { name, enabled: !disabled.has(name), error: "plugin.json parse failed" };
          }
        }
        out.push(summary);
      }
      return { plugins: out };
    }

    case "plugin_get": {
      const { getInstalledPluginEntries: getInstalledPlugins } = await import("./pluginRegistry");
      const { getSettings } = await import("../stores/settingsStore");
      const { getPluginProcesses } = await import("./pluginProcessBridge");
      const name = params.name as string;
      const installed = await getInstalledPlugins();
      const entry = installed.get(name);
      if (!entry?.manifestJson) throw new Error(`Plugin not found: ${name}`);
      const manifest = JSON.parse(entry.manifestJson);
      // 该插件声明的进程的实时状态。
      // ⚠️ `ProcessInfo.processId` 是**裸 id**（如 `screenshot-server`），**不带**
      // `plugin:<name>:` 前缀 —— 那个前缀只存在于命令 id / 面板 id。早先按前缀
      // startsWith 过滤，恒为空数组（AI 永远看不到插件进程状态）。
      // 正确做法：先从 manifest 取本插件声明了哪些 id，再按裸 id 匹配
      // （与 pluginCommandBridge.forwardToPluginProcess 同一范式）。
      const declared = new Set<string>(
        (Array.isArray(manifest.processes) ? manifest.processes : [])
          .map((p: { id?: unknown }) => p?.id)
          .filter((x: unknown): x is string => typeof x === "string"),
      );
      const processes = getPluginProcesses().filter((p) => declared.has(p.processId));
      return {
        name,
        enabled: !(getSettings().disabledPlugins ?? []).includes(name),
        manifest,
        readme: entry.readme ?? null,
        aiStatus: getPluginAiStatus(name) ?? null,
        processes,
      };
    }

    case "plugin_docs": {
      // 无 name → 内置通用指南。有 name → 插件专属 AI_NOTES.md 三级回退：
      // 本地已装目录 → 市场 server（ai_notes 透传字段）→ 提示无专属文档 + 通用指南兜底。
      const name = params.name as string | undefined;
      if (!name) return { docs: PLUGIN_DOCS };
      const { getInstalledPluginEntries } = await import("./pluginRegistry");
      const installed = await getInstalledPluginEntries();
      const local = installed.get(name)?.aiNotes;
      if (local) return { plugin: name, source: "local", docs: local };
      try {
        const { skillMarketplace } = await import("./skillMarketplace");
        const settings = (await import("../stores/settingsStore")).getSettings();
        const base = settings.skillRegistryUrl;
        const resp = await fetch(`${base}/api/packages/${encodeURIComponent(name)}`);
        if (resp.ok) {
          const body = await resp.json();
          const notes = body?.data?.ai_notes;
          if (notes) return { plugin: name, source: "marketplace", docs: notes };
        }
      } catch { /* server 不可达 → 走兜底 */ }
      return {
        plugin: name,
        source: "fallback",
        note: `Plugin "${name}" has no AI_NOTES.md (author hasn't provided one — locally or on the marketplace). Below is the general plugin troubleshooting guide.`,
        docs: PLUGIN_DOCS,
      };
    }

    // ── git-viewer 只读工具（经插件进程 HTTP API 转接; MCP 响应 = AI 呈现给用户）──

    case "git_view_diff": {
      const file = params.file as string | undefined;
      if (!file) throw new Error("file is required");
      const port = await getGitViewerPort();
      if (!port) throw new Error("git-viewer 进程未运行（没有端口）。插件进程在工作区绑定时自动启动——等待或检查 Worker 面板状态。");
      const url = `http://127.0.0.1:${port}/api/diff?file=${encodeURIComponent(file)}${params.context ? `&context=${params.context}` : ""}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        throw new Error(`git_view_diff 失败 (HTTP ${resp.status}): ${err.slice(0, 300)}`);
      }
      const body = await resp.json();
      return { file, diff: truncateDiff(body.diff ?? "") };
    }

    case "git_history": {
      const port = await getGitViewerPort();
      if (!port) throw new Error("git-viewer 进程未运行（没有端口）。插件进程在工作区绑定时自动启动——等待或检查 Worker 面板状态。");
      const limit = clampMcpInt(params.limit, 20, 1, 200);
      const resp = await fetch(`http://127.0.0.1:${port}/api/log?limit=${limit}`);
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        throw new Error(`git_history 失败 (HTTP ${resp.status}): ${err.slice(0, 300)}`);
      }
      const body = await resp.json();
      return { commits: body.commits ?? [] };
    }

    case "git_branches": {
      const port = await getGitViewerPort();
      if (!port) throw new Error("git-viewer 进程未运行（没有端口）。插件进程在工作区绑定时自动启动——等待或检查 Worker 面板状态。");
      const resp = await fetch(`http://127.0.0.1:${port}/api/branches`);
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        throw new Error(`git_branches 失败 (HTTP ${resp.status}): ${err.slice(0, 300)}`);
      }
      const body = await resp.json();
      return { branches: body.branches ?? [] };
    }

    case "plugin_install": {
      const slug = params.slug as string;
      if (!slug) throw new Error("slug is required");
      const { skillMarketplace } = await import("./skillMarketplace");
      const { reloadPlugins } = await import("./pluginRegistry");
      // 依赖校验: 市场详情里 dependencies 未装 → 拒绝并列出（AI 据此先装依赖）
      const detail = await skillMarketplace.getPackage(slug);
      const deps: string[] = (detail as any).dependencies ?? [];
      if (deps.length > 0) {
        const { getInstalledPluginEntries } = await import("./pluginRegistry");
        const installed = await getInstalledPluginEntries();
        const missing = deps.filter((d) => !installed.has(d));
        if (missing.length > 0) {
          throw new Error(`Missing dependencies: ${missing.join(", ")}. Install them first (plugin_install slug=<each>).`);
        }
      }
      // ai-guided 插件没有运行时, GUI 装了也只是文件——拒绝并引导 AI 走指导
      if ((detail as any).installType === "ai-guided") {
        throw new Error(`'${slug}' is an ai-guided plugin (no runtime). Read its readme/docs and perform the guided installation steps yourself.`);
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const pluginName = await invoke<string>("install_plugin_package", {
        zipUrl: skillMarketplace.getPackageDownloadUrl(slug),
        packageName: slug,
      });
      await reloadPlugins();
      addStatusMessage(`Plugin installed: ${pluginName}`, "success");
      return { installed: true, pluginName };
    }

    case "plugin_uninstall": {
      const pluginName = params.name as string;
      const confirm = params.confirm === true;
      if (!pluginName) throw new Error("name is required");
      // 危险操作门: AI 必须在对话里得到用户明确同意后才能传 confirm:true
      if (!confirm) {
        throw new Error("Uninstall requires user consent. Ask the user first, then re-call with confirm:true.");
      }
      // 依赖反查 + 删除 + 重扫全部在 uninstallPlugin 单一入口（GUI 面板共用同一门）
      const { uninstallPlugin } = await import("./pluginRegistry");
      await uninstallPlugin(pluginName);
      addStatusMessage(`Plugin uninstalled: ${pluginName}`, "success");
      return { uninstalled: true, pluginName };
    }

    case "plugin_set_status": {
      const pluginName = params.name as string;
      const status = params.status as "ready" | "not_ready" | "error";
      const detail = params.detail as Record<string, unknown> | undefined;
      if (!pluginName) throw new Error("name is required");
      // 对照已装列表拒未知插件（AI 打错名字即时报错, 而不是存一个没人读的状态）
      const { getInstalledPluginEntries } = await import("./pluginRegistry");
      const installed = await getInstalledPluginEntries();
      if (!installed.has(pluginName)) {
        throw new Error(`Plugin not found: ${pluginName}. Check plugin_list for installed names.`);
      }
      const { setPluginAiStatus } = await import("./pluginStatusStore");
      setPluginAiStatus(pluginName, status, detail);
      return { reported: true, pluginName, status };
    }

    case "app_relaunch": {
      // 危险操作门: AI 必须在对话里得到用户明确同意后才能传 confirm:true。
      // 调用即终止本进程（含本 AI 会话）——响应必须先于 relaunch 发出。
      // Rust 侧 spawn 新实例 → 800ms → exit(0); 本函数 return 后由
      // handleMcpRequest 把 JSON-RPC 响应写回, 然后进程才退出。
      const confirm = params.confirm === true;
      if (!confirm) {
        throw new Error("Relaunch requires user consent. Ask the user first, then re-call with confirm:true.");
      }
      const result = { relaunching: true, note: "GUI is restarting now. The current session ends here — the new instance will pick up fresh MCP config from ~/.claude.json." };
      // 延迟执行: 让 respond() 先把工具结果送达 AI（写回 HTTP 响应）, 再退进程。
      setTimeout(() => {
        invoke("app_relaunch").catch((e) => console.error("[mcpBridge] relaunch failed:", e));
      }, 500);
      return result;
    }

    case "chat_send_command": {
      // 把命令/提示词预填进聊天输入框, 用户审阅后一键发送——确认门就是发送本身,
      // 不自动发。复用 CHAT_INSERT_TEXT 通路（命令面板/划词发送同源）。
      const text = params.text as string;
      if (!text || !text.trim()) throw new Error("text is required");
      windowBus.emit(Events.CHAT_INSERT_TEXT, { text, atStart: true });
      return { prefilled: true, text, note: "Placed into the chat input box. Ask the user to review and press Enter to send." };
    }

    default: {
      // 不是宿主工具 → 可能是插件贡献的（名形如 `plugin_<插件名>_<工具>`）。
      // 现算一次工具表（不缓存）：插件可能刚装上，缓存会让新工具"看不见"。
      const t = (await getPluginTools()).find((x) => x.fullName === name);
      if (t) return await callPluginMcpTool(t, params);
      throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// ─── Response back to Rust ───

async function respond(requestId: string, data: unknown): Promise<void> {
  try {
    await invoke("mcp_response", { requestId, result: JSON.stringify(data) });
  } catch (err) {
    console.error("[mcpBridge] Failed to send response:", err);
  }
}

// ─── MCP status tracking (for Workers panel) ───

export type McpStatus = "stopped" | "starting" | "running" | "error";

let _mcpStatus: McpStatus = "stopped";
let _mcpPort: number = 0;
let _mcpError: string | undefined;
const _mcpListeners = new Set<() => void>();

function notifyMcpChanged(): void {
  for (const fn of _mcpListeners) fn();
}

export function getMcpState(): { status: McpStatus; port: number; error?: string } {
  return { status: _mcpStatus, port: _mcpPort, error: _mcpError };
}

export function useMcpStatus() {
  const [st, setSt] = useState(getMcpState());
  useEffect(() => {
    const fn = () => setSt(getMcpState());
    _mcpListeners.add(fn);
    return () => { _mcpListeners.delete(fn); };
  }, []);
  return st;
}

// ─── Startup ───

let _started = false;

export async function startMcpBridge(): Promise<void> {
  if (_started) return;
  _started = true;
  _mcpStatus = "starting";
  notifyMcpChanged();

  try {
    const port: number = await invoke("get_mcp_port");
    _mcpPort = port;
  } catch {
    // Port query failed, bridge may still work
    _mcpPort = 0;
  }

  await listen<McpRequest>("mcp-request", (event) => {
    handleMcpRequest(event.payload);
  });

  _mcpStatus = "running";
  notifyMcpChanged();
  console.log("[mcpBridge] Listening for MCP requests on port", _mcpPort || "?");
}
