// ── pluginDetailStore — 插件详情页数据桥（市场面板 → 独立详情面板）──
// 详情渲染为独立系统面板(userManaged:false, 默认 editor-area 中央区)——市场面板
// 常驻侧栏很窄, markdown 表格挤没法看; 详情在宽大的中央区展开(类 VS Code 扩展页)。
// 模块级单例: 详情面板组件经 usePluginDetail() 订阅, 市场面板 setPluginDetail() 发布。

import { useEffect, useState } from "react";

export interface PluginDetailData {
  /** 详情 key（market:<slug>）——重开同一插件时强制刷新 */
  key: string;
  slug: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  downloadCount: number;
  readme: string | null;
  /** 安装形态: standard(zip) | ai-guided(纯指导)——决定详情页按钮组 */
  installType?: "standard" | "ai-guided";
  /** 依赖的其它插件（展示） */
  dependencies?: string[];
  /** 官方签名验证通过（Ed25519）。false/undefined → 详情页只给「AI 安装」+ 安全审查,
   *  与市场卡片同规则——信任判定不能只在列表页生效, 否则从详情页能绕过未受信任的门。 */
  trusted?: boolean;
}

let detail: PluginDetailData | null = null;
const listeners = new Set<() => void>();

export function setPluginDetail(
  d: PluginDetailData | ((prev: PluginDetailData | null) => PluginDetailData | null),
): void {
  detail = typeof d === "function" ? d(detail) : d;
  for (const l of listeners) l();
}

export function getPluginDetail(): PluginDetailData | null {
  return detail;
}

/** 签名验证完成后回填信任状态(仅当详情页仍停在该 slug)。
 *  验证是异步串行下载校验——用户可能在完成前就点开详情, 那时 trusted=false;
 *  验证完成后据此修正, 否则详情页永久停在"未受信任"。 */
export function setPluginDetailTrusted(slug: string, trusted: boolean): void {
  if (!detail || detail.slug !== slug || detail.trusted === trusted) return;
  detail = { ...detail, trusted };
  for (const l of listeners) l();
}

/** React hook — 详情变化时重渲染 */
export function usePluginDetail(): PluginDetailData | null {
  const [cur, setCur] = useState<PluginDetailData | null>(detail);
  useEffect(() => {
    const un = subscribePluginDetail(() => setCur(detail));
    return un;
  }, []);
  return cur;
}

function subscribePluginDetail(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
