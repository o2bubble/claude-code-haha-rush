import { describe, it, expect } from "vitest";
import { prettyToolName, toolSummary, statusMark } from "./widgetToolSummary";
import type { ToolUse } from "../../stores/chatStore";

const tool = (over: Partial<ToolUse>): ToolUse => ({
  id: "t1",
  index: 0,
  name: "BashTool",
  input: {},
  status: "done",
  ...over,
});

// ── 工具名 → 挂件显示名 ──
//
// 2026-10-26 用户反馈：挂件里「bash 命令和 mcp 工具相关的块都没有渲染」，
// 只能看到 AI 的文字。这两条锁住"名字认得出"这一层。

describe("prettyToolName", () => {
  it("内置工具走短名映射", () => {
    expect(prettyToolName("BashTool")).toBe("Bash");
    expect(prettyToolName("FileEditTool")).toBe("Edit");
    expect(prettyToolName("FileReadTool")).toBe("Read");
    expect(prettyToolName("GrepTool")).toBe("Grep");
  });

  it("未知但以 Tool 结尾的，去掉后缀", () => {
    expect(prettyToolName("SomethingTool")).toBe("Something");
  });

  it("MCP 工具显示成 server: tool（不是一坨下划线）", () => {
    expect(prettyToolName("mcp__memory__memory_search")).toBe("memory: memory_search");
    expect(prettyToolName("mcp__playwright__browser_navigate")).toBe("playwright: browser_navigate");
  });

  it("插件贡献的工具：plugin_<插件名>_<工具名> → 插件名: 工具名", () => {
    // 真实格式见 pluginRegistry.ts:658 —— 是**一个**下划线，不是 mcp__ 那种
    expect(prettyToolName("plugin_config-export_export_profile")).toBe(
      "config-export: export_profile",
    );
    expect(prettyToolName("plugin_git-viewer_view_diff")).toBe("git-viewer: view_diff");
  });

  it("太长的 MCP 名只留工具部分（挂件宽度有限）", () => {
    const long = prettyToolName("mcp__plugin_very-long-server-name__some_tool_name_here");
    expect(long).toBe("some_tool_name_here");
    expect(long).not.toContain(":");
  });

  it("空名字不崩", () => {
    expect(prettyToolName("")).toBe("工具");
  });
});

// ── 一句话摘要：知道"在干啥" ──

describe("toolSummary", () => {
  it("Bash 显示命令", () => {
    expect(toolSummary(tool({ name: "BashTool", input: { command: "npm run build" } }))).toBe(
      "npm run build",
    );
  });

  it("Bash 命令太长截断（挂件放不下）", () => {
    const long = "x".repeat(200);
    const out = toolSummary(tool({ name: "BashTool", input: { command: long } }));
    expect(out.length).toBeLessThanOrEqual(81); // 80 + 省略号
    expect(out.endsWith("…")).toBe(true);
  });

  it("Bash 多行命令只取第一行有内容的那行", () => {
    const cmd = "\n\necho hello\nrm -rf /tmp/x";
    expect(toolSummary(tool({ name: "BashTool", input: { command: cmd } }))).toBe("echo hello");
  });

  it("PowerShell 也算命令类", () => {
    expect(toolSummary(tool({ name: "PowerShell", input: { command: "Get-ChildItem" } }))).toBe(
      "Get-ChildItem",
    );
  });

  it("文件类显示路径末两段（完整路径在挂件里放不下）", () => {
    expect(
      toolSummary(tool({ name: "FileReadTool", input: { file_path: "/a/b/c/deep/file.ts" } })),
    ).toBe("deep/file.ts");
  });

  it("Windows 路径同样取末两段", () => {
    expect(
      toolSummary(tool({ name: "FileEditTool", input: { file_path: "D:\\proj\\src\\App.tsx" } })),
    ).toBe("src/App.tsx");
  });

  it("搜索类显示 pattern", () => {
    expect(toolSummary(tool({ name: "GrepTool", input: { pattern: "TODO" } }))).toBe("TODO");
    expect(toolSummary(tool({ name: "GlobTool", input: { pattern: "**/*.ts" } }))).toBe("**/*.ts");
  });

  it("URL 类显示 URL", () => {
    expect(toolSummary(tool({ name: "WebFetchTool", input: { url: "https://x.com/a" } }))).toBe(
      "https://x.com/a",
    );
  });

  it("MCP 工具没有已知字段 → 回退到第一个字符串参数", () => {
    const t = tool({
      name: "mcp__memory__memory_search",
      input: { query: "晶振频率" },
    });
    expect(toolSummary(t)).toBe("晶振频率");
  });

  it("完全没有可用信息 → 空串（不显示摘要，只显示名字）", () => {
    expect(toolSummary(tool({ name: "UnknownTool", input: {} }))).toBe("");
  });

  it("非字符串参数被忽略，不会崩", () => {
    expect(
      toolSummary(tool({ name: "X", input: { a: 1, b: true, c: null, d: "real" } })),
    ).toBe("real");
  });
});

// ── 状态点 ──

describe("statusMark", () => {
  it("running / pending 是实心点（带闪烁）", () => {
    expect(statusMark("running")).toBe("●");
    expect(statusMark("pending")).toBe("●");
  });

  it("error 是叉", () => {
    expect(statusMark("error")).toBe("!");
  });

  it("done 是勾", () => {
    expect(statusMark("done")).toBe("✓");
  });
});
