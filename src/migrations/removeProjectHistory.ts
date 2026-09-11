import type { ProjectConfig } from '../utils/config.js'

/**
 * Removes history field from projects (migrated to history.jsonl)
 *
 * 不是版本号门控的一次性迁移 —— 它挂在全局配置的 save 路径上，
 * 每次写配置都会跑（纯转换），幂等：无 history 字段时原样返回同一引用。
 *
 * @internal
 */
export function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history is removed from the type but may exist in old configs
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}
