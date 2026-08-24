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
import { eventBus } from "./serviceBus";
import { Events } from "./events";

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

    // Force persistence for desktop mutation tools
    const MUTATIONS = new Set(["desktop_create","desktop_delete","desktop_create_item","desktop_update_item","desktop_delete_items","desktop_move_item","desktop_resize_item","desktop_connect","desktop_disconnect","desktop_undo","desktop_redo"]);
    if (MUTATIONS.has(toolName)) forceSaveDesktop();

    // Notify NotesPanel if a note was mutated
    const NOTE_MUTATIONS = new Set(["note_create","note_update","note_delete","note_associate","note_disassociate","note_normalize_tags","note_apply_tag_mapping"]);
    if (NOTE_MUTATIONS.has(toolName)) eventBus.emit(Events.NOTES_CHANGED, {});

    // MCP protocol: tools/call responses must be wrapped in { content: [...] }
    const responsePayload = method === "tools/call"
      ? { content: [{ type: "text", text: JSON.stringify(result) }] }
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

async function dispatchTool(name: string, params: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-code-haha-desktop", version: "1.0.0" },
      };

    case "tools/list":
      return {
        tools: [
          { name: "desktop_summary", description: "Get lightweight summary of all desktops and items (no content payloads)", inputSchema: { type: "object", properties: { viewportW: { type: "number" }, viewportH: { type: "number" } } } },
          { name: "desktop_get_items", description: "Get full content of specific items by ID", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
          { name: "desktop_search", description: "Search items by keyword (label + content text)", inputSchema: { type: "object", properties: { query: { type: "string" }, desktopId: { type: "string" } }, required: ["query"] } },
          { name: "desktop_list", description: "List all desktops", inputSchema: { type: "object", properties: {} } },
          { name: "desktop_create", description: "Create a new desktop", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
          { name: "desktop_delete", description: "Delete a desktop by ID", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
          { name: "desktop_create_item", description: "Create an item on a desktop.\nType choices:\n- text: markdown note. content={type:'text',format:'plain'|'markdown',text:'...'}\n- table: editable spreadsheet. content={type:'table',columns:[{id,name,width?}],rows:[{id,cells:{colId:'value'}}]}\n- drawing: vector art. content={type:'drawing',svg:'<svg>...</svg>',width:W,height:H, elements?[...]}. svg=view mode; elements=editable strokes (optional). Element shapes: rect{x,y,w,h,color,strokeWidth,fillColor|null,opacity}, circle{cx,cy,r,...}, line{x1,y1,x2,y2,...}, arrow{x1,y1,x2,y2,...}, text{x,y,text,color,fontSize,opacity}, freehand{points:[{x,y}],color,strokeWidth,opacity}. All elements need {id,type}.\n- chart: data visualization (ECharts). content={type:'chart', title:'...'} with THREE data channels, priority: (a) option=full ECharts option object (all types: line/bar/pie/scatter/radar/gauge/funnel/heatmap/tree/treemap/sankey/boxplot/candlestick/graph/sunburst/... and components gadget zoom/visualMap). (b) series=array of raw ECharts series (any type, built-in tooltip/legend added). (c) data+chartType simple form for basic cases: data={labels:[...],datasets:[{label,data:[...]}]} with chartType 'bar'|'line'|'pie'|'scatter'|'area'|'radar'|'funnel'|'gauge'; config optional bar{stack:true}, pie{donut:true}. Pick (a) for complex, (c) for quick bar/line/pie.\n- graphic: Mermaid diagram (recommended) OR structured flowchart/mindmap. content={type:'graphic',mermaid:'Mermaid code'}, e.g. {type:'graphic',mermaid:'graph TD;\n  A-->B'} — supports all Mermaid types (flowchart/sequenceDiagram/mindmap/stateDiagram/gantt/pie/...). Legacy structured (optional): content={type:'graphic',subType:'flowchart'|'mindmap',nodes:[{id,label,x,y,width,height}],edges:[{id,from,to,label?}]}\n- ref: @ref links. content={type:'ref',references:[{type,path,label?}]}\n- filegroup: file list. content={type:'file-group',files:[{type,path,label?}]}\n- image: image display. content={type:'image',path:'...',width?,height?}\n- form: editable form. content={type:'form',fields:[{id,name,type,value,...}]}\nIMPORTANT: match type= to content.type= exactly.", inputSchema: { type: "object", properties: { desktopId: { type: "string" }, type: { type: "string", enum: ["text", "chart", "graphic", "ref", "filegroup", "image", "form", "drawing", "table"] }, label: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, content: { type: "object" } }, required: ["desktopId", "type", "label"] } },
          { name: "desktop_update_item", description: "Update an item's properties (e.g. partial.content.mermaid to change a Mermaid graphic's code)", inputSchema: { type: "object", properties: { itemId: { type: "string" }, partial: { type: "object" } }, required: ["itemId"] } },
          { name: "desktop_delete_items", description: "Delete items by ID", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
          { name: "desktop_move_item", description: "Move an item to new canvas coordinates", inputSchema: { type: "object", properties: { itemId: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["itemId", "x", "y"] } },
          { name: "desktop_resize_item", description: "Resize an item", inputSchema: { type: "object", properties: { itemId: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, required: ["itemId", "width", "height"] } },
          { name: "desktop_connect", description: "Create a connection between two item anchors", inputSchema: { type: "object", properties: { desktopId: { type: "string" }, from: { type: "object" }, to: { type: "object" }, label: { type: "string" } }, required: ["desktopId", "from", "to"] } },
          { name: "desktop_disconnect", description: "Remove a connection by ID", inputSchema: { type: "object", properties: { connectionId: { type: "string" } }, required: ["connectionId"] } },
          { name: "desktop_undo", description: "Undo the last operation on a desktop", inputSchema: { type: "object", properties: { desktopId: { type: "string" } }, required: ["desktopId"] } },
          { name: "desktop_redo", description: "Redo the last undone operation", inputSchema: { type: "object", properties: { desktopId: { type: "string" } }, required: ["desktopId"] } },
          // ── Notes tools ──
          { name: "note_create", description: "Create a note. Scope: global (default), domain:<name>, or project:<name>.", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, scope: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["title", "content"] } },
          { name: "note_update", description: "Update a note. Only provided fields are changed. tags replaces all tags.", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" }, scope: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["id"] } },
          { name: "note_delete", description: "Delete a note by ID", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
          { name: "note_get", description: "Get full note content + tags + associations", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
          { name: "note_list", description: "List notes, optionally filtered by scope or tag", inputSchema: { type: "object", properties: { scope: { type: "string" }, tag: { type: "string" }, limit: { type: "number" } } } },
          { name: "note_search", description: "Search notes by text. Searches title, content, and tags; multiple whitespace-separated terms accumulate weight. Results ranked: exact/leading title match > partial title or tag match > content match. scope narrows to a scope (or scope* prefix).", inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
          { name: "note_associate", description: "Link two notes", inputSchema: { type: "object", properties: { source_id: { type: "string" }, target_id: { type: "string" }, weight: { type: "number" }, type: { type: "string", enum: ["related_to","derived_from","contradicts","supports"] }, bidirectional: { type: "boolean" } }, required: ["source_id", "target_id"] } },
          { name: "note_tags", description: "List all tags with usage counts", inputSchema: { type: "object", properties: { scope: { type: "string" } } } },
          { name: "note_normalize_tags", description: "Normalize tags by grouping similar ones via LLM. Returns mapping of old→canonical tags.", inputSchema: { type: "object", properties: { dry_run: { type: "boolean" } } } },
        ],
      };

    // ── Query tools ──

    case "desktop_summary":
      return computeDesktopSummary({
        viewportW: params.viewportW as number | undefined,
        viewportH: params.viewportH as number | undefined,
      });

    case "desktop_get_items":
      return getDesktopItems(params.ids as string[]);

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
        const result = await invoke<string>("run_cli_print", { prompt });
        // Parse JSON from the result — extract first { ... } block
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found in response");
        const parsed = JSON.parse(jsonMatch[0]);
        const mappings: Record<string, string> = parsed.mappings || {};

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

    default:
      throw new Error(`Unknown tool: ${name}`);
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
