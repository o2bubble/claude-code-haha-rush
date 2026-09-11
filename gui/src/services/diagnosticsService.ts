// diagnosticsService.ts — 运行环境诊断（委托 Rust run_env_diagnostics）

export type CheckStatus = "pass" | "warn" | "fail" | "na";

export interface DiagnosticCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  /** 分类内的小节（如「安装环境变量」），缺省则直接挂在分类下 */
  group?: string;
}

export interface DiagnosticCategory {
  id: string;
  title: string;
  checks: DiagnosticCheck[];
}

export interface DiagnosticsReport {
  timestamp: number;
  categories: DiagnosticCategory[];
}

/** 云服务器镜像地址 — 与后端探测常量一致，用于「切换到云服务器」 */
export const CLOUD_SERVER_URL = "http://123.56.66.84:8765";

export const diagnosticsService = {
  async run(): Promise<DiagnosticsReport> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DiagnosticsReport>("run_env_diagnostics");
  },

  /** 网络连通探测 — 独立命令（较慢，后台线程并行探测） */
  async runNetwork(): Promise<DiagnosticsReport> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DiagnosticsReport>("run_network_diagnostics");
  },

  /** 工作区检查（绑定状态 / 局部设置 / 会话数据库） */
  async runWorkspace(): Promise<DiagnosticsReport> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DiagnosticsReport>("run_workspace_diagnostics");
  },

  /** 修复: 杀死残留 claude/bun 后台并重启 IDE 后端 */
  async fixRestartIdeBackend(): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("fix_restart_ide_backend");
  },

  /** 修复: 探测并修正环境变量(写注册表 + 更新进程 env), 返回逐项报告 */
  async fixEnvironmentVars(): Promise<EnvVarFix[]> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<EnvVarFix[]>("fix_environment_vars");
  },

  /** 修复: 激活的 profile 无效时自动切换到第一个有凭据的 profile, 返回逐项报告 */
  async fixProfiles(): Promise<EnvVarFix[]> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<EnvVarFix[]>("fix_profiles");
  },
};

export interface EnvVarFix {
  name: string;
  problem: string;
  action: string;
}
