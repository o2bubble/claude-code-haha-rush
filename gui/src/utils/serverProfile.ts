/**
 * 服务器档位与地址 —— 前端唯一真源。
 *
 * 地址字面量此前散落在 8+ 处，靠注释维持一致。Rust 侧也各有一份
 * （`settings.rs::DEFAULT_96_SERVER` 与 `diagnostics.rs::CLOUD_SERVER_URL`）——
 * 跨语言无法共享常量，改本文件时请同步那两处。
 *
 * 公网档用 Cloudflare Tunnel 域名而非云主机裸 IP：裸 IP 在受限网络下被整段
 * 拦掉，详见 docs/cloudflare-tunnel-cloud-playbook.md。
 */

/** 三档。字面量沿用向导既有的 "intranet"/"public"，只新增 "custom" —— 向导侧无需重命名。 */
export type ServerProfile = "intranet" | "public" | "custom";

/** 向导的两档：可一键选定、可做连通性探测。 */
export type PresetServerProfile = Exclude<ServerProfile, "custom">;

/** 内网 96（同局域网直连，比绕公网隧道快）。 */
export const INTRANET_SERVER_URL = "http://192.168.186.96:8765";

/** 公网云（Cloudflare Tunnel）。 */
export const CLOUD_SERVER_URL = "https://release.17lumen.cloud";

/**
 * 档位 → 两个设置字段的值。
 *
 * 两字段必须同值：早期设置面板只写 `skillRegistryUrl`，导致技能库切了、
 * 自动更新仍指向旧地址。
 */
export function serverProfileUrls(
  profile: ServerProfile,
  customUrl?: string,
): { skillRegistryUrl: string; updateServerUrl: string } {
  switch (profile) {
    case "intranet":
      return { skillRegistryUrl: INTRANET_SERVER_URL, updateServerUrl: INTRANET_SERVER_URL };
    case "public":
      return { skillRegistryUrl: CLOUD_SERVER_URL, updateServerUrl: CLOUD_SERVER_URL };
    case "custom": {
      const url = (customUrl ?? "").trim();
      return { skillRegistryUrl: url, updateServerUrl: url };
    }
  }
}

/**
 * 从当前设置值反推档位。
 *
 * 两个字段都精确等于某个预设才算命中 —— 只有一个匹配、或两者不一致时一律落
 * "custom"。这是有意为之：既覆盖历史漂移残留（旧面板只写一个字段），也让用户
 * 一保存就把两字段收敛自愈，而不是替用户猜哪个才对。
 */
export function deriveServerProfile(
  skillRegistryUrl?: string,
  updateServerUrl?: string,
): ServerProfile {
  const a = (skillRegistryUrl ?? "").trim();
  const b = (updateServerUrl ?? "").trim();
  if (a === INTRANET_SERVER_URL && b === INTRANET_SERVER_URL) return "intranet";
  if (a === CLOUD_SERVER_URL && b === CLOUD_SERVER_URL) return "public";
  return "custom";
}

/**
 * 自定义档输入框的显示值。优先 `skillRegistryUrl` —— 旧面板写的就是它，最可能
 * 是用户真实意图；为空再退回 `updateServerUrl`。
 */
export function customServerUrlForDisplay(
  skillRegistryUrl?: string,
  updateServerUrl?: string,
): string {
  return (skillRegistryUrl ?? "").trim() || (updateServerUrl ?? "").trim();
}
