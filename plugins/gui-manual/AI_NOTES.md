# AI_NOTES — gui-manual 排查文档

GUI 功能手册：一个**静态面板**（`manual.html`，预渲染、无进程）+ 一个**技能**（`skill/`，给 AI 查）。
两部分由 `build.mjs` 从 `docs/gui/features.md` **同源构建**。

## 贡献

- 1 个面板：`功能手册`（id `gui-manual-panel`，in-main，userManaged）
- 1 个技能：`gui-manual`（链接进 `~/.claude/skills/gui-manual`）
- **无后台进程**（面板是纯静态 HTML，搜索在前端做）

## 故障模式与诊断

### 1. 面板打开是空白

- **先看是不是构建产物缺失**：`manual.html` 是**提交进仓库的生成物**，
  若它不存在或过小（正常约 85KB），说明没跑构建
  → 修复：`node plugins/gui-manual/build.mjs`
- 若文件在但空白：面板是 iframe 加载 `manual.html`，检查该文件能否被 `plugins://` 协议读到
  （同 git-viewer 的面板机制）

### 2. 搜索没结果 / 结果不全

- 搜索索引是**构建时内嵌**的（`var INDEX = [...]`，78 条）——
  **手册更新了但没重跑构建**时，索引会停在旧版（症状：搜新加的功能找不到）
  → 修复：重跑 `build.mjs`
- 诊断：`grep -c '"ch":' manual.html` 应等于功能点数（当前 78）

### 3. AI 不查手册 / 查不到

- **技能是否链接**：`~/.claude/skills/gui-manual` 应存在（junction），
  且 `skill/chapters/` 下应有 17 个 md 文件
- **技能在会话启动时扫描** → 装完要**新开会话** AI 才看得到
- AI 读章节的路径：`<技能目录>/chapters/NN-xxx.md`

### 4. 手册内容过时（文档说 A、界面是 B）

**这是本插件最可能的长期故障**（手册会随功能迭代失真）：

- 真源是 `docs/gui/features.md`；**改功能时要顺手更新它**
- 更新后必须 `node plugins/gui-manual/build.mjs`（重新生成两份产物）
- 版本号要升（`plugin.json` + `meta.yaml` 同步），否则用户端不会更新

## 日志与状态位置

- 面板：无进程、无日志（纯静态）—— 出问题看 DevTools 控制台
- 构建产物：`manual.html`（面板）、`skill/chapters/*.md`（AI）
- 构建脚本：`build.mjs`（跑一次会打印章节清单与索引统计）

## 配置依赖

- dependencies: 无
- installType: `standard`
- platforms: 未声明 = 全平台
- 版本兼容: 需要宿主支持 `contributes.skills`（GUI ≥ 2026.09.17.9）与 `content.type:"html"` 面板
