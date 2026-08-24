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
}

export interface SkillInPackage {
  name: string;
  description: string;
  type: string;
}

export interface PackageDetail extends PackageSummary {
  skills: SkillInPackage[];
  translations?: string[];
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
