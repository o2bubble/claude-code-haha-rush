# 底部状态栏（StatusBar）改版 · 设计规格

> **状态：已锁定** · 2026-09-11
> **方向：B 轻量状态条** — 平时 0px 悬浮胶囊，有新消息自动展开、5 秒收回，点击开消息列表
> **可视化参考**：`status-bar-redesign.html`（同目录，可交互）
> **目标文件**：`claude-code-haha-dev/gui/src/components/StatusBar.tsx` + `gui/src/i18n/{zh,en}.ts`

---

## 1. 决策背景

现有 `StatusBar.tsx`（100 行）是「一个日志查看器冒充通知系统」：

1. **收起态什么都不显示** —— 只有「◈ 通知 (N) ▲」，最新发生了什么一个字都看不到。用户截图里那三条启动日志在收起态完全不可见。
2. **展开方向错** —— 面板在底部却往上长 200px，把上面的聊天内容顶掉；列表还是**最老在上**，得扫过旧消息才看到刚发生的。
3. **两套视觉语言** —— `StatusBar` 用 emoji 字符（`ℹ️⚠️❌✅`）+ 11px 字号；右下角 `ToastContainer` 用 lucide 图标。同一份 `statusMsgStore` 数据，两种长相。
4. **裸 hex 漏进设计系统** —— 空态文字 `#bbb`。
5. **箭头方向误导** —— `expanded ? "▼" : "▲"`，但内容是在**上方**展开的。
6. **无键盘可达性** —— 是 `div onClick`，不是 button，没有 `:focus-visible`。

经 grilling 与三轮 demo 迭代（A 活动条 / B 静默条 → 用户选 B → 按职责纠正简化）锁定。

### 1.1 职责界定（本节是后续所有决策的前提）

**StatusBar 不承担「提醒用户」的职责 —— 那是 `ToastContainer` 的活。**

| 组件 | 职责 | 数据源 |
|------|------|--------|
| `ToastContainer` | **提醒**：右下角滑入，error 常驻 / warn 6s / success 3s | `statusMsgStore`（仅非 info） |
| `StatusBar`（本方案） | **轻量状态显示 + 消息列表**：以最小视觉重点呈现新消息，可随时回看历史 | `statusMsgStore`（全部，保留最近 100） |

因此本方案**明确不做**：浮出卡片、动作按钮（重试/压缩等）、连接状态展示、告警语义。
用户原话：「这个状态栏职责不是提醒用户的…Toast 弹过了你弹啥，你只用以尽量小的视觉重点呈现一下新消息就行，然后自动收起即可。它本质是一个简单的状态栏和消息列表的功能。」

## 2. 设计原则（锁定）

1. **不重复 Toast** —— 同一份 store，但职责不重叠：Toast 负责打断，StatusBar 负责回看。
2. **平时零占用** —— 无消息时底部高度 0px，不占布局流。
3. **最小视觉重点** —— 呈现新消息用低对比（半透明、小字号、无阴影强调），不抢注意力。
4. **消息列表不可丢** —— 点击可展开完整历史列表（核心功能，必须保留）。
5. **不改数据层** —— `statusMsgStore` 的 93 处 `addStatusMessage` 调用点全部不动，只换呈现层。

## 3. 交互规格

### 3.1 三态

```
① 静止（无新消息）
                                                      （底部 0px，什么都不显示）

② 新消息到达 → 自动展开
                                                 ◯ 已加载 12 个技能  8
                                                  ▂▂▂▂▂▂▂▂▂▂  ← 5s 倒计时

③ 5 秒后自动收回
                                                        ◯ 8
```

| 状态 | 触发 | 呈现 |
|------|------|------|
| **静止** | 无新消息 | 底部 0px；**左下角**半透明胶囊（圆点 + 计数），`opacity: .5`，不抢视线 |
| **展开** | 新消息到达 | 胶囊展开至内容宽度（上限 260px），显示「级别色点 + 消息文本 + 计数」，`opacity: .9` |
| **收回** | 展开后 5 秒无新消息 | 收回成静止态 |

**暂停收回的条件**：
- **鼠标悬停**在胶囊上 → 暂停并重置计时（移开后重新计 5 秒）；用户想读完消息时它不会跑掉。
- **连接异常**（`!state.connected`）→ 保持展开，因为这是持续状态而非一次性事件。

> **实现要点（易错）**：悬停暂停**必须持续续期**，只在 `mouseenter`/`mouseleave` 各重置一次
> `at` 是不够的 —— 那样悬停超过 5 秒照样会收回。实现改为 **250ms 间隔检查**：
> 悬停中不断刷新 `at`（等效暂停），离开后从当前时刻重新起算完整 5 秒。
> 悬停态用 `useRef` 持有（供 interval 读取，不触发重渲染），另有一份 `useState` 仅用于渲染。

> **落地结果（code review 后修正）**：初版实现按「倾向前者」做了 —— 订阅 `CHAT_STATE_CHANGED`
> 读 `connected`，并在断线时把胶囊文本替换为「连接已断开」、圆点强制红色。
> **code review 判定这违反了 §1.1/§10「不复述连接状态」**（那是 `ChatStatusBar` 的职责，
> 且把胶囊变成常驻红色错误徽标，触及 §5.2「不得对 warn/error 做额外强调」）。
>
> **最终决定：整个连接状态依赖被移除** —— 不订阅 chatStore，`connected` 概念不复存在，
> 同时删掉 `status.connectionLost` / `status.connecting` 两个 key。StatusBar 保持对 chatStore **零依赖**。
> 「断线保持展开」这条规则一并作废：断线本身会作为一条普通 error 消息进入列表（由既有调用点产生），
> 由 §3.1 的常规 5 秒逻辑处理，不特殊对待。

### 3.2 点击 = 打开消息列表

**胶囊唯一的功能入口。** 点击 → 打开完整消息列表浮层。

| 列表要素 | 规格 |
|---------|------|
| **排列** | **倒序（最新在上）** —— 与现状相反，现状是最老在上，得翻到底才看到刚发生的 |
| **触发** | 点击胶囊本体或计数 |
| **内容** | 级别色条（3px）+ 消息文本 + 时间戳（等宽数字） |
| **时间戳** | 绝对时间 `HH:MM:SS`（现状已是此格式，保留） |
| **空态** | 「没有新消息」（复用现有 `status.noMessages`） |
| **清空** | 列表头部一个「清空」文字按钮 → 调 `clearStatusMessages()`。**这是 code review 后补评审通过的新增项** —— 规格书初版未列，但消息列表缺清空入口不合理；破坏性动作放在头部右侧（非主 CTA），用 muted 色，非按钮样式 |
| **位置** | 浮层**向上覆盖**，不挤压布局流（不再让聊天内容上下跳动） |
| **关闭** | 点浮层外 / `Esc` / 再点胶囊 |

### 3.3 键盘可达性

- 胶囊是 `<button>`（非 `div`），带 `aria-label` 与 `aria-expanded`。
- `:focus-visible` 光圈（复用 `tokens.css` 的全局规则）。
- `Esc` 关闭浮层。

## 4. 视觉规格

| 项 | 值 | 来源 |
|----|-----|------|
| 胶囊圆角 | `10px`（Pill） | — |
| 折叠宽度 | 内容宽（约 22px） | — |
| 展开最大宽 | `260px` | 防止长消息撑破布局 |
| 文本最大宽 | `200px` + `text-overflow: ellipsis` | 超出截断 |
| 字号 | `10px` | 与现状 11px 接近，略小 |
| 透明度 | 静止 `.5` / 展开 `.9` / hover `1` | 最小视觉重点 |
| 边框 | `1px solid var(--border-light)` | token |
| 背景 | 静止 `var(--bg-surface)` / 展开 `var(--bg-root)` | token |
| 圆点 | `7px`，色 = 级别色 | `STATUS_LEVEL_COLOR` |
| 倒计时条 | 2px 高，底部，`transform: scaleX()` | 让用户知道还剩多久 |
| 边框色（展开） | `var(--border-medium)` | token |

**级别色映射**：复用现有 `utils/statusLevels.ts` 的 `STATUS_LEVEL_COLOR`（info→`--fg-muted` / warn→`--semantic-warning` / error→`--semantic-error` / success→`--semantic-success`），不新增映射表。

**明确移除的裸 hex**：`#bbb`（空态文字）→ `var(--fg-muted)`。

## 5. 架构冲突与落地决策（重要）

demo 环境没有真实宿主，以下 4 处冲突在落地时必须处理：

### 5.1 位置冲突：胶囊 vs ToastContainer

**事实**：`ToastContainer.tsx:147` 是 `position: fixed; right: 16; bottom: 40; zIndex: 100000`，且**同时显示最多 3 条**（`MAX_VISIBLE = 3`）。demo 里胶囊的 `right: 8 / bottom: 6` 与之**完全重叠**。

**决策**：
- 胶囊**不放右下角** —— 改放**左下角**（`left: 8; bottom: 6`），与 Toast 的角落错开，互不遮挡。
- 若后续视觉上仍冲突，可再让胶囊避让：Toast 出现时胶囊上移。**v1 先做角落分离，不做避让动画**（避免过度设计）。

> **落地修正（实现期发现）**：消息列表浮层原设计为相对 StatusBar 根节点的
> `position: absolute; bottom: calc(100% + 6px)`。但根节点是 `flexShrink: 0` 的**零高度占位**，
> `100%` 会算成 0 —— 浮层被推到视口下方之外（实测 `bottom: 566`，完全不可见）。
> **改为 `position: fixed; left: 8; bottom: 32`**，与胶囊同角落、向上展开。
> 因此根节点也去掉了 `height: 0` —— 胶囊与浮层都已 `fixed`，根节点不再需要占位语义。

### 5.2 职责重复（已在 §1.1 解决）

同一份 `statusMsgStore`：warn/error 会**同时**进 Toast（提醒）和 StatusBar 列表（回看）。这是**刻意的**，不是重复缺陷 —— 提醒要短暂，回看要持久。

但因此 StatusBar **不得**对 warn/error 做额外强调（不加背景色、不加图标变大、不加动作按钮），否则就变成二次提醒。

### 5.3 渲染位置：StatusBar 在正常文档流内

**事实**：`StatusBar` 挂在 `App.tsx:751`，是根 `flex column` 的第 3 个子元素（Toolbar → Layout → StatusBar），并非 `fixed`。

**决策**：B 的「0px」**只需不渲染该元素**（返回 `null` 或高度 0），悬浮胶囊用 `position: fixed` 独立于该流。**比方案 A 简单得多** —— A 需要在文档流里维持一条 26px 的条。

### 5.4 折叠态无消息时

`statusMsgStore` 初始为空。此时**不渲染胶囊**（避免出现「◯ 0」这种无意义元素）。

## 6. i18n 新增

现有 `status` 命名空间仅 2 个 key（`noMessages` / `title`），zh/en 已对齐。**最终新增 2 个**：

| key | 中文 | 英文 |
|-----|------|------|
| `status.records` | 消息记录 | Messages |
| `status.clear` | 清空 | Clear |

保持现有 `status.noMessages`（"没有新消息"）/ `status.title`（"通知"）不动。

> **落地结果**：原计划的 `status.count` 未使用（胶囊直接渲染 `msgs.length`，无需模板 key）；
> `status.connectionLost` / `status.connecting` 随连接状态依赖一并删除（见 §3.1）。
> 三者均在 code review 中作为死 key 清理。

**顺带（独立于本方案）**：`chat` 命名空间新增 `chat.contextUsed`（"已用 {pct}%" / "{pct}% used"），
替代 `ChatInputPanel` 误用的 `chat.contextRemaining`（该旧 key 已删，见 §8）。

> 注意：`i18n/index.ts` 的 `t()` 参数替换只替换**第一处**匹配（`result.replace` 非 `replaceAll`），每个 key 内避免重复占位符。

## 7. 实现范围

| 文件 | 改动 |
|------|------|
| `gui/src/components/StatusBar.tsx` | 重写（现 100 行）。三态胶囊 + 消息列表浮层；复用 `getStatusMessages` / `subscribeStatusMessages` / `STATUS_LEVEL_COLOR` |
| `gui/src/i18n/{zh,en}.ts` | 各新增 5 个 key（两边必须同名同数量） |
| `gui/src/stores/statusMsgStore.ts` | **不改**（93 处调用点全部保留） |
| `gui/src/components/ToastContainer.tsx` | **不改**（职责分离，互不干扰） |

**明确不动**：`statusMsgStore.ts` / `ToastContainer.tsx` / `App.tsx`（挂载点保持 751 行不变）/ `tokens.css` / 任何 `addStatusMessage` 调用点。

## 8. 顺带修复的真 bug（输入框状态条，独立于本方案）

**位置**：`gui/src/components/chat/ChatInputPanel.tsx`

```
:170   ctxPct = 100 - state.contextPercent        → 已用%
:277   进度条 width = ctxPct%                     → 条表示「已用」
:289   显示 {state.contextPercent}%               → 数字表示「剩余」
```

`contextPercent` 实际是后端给的 `remaining_percentage`（`chatReduce.ts:429`）。所以**条越长、数字越小**，两者朝相反方向。用户截图正是如此：**条是空的，旁边写 100%**。

**修复**：统一为「已用」，条与数字同向增长。建议同时把 `contextPercent` 重命名为 `contextRemainingPct`（名字含糊正是这个 bug 的温床），但重命名涉及 `chatStore` / `chatReduce` / `crossWindowBus*` 多处，可**拆为独立改动**，本方案只修显示口径。

> **落地结果**：变量 `ctxPct` 重命名为 **`ctxUsedPct`**（`100 - contextPercent`），条、数字、tooltip、
> 告警浮层四处口径全部对齐为「已用」。新增 i18n key **`chat.contextUsed`**（"已用 {pct}%" /
> "{pct}% used"）替代原先误用的 `chat.contextRemaining`；旧 key 保留未删（其他地方可能引用）。
> 原计划的重命名 `contextPercent` → `contextRemainingPct` **未执行**（跨文件改动，按计划拆分）。

## 9. 验收清单（✅ = 落地时已实测通过）

> 验证方式：真实 React 挂载（`createRoot`）+ 真浏览器测量，非静态代码审查。
> 覆盖：空态 / 推消息 / 自动收回 / 悬停 6 秒 / 移开重新计时 / 长消息截断 / 点击开列表 / 倒序 / Esc。

- [x] 无消息时底部高度 **0px**（根节点零高度，胶囊与浮层均 `fixed`）。
- [x] 新消息到达 → 胶囊**自动展开**显示文本（实测 117px），5 秒后**自动收回**（22px）。
- [x] 展开宽度**不超过 260px**；长消息实测 246px，文本截到 200px，不溢出、不碰 Toast 区。
- [x] 鼠标悬停时**暂停收回**（实测悬停 6 秒仍展开）；移开后重新计时（3s 仍展开 → 5.6s 收回）。
- [x] StatusBar 对 `chatStore` **零依赖**（连接状态依赖已移除，见 §3.1 落地结果）。
- [x] **点击胶囊可打开消息列表**。
- [x] 列表**倒序**（最新在上），时间戳显示 `HH:MM:SS`。
- [x] 列表浮层**向上覆盖**，不挤压布局流（实测视口内 left 8 / bottom 32）。
- [x] 胶囊位置**不与 `ToastContainer` 重叠**（左下角 vs 右下角）。
- [x] warn/error 在 StatusBar 中**无额外强调**（无背景色/大图标/动作按钮；仅圆点着色）。
- [x] 胶囊是 `<button>`，有 `aria-label` / `aria-expanded`。
- [x] `Esc` 可关闭列表浮层。
- [x] 无裸 hex（全部走 token）；字号全部走 `FS()` / `--font-scale`（code review 后修正 7 处裸 `fontSize`）。
- [x] `prefers-reduced-motion: reduce` 时禁用展开宽度过渡（注入式媒体查询，同 `WorkspaceSelector` 做法）。
- [x] `tsc --noEmit` 通过（0 错误）；`vitest run` 通过（551/551, 49 文件）。
- [ ] **深色主题未实测** —— 胶囊只用 token 颜色，理论上自动适配，但本次未在深色下渲染验证。
- [ ] `ToastContainer` 行为无变化（未改动该文件，但未做运行时对照验证）。

## 10. 明确不做（非目标）

- **不做方案 A 的活动条**（用户已选 B）。
- **不做浮出告警卡片**（职责属 Toast）。
- **不做动作按钮**（重试/压缩等 —— 属 Toast 的交互，且需按消息类型映射，过度设计）。
- **不复述连接状态**（`ChatStatusBar` 已有连接状态点）。
- **不改 `statusMsgStore` 的数据模型**（保留最近 100 条、4 个 level 不变）。
- **不做消息筛选/搜索**（100 条量级不需要）。
- **不做启动日志分组折叠**（demo 里试过，用户简化时已移除 —— 属过度设计）。
