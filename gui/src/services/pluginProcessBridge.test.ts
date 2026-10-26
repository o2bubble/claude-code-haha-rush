// ── pluginProcessBridge 纯函数测试 ──
// T3: processStatusMeta 归一化 + isProcessActive 判定。状态 store 经 listener 更新,
// 测试直接调纯函数 (不 mock Tauri listen)。

import { describe, it, expect } from "vitest";
import { processStatusMeta, isProcessActive, buildPluginProcessEnv, pluginProcessCwd, selectProcessesToStart, selectProcessesToRebind, applyProcessStatus, selectIdleProcesses } from "./pluginProcessBridge";
import type { PluginManifest } from "./pluginRegistry";
import type { PluginProcessInfo } from "./pluginProcessBridge";


// 最小 manifest 夹具 — selectProcessesToStart 只读 pluginName + processes
function manifest(pluginName: string, processes: Array<{ id: string; startOn?: "workspace_bound" | "on_demand" }>): PluginManifest {
  return {
    pluginName,
    processes: processes.map((p) => ({ command: "node", args: [`${p.id}.cjs`], ...p })),
  } as unknown as PluginManifest;
}
const running = (processId: string): PluginProcessInfo => ({ processId, status: "running" });

describe("selectProcessesToStart — 重扫/绑定后的启动判定", () => {
  it("picks declared-but-not-running processes", () => {
    const out = selectProcessesToStart(
      [manifest("git-viewer", [{ id: "git-viewer-server", startOn: "workspace_bound" }])],
      [],
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "git-viewer-server", pluginName: "git-viewer" });
  });

  it("never re-spawns an already running/starting process (重扫不打断服务)", () => {
    const m = [manifest("a", [{ id: "a-srv", startOn: "workspace_bound" }])];
    expect(selectProcessesToStart(m, [running("a-srv")], new Set())).toHaveLength(0);
    expect(selectProcessesToStart(m, [{ processId: "a-srv", status: "starting" }], new Set())).toHaveLength(0);
  });

  it("skips processes already requested (pending spawn, status not yet propagated)", () => {
    const m = [manifest("a", [{ id: "a-srv", startOn: "workspace_bound" }])];
    expect(selectProcessesToStart(m, [], new Set(["a-srv"]))).toHaveLength(0);
  });

  it("re-spawns when the last known status is error/killed/stopped (崩溃后重扫可拉起)", () => {
    const m = [manifest("a", [{ id: "a-srv", startOn: "workspace_bound" }])];
    for (const status of ["error", "killed", "stopped"]) {
      const out = selectProcessesToStart(m, [{ processId: "a-srv", status }], new Set());
      expect(out, status).toHaveLength(1);
    }
  });

  it("ignores processes with a different/absent startOn (不在绑定时机启动)", () => {
    const out = selectProcessesToStart(
      [manifest("a", [{ id: "manual-srv" }, { id: "bound-srv", startOn: "workspace_bound" }])],
      [],
      new Set(),
    );
    expect(out.map((d) => d.id)).toEqual(["bound-srv"]);
  });

  it("carries pluginName so cwd resolves to the plugin dir", () => {
    const out = selectProcessesToStart(
      [manifest("git-viewer", [{ id: "git-viewer-server", startOn: "workspace_bound" }])],
      [],
      new Set(),
    );
    expect(out[0].pluginName).toBe("git-viewer");
    expect(pluginProcessCwd("C:/base/plugins", out[0].pluginName)).toBe("C:/base/plugins/git-viewer");
  });

  it("handles manifests with no processes array (容错)", () => {
    expect(selectProcessesToStart([{ pluginName: "x" } as unknown as PluginManifest], [], new Set())).toEqual([]);
  });
});

describe("selectProcessesToRebind — 切换工作区后需重启的进程", () => {
  const map = (entries: Array<[string, string]>) => new Map(entries);

  it("rebinds a running process spawned under a different workspace", () => {
    // 场景来源：git-viewer 在无 git 仓库的工作区启动，切到仓库后仍在跑旧路径,
    // 于是 /api/status 500 (not a git repository)。
    const out = selectProcessesToRebind(
      [running("git-viewer-server")],
      map([["git-viewer-server", "C:/Users/MR/claude-code-workspace"]]),
      "D:/Development/claude-code-haha-dev",
    );
    expect(out).toEqual(["git-viewer-server"]);
  });

  it("keeps a process already bound to the current workspace", () => {
    const out = selectProcessesToRebind(
      [running("git-viewer-server")],
      map([["git-viewer-server", "D:/Development/claude-code-haha-dev"]]),
      "D:/Development/claude-code-haha-dev",
    );
    expect(out).toEqual([]);
  });

  it("ignores processes that are not active (stale entries get respawned instead)", () => {
    const out = selectProcessesToRebind(
      [{ processId: "a-srv", status: "killed" }],
      map([["a-srv", "C:/old"]]),
      "D:/new",
    );
    expect(out).toEqual([]);
  });

  it("does not judge when the workspace is unknown (非 Tauri 保护, 避免误杀)", () => {
    const out = selectProcessesToRebind(
      [running("a-srv")],
      map([["a-srv", "C:/old"]]),
      undefined,
    );
    expect(out).toEqual([]);
  });

  it("ignores processes with no recorded spawn workspace (启动于本功能之前)", () => {
    const out = selectProcessesToRebind([running("a-srv")], map([]), "D:/new");
    expect(out).toEqual([]);
  });
});

describe("applyProcessStatus — 状态事件归约", () => {
  it("appends a new entry, updates an existing one", () => {
    const empty: PluginProcessInfo[] = [];
    const a = applyProcessStatus(empty, { processId: "p", status: "starting" });
    expect(a).toEqual([{ processId: "p", status: "starting" }]);
    const b = applyProcessStatus(a, { processId: "p", status: "running", port: 8300 });
    expect(b).toEqual([{ processId: "p", status: "running", port: 8300 }]);
    // 新数组(不可变更新)——React store 依赖引用变化触发重渲染;
    // 不就地改输入, a 保持 starting
    expect(empty).toEqual([]);
    expect(a).toEqual([{ processId: "p", status: "starting" }]);
    expect(b).not.toBe(a);
  });

  it('drops the row on "removed" (插件已卸载/禁用 → WorkerPanel 不残留)', () => {
    const list: PluginProcessInfo[] = [
      { processId: "git-viewer-server", status: "killed" },
      { processId: "other", status: "running" },
    ];
    const out = applyProcessStatus(list, { processId: "git-viewer-server", status: "removed" });
    expect(out).toEqual([{ processId: "other", status: "running" }]);
  });

  it('keeps the row on "killed" (WorkerPanel 显示已停止且可 ↻ 重启)', () => {
    const list: PluginProcessInfo[] = [{ processId: "p", status: "running" }];
    const out = applyProcessStatus(list, { processId: "p", status: "killed" });
    expect(out).toEqual([{ processId: "p", status: "killed" }]);
  });
});

describe("processStatusMeta — 状态归一化", () => {
  it("maps each status to label+color", () => {
    expect(processStatusMeta("running")).toEqual({ label: "running", color: "success" });
    expect(processStatusMeta("starting")).toEqual({ label: "starting", color: "accent" });
    expect(processStatusMeta("error")).toEqual({ label: "error", color: "error" });
    expect(processStatusMeta("killed")).toEqual({ label: "killed", color: "muted" });
    expect(processStatusMeta("stopped")).toEqual({ label: "stopped", color: "muted" });
    expect(processStatusMeta("unknown-state")).toEqual({ label: "stopped", color: "muted" });
  });
});

describe("isProcessActive — 面板订阅判定", () => {
  it("true for running/starting, false for stopped/error/killed", () => {
    expect(isProcessActive({ processId: "p", status: "running" })).toBe(true);
    expect(isProcessActive({ processId: "p", status: "starting" })).toBe(true);
    expect(isProcessActive({ processId: "p", status: "stopped" })).toBe(false);
    expect(isProcessActive({ processId: "p", status: "error" })).toBe(false);
    expect(isProcessActive({ processId: "p", status: "killed" })).toBe(false);
  });
});

// ── T2 (plugin-nodejs-runtime): 插件进程 env 组装 ──

describe("buildPluginProcessEnv — runtime PATH 注入", () => {
  it("injects PATH segment via CLAUDE_PLUGIN_PATH_PREPEND (Rust 拼接继承 PATH)", () => {
    const env = buildPluginProcessEnv(
      { VAR: "x" },
      ["C:/base/nodejs/runtime", "C:/base/py/rt"],
    );
    expect(env.VAR).toBe("x");
    expect(env.CLAUDE_PLUGIN_PATH_PREPEND).toBe("C:/base/nodejs/runtime;C:/base/py/rt");
  });

  it("omits the variable entirely when no runtime dirs (零回归)", () => {
    const env = buildPluginProcessEnv({ VAR: "x" }, []);
    expect(env.CLAUDE_PLUGIN_PATH_PREPEND).toBeUndefined();
    expect(env).toEqual({ VAR: "x" });
  });

  it("does not mutate the caller's env object", () => {
    const src = { VAR: "x" };
    buildPluginProcessEnv(src, ["C:/rt"]);
    expect(src).toEqual({ VAR: "x" });
  });

  // ── GV-T2: ${workspace} 占位符展开（git-viewer-server 的 CLAUDE_PLUGIN_WORKSPACE）──

  it("expands ${workspace} into the bound workdir when provided", () => {
    const env = buildPluginProcessEnv(
      { CLAUDE_PLUGIN_WORKSPACE: "${workspace}" },
      [],
      "C:/projects/my-repo",
    );
    expect(env.CLAUDE_PLUGIN_WORKSPACE).toBe("C:/projects/my-repo");
  });

  it("leaves the placeholder untouched when workspace is undefined (未绑定)", () => {
    const env = buildPluginProcessEnv({ CLAUDE_PLUGIN_WORKSPACE: "${workspace}" }, []);
    expect(env.CLAUDE_PLUGIN_WORKSPACE).toBe("${workspace}");
  });

  it("expands placeholders inside longer env values (组合值)", () => {
    const env = buildPluginProcessEnv(
      { GIT_BIN: "${workspace}/.git/bin/git.exe" },
      [],
      "C:/w",
    );
    expect(env.GIT_BIN).toBe("C:/w/.git/bin/git.exe");
  });

  // ── GV 进程 cwd 纯函数 (2026-09-09 修复: 相对 args 需在插件目录解析) ──

  it("builds cwd = plugins base + pluginName", () => {
    expect(pluginProcessCwd("C:/base/plugins", "git-viewer")).toBe("C:/base/plugins/git-viewer");
  });

  it("returns undefined when base or pluginName missing (防 cwd = plugins 根)", () => {
    expect(pluginProcessCwd(undefined, "git-viewer")).toBeUndefined();
    expect(pluginProcessCwd("C:/base/plugins", undefined)).toBeUndefined();
    expect(pluginProcessCwd(undefined, undefined)).toBeUndefined();
  });
});

// ── 按需启动（startOn: "on_demand"）──
//
// 用户 2026-10-26：很多插件只在"点一下"的那一刻需要跑，却必须常驻。
// 这里锁三条不变式：① 不随工作区自动起；② 空闲才回收；③ 拿不准就不回收。

describe("selectProcessesToStart — on_demand 不随工作区启动", () => {
  it("on_demand 的进程不会被 workspace_bound 那条路径拉起", () => {
    const out = selectProcessesToStart(
      [manifest("config-export", [{ id: "config-export-server", startOn: "on_demand" }])],
      [],
      new Set(),
    );
    expect(out).toHaveLength(0);
  });

  it("同一插件里常驻与按需混用时，只起常驻的", () => {
    const out = selectProcessesToStart(
      [manifest("mixed", [
        { id: "always-srv", startOn: "workspace_bound" },
        { id: "lazy-srv", startOn: "on_demand" },
      ])],
      [],
      new Set(),
    );
    expect(out.map((d) => d.id)).toEqual(["always-srv"]);
  });
});

describe("selectIdleProcesses — 空闲回收判定", () => {
  const IDLE = 5 * 60_000;
  const NOW = 1_000_000_000;

  const manifestWith = (id: string, startOn: "workspace_bound" | "on_demand") => {
    const m = manifest("p", [{ id }]);
    (m.processes![0] as any).startOn = startOn;
    return m;
  };
  const runningAt = (processId: string): PluginProcessInfo =>
    ({ processId, status: "running", port: 1234 });

  it("空闲够久 + 没面板在用 → 回收", () => {
    expect(selectIdleProcesses(
      [manifestWith("lazy", "on_demand")],
      [runningAt("lazy")],
      new Map(),
      new Map([["lazy", NOW - IDLE - 1]]),
      NOW, IDLE,
    )).toEqual(["lazy"]);
  });

  it("面板还开着 → 绝不回收（开着被杀 = 界面突然失联）", () => {
    expect(selectIdleProcesses(
      [manifestWith("lazy", "on_demand")],
      [runningAt("lazy")],
      new Map([["lazy", 1]]),
      new Map([["lazy", NOW - IDLE * 10]]), // 很久没调用，但面板开着
      NOW, IDLE,
    )).toEqual([]);
  });

  it("还没到空闲阈值 → 不回收", () => {
    expect(selectIdleProcesses(
      [manifestWith("lazy", "on_demand")],
      [runningAt("lazy")],
      new Map(),
      new Map([["lazy", NOW - IDLE + 1]]),
      NOW, IDLE,
    )).toEqual([]);
  });

  it("常驻进程即使空闲也不回收", () => {
    expect(selectIdleProcesses(
      [manifestWith("always", "workspace_bound")],
      [runningAt("always")],
      new Map(),
      new Map([["always", NOW - IDLE * 10]]),
      NOW, IDLE,
    )).toEqual([]);
  });

  it("没有使用记录（不是我们按需拉起的）→ 保守不动", () => {
    expect(selectIdleProcesses(
      [manifestWith("lazy", "on_demand")],
      [runningAt("lazy")],
      new Map(),
      new Map(),
      NOW, IDLE,
    )).toEqual([]);
  });

  it("只在 running 状态才考虑回收（starting/error 不碰）", () => {
    expect(selectIdleProcesses(
      [manifestWith("lazy", "on_demand")],
      [{ processId: "lazy", status: "starting" }, { processId: "lazy", status: "error" }],
      new Map(),
      new Map([["lazy", NOW - IDLE * 10]]),
      NOW, IDLE,
    )).toEqual([]);
  });
});
