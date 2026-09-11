/**
 * ── GUI 侧迁移统一入口与权威登记表 ──
 *
 * 本文件是 GUI（gui/src/）所有「旧配置 / 旧持久化数据格式迁移」的唯一索引。
 * 新增迁移时：先实现迁移函数，再在下方 MIGRATION_REGISTRY 登记一条。
 *
 * ## 触发方式
 *
 * - `startup`   启动 / 加载路径上跑（由 store 的 load/restore 调用）
 * - `read-path` 挂在读路径上，每次读都跑（纯转换，幂等）
 * - `ui-effect` 由 React 组件的 effect 触发，含写回
 *
 * ## 登记项里为什么有"不搬家的"迁移
 *
 * 部分迁移与所在模块的管线强耦合（store 自身的反序列化流程、React 组件状态），
 * 强搬会改变调用时机、引入循环依赖或让组件逻辑碎片化。这类迁移**保留在原地**，
 * 在本表登记但 `fn` 留空 —— 保证「所有迁移在哪」一处可查。
 *
 * ## Rust 侧的迁移在哪
 *
 * GUI 的 Tauri 后端（gui/src-tauri/src/migrations.rs）另有一份登记表，
 * 管磁盘配置文件的迁移（settings.json / claude.json / .env profiles）。
 * 本文件只管前端持久化数据。
 */

import type { AppSettings } from "../stores/settingsStore";

/**
 * workspaces 为空但 workDir 有值 → 用 workDir 播种 workspaces。
 *
 * 早期版本只存单个 workDir，后来引入多工作区；老用户升级后 workspaces
 * 为空会导致工作区选择器无内容，故在加载时补齐。
 *
 * 纯函数（原地修改并返回同一对象，与调用点原有语义一致），幂等。
 */
export function migrateWorkspaceSeed(settings: AppSettings): AppSettings {
  if (settings.workspaces.length === 0 && settings.workDir) {
    settings.workspaces = [settings.workDir];
  }
  return settings;
}

export type MigrationTrigger = "startup" | "read-path" | "ui-effect";

export interface MigrationEntry {
  /** 迁移函数名（未搬家的填函数名以便检索） */
  name: string
  /** 触发方式（见文件头说明） */
  trigger: MigrationTrigger
  /** 迁移什么（旧格式 → 新格式） */
  target: string
  /** 函数本体所在文件（相对 gui/src） */
  source: string
  /** 幂等性说明 */
  idempotent: string
  /** 迁移函数本体；未搬家的留空（只登记，不参与调用） */
  fn?: (input: never) => unknown
}

/**
 * 权威登记表 —— GUI 前端所有迁移的唯一索引。顺序无关（各项互相独立）。
 */
export const MIGRATION_REGISTRY: readonly MigrationEntry[] = [
  {
    name: "migrateWorkspaceSeed",
    trigger: "startup",
    target: "settings.workDir（单工作区时代）→ settings.workspaces 数组",
    source: "migrations/index.ts",
    idempotent: "workspaces 非空即跳过",
    fn: migrateWorkspaceSeed as (input: never) => unknown,
  },

  // ── 登记但未搬家：与所在模块管线强耦合，详见文件头说明 ──
  {
    name: "deserializeTab / deserializeLayout / refreshTitles",
    trigger: "startup",
    target: "持久化布局树：旧 icon（ReactNode 对象）→ 回退 registry；旧硬编码英文标题 → 按 i18n 刷新",
    source: "stores/layoutStore.ts",
    idempotent: "仅在字段非法 / 与 registry 不一致时改写",
  },
  {
    name: "loadQueueData",
    trigger: "startup",
    target: "localStorage 消息队列：畸形 / 旧形状条目丢弃，一律恢复为 paused",
    source: "stores/msgQueueState.ts",
    idempotent: "丢弃非法条目，合法条目原样保留",
  },
  {
    name: "toColumnDefs（表格旧数据兼容）",
    trigger: "read-path",
    target: "表格 content：扁平列 / 无 children|cellStyles|formats|pinned → 新列定义",
    source: "utils/tableAdapter.ts",
    idempotent: "纯转换，不写回",
  },
  {
    name: "customCompactPrompt presetId 推导",
    trigger: "ui-effect",
    target: "settings.customCompactPrompt：缺 presetId → 按 text 推导；handoff 旧模板 → 刷新为最新文本",
    source: "components/chat/SettingsPanel.tsx",
    idempotent: "text 已是最新模板即不改写",
  },
  {
    name: "normalizeGraphicContent",
    trigger: "read-path",
    target: "超级桌面图形 content：旧 nodes/edges 结构 → 规范结构；空 → 默认示例",
    source: "components/desktop/graphicContent.ts",
    idempotent: "纯转换，不写回（仅在编辑提交时落库）",
  },
]
