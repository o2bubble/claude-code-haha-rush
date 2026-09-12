# 插件市场面板 · UI/UX 改版 · 设计规格

> **状态：已锁定** · 2026-09-10
> **方向：B 结构重做** — 卡片三段化 + 主按钮/⋯ 溢出菜单 + 详情页头部收敛
> **可视化参考**：`plugin-panel-redesign.html`（同目录，可交互）
> **目标文件**：`claude-code-haha-dev/gui/src/components/chat/PluginMarketPanel.tsx` + `PluginMarketDetailPanel.tsx` + `marketplaceStyles.ts` + `i18n/{zh,en}.ts`

---

## 1. 决策背景

插件市场面板（`PluginMarketPanel.tsx`，常驻侧栏，宽度约 190–300px）现状痛点，来自用户截图与代码核对：

1. **单行按钮爆炸**：`git-viewer` 一行挤 9 个元素——名称 + 「已安装」徽标 + 「79 次下载」+ 更新 + 禁用 + 卸载 + AI 卸载。实测 268px 宽下面板**物理溢出**，名称被截断、下载数竖排成三行。
2. **按钮无主次**：「更新」与「AI 卸载」视觉权重完全相同（同为 `installBtnStyle` 描边按钮），看不出哪个是决定性动作。
3. **信息混排**：描述与「作者 · 版本 · 依赖 · 标签」压成两行 11px `--fg-muted` 灰字，读不清。
4. **不使用图标**：manifest 有 `icon?` 字段，市场侧不下发（见 §5），卡片完全无视觉锚点。
5. **详情页头部同病**：`PluginMarketDetailPanel` 头部同样平铺 4 个按钮。

经 grilling 三轮决策（Q1 范围 / Q2 按钮模型 / Q3 详情页力度），锁定 B 方案。

### 1.1 关键前提（已核实）

- **主战场是窄栏，不是宽屏**。`PluginMarketPanel.tsx:5` 明确写着「本面板常驻侧栏窄, 宽幅 README markdown 展示由详情面板承担」。卡片设计必须按 268px 验收。
- **详情页本就该开在宽中央区**。`pluginDetailStore.ts:2-3` 注释：「市场面板常驻侧栏很窄, markdown 表格挤没法看; 详情在宽大的中央区展开(类 VS Code 扩展页)」。用户截图里详情挤成一团，是因为它被拖进了窄列——**不因此推翻该设计**。

## 2. 设计原则（锁定）

1. **窄栏优先**：一切尺寸在 268px 下验收通过，宽屏是增强而非前提。
2. **单一决策点**：主按钮由唯一函数产出，列表与详情共用，禁止两处各写一套判定。
3. **安全门零改动**：未受信任插件的判定与文案**一行不动**，只换外观（详见 §6）。
4. **零新接口**：不改 `PackageSummary`、不改市场接口、不改 Rust。图标退化方案见 §5。
5. **数据流零改动**：`install_plugin_package` / `reloadPlugins` / `PLUGINS_RESCANNED` / `pluginDetailStore` 全部原样，只换渲染层。

## 3. 卡片规格（三段结构）

### 3.1 结构

```
┌──────────────────────────────────────────┐
│ ▣  git-viewer          [已安装] [可更新]  │  ← r1 名称行
│ 只读 Git 查看器 — 工作区改动 diff / 提交  │  ← r2 描述行
│ 历史 / 分支列表。纯查看不做写操作          │     (clamp 2 行)
│ 官方 · v0.1.3 → v0.1.3+ · 79 次下载  git  │  ← r3 元信息行
│ diff  +2                                 │
│ [  ↓ 更新  ]                        [⋯]  │  ← act 操作行
└──────────────────────────────────────────┘
```

| 行 | 内容 | 规格 |
|----|------|------|
| `r1` | 分类图标（26×26 圆角）+ 名称 + 徽标组 | 名称 `flex:1`、`text-overflow:ellipsis` |
| `r2` | 描述 | `margin-left:33px` 与名称对齐；`-webkit-line-clamp:2` |
| `r3` | 作者 · 版本 · 下载数 + 依赖/标签小片 | 依赖与标签降级为等宽小片（`--bg-code`），**最多显示 2 个**，超出折叠为 `+N`（`title` 给全量） |
| `act` | 主按钮 + ⋯ | `margin-left:33px`；无主按钮时 ⋯ 靠右 |

### 3.2 徽标（保留现有全部徽标语汇）

| 徽标 | 条件 | 样式 |
|------|------|------|
| `已安装` / `已禁用` | `installedMap` 命中（name 或 slug 任一） | accent 描边 / muted 描边 |
| `可更新` | `isPluginUpdateAvailable(已装版本, 市场版本)` | info 描边（**新增徽标**） |
| `未受信任` | `!trustedSlugs.has(slug)` 且未装 | warning 描边 |
| `不支持当前平台` | `!pluginSupportsPlatform(...)` | error 描边（**保留现有**） |
| `AI-guided` | 仅详情页 | accent 描边 |

卡片 `opacity:0.55` 条件（禁用 / 平台不支持）保留不变。

### 3.3 分区与筛选（保留现状，不改）

- 搜索框、分类 chips（`collectCategoryTabs` 动态并集）、「已安装 / 可安装」两分区（`SectionHeader`）**结构保留**。
- 分区标题由 `<div sticky>` 保留 `position:sticky; top:0`。

## 4. 操作模型（主按钮 + ⋯ 溢出菜单）

### 4.1 决策表（唯一决策函数 `primaryKey(plugin)`）

| 状态 | 主按钮 | ⋯ 菜单项 |
|------|--------|----------|
| 未装 · 受信任 · standard | **安装**（实心 accent） | AI 安装 |
| 未装 · 未受信任 | **AI 安装**（实心 accent） | —（无 ⋯） |
| 未装 · ai-guided | **AI 安装**（实心 accent） | —（无 ⋯） |
| 已装 · 可更新 · standard/受信任 | **更新**（实心 accent） | 禁用 / 卸载(红) / ─── / AI 卸载 |
| 已装 · 可更新 · 未受信任 或 ai-guided | **更新**（实心 accent，走 AI） | 禁用? / 卸载? / AI 卸载 |
| 已装 · 已禁用 | **启用**（实心 accent） | 卸载(红) / AI 卸载 |
| 已装 · 启用 · 最新 · standard | **禁用**（**描边，降一级**） | 卸载(红) / ─── / AI 卸载 |
| 已装 · 启用 · 最新 · ai-guided | 无主按钮 | AI 卸载 |

**规则说明**：

- 高频决定性动作（安装/更新/启用）→ 主按钮，实心 `--accent` 填充。
- 「已装·启用·最新」**无正事可做**，主按钮降为「禁用」并改用**描边**（非实心），避免把低频动作抬成主 CTA。
- 卸载是破坏性动作 → 永远在 ⋯ 内，红色（`--semantic-error`）。
- **AI 卸载与直接操作之间加分隔线**（`div`），语义区隔「AI 代办」与「直接操作」。
- **无主按钮时 ⋯ 自动加描边**（用 `btn` 而非 `btn ghost`）——否则它是卡片唯一控件却几乎不可见（渲染验证时实测发现）。

### 4.2 ⋯ 菜单

- 菜单项 = **该插件全部可用动作 − 已作为主按钮出现的那个**，由 `actionSet()` 与 `primaryKey()` 求差集得出。**禁止另写一份条件判断**。
- 实现方式：复用现成的 `showCtxMenu`（`components/ContextMenu.tsx`），与 `NoteEditor.tsx` 同款用法。
- 定位：`showCtxMenu(x, y, items)` 接收点击坐标；弹出层由 ContextMenu 组件自行处理层级（**不自己写 `position:fixed` 弹层**——避免重蹈笔记面板被布局容器裁切的覆辙）。

### 4.3 可用动作集合 `actionSet(plugin)`（逐条镜像现状判定）

| 状态 | 可用动作 |
|------|----------|
| 已装 standard | 更新? / 禁用·启用 / 卸载 / AI 卸载 |
| 已装 ai-guided | 更新? / AI 卸载 |
| 未装 受信任 | 安装 / AI 安装 |
| 未装 未受信任 | AI 安装 |

**与现状代码逐条对应**（`PluginMarketPanel.tsx:415-506`），不增不减。

## 5. 图标方案（零接口改动）

`PackageSummary`（`skillMarketplace.ts:5-24`）**无 `icon` 字段**——市场接口不下发图标。`icon?: string` 只存在于 `pluginRegistry.ts:82` 的 `PluginManifest`（安装后才拿得到）。

因此卡片图标位采用**按分类映射的 Lucide 图标**：

| category | Icon |
|----------|------|
| `component` | `Layers` |
| `tool` | `Wrench` |
| `guide` | `BookOpen` |
| `integration` | `Zap` |
| 未知 / undefined | `Package` |

图标底色 `--accent-subtle`、前景 `--accent`。

> 若将来市场接口新增 `icon` 字段，只需替换该映射函数一处。

## 6. 安全门（明确保留 · 硬约束）

**判定逻辑与文案一行不动，只改外观。** 逐条核对清单：

| 位置 | 现状 | 改版后 |
|------|------|--------|
| 卡片未装·未受信任 | 只给「AI 安装」 | 主按钮 = AI 安装，**无 ⋯**（不多给任何直接安装入口） |
| 卡片未受信任徽标 | 显示 + tooltip | 保留（样式换新，语义不变） |
| 卡片已装·未受信任·可更新 | 走 `requestAiInstall` 而非 `handleInstall` | 保留（主按钮文案「更新」，动作走 AI） |
| 卡片未受信任 AI 安装提示词 | 注入安全审查要求（`aiInstallPrompt` + ⚠️ 段） | **保留**（`requestAiInstall` 函数体不动） |
| 详情页未受信任判定 | `untrusted = !isAiGuided && !d.trusted`（`PluginMarketDetailPanel.tsx:91`） | **保留** |
| 详情页未受信任更新 | `(isAiGuided \|\| untrusted) ? requestAi("install") : handleInstall()`（:138） | **保留** |
| 详情页未受信任提示词 | 注入安全审查要求（:111-113） | **保留** |
| 详情页 `setPluginDetailTrusted` 回填 | 逐个验证后回填（:104） | **保留** |
| 详情页 `aiInstalling` hook 位置 | 必须在早退之前（:39-41 注释说明） | **保留**（重写头部时不得把它移到 `if (!d) return` 之后） |

## 7. 详情页规格

### 7.1 头部收敛（唯一实质改动）

```
▣  git-viewer  [已安装] [可更新]              [ ↓ 更新 ] [⋯]
   作者: 官方 · v0.1.3 · 79 次下载 · 工具 · git · diff · viewport · plugin
```

- 图标 40×40 + 名称（18px/700）+ 徽标组（可换行）+ 元信息行。
- 右侧：主按钮 + ⋯，与卡片同一套 `primaryKey` / `actionSet`。
- 描述从普通段落改为**左侧 accent 竖线引用块**（`--bg-surface` 底 + 2px accent 左边框）。

### 7.2 正文 —— 明确不改（已实测澄清）

写规格时实测发现先前判断有误，须纠正：

| 曾以为 | 实测事实 | 结论 |
|--------|----------|------|
| `.md-body table` 无响应式降级、表格溢出 | `tokens.css:305-313` **已有** `display:block; max-width:100%; overflow-x:auto`。实测 258px 容器下 scrollWidth 236 > clientWidth 216，**本来就能横滚** | **不加**外层滚动容器（重复） |
| `maxWidth:900` 是 bug | 容器 216px 时正文实测即 216px（max-width 不生效），它只在宽屏做可读性上限，属**刻意设计** | **不改** |
| 需要 `.md-scroll` 包裹层 | 与既有 `overflow-x:auto` 功能重复 | **不加** |

**详情页正文零改动**。demo 中对应批注与样式已同步修正。

## 8. i18n 新增（`pluginMarket.*`）

现有 49 个 key（zh/en 完全对齐）。新增：

| key | 中文 | 英文 |
|-----|------|------|
| `moreActions` | 更多操作 | More actions |
| `badgeUpdatable` | 可更新 | Update available |
| `moreTags` | 还有 {count} 个 | +{count} more |
| `disableHint` | 禁用后插件面板与命令会保留，但不再加载 | Plugin panels and commands are kept but no longer loaded |

（复用现有：`install` / `update` / `uninstall` / `disable` / `enable` / `aiInstall` / `aiUninstall` / `installing` / `untrusted` / `untrustedTip` / `badgeInstalled` / `badgeDisabled` / `sectionInstalled` / `sectionAvailable` / `byAuthor` / `versionLabel` / `downloads` / `dependsOn` / `cat_*`。）

**注意**：`i18n/index.ts` 的 `t()` 参数替换只替换**第一处**匹配（`result.replace` 非 `replaceAll`），`moreTags` 只有一个 `{count}`，无影响。

## 9. 实现范围

| 文件 | 改动 |
|------|------|
| `PluginMarketPanel.tsx` | 重写 `PkgCard` 渲染（三段 + 操作行）；新增 `actionSet` / `primaryKey` / `CAT_ICON` 模块级函数与常量；`SectionHeader` 保留；搜索/分类/分区逻辑保留 |
| `PluginMarketDetailPanel.tsx` | 重写头部 JSX；新增 ⋯ 菜单；**函数体逻辑（安装/卸载/禁用/信任判定/提示词）一行不改** |
| `marketplaceStyles.ts` | 新增按钮样式导出（`priBtnStyle` / `ghostBtnStyle` / `badgeStyle` 等）。**现有 5 个导出可自由改**——见下方澄清 |
| `i18n/{zh,en}.ts` | 同步新增 4 个 key（两边必须同名同数量） |

**`marketplaceStyles.ts` 的真实依赖面（已核实）**：

该文件头部注释写着「与 SkillsPanel MarketplaceTab 共用」，但**实际是过时的**：`SkillsPanel.tsx:512-547` 有一份**自己的本地副本**（`pkgCardStyle` / `pkgHeaderStyle` / `skillItemStyle` / `installBtnStyle` / `emptyStyle` / `retryBtnStyle`），从未 import 过这个文件。

全仓库 import 该文件的只有两处，都是插件面板：

```
PluginMarketDetailPanel.tsx:15  import { installBtnStyle } from "./marketplaceStyles";
PluginMarketPanel.tsx:16        import { pkgCardStyle, pkgHeaderStyle, installBtnStyle, emptyStyle, retryBtnStyle } from "./marketplaceStyles";
```

**结论**：改动该文件对技能面板**零风险**。实现时顺手修正其文件头注释（或直接删除误导性描述）。`SkillsPanel.tsx` 不动。

**明确不动**：`skillMarketplace.ts` / `pluginRegistry.ts` / `pluginDetailStore.ts` / `SkillsPanel.tsx` / Rust 侧 / `tokens.css`。

## 10. 验收清单

- [ ] **268px 窄栏下无溢出**：卡片无横向滚动、名称完整、下载数不换行（对照「改造前」视图）。
- [ ] 三段结构：名称 / 描述（clamp 2 行）/ 元信息分别在独立行，左边缘对齐图标轴线。
- [ ] 图标按分类正确映射（component/tool/guide/integration/未知 五路）。
- [ ] 主按钮按 §4.1 决策表全 8 种状态正确；「已装·最新」为**描边**「禁用」。
- [ ] ⋯ 菜单项 = 可用动作 − 主按钮，无重复项；卸载为红色；AI 卸载前有分隔线。
- [ ] **无主按钮时 ⋯ 有描边可见**。
- [ ] 未受信任插件：卡片只给「AI 安装」且无 ⋯；已装未受信任的「更新」仍走 AI（**不得退化为直接安装**）。
- [ ] 详情页头部与卡片按钮状态一致（同一 `primaryKey` 驱动）。
- [ ] 详情页 `aiInstalling` hook 仍在早退之前（否则 `d` 由有到无时抛 "Rendered fewer hooks than expected"）。
- [ ] 详情页正文渲染与改版前**完全一致**（表格可横滚、宽屏 900px 上限）。
- [ ] 技能面板（`SkillsPanel.tsx`）外观**无变化**（本就使用本地副本，不受影响）。
- [ ] 深浅主题正常；`prefers-reduced-motion` 降级（安装中 spinner）。
- [ ] `"./node_modules/.bin/tsc" --noEmit` 通过；`"./node_modules/.bin/vitest" run` 通过。

## 11. 明确不做（非目标）

- **不改技能面板**：`SkillsPanel.tsx` 的 MarketTab 使用**自己的本地样式副本**（不 import `marketplaceStyles.ts`），且技能包的安装模型（按 skill 逐条装、展开列表、`skill_count`）与插件完全不同。本次**完全不碰技能面板**。
- **不改市场接口**：不为图标新增后端字段。
- **不改详情页正文**（§7.2 实测结论）。
- **不做卡片虚拟滚动**：插件市场条目量级（个位数到几十）不需要；技能面板已有展开态，加虚拟化复杂度不划算。
- **不做插件设置（`contributes.settings`）界面**：属独立需求，另行评估。
