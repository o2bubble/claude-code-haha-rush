# 布局模式 · 操作可视性改版 · 设计规格

> **状态：已锁定** · 2026-08-13
> **方向：统一绿色浮动 chip（所有面板一致，不区分 activity bar）**
> **可视化参考**：`layout-mode-redesign.html`（Open Design 工作区，可交互）
> **目标文件**：`gui/src/components/LayoutRenderer.tsx` + `components/Toolbar.tsx` + `i18n/{zh,en}.ts`

---

## 1. 决策背景

现状布局模式（工具栏 `Grid3x3` 切换 `layoutMode`）开启后，各面板的 hover 控件只是常显，但**过于小且弱**：

- `SplitButton`（面板右上角）：拖拽手柄 18px、关闭「×」16px、分割「⊕」16px——纯图标、`--fg-muted` 灰、无文字，普通用户看不懂；
- `ResizeDivider`：8px 条内 3px 细线，hover 才变蓝，布局模式下也不增强；
- 原有设计前提是「尽量不遮挡原信息」，所以全部做小做淡。

用户判断：**既然进了布局模式，遮挡代价可接受**，目标是让普通用户一眼看懂「每块面板能做什么」。

经过逐项决策（grilling）+ 两轮视觉反馈（紫→绿、顶部条→统一 chip），锁定以下方案。

## 2. 设计原则（锁定）

1. **统一 chip**：所有面板（含 activity 图标条样式）一律用右上角浮动 chip，**不区分面板类型、不重排布局**。
2. **绿色身份色**：布局模式专属色用**绿色**（用户明确否决紫色「太艳」），与主界面蓝色 UI 一眼区分——看到绿色 = 布局编辑态。
3. **可遮挡**：布局模式下允许覆盖面板内容，无需保持「不遮挡」约束。
4. **复用既有逻辑**：拖动/分割/浮动/关闭全部走现有 `layoutStore` 操作与拖拽引擎，只改呈现层。
5. **零新接口**：纯前端；`layoutMode` store 已存在（全局 + DataBus 同步），直接复用。

## 3. 交互规格

### 3.1 进入 / 退出

| 入口 | 行为 |
|------|------|
| 工具栏 `Grid3x3` 按钮 | 切换布局模式；开启态显示**绿色高亮**（`lm-on` 态） |
| `Esc` | 退出布局模式 |
| 右下角「✓ 完成布局」绿色胶囊 | 常驻可见，点击退出 |

### 3.2 统一浮动 chip（每面板右上角）

- `position: absolute` 悬浮于面板右上角（top 6px / right 6px），**不参与布局流**、不遮挡 activity 图标条。
- 绿色实底胶囊 + 白色图标按钮，`title` 提供 tooltip（48px 级窄面板无空间放文字）。
- 按钮：`≡ 拖动` / `⇄ 分割`（四向下拉）/ `⧉ 浮动` / `× 关闭` / `⋯`（溢出菜单：换图标 / 新窗口打开 / 关闭标签）。
- 拖拽：按住 `≡` 时整面板绿色外框高亮 + 轻微抬升（`scale(1.012)` + 阴影）。

### 3.3 分割线（ResizeDivider）

- 布局模式下加宽：横分割 8→12px、竖分割 8→12px。
- 中间显示**双箭头抓柄**（横 `⇔`、竖 `⇅`），常显绿色；hover 提亮 + 阴影。

### 3.4 面板块化

- 每个面板外框加**细绿色边框**（`outline: 1.5px solid --lm-accent-soft`）。
- 拖拽时 `outline: 2px solid --lm-accent` + `box-shadow: --shadow-lg`。

### 3.5 模式横幅

- 进入后顶部出现一条绿色横幅，解释操作：`布局模式 · 拖动「≡」移动面板 · 「⇄」分割 · 「⧉」浮动 · 完成点右下角按钮`。
- 携带 `Esc 退出` 提示。

## 4. 视觉规格（绿色身份色，oklch 派生）

| Token | 浅色 | 深色 |
|-------|------|------|
| `--lm-accent` | `oklch(0.56 0.15 150)` | `oklch(0.72 0.14 150)` |
| `--lm-accent-strong` | `oklch(0.48 0.17 150)` | `oklch(0.78 0.12 150)` |
| `--lm-accent-soft` | `oklch(0.56 0.15 150 / 0.14)` | `oklch(0.72 0.14 150 / 0.18)` |
| `--lm-bar-bg` | `oklch(0.56 0.15 150 / 0.08)` | `oklch(0.72 0.14 150 / 0.12)` |

应用范围：chip、面板边框、分割线抓柄/线条、模式横幅、退出胶囊、工具栏 `lm-on` 态。**主界面 UI 保持蓝色 accent 不变。**

## 5. 数据与依赖（零新接口）

- `layoutMode` store：已有，全局开关 + DataBus 同步，直接复用（`subscribe` 驱动组件重渲染）。
- 面板图标/标题：复用 `panelDefs` / `iconFor()`，chip 无需新数据。
- 拖动/分割/浮动/关闭：复用 `layoutStore` 现有操作与 `SplitButton` 内的动作逻辑（`splitGroupEmpty`、`closeGroup`、`hideGroup`、`prepareDrag` 等）。
- `ResizeDivider`：增强仅 CSS 呈现（加宽 + 抓柄），拖拽逻辑不变。

## 6. i18n 新增（`layout.*` 命名空间）

| key | 中文 | 英文 |
|-----|------|------|
| `layoutModeTitle` | 布局模式 | Layout Mode |
| `dragPanel` | 拖动 | Drag |
| `splitPanel` | 分割 | Split |
| `floatPanel` | 浮动 | Float |
| `closePanel` | 关闭 | Close |
| `exitLayout` | 完成布局 | Done |
| `lmBannerHint` | 拖动「≡」移动面板 · 「⇄」分割 · 「⧉」浮动 · 完成点右下角按钮 | … |
| `lmEscHint` | 退出 | Exit |
| `morePanel` | 更多 | More |

（现有 `layout.hide/split/floatTab/openInNewWindow/closeTab/closeGroup/splitLeft/Right/Top/Bottom/emptyGroup/changeIcon` 保留复用。）

## 7. 实现范围

- **`LayoutRenderer.tsx`**：
  - 重写 `SplitButton` 呈现 → 绿色浮动 chip（按钮改为图标 + tooltip；分割下拉、⋯ 菜单复用现有弹层逻辑）。
  - 对 activity 分支无需特殊处理（统一 chip，天然兼容图标条布局）。
  - `ResizeDivider` 增加布局模式增强态（加宽 + 双箭头抓柄 + 绿色）。
  - 面板外框绿色 outline（`.lm .block`）、拖拽高亮。
- **`Toolbar.tsx`**：布局模式按钮增加绿色 `lm-on` 态。
- **挂载**：退出胶囊（body 级 fixed）+ 模式横幅（`TabGroupView` 顶层或 App 根），随 `layoutMode.enabled` 显隐。
- **注入样式**：`ensureLayoutModeStyles()` 一次性注入（keyframes/`.lm` 规则），不修改 `tokens.css`。
- **i18n**：`{zh,en}.ts` 补 key。

## 8. 验收清单

- [ ] 进入布局模式：所有面板右上角出现统一绿色 chip；activity 图标条面板同样适用，图标条不被遮挡。
- [ ] chip 操作：拖动（整块高亮抬升）/ 分割（四向下拉）/ 浮动 / 关闭 / ⋯（换图标·新窗口·关标签）全部可用。
- [ ] 退出：右下角绿色「完成布局」胶囊、`Esc`、工具栏按钮三路均可退出。
- [ ] 分割线：布局模式下加宽 + 双箭头抓柄 + 绿色，hover 提亮。
- [ ] 模式横幅显示操作说明。
- [ ] 主界面 UI 仍是蓝色 accent，布局模式 chrome 全绿，二者明显区分。
- [ ] 深浅主题正常；`prefers-reduced-motion` 降级。
- [ ] `tsc --noEmit` + 测试通过。

## 9. 明确不做（非目标）

- 不做全屏布局编辑器（Q1 早期选项 C）。
- 不做每面板带文字的工具条（已改为统一 chip）。
- 不改变 `layoutStore` 数据模型 / 拖拽落点逻辑 / 多窗口同步机制。
- 不改 `tokens.css`（布局绿作为组件内注入的专用 token）。
