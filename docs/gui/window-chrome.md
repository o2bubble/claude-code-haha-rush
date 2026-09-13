# 自绘窗口边框（Windows 专属）

## 为什么 mac 不动

mac 的原生窗口整合度高（红绿灯、圆角、阴影、全屏动画都由系统处理），
Tauri 在 mac 上做无装饰窗口要改用 `titleBarStyle: Overlay` 而非
`decorations(false)`，且红绿灯位置需要手动留 padding —— 收益低、风险高。
**Windows 用自绘，mac 保留原生装饰。**

## 结构

| 层 | 位置 | 职责 |
|---|---|---|
| Rust | `gui/src-tauri/src/lib.rs` 主窗口 builder（`#[cfg(windows)] .decorations(false)`） | 关掉系统标题栏 |
| 权限 | `gui/src-tauri/capabilities/default.json` | `core:window:allow-minimize` / `-toggle-maximize` / `-unmaximize` / `-is-maximized` / `-close` |
| 组件 | `gui/src/components/TitleBar.tsx` | `AppMark`（内联 SVG 图标）、`WindowControls`（三个按钮）、`isWindowsChrome()`（平台判断） |
| 合并 | `gui/src/components/Toolbar.tsx` | 标题栏与工具栏**合成一条 36px**：左=图标+应用名+工作区名，中=原有功能按钮，右=窗口按钮 |
| 覆盖层 | `chat/WorkspaceSelector.tsx`、`chat/WelcomeWizard.tsx` | 全屏覆盖层会盖住工具栏 → 各自在右上角挂一组 `WindowControls` + 顶部拖动条 |

### ⚠️ 全屏覆盖层必须自带窗口按钮

无装饰窗口下，**工具栏是唯一的窗口按钮来源**。`WorkspaceSelector`（z-index 1000）
和 `WelcomeWizard`（z-index 2000）都是 `position: absolute; inset: 0` 的全屏层，
会把工具栏整个盖住 —— 结果就是**启动后第一屏没有关闭按钮，用户关不掉窗口**。

新增任何全屏覆盖层时都要挂窗口按钮。已处理：上述两个。已排查不受影响：
`ProfileDialog`（浮窗内的局部层）、`SessionPanel` 的确认框（有遮罩但工具栏仍可见）、
`LayoutRenderer:141` 的 z-index 9998（`pointerEvents: none` 的装饰元素）。

### ⚠️ `="deep"` 会吞掉非 button 元素的点击（踩了两次）

Tauri 的 `drag.js` 只豁免 `BUTTON/INPUT/A/SELECT/TEXTAREA/LABEL/SUMMARY` 等标签，
对 **`div onClick`** 会 `preventDefault()` —— 祖先链上有 `="deep"` 时，该 div 的
点击**完全失效**（表现为"元素显示正常但点不动"，极难联想到拖拽区）。

**两次踩坑**：

1. `WorkspaceSelector` 的工作区卡片（`div onClick`）→ 改成只把顶部 36px
   空白条设为拖动区（bare 属性 = 只有直接点它才拖），不用 `deep`。
2. 工具栏下拉的**菜单项全是 `div onClick`**（`DROPDOWN_ITEM_BASE` 那条路径）
   → 菜单显示正常但点不动。修法：给弹层容器加
   **`data-tauri-drag-region="false"`** —— 该值在遍历路径中命中即返回 `false`，
   阻止该子树及祖先的拖拽判定，点击恢复。

**规则**：

- 容器用 `="deep"` 前，先确认**整棵子树**都没有非 button 的可点元素
- 弹层/浮层一律加 `data-tauri-drag-region="false"`（`Toolbar.tsx` 的
  `DROPDOWN_MENU_ATTRS` 常量即此用途，新下拉复用它）
- 症状是"显示正常但点不动"时，**优先怀疑拖拽区**，而不是事件绑定或 z-index

## 拖拽区语义（Tauri `drag.js`，已核对源码）

Tauri 注入的 `drag.js` 决定哪些区域能拖动窗口，规则：

| 写法 | 行为 |
|---|---|
| 无属性 | 不是拖拽区 |
| `data-tauri-drag-region`（空值/`"true"`） | **只有直接点在该元素上**才拖 |
| `data-tauri-drag-region="deep"` | 子树内任意位置都能拖 |
| `data-tauri-drag-region="false"` | 显式禁用 |

**BUTTON / INPUT / SELECT / TEXTAREA / A / LABEL / SUMMARY，以及带
`contenteditable`、`tabindex`、交互型 `role` 的元素，默认阻止拖拽** ——
不需要为每个按钮手动排除。

**双击拖拽区 = toggle maximize 是框架内置的**，不用自己实现。

本仓库用 `="deep"` 挂在 Toolbar 容器上：空白处（含 `flex:1` 的会话名占位区）
可拖，按钮天然可点。

## 已知取舍

- **丢失 Win11 Snap Layout**：悬停最大化按钮弹出贴靠布局（Win11 特色）需要
  自己子类化窗口过程处理 `WM_NCHITTEST` 返回 `HTMAXBUTTON`，是纯 Rust 活、
  工作量比整个标题栏还大。当前**未实现**。
- **窗口几何保存**：`App.tsx` 保存 `outerPosition`，Rust 恢复也用外坐标 ——
  无装饰时外=内，语义自洽。但从「有装饰的旧版本」升级后首次启动，位置会因
  装饰高度差有轻微位移，之后自愈。
- **浮窗不受影响**：`create_floating_window` / 外链窗口仍用原生装饰（它们是
  工具窗口，原生标题栏便于拖动和关闭）。

## 验证清单

改这块后至少要验：

- [ ] 拖动标题栏空白处能移动窗口
- [ ] 双击标题栏空白处能最大化/还原
- [ ] 三个按钮各自生效（最小化/最大化还原/关闭）
- [ ] 最大化状态下按钮图标变成「还原」
- [ ] 用 Win+↑ 或双击最大化后，按钮图标**跟随更新**（靠 `onResized` 监听）
- [ ] 所有工具栏按钮点击正常（不被拖拽区吞掉）
- [ ] 窗口边缘能拖拽缩放
- [ ] **工作区选择页**：右上角有关闭按钮；点卡片能选中；双击卡片能进入
- [ ] **欢迎向导页**：右上角有关闭按钮；向导内的输入/按钮都能点
- [ ] mac 上一切如常（未受影响）

## 本地验证方式

```bash
cd gui && cargo tauri dev --config src-tauri/tauri.conf.json
```

⚠️ 必须在 **`gui/`** 下跑并显式带 `--config` —— `beforeDevCommand`（`bun run dev`）
是相对 tauri.conf.json 所在目录解析的，在 `src-tauri/` 下跑会报 `Script not found "dev"`。

前端改动有热更新；Rust 改动会触发重编译。端口 1420 被占说明已有实例在跑，
先关掉旧的（`netstat -ano | grep 1420` 找 PID）。
