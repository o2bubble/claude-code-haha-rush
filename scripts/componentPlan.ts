// scripts/componentPlan.ts — 平台参数化的构建规划纯函数
//
// macOS 移植的"唯一测试 seam"（见 .scratch/macos-port/PRD.md）：
// 规划器决定每个组件在给定平台下怎么构建（build/reuse/system/skip）
// 与产物形态（exe/app/binary/dir/none），无 I/O、无平台 API。
// 执行器（build.ts）按规划调用对应平台的工具。Windows 与 macOS 走同一
// 规划逻辑，平台只是参数——将来加 Linux 只扩展枚举 + 补决策表测试。

export type Platform = "windows" | "macos";
export type ComponentAction = "build" | "reuse" | "system" | "skip";
export type ComponentArtifact = "exe" | "app" | "binary" | "dir" | "none";

export interface ComponentPlan {
  name: string;
  action: ComponentAction;
  artifact: ComponentArtifact;
  /** mac 上 system 组件的安装来源提示（如 brew 包名），仅决策可读性用 */
  requiresMacTools?: string[];
}

export interface PlanInput {
  platform: Platform;
  /** --components 显式选择；null = 全量构建 */
  selected: Set<string> | null;
  /** 上一版本产物：zip 是否存在（用于未选中组件复用） */
  prevRelease: { zipExists: (name: string) => boolean } | null;
}

export const KNOWN_COMPONENTS = [
  "gui", "claude", "bun", "tools", "python", "git", "extensions", "updater",
] as const;

/** 平台默认动作（全量构建语义）。mac 上 git 用系统（官方无便携发行版），
 *  bun/tools/python 均自包含（官方有 mac 二进制/包，下载内置，面向小白用户 0 操作）、
 *  updater 是 Windows 专属存根 → skip。 */
function defaultAction(platform: Platform, name: string): ComponentAction {
  if (platform === "windows") return "build";
  switch (name) {
    case "bun": return "build";    // macOS 自包含 bun（下载官方 darwin 二进制）
    case "tools": return "build";  // macOS 自包含 CLI 工具（下载各 darwin 资产）
    case "python": return "build"; // macOS 自包含 python（download + unpack pkg）
    case "git": return "system";
    case "updater": return "skip";
    default: return "build"; // gui / claude / extensions
  }
}

/** 平台产物形态（reuse 时保持与平台一致的 zip 形态）。 */
function artifactFor(platform: Platform, name: string, action: ComponentAction): ComponentArtifact {
  if (action === "system" || action === "skip") return "none";
  switch (name) {
    case "gui": return platform === "windows" ? "exe" : "app";
    case "claude": return platform === "windows" ? "exe" : "binary";
    case "bun": return platform === "windows" ? "exe" : "binary";
    case "updater": return "exe";
    default: return "dir"; // tools / python / extensions
  }
}

const MAC_TOOLS: Record<string, string[]> = {
  git: ["git"],
};

/** 构建规划：给定平台 + 组件选择 + 上一版本，产出每组件构建计划。 */
export function planComponents(input: PlanInput): ComponentPlan[] {
  return KNOWN_COMPONENTS.map((name) => {
    let action = defaultAction(input.platform, name);
    if (action === "build") {
      // 显式选择（--components）：选中的构建；未选中的优先复用上一版本。
      if (input.selected !== null && !input.selected.has(name)) {
        if (input.prevRelease && input.prevRelease.zipExists(name)) {
          action = "reuse";
        }
        // 无上一版本 → 保持 build（全量语义兜底，产物必须有）
      }
    }
    // system/skip 组件不受显式选择影响（mac 上不会因 --components bun 打包 brew 工具）
    const artifact = artifactFor(input.platform, name, action);
    return {
      name,
      action,
      artifact,
      requiresMacTools: input.platform === "macos" && action === "system"
        ? MAC_TOOLS[name] ?? undefined
        : undefined,
    };
  });
}
