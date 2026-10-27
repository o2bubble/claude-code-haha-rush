// ── 技能更新检测（纯函数，便于单测）──
//
// 为什么用**内容哈希**而不是版本号（2026-10-26）：
//   · 本地装技能时只复制文件，不记录来源版本
//   · 上游大部分 SKILL.md 也没有 version 字段
//   → 版本号这条路走不通
//
// 现在的做法：服务端发布时算好每个技能的内容哈希，客户端对本地目录用
// **同一算法**算一遍（见 docs/skill-content-hash.md），直接比字符串。

/** 单个技能的更新状态 */
export type SkillUpdateState =
  /** 本地没装 */
  | "not-installed"
  /** 已装且内容一致 */
  | "up-to-date"
  /** 已装但内容不同 —— 可以更新 */
  | "outdated"
  /** 已装，但服务端没给哈希（老服务端）→ 无法判断 */
  | "unknown";

/**
 * 判断一个技能当前的更新状态。
 *
 * @param localHash 本地技能内容哈希（`local_skill_hashes` 返回）；没装传 undefined
 * @param remoteHash 市场包的 `skill_hashes[skillName]`；服务端没提供传 undefined
 */
export function skillUpdateState(
  localHash: string | undefined,
  remoteHash: string | undefined,
): SkillUpdateState {
  if (!localHash) return "not-installed";
  if (!remoteHash) return "unknown";
  return localHash === remoteHash ? "up-to-date" : "outdated";
}

/**
 * 一个包里有几个技能是过期的。
 *
 * 只看本地已装且能判断的技能 —— 没装的不算"过期"（那是安装，不是更新）。
 */
export function countOutdated(
  pkgSkillNames: string[],
  localHashes: Record<string, string>,
  remoteHashes: Record<string, string> | undefined,
): number {
  if (!remoteHashes) return 0;
  let n = 0;
  for (const name of pkgSkillNames) {
    const local = localHashes[name];
    const remote = remoteHashes[name];
    if (local && remote && local !== remote) n++;
  }
  return n;
}

/**
 * 整包的更新状态（用于包级别的徽标）。
 *
 * 包内只要有**任意一个**本地已装技能过期，就算整包可更新。
 * 一个都没装过 → not-installed（不是"可更新"）。
 */
export function packageUpdateState(
  pkgSkillNames: string[],
  localHashes: Record<string, string>,
  remoteHashes: Record<string, string> | undefined,
): SkillUpdateState {
  if (!pkgSkillNames.length) return "not-installed";

  const installed = pkgSkillNames.filter((n) => localHashes[n]);
  if (!installed.length) return "not-installed";

  if (!remoteHashes) return "unknown";

  const outdated = installed.filter((n) => {
    const remote = remoteHashes[n];
    return remote && remote !== localHashes[n];
  });

  if (outdated.length > 0) return "outdated";
  return "up-to-date";
}
