# Handoff — Claude Code GUI 开发 · 2026-08-20

> 跨机器 / 跨会话继续用。当前状态以 git 为准；架构细节在 `docs/ARCHITECTURE.md`。本文件不含凭据——服务器账号/密码在 **Memory MCP**。

## 当前状态

- **Git HEAD**: `3da3613`（**feature/macos-port** 分支，macOS 移植工作线；main=`e63845c` 未推 gitee）
- **发布版本**: **2026.08.23.1**（云 `123.56.66.84:8765` 已发；**96 内网未同步**）
- **GUI 版本**: `1.0.0-preview`；setup 安装包 `dist/ClaudeCodeHaha_Setup_v2.1.89_2026W34.exe`（179MB，含 git/python 全组件）
- **核心用户偏好**: 常驻暗色（"亮色是给别人用的"），主题预设已落地 A/B 两档可选
- **macOS 移植**: 进行中（feature/macos-port 分支 + GitHub CI 出包，见「macOS 移植」节）

## 近期工作（08.19 系列，全部已发布）

| 版本 | 内容 |
|------|------|
| **08.23.1** | 守卫无人值守验收撞 busy — 中途 error 不上报守卫(只在权威 result/ready 后验收) + 上报过滤 `Error:` 文本(错误不再被当验收回复) |
| **08.19.1** | 控制台子进程统一 `CREATE_NO_WINDOW` — 诊断/重启后端/关 GUI/更新不再闪黑窗 |
| **08.19.2** | 超级桌面三 block UI 增强 — 文本/表单视觉重构 + 图表全量 ECharts 三通道(option/series/data) |
| **08.19.3** | 启动时自动清理历史 WebView2 缓存目录 — 非当前 PID 的 EBWebView-{PID} 旧目录删除 |
| **08.19.4** | 超级桌面剩余 block 小优化 — 表格/图片/文件组 i18n + 绘图主题统一 + 文件行 hover |
| **08.19.5** | 超级桌面全组件接入明暗主题 — 卡片默认不再亮白(暗色深灰) |
| **08.19.6** | 主题预设系统 — 界面主题 4 档(浅色/深灰/深蓝/高级深灰)、统一暗色判定 |
| **08.19.7** | 原生 select 下拉暗色下看不清 — 全局 option 跟随主题配色 |
| **08.18.7** | 环境变量检测/修复迁移系统级(HKLM) — UAC 提权 · HKCU 清理仅相关项 |

## macOS 移植（进行中，feature/macos-port）

- **路线图**: `docs/macos-port.md`（4 阶段）；**PRD**: `.scratch/macos-port/PRD.md`（Status: ready-for-agent）
- **GitHub 镜像**: `o2bubble/claude-code-haha-rush`（**private**）——无 mac 机器的出包路径，push 即触发 macOS CI 出 `.dmg`/`.app` artifact。Gitee 仍是主开发仓库
- **已完成的代码改造**（feature/macos-port 提交）:
  - `scripts/componentPlan.ts` 构建规划纯函数（唯一 seam，8 个平台矩阵单测）→ build.ts 平台接入
  - `update.rs` 组件路径平台化（mac: gui→`.app`/claude→无后缀/bun·tools·python·git→系统/updater→skip）
  - `diagnostics.rs` mac 上「安装环境变量」小节返回不适用（不触发 reg.exe）
  - `icon.icns`（Pillow 从 256 源生成，tauri.conf.json 已加）
  - `.github/workflows/macos-build.yml`（macos-latest → cargo tauri build → upload artifact）
- **CI 迭代**（3 次失败已修 + 1 次进行中）: #1 缺 tauri-cli → workflow 加 install；#2 缺 `@types/node`（CI 无本地 root 隐式依赖）→ gui 显式声明；#3 **mac 编译错误**（`open_in_explorer` borrow move + `backend.rs` unused pid，Windows 编译看不到）→ 已修；#4 进行中
- **关键坑**: GitHub 单文件 100MB 限制 → 仓库是**孤儿快照**（排除 `offline-tools/windows/*.exe` 等大文件），本地/Gitee 历史不动；孤儿快照重建流程 = `.gitignore` 临时加 exe → `checkout --orphan github-clean` → `rm --cached` exe → commit → force push main → 恢复
- **测试基建**: `gui/vitest.config.ts` include `../scripts/` 测试；排除 3 个预存 console 断言文件（themeUtils/pathDetector/snapAnchor，非 vitest 测试）

## 热数据（本会话产物，直接复用）

### 主题预设系统（08.19.6）
- **4 档主题值**: `light` / `dark`(=深灰 B, 兼容旧值) / `dark-a`(深蓝专业) / `dark-b`(高级深灰)
- **A 深蓝** 底色: bg-root `#14171f` / bg-surface `#1b2029` / bg-hover `#222a3a` / accent `#5aa8ff`
- **B 高级深灰** 底色: bg-root `#0e0e12` / bg-surface `#15161d` / bg-hover `#1d1e28` / accent `#58c4e8`
- CSS 定义在 `tokens.css`: `[data-theme="dark"], [data-theme="dark-b"]` 同一段(暗=B), `[data-theme="dark-a"]` 独立段
- **关键兼容**: 老配置 `theme:"dark"` 与 `dark-b` 视觉一致 → 无感迁移, 无需数据迁移
- **暗色判定统一**: `gui/src/utils/themeUtils.ts` — `isDarkTheme(theme)` / `normalizeTheme(theme)` / `isDarkNow()`; 替换了 **8 处** `=== "dark"` 硬判断(高亮/编辑器/终端/消息/图形/工具栏)
- **设置入口**: `SettingsPanel.tsx` 主题下拉 2→4 项; 工具栏 toggle 亮↔暗保持默认暗色不重置预设
- **启动恢复**: `App.tsx` `normalizeTheme(s.theme)` 非法值回退 `light`
- **测试**: `themeUtils.test.ts` 16/16 PASS (console 断言风格, 项目惯例)

### select 下拉暗色修复（08.19.7）
- 根因: WebView2 原生 `<select>` 弹开的 option 列表用系统浅色底, 不跟随主题 → "褐色底黑字"
- 修复: `tokens.css` 加全局 `select, select option { background-color: var(--bg-root); color: var(--fg-primary); }` + `select:focus` outline
- 一个改动覆盖所有下拉(语言/主题/排序/聊天行为), 不逐个改组件

### 超级桌面图表三通道（08.19.2）
- `ChartItem.tsx` 全量引入 ECharts(echarts ^6.1.0), 三通道: (a) `option` 完整透传 (b) `series` 透传(自动补 tooltip/legend) (c) `data+chartType` 简单映射
- chartType 支持: bar/line/pie/scatter/area/radar/funnel/gauge; 任意类型走 option/series(树图/桑基/烛台等)
- MCP 提示词 + `docs/gui/gui-agent-guide.md` 已同步三通道说明
- 验收: 用户画了柱状图 + 桑基图确认通过

### WebView2 缓存清理（08.19.3）
- `lib.rs` `cleanup_old_webview_dirs(app)` 在 setup 构建主窗口前调用; 删非当前 PID 的 `EBWebView-{PID}` 目录
- 只清纯数字 PID 命名目录(防误删); 保留当前运行实例(多实例隔离不破坏)
- 启动日志: `removed N stale EBWebView dirs, freed ~X MB`

### 计费选型（已存笔记，核心结论）
- 完整决策已存超级桌面笔记 `a01d77f7-1290-291f-f70a-f05113af26dc`「模型计费选型决策备忘」
- 单位成本: 官方按量 15.45 元/亿 < 199套餐 11.58 < 通义 139套餐 13.06 < 企业订阅 2999 10.8(最省~30%)
- 我的常态负载: 工作日日均 ~9亿 tokens, 月 ~200亿; 临界点 ~194亿(>194 订 2999, <194 退订按量)
- 实测锚点: 官方后付费 08-13 一天 15.81亿 tokens 命中率98% = 244.22元 → 15.45 元/亿
- 2999 企业订阅: 月顶 277亿 + 周限≈24.7万积分(~64亿)/周, 可随时取消 → 余量充足

## Pending / 待办

- **macOS 移植**: CI #4 结果（构建通过则下载 `.dmg` 验证）→ 后续签名/公证（需 Developer ID 证书）→ feature/macos-port 合回 main → update.rs stager/更新机制 mac 化（PRD out-of-scope）
- **96 内网同步**: 云已发 2026.08.23.1，96（192.168.186.96:8765）未同步（本机连不通，需内网/Workbench）
- **08.19.6/08.19.7 真机验收**: 用户已确认暗色效果"舒服多了", 但主题 A/B 切换 + select 下拉修复尚未真机复验一轮(08.19.7 刚发布)
- 守卫诊断 toast 仍在(reportGuardTurnEnded), 稳定后可移除
- 环境变量修复 UAC 全链路(检测→提权→清理→重启生效)待正式验证一轮
- 主题预设 A/B 是否足够、要不要后续加档 —— 用户已确认 A/B 两档即可, 亮色不增预设

## 环境 / 测试数据

- **96 服务器**: `192.168.186.96:8765` 更新服务; 账号/密码在 Memory MCP `server_96.md`
- **云 Workbench**: 实例 `i-2ze2rouoikcqrlbseu8a` / 地域 `cn-beijing`; 发布走 `workbench upload/exec`
- **GitHub**: `o2bubble/claude-code-haha-rush`（private，macOS CI 出包用）——token 在会话内，勿存本文件（凭据政策）
- **发布 API Key**: `sk-mattpocock-skills-2026`
- **发布脚本模板**: `temp/release_0819g.py`(最新, 改 VERSION+NOTES+ZIPS 复用)
- **构建**: `cargo tauri build --no-bundle` + `bun run scripts/build.ts --quick --release YYYY.MM.DD.N --gui-only`
- **Inno Setup 6.7.3**: winget 装到 `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`（非标准 Program Files）
- **Gitee 认证**: `.git/config` 的 `http.extraheader` 已改为 **URL-scoped**（`http.https://gitee.com/.extraheader`）——否则会污染 GitHub 请求导致 duplicate Authorization；push GitHub 用 `-c http.extraheader="Authorization: Basic <user:token>"`
- **codebase-memory 索引**: 本项目已索引(76418 节点/405833 边), watched 自动刷新; 查代码优先 search_graph/trace_path, 必要时再 grep

## 参考资料（冷数据索引）

**Specs/PRD**: `.scratch/theme-presets/PRD.md`(主题预设系统) · `.scratch/guard-mode/PRD.md`(守卫)
**票据**: `tickets.md` — T-NEXT 主题预设(done)
**文档**: `docs/gui/gui-agent-guide.md`(超级桌面 block MCP 契约) · `docs/ARCHITECTURE.md` · `docs/architecture/config-files-architecture.md`
**代码**: `gui/src/utils/themeUtils.ts`(暗色判定) · `gui/src/tokens.css`(主题变量) · `gui/src/components/desktop/ChartItem.tsx`(图表三通道) · `gui/src-tauri/src/lib.rs`(WebView2 清理)
**原型**: `gui/prototypes/prototype-dark-theme.html`(A/B/C 配色 demo, C 淘汰)
**笔记(MCP)**: `a01d77f7`(计费选型) · `server_96.md`(96 服务器) · lesson `1aeebd1f`(MCP 配置位置) · lesson `a47994fc`(tauri serde wire)

## Suggested skills

- **prototype** — 配色/UI 变体先做 demo 再落地(本次主题预设走了这条路)
- **grilling** — 需求拍板前用拷问收敛边界(本次砍掉了亮色预设)
- **to-spec** — 实现前把决策固化成 PRD(本次产出 theme-presets/PRD.md)

## 安全

- 本文件不含凭据; 服务器账号密码在 Memory MCP
- `release_*.py` 内含 API Key, 在 temp/(gitignore), 不提交
