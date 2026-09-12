// skillMarketplace.ts — API client for the skill registry server

import { getSettings } from "../stores/settingsStore";

export interface PackageSummary {
  slug: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  download_count: number;
  skill_count: number;
  /** 包类型: "skill"(技能市场) | "plugin"(插件市场)。server 无该字段时默认 "skill" */
  type?: "skill" | "plugin";
  /** 插件分类: component(基础组件)/tool(工具)/guide(指导)/integration(集成)。server 无该字段时 undefined */
  category?: "component" | "tool" | "guide" | "integration";
  /** 依赖的其它插件(pluginName 列表)。server 无该字段时 undefined */
  dependencies?: string[];
  /** 安装形态: standard(zip 可执行物) | ai-guided(纯指导文档, 只能 AI 代装/卸)。undefined 视为 standard */
  installType?: "standard" | "ai-guided";
  /** 支持平台 (windows/macos/linux)。undefined/空 = 全平台。GUI 按编译结果展示支持状态 */
  platforms?: string[];
}

export interface SkillInPackage {
  name: string;
  description: string;
  type: string;
}

export interface PackageDetail extends PackageSummary {
  skills: SkillInPackage[];
  translations?: string[];
  /** 插件详情页正文（包根 README.md，server 对 type=plugin 透传；缺省 undefined） */
  readme?: string;
}

function getBaseUrl(): string {
  return getSettings().skillRegistryUrl ?? "http://192.168.186.96:8765";
}

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const skillMarketplace = {
  async listPackages(): Promise<PackageSummary[]> {
    const url = `${getBaseUrl()}/api/packages`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error ?? "Unknown error");
    return json.data ?? [];
  },

  /** 插件专用列表端点（GET /api/plugins）——服务端按 type=plugin 过滤。
   *  与技能列表分开，防旧服务端/旧 GUI 两端任何一侧缺 type 过滤时串库。 */
  async listPlugins(): Promise<PackageSummary[]> {
    const url = `${getBaseUrl()}/api/plugins`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error ?? "Unknown error");
    return json.data ?? [];
  },

  async getPackage(slug: string): Promise<PackageDetail> {
    const url = `${getBaseUrl()}/api/packages/${encodeURIComponent(slug)}`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error ?? "Unknown error");
    return json.data;
  },

  getPackageDownloadUrl(slug: string): string {
    return `${getBaseUrl()}/api/packages/${encodeURIComponent(slug)}/download`;
  },

  getSkillDownloadUrl(slug: string, skillName: string): string {
    return `${getBaseUrl()}/api/packages/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillName)}/download`;
  },

  async fetchTranslations(slug: string, lang: string): Promise<Record<string, { title?: string; desc?: string }> | null> {
    const url = `${getBaseUrl()}/api/packages/${encodeURIComponent(slug)}/translations/${encodeURIComponent(lang)}`;
    const resp = await fetchWithTimeout(url, 8000);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  },
};
