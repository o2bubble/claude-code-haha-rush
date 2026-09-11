/**
 * ── CLI 侧迁移统一入口与权威登记表 ──
 *
 * 本文件是 CLI（src/）所有「旧配置 / 旧持久化数据格式迁移」的唯一索引。
 * 新增迁移时：先实现迁移函数，再在下方 MIGRATION_REGISTRY 登记一条。
 *
 * ## 触发方式
 *
 * - `sync`      启动时跑一次，受 CURRENT_MIGRATION_VERSION 版本号门控（见 src/main.tsx）
 * - `async`     启动时 fire-and-forget，不参与版本号门控
 * - `read-path` 挂在配置的读 / 写路径上，每次访问都跑（纯转换，幂等，不写回）
 * - `startup`   由其它启动流程按需调用（不经过 runMigrations）
 *
 * ## 登记项里为什么有"不搬家的"迁移
 *
 * 部分迁移与所在模块的私有状态强耦合（模块级缓存、私有 helper、自带版本体系），
 * 强搬会产生循环依赖或语义漂移。这类迁移**保留在原地**，在本表登记但 `fn` 留空 ——
 * 保证「所有迁移在哪」一处可查，同时不把它们塞进 runMigrations 的遍历。
 *
 * ## 导入约束
 *
 * 本文件会 import 各迁移模块。需要反向使用迁移函数的模块（如 src/utils/config.ts）
 * 必须从**具体文件**导入，不能从本文件导入，否则形成运行时循环依赖。
 */

import { feature } from 'bun:bundle'

import { migrateAutoUpdatesToSettings } from './migrateAutoUpdatesToSettings.js'
import { migrateBypassPermissionsAcceptedToSettings } from './migrateBypassPermissionsAcceptedToSettings.js'
import { migrateEnableAllProjectMcpServersToSettings } from './migrateEnableAllProjectMcpServersToSettings.js'
import { migrateFennecToOpus } from './migrateFennecToOpus.js'
import { migrateLegacyOpusToCurrent } from './migrateLegacyOpusToCurrent.js'
import { migrateOpusToOpus1m } from './migrateOpusToOpus1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrateReplBridgeEnabledToRemoteControlAtStartup.js'
import { migrateSonnet1mToSonnet45 } from './migrateSonnet1mToSonnet45.js'
import { migrateSonnet45ToSonnet46 } from './migrateSonnet45ToSonnet46.js'
import { resetAutoModeOptInForDefaultOffer } from './resetAutoModeOptInForDefaultOffer.js'
import { resetProToOpusDefault } from './resetProToOpusDefault.js'

// 搬家进来的两个读 / 写路径迁移（原位于 src/utils/config.ts）
export { migrateConfigFields } from './migrateConfigFields.js'
export { removeProjectHistory } from './removeProjectHistory.js'

// 统一 re-export 目录内全部一次性迁移（调用点可从本文件单点导入）
export {
  migrateAutoUpdatesToSettings,
  migrateBypassPermissionsAcceptedToSettings,
  migrateEnableAllProjectMcpServersToSettings,
  migrateFennecToOpus,
  migrateLegacyOpusToCurrent,
  migrateOpusToOpus1m,
  migrateReplBridgeEnabledToRemoteControlAtStartup,
  migrateSonnet1mToSonnet45,
  migrateSonnet45ToSonnet46,
  resetAutoModeOptInForDefaultOffer,
  resetProToOpusDefault,
}

// feature() 只允许直接用于 if / 三元条件（bun:bundle 的 DCE 约束），
// 故此处用三元在模块加载时求值成静态布尔，登记表里引用该常量。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
const TRANSCRIPT_CLASSIFIER_ENABLED = feature('TRANSCRIPT_CLASSIFIER') ? true : false

export type MigrationTrigger = 'sync' | 'async' | 'read-path' | 'startup'

export interface MigrationEntry {
  /** 迁移函数名 */
  name: string
  /** 触发方式（见文件头说明） */
  trigger: MigrationTrigger
  /** 迁移什么（旧字段 / 旧文件 → 新字段 / 新文件） */
  target: string
  /** 函数本体所在文件（相对仓库根）；不在本目录时说明它是"登记但未搬家" */
  source: string
  /** 幂等性说明 */
  idempotent: string
  /** 版本号门控 / feature flag 等附加约束（人类可读） */
  gate?: string
  /** 迁移函数本体；与模块强耦合而未搬家的项留空（只登记，不参与遍历） */
  fn?: () => void
  /** 运行条件（feature flag / 构建类型），模块加载时求值的静态布尔；缺省 = 无条件 */
  condition?: boolean
}

/**
 * 权威登记表 —— CLI 侧所有迁移的唯一索引。
 *
 * sync 项的顺序 = runMigrations() 的调用顺序（src/main.tsx 遍历本表），
 * 改动顺序等于改变行为，勿随意调整。
 */
export const MIGRATION_REGISTRY: readonly MigrationEntry[] = [
  {
    name: 'migrateAutoUpdatesToSettings',
    trigger: 'sync',
    target: 'globalConfig.autoUpdates → settings.json env.DISABLE_AUTOUPDATER',
    source: 'src/migrations/migrateAutoUpdatesToSettings.ts',
    idempotent: '仅在 autoUpdates === false 且非 native 保护时写；写完从 config 删除该字段',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: migrateAutoUpdatesToSettings,
  },
  {
    name: 'migrateBypassPermissionsAcceptedToSettings',
    trigger: 'sync',
    target: 'globalConfig.bypassPermissionsModeAccepted → settings.json',
    source: 'src/migrations/migrateBypassPermissionsAcceptedToSettings.ts',
    idempotent: '写入后删除源字段',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: migrateBypassPermissionsAcceptedToSettings,
  },
  {
    name: 'migrateEnableAllProjectMcpServersToSettings',
    trigger: 'sync',
    target: 'globalConfig.enableAllProjectMcpServers → settings.json',
    source: 'src/migrations/migrateEnableAllProjectMcpServersToSettings.ts',
    idempotent: '写入后删除源字段',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: migrateEnableAllProjectMcpServersToSettings,
  },
  {
    name: 'resetProToOpusDefault',
    trigger: 'sync',
    target: '每次版本升级后重置 Pro 用户默认模型',
    source: 'src/migrations/resetProToOpusDefault.ts',
    idempotent: '由 lastOnboardingVersion 比对决定是否执行',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: resetProToOpusDefault,
  },
  {
    name: 'migrateSonnet1mToSonnet45',
    trigger: 'sync',
    target: 'sonnet[1m] → 显式 Sonnet 4.5[1m] 模型串',
    source: 'src/migrations/migrateSonnet1mToSonnet45.ts',
    idempotent: '只匹配旧模型串',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: migrateSonnet1mToSonnet45,
  },
  {
    name: 'migrateLegacyOpusToCurrent',
    trigger: 'sync',
    target: '旧 Opus 模型串 → current Opus',
    source: 'src/migrations/migrateLegacyOpusToCurrent.ts',
    idempotent: '只匹配旧模型串',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: migrateLegacyOpusToCurrent,
  },
  {
    name: 'migrateSonnet45ToSonnet46',
    trigger: 'sync',
    target: '显式 Sonnet 4.5 串 → sonnet / sonnet[1m] 别名',
    source: 'src/migrations/migrateSonnet45ToSonnet46.ts',
    idempotent: '仅当 userSettings.model 命中 4.5 串时写',
    gate: 'CURRENT_MIGRATION_VERSION + firstParty + Pro/Max/Team',
    fn: migrateSonnet45ToSonnet46,
  },
  {
    name: 'migrateOpusToOpus1m',
    trigger: 'sync',
    target: 'opus → opus[1m]（1m 上下文）',
    source: 'src/migrations/migrateOpusToOpus1m.ts',
    idempotent: '只匹配旧模型串',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: migrateOpusToOpus1m,
  },
  {
    name: 'migrateReplBridgeEnabledToRemoteControlAtStartup',
    trigger: 'sync',
    target: 'replBridgeEnabled → remoteControlAtStartup',
    source: 'src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts',
    idempotent: '写入后删除源字段',
    gate: 'CURRENT_MIGRATION_VERSION',
    fn: migrateReplBridgeEnabledToRemoteControlAtStartup,
  },
  {
    name: 'resetAutoModeOptInForDefaultOffer',
    trigger: 'sync',
    target: 'churn 用户的 auto 模式 opt-in 一次性重置',
    source: 'src/migrations/resetAutoModeOptInForDefaultOffer.ts',
    idempotent: '由 hasResetAutoModeOptInForDefaultOffer 标记位保证',
    gate: "CURRENT_MIGRATION_VERSION + feature('TRANSCRIPT_CLASSIFIER')",
    fn: resetAutoModeOptInForDefaultOffer,
    condition: TRANSCRIPT_CLASSIFIER_ENABLED,
  },
  {
    name: 'migrateFennecToOpus',
    trigger: 'sync',
    target: 'Fennec 内部模型串 → Opus',
    source: 'src/migrations/migrateFennecToOpus.ts',
    idempotent: '只匹配旧模型串',
    gate: 'CURRENT_MIGRATION_VERSION + ant 内部构建',
    fn: migrateFennecToOpus,
    // 与 main.tsx 原判断一致：构建期字面量替换（external 构建下整段被 DCE）
    condition: "external" === 'ant',
  },

  // ── 登记但未搬家：与所在模块强耦合，fn 留空，见文件头说明 ──
  {
    name: 'migrateConfigFields',
    trigger: 'read-path',
    target: 'autoUpdaterStatus → installMethod + autoUpdates',
    source: 'src/migrations/migrateConfigFields.ts',
    idempotent: 'installMethod 已存在即原样返回（同引用）',
    gate: '无（挂 getGlobalConfig 三个读路径，每次读都跑）',
  },
  {
    name: 'removeProjectHistory',
    trigger: 'read-path',
    target: 'config.projects[*].history → 删除（已迁 history.jsonl）',
    source: 'src/migrations/removeProjectHistory.ts',
    idempotent: '无 history 字段时返回同一引用',
    gate: '无（挂全局配置 save 路径，每次写都跑）',
  },
  {
    name: 'migrateChangelogFromConfig',
    trigger: 'async',
    target: 'globalConfig.cachedChangelog → ~/.claude/cache/changelog.md',
    source: 'src/utils/releaseNotes.ts',
    idempotent: '写文件后从 config 删除源字段',
    gate: '无（每次启动 fire-and-forget，失败下次重试）',
  },
  {
    name: 'migrateToSinglePluginFile',
    trigger: 'startup',
    target: 'installed_plugins_v2.json + v1 installed_plugins.json → 单文件 v2',
    source: 'src/utils/plugins/installedPluginsManager.ts',
    idempotent: '模块级 migrationCompleted 标记，每会话一次',
    gate: '无（由 loadInstalledPlugins 的初始化路径调用）',
  },
  {
    name: 'migrateV1ToV2',
    trigger: 'read-path',
    target: 'installed_plugins.json V1 → V2（补 scope: user）',
    source: 'src/utils/plugins/installedPluginsManager.ts',
    idempotent: '纯转换，被读取路径与文件迁移共同调用',
    gate: '无',
  },
  {
    name: 'migrateFromEnabledPlugins',
    trigger: 'startup',
    target: 'settings.json enabledPlugins → installed_plugins.json 回填',
    source: 'src/utils/plugins/installedPluginsManager.ts',
    idempotent: '已存在的安装记录跳过',
    gate: '无（pluginStartupCheck 调用）',
  },
  {
    name: 'migrateStatsCache',
    trigger: 'read-path',
    target: 'stats-cache.json v1/v2 → v3',
    source: 'src/utils/statsCache.ts',
    idempotent: '版本相等即跳过；迁移后立即 saveStatsCache 落盘',
    gate: 'STATS_CACHE_VERSION / MIN_MIGRATABLE_VERSION（自带版本体系）',
  },
]
