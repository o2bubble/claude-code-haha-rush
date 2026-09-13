# Handoff — Claude Code GUI 开发 · 2026-09-14（main @dfb9a17）

> 跨机器 / 跨会话继续用。当前状态以 git 为准；架构细节在 `docs/ARCHITECTURE.md`；**本文件不含凭据**——服务器账号/密码/密钥见内部凭据记录（`.private/api-keys.md`，gitignored）与 Memory MCP（`server_96.md`）。
> ⚠️ 维护本文件时：**不要把任何真实密码/密钥写进来**。本文件曾两次因此出事（2026-09-11 云 root 密码、2026-09-14 上传 key 硬编码进脚本），**都推到了公开的 gitee**。

## 当前状态

- **分支**: `main`（`dfb9a17`）；远端全同步（gitee `main` = `dfb9a17`；gitee `github-clean` = GitHub `main` = `9cc8fee` 快照）。
- **本批主题**: **macOS 平台首次跑通全链路**（真机验证 → 修 8 个 bug → 发布到云端更新服务器）+ **发布 key 泄露事故 #3 轮换**。
- **macOS 云端版本**: `2026.09.14.1`（首版）→ **`2026.09.14.2`**（含 GUI 组件路径修复）。此前云端 `?platform=macos` **一直 404** —— 服务端/客户端代码都支持 mac，只是**从没上传过**。
- **Windows 云端版本**: `2026.09.13.8`。
- **Memory 服务（96）**: 容器 `claude-memory`，端口 **`14020`(MCP) / `40021`(Web)**（40020 因落在内核 ephemeral 端口范围被征用，已迁移；**仅 96 改了**，云仍是 8080）；303 条记忆。
- **Memory 服务（云 123.56.66.84）**: 镜像 `claude-memory:20260912`，端口 `8080` MCP / `40021` Web。流程 = 本地构建镜像 → workbench 上传 → 云端 `docker load` + compose 切 `image:`（**线上永不构建**，见 `docs/memory-deploy-playbook.md`）。
- **凭据**: 云更新服务上传 key 已于 2026-09-14 **轮换**（事故 #3）；发布脚本改为读环境变量 `RELEASE_API_KEY`。

## 决策留痕表

### 决策：检索层用 FTS5 + jieba 纯本地方案，不做向量（本批）
- 为什么：原 embedding 通道在 7-30 瘦身重构时被移除，但代码假装还在（embedder 恒未加载 + **静默降级**）；且不接受"代理整个大模型 API"的重型方案。
- 影响：`extensions/memory/` 检索链路重写；删除 `embeddings.py`，**保留 `memories.embedding` 列**（未来向量路复用，SPEC §10 有预留方案）。
- 留痕：`7617598`；`.scratch/memory-upgrade/SPEC.md` §4。

### 决策：写入改两段式契约（预检 → agent 决策）（本批）
- 为什么：腾讯靠服务端自动调 LLM 去重，我们是被动 MCP server 没有这条通道；但"调用方 agent 本身就是 LLM"，把决策挪到 agent 侧。
- 影响：`memory_store` 协议变更（破坏性）——首次调用返回 `conflict_detected` + 候选**且不落库**，agent 带 `action=store|update|merge|skip` 二次调用。`skills/remember.md`、`docs/agents/memory-mcp.md` 同步更新。
- 留痕：`7617598`；SPEC §5。

### 决策：schema v2 → v3 自动迁移（本批）
- 为什么：需要 `version`/`superseded_by`/`deleted_at`/`source` 四列支持软删除与合并追溯。
- 影响：`store.py` 迁移链扩展；**多进程并发迁移用 `BEGIN IMMEDIATE` 串行化**（真机暴露竞态：server.py + api.py 同时迁移撞 duplicate column）。
- 留痕：SPEC §6；测试 `test_concurrent_migration`。

### 决策：MCP 端口 40020 → 14020（仅 96，本批）
- 为什么：40020 落在 Linux 内核 ephemeral 端口范围（32768-60999），96 上有持续连接风暴，源端口分配征用了它 → Docker bind 失败（41020/42020 同样被污染）。
- 影响：**只改了 96 服务器的运行配置 + 本机 `~/.claude.json` 的 memory MCP url。**
  ⚠️ 2026-09-12 核实修正：`extensions/memory/docker-compose.yml` **并未**改成 `14020`，仍是
  `40020:8080`；云服务器 `123.56.66.84` 也没改（实测容器仍是 `8080:8080`）。三处端口现状：
  仓库 compose / 云 = **40020↔8080**，96 = **14020↔8080**。
- 补充：40020 属于 Linux ephemeral 范围，但在 **Windows 客户端**上是安全的（Windows 动态端口
  范围默认 49152-65535），所以本地/云用 40020 没问题，无需为新端口改 compose。
- 留痕：服务器配置 + 用户全局配置（无 commit）。

### 决策：github-clean 重建为全新孤儿快照（本批）
- 为什么：原快照 40 个提交累积含明文密钥，且 `079d70d` 把 `.private/` 推到了公开 gitee。
- 影响：`github-clean` 丢弃全部历史从 main 重建；`scripts/sync-github-clean.sh` 的 offline-tools 特殊处理已移除。
- 留痕：`8e84f04`（main）；快照 `a2fc887`。

### 决策：offline-tools/ 移出版本控制（本批）
- 为什么：167MB 二进制；构建已转编译发布+打包模式，源码运行不再是主路径。
- 影响：`.gitignore` 改 `offline-tools/` 整目录忽略；**本地文件保留**（需要时重新下载）。
- 留痕：`8e84f04`。

### 决策：密钥轮换 + 旧 AK 回收（不重写 git 历史）（本批）
- 为什么：密钥已泄露于公开 gitee 历史；重写历史代价大，选择"轮换后旧值即为废字符串"。
- 影响：服务端上传 key 已轮换（两台服务器同值）；两个阿里云 AK 已进回收站。
- 留痕：`.private/api-keys.md`。

### 决策：GUI 插件系统 = 混合双轨 + 平台化共享 + GUI 自己读目录（前批，已发布）
- 为什么：用户希望后续功能通过插件补充；GUI 与 claude.exe 引擎两进程，GUI 不能读 `~/.claude/plugins`，必须自己发现 `%APPDATA%/claude-code-gui/plugins/`。
- 影响：`gui/src/services/pluginRegistry.ts` 等一批模块；PRD 在 `.scratch/gui-plugin-system/`（gitignore）。
- 留痕：`1415619` 及其前序 T0-T5 提交；已随 GUI 09.09.x 发布。

### 决策：插件系统通信标识符全对称重命名（前批）
- 为什么：`eventBus`/`bus` 在窗内与跨窗语义歧义。
- 影响：`windowBus`（跨窗）/`eventBus`（窗内）命名统一；197 文件受影响（用字节级替换，见踩坑 1）。

### 决策：云 server 部署用 workbench（阿里云 CLI）（前批）
- 为什么：SSH channel 慢；workbench（AK 模式 + 免密 ECS）更稳。
- 影响：`workbench exec -i <instance-id> -c "cmd"`；**必须 python subprocess 调**（Git Bash 直调报 named-pipe 错误）。

## 不可再生资料

### Memory MCP "假语义检索" 根因链（本批）
- **类型**：调查结论（起点：记忆 `387c8269` 的症状记录）
- **关键内容**：
  - `1d778226`（7-30 镜像瘦身 1.8GB→248MB）移除 PyTorch/sentence-transformers
  - 但 `api.py`/`server.py` 仍调用无参 `EmbeddingModel()` → `_loaded` 恒 False
  - `search_engine.py` 的 `embedder.loaded` 恒 False → semantic 分支恒不执行
  - 结果：`mode="semantic"` **静默返回空数组**；hybrid 退化成 LIKE 匹配，`similarity` 恒 0.0
  - **最坑的是无声降级**——空数组不报错，两个月无人察觉
- **对下轮价值**：新代码已改为 `strategy` 枚举显式报告；再遇类似症状先查 `memory_stats` 的 capabilities。

### 部署踩坑（本批实测，通用可复用）
1. **`PRAGMA journal_mode=WAL` 不遵守 busy_timeout** —— 实测 0.0s 立即报 `database is locked`。修复：先读 `PRAGMA journal_mode` 判断，已是 wal 就跳过。
2. **嵌套 `with self._conn` 在显式 `BEGIN IMMEDIATE` 事务里会提前 commit** —— 事务内禁用带 `with` 的 helper，改裸 `execute`。
3. **FTS5 `bm25()` 权重参数按所有列**（含 UNINDEXED）—— 3 列表用 `bm25(t, 0.0, 10.0, 1.0)`。
4. **小语料 BM25 idf 坍缩** —— N=2、n=1 时 `log(1.5/1.5)=0`，分数全 0；需"命中数 ≤ limit 跳过阈值"豁免。
5. **jieba 分词上下文歧义** —— "有龙猫"切成 `有龙|猫`，查询"龙猫"整词搜不到；解法 = CJK 字符 bigram 双通道。
6. **端口别落在 ephemeral 范围**（Linux 默认 32768-60999）—— 被征用时 `ss -tlnp` 看不到（只有 TIME-WAIT 出站），要 `grep :端口hex /proc/net/tcp`。

### 密钥泄露事故复盘（本批）
- **类型**：调查结论
- **关键内容**：
  - 事故点 A：`sync-github-clean.sh` 的 `git add -A` 把 orphan 分支工作区里的 `.private/`（含刚轮换的有效密钥）收进快照 `079d70d` → 推到**公开 gitee**。
  - 事故点 B：`docs/HANDOFF.md` 旧版含云 server 明文 root 密码（`efc1a7d` 脱敏时**遗漏**），已随 main 推到公开 gitee。本次重写已移除。
  - **gitee 服务端保留旧提交对象**：强推覆盖分支头**不删对象**，`raw/<old-sha>/<path>` 匿名仍可读（实测 200）。处理 = 换 key/密码使其失效。
  - 新快照 `a2fc887` 已验证：`.private` 404、无密钥模式。
- **对下轮价值**：再做分支/工作区清理类操作前，先确认 `.private/` 状态；快照脚本 `git add -A` 前应显式检查 `git status`。**改文档时逐项核对是否含凭据**（本次的遗漏就是这么来的）。

### 密钥泄露事故 #2（2026-09-12，同根因复发）
- **类型**：调查结论 —— **上一次只清了数据、没修脚本，所以第二次又犯**
- **触发**：跑 `sync-github-clean.sh` 同步快照，`.private/release_20260912.1.py`（含 release-platform **上传 key 明文**）被提交为 `337b6de` 并推到 GitHub + 公开 gitee。
- **根因**：脚本刻意 `git checkout main -- . ':(exclude).gitignore'`，让快照分支沿用自带旧 `.gitignore`；那份比 main 少 `.private/`、`.codex/`、`AGENTS.md` 三条 → `git add -A` 收了凭据目录。**与 079d70d 完全同因**。
- **止损**：① `github-clean` 重置回 `2f9bf42` 强推覆盖两端；② 云端轮换 key（旧 key 实测 401，新 key 422 通过）；③ 脚本修根因 + 加两道路径/密钥模式安全闸（已实测拦截）。
- **仍存在的残留**：gitee 旧对象 `raw/337b6de/...` 匿名仍可读（HTTP 200，已验证）——**强推不删对象**。key 已作废故无实际风险，但**下次轮换后同样要意识到这一点**。
- **对下轮价值**：
  - **同一事故第二次 = 上次的修复没落到源头**。清数据 ≠ 修脚本；处理完泄露必须回到产生泄露的那行代码。
  - `.gitignore` 这类"隐式忽略"存在两份副本时会漂移 —— **必须单一权威**，别让分支各持一份。
  - gitee/远端 `raw/<sha>` 的永久可达性意味着：**任何进过公开远端的凭据，唯一出路是轮换**，覆盖历史没有用。

### 腾讯 tencentdb-agent-memory 研究结论（本批）
- **类型**：已读资料（三份精读报告在 `.scratch/memory-borrow/`，共 1377 行）
- **关键内容**：
  - 其核心架构 = L0→L1→L2→L3 异步流水线 + **proxy 拦截 API 做注入**（代理整个大模型 API——明确不采纳）
  - **已借鉴落地**：jieba `cut_for_search` 子词铺开、OR 查询语义、RRF 融合（k=60，只吃 rank）、capability 位 + strategy 枚举、两段式去重、失败姿态"宁多存不误删"
  - **明确不做**：proxy 拦流量、服务端自动 LLM 提取、向量路（暂缓，方案已预留）

### 脱敏收尾（`e9495ca`）— 部署 web 前端前必读
- **类型**：调查结论
- **关键内容**：
  - `docs/architecture-reference.md`：96/云 SSH 密码、Memory Explorer 密码 → 占位符（此前明文在公开 gitee 上）。
  - `Login.jsx`：硬编码密码常量 → `import.meta.env.VITE_MEMORY_PASSWORD || ''` + fail-closed（未配置时拒绝一切登录）+ `login.notConfigured` 提示。
  - **`VITE_MEMORY_PASSWORD` 尚未接入构建流程**（全仓库仅 Login.jsx 与 locales 引用，无构建/部署侧注入代码）。
  - 构建命令（含注入）：`cd extensions/memory/web && VITE_MEMORY_PASSWORD=<值> bun run build`；值见内部凭据笔记。
- **对下轮的价值**：**若重建/部署 memory web 前端**，忘记注入 → 构建产物 `PASSWORD=''` → fail-closed 拒绝所有登录。要么补构建注入，要么知悉此行为。

### 前批教训（GUI 插件系统，仍有长期价值）
- **sed/perl -i 破坏 UTF-8**：Git Bash 下 `sed -i`/`perl -pi -e` 重写含多字节 UTF-8 的文件会损坏非 ASCII 内容（197 文件受损事故）。可靠做法 = python 读 bytes、只做 ASCII token 替换、写回 bytes。
- **.ps1 脚本中文编码**：Windows PowerShell 5.1 读 .ps1 需 UTF-8 with BOM；稳妥做法 = .ps1 只用纯 ASCII。
- **云 server SSH 慢真因**：channel 超时太短（非限流）；90s connect + 120-240s channel 可连。workbench 是更稳通道。
- **T3 kill/wait 竞态**：wait 返回后须核对 registry 中 current_pid/current_status 再处理（否则用户 kill 的 error 会覆盖 killed；restart 时旧线程会删新 pid）。
- **compound 剪枝判断"无变化"**：用引用/字段比对，不用 `tabs.length`（剪枝时长度不变 → 误判）。

## 热数据

### Git 状态
- branch `main`，HEAD `dfb9a17`；工作区干净，远端全同步。

```text
dfb9a17 fix(scripts): release_mac.py 改从环境变量读 key（不留明文）
f2dbd54 docs(playbook): mac 发布定论 — sha 沿用内嵌 manifest + 发布脚本入库
b74906a fix(mac): GUI 组件路径解析错位 — 更新面板误判「未安装」
a0ed8e6 fix(build): mac 不再生成三个跑不起来的 launcher
9db1864 docs(playbook): 记录 mac 2026.09.14.1 首次发布 + 四条上传踩坑
```

> ⚠️ `f2dbd54` 含已失效的旧上传 key（用户选择不改写历史）。key 已轮换失效，
> 风险消除；但**不要再从该提交取脚本内容**。

### Memory 服务（96）
- 容器 `claude-memory`，镜像 `192.168.186.96:5000/claude-memory:latest`
- 端口 `14020`→容器 8080(MCP) / `40021`(Web+REST)；96 宿主库 `/data/claude-memory/claude-memory.db`（云为 `/data/memory/claude-memory.db`，挂载路径两边不同）
- 数据 303 条（fact 83 / experience 87 / lesson 133）；`capabilities={fts:true, jieba:true, tags:true, like_fallback:false, embedding:false}`
- 部署前备份：`claude-memory.db.bak.20260911`

### 测试基线
- Memory MCP：`cd extensions/memory && python -m unittest discover -s tests` → **43 passed**
- GUI 前端：`npx vitest run` → **708 通过**（58 文件）· `tsc --noEmit` 干净
- Rust：`cargo test --lib`（gui/src-tauri）→ 全部通过（含 `update::tests` 6 项）

### 发布版本 (dist/release)
- 2026.09.10.5 ~ 2026.09.10.9（含 bun/claude/extensions/git/gui/python/server/tools/updater zip + manifest）
- **2026.09.12.5**（笔记面板 FTS5 + jieba + 两段式查重；仅 gui/server 重建，其余复用 .4）
  —— 已上传云 `123.56.66.84:8765`；**96 未上传**（内网不通）
- **2026.09.13.1**（切会话打断确认 + 子代理工具标记 + 时间线遮挡修复；仅 gui，其余复用 .12.6）
  —— 已上传云；gui sha `d36b7903…`
- **2026.09.13.2**（终端输出重复 + 并发串台修复；仅 gui，其余复用 .12.6）
  —— 已上传云，9 组件 sha 全部核对一致；gui sha `b43b6005…`
- **2026.09.13.3**（终端重复第二因：xterm 异步队列堆积 → 合并重绘；仅 gui）
  —— 已上传云，9 组件 sha 全部核对一致；gui sha `edd9fdbf…`
- **2026.09.13.4**（Windows 自绘标题栏 + 工具栏收纳 + 布局预设更新；仅 gui）
  —— 已上传云，9 组件 sha 全部核对一致；gui sha `0f1c30b1…`
- **2026.09.13.5**（预览路径修复 + 时间线默认开启迁移 + 3 处视觉修正；仅 gui）
  —— 已上传云，9 组件 sha 全部核对一致；gui sha `27593729…`
- **2026.09.13.6**（快捷键系统 + 关于页仓库地址；仅 gui）
  —— 已上传云，9 组件 sha 全部核对一致；gui sha `5c3bc887…`
  —— ⚠️ **未实机验证**（只跑了 tsc + 703 单测），见下方「快捷键系统」条
- **2026.09.13.7**（新建笔记无反应 + normalize_tags 失效 + 停止打包 CDP；仅 gui）
  —— 已上传云，9 组件 sha 全部核对一致；gui sha `f2ecc8d6…`
  —— 本版同时含 mac 侧修复（python 自包含 / server 内嵌 / 打开终端 / 菜单语言），
     但 mac 需 CI 单独构建，见下方「mac 真机验证发现的问题」条
- **2026.09.13.8**（插件 runtime PATH 少一层 bin/ + 笔记列表宽度自适应；仅 gui）
  —— 已上传云，9 组件 sha 全部核对一致；gui sha `fd76b427…`

### macOS 发布（云端，2026-09-14 首次）

| 版本 | 内容 | 组件 |
|---|---|---|
| **2026.09.14.1** | 对齐 Windows `.13.8`（PATH 修复 / 笔记宽度）+ mac 专属修复（python 自包含、server 内嵌、打开终端、新建笔记、CDP 移除、菜单中文化） | 6 个（bun/claude/extensions/gui/python/tools），6/6 sha 一致 |
| **2026.09.14.2** | GUI 组件路径修复（更新面板误判「未安装」）+ 移除三个死 launcher；发布 sha 改为沿用内嵌 manifest（修全量误报） | 仅 gui 变动，其余由服务端从 `.14.1` 复用 |

**mac 组件集**（服务端 `VALID_COMPONENTS_MAC`）= `{gui, claude, bun, tools, python, extensions}`
—— **无 `server`**（它内嵌在 gui.zip 的 `.app` 里）、无 git（系统自带）、无 updater（osascript 提权替代）。

**发布流程**：`scripts/release_mac.py`（本次入库；改顶部 VERSION/UPLOAD_ONLY/COMPONENTS/RELEASE_NOTES
→ `make` → `cloud` → `verify`）。细节与踩坑见 `docs/macos-build-playbook.md` §3。

**四条上传踩坑**（都真实踩到，详见 playbook）：
① 组件文件名必须规范 —— 服务端按 `upload.filename` 判组件，不在集合就**静默 continue**
（`gui (3).zip` → `"gui (3)"` ≠ `"gui"`，**gui 被丢但接口仍返回 `ok:true`**）
② `workbench upload` 不自动建目录（报 `PathNoWritePermission`，文案误导）
③ 同名文件**交互式**问覆盖（非交互环境当取消）
④ workbench 输出含 Braille 进度字符，**Windows GBK 控制台编解码都崩**

### ⚠️ 发布 sha 算法定论（推翻早先 playbook 的规则）

早先 playbook 写「发布时必须用 `dir_content_hash` 覆盖 gui sha（防 size-only 漏检）」
—— **这条规则本身就是故障原因**：

客户端读的**本地 manifest 就是 `.app` 内嵌那份**（`update.rs` 的
`local_manifest_path = Contents/MacOS/manifest.json`），其 sha 是构建期算的
`dirMetaHash(path,size)`。发布时改用内容 hash → **同一份内容两套算法算出不同值** →
`local_sha != remote_sha` → **每次检查都报"有更新"**（实测 6 个组件全亮，用户发现的）。

**定论**：sha 一律**沿用内嵌 manifest 的值** —— 比对算法与客户端一致是第一原则，
"算法更敏感"必须让位。代价是放弃"内容变但 size 恰好不变也能检测"（.25.5 那个坑）；
若日后要改回内容 hash，**必须同时改客户端 `local_manifest_path` 那份的生成方式**。

**顺带记录**：`gui.zip` 内嵌 manifest 的 `size` 是**陈旧的**（build.ts 在"回填 size 为
zip 实际大小"之前就打包了 gui.zip，所以 zip 内永远是**解压后目录**大小）—— 发布脚本
修正 size 即可；sha 不受影响（在打包前就算好了）。

### 2026-09-14 发布 key 泄露事故 #3（硬编码进脚本）

写 `scripts/release_mac.py` 时把云更新服务上传 key **硬编码进源码**并提交 →
推到**公开的 gitee**（`f2dbd54`）。

- **只有 gitee 中招**；GitHub 被 `sync-github-clean.sh` 的密钥安全闸拦下（它扫暂存 diff）
- **闸只保护快照分支，挡不住直接 push 主仓** —— 这是漏掉的路径
- 处理：云端 `api_keys` 表删 id=6、插 id=7，**实测旧 key 返回 401、新 key 422**；
  用户明确**不清理 git 历史**（key 已失效，风险消除）
- 脚本改为读 `RELEASE_API_KEY` 环境变量（`HEAD dfb9a17`）

**根因不是技术，是注意力**：同一轮对话里刚引用过"红线是进仓库/公开远端"却仍犯 ——
把 key 写进**脚本**时没意识到"这也是会提交的文件"。**写任何进仓库的文件一律从环境变量读。**

### 2026-09-14 插件 runtime 的 PATH 注入少一层（mac 实测，影响 Windows 亦然）
用户装 nodejs 插件后 mac 上 `node`/`npm`/`npx` 全不可用，**连带弄坏 playwright-mcp**
（`"command": "npx"` 解析不到；即便用绝对路径跑 npx-cli.js，npx 子进程的
shebang `#!/usr/bin/env node` 仍会失败）。

**根因**：`aggregateRuntimePaths` 把 runtime 声明目录原样当 PATH 条目 ——
Windows 发行版 `node.exe` 在解压根（命中），mac/Linux 按 Unix 惯例放 `bin/`（差一层）。
**而 AI_NOTES.md 把缺陷记成了"macOS 已知限制 / 用绝对路径绕行"** —— 那是错的，
设计意图本就写着「一个 runtime 声明覆盖 node/npm/npx」。

**修法**：注入声明目录**及其 `bin/`**（存在才加；声明已以 `/bin` 结尾则不追加，
防 `bin/bin`）。一处改动同时修好 A（claude.exe 启动自扫）与 B（GUI 推送）两条通道
—— 它们共用此函数。Windows 侧 `runtime/bin` 不存在 → 行为不变。

**可复用教训**：**别把实现缺陷当平台限制写进文档** —— 那会固化错误认知，
后续 AI 会照着文档说"必须用绝对路径"，问题永远不被修。

### 2026-09-13 mac 真机验证发现的问题（6 个，全部已修）
用户首次在 mac 真机跑 `.13.6`，点出 6 个问题。**其中 4 个是"必现且功能完全不可用"**
—— 说明这些代码路径**从没在 mac 上走通过**。这类 bug 单测/tsc 全抓不到。

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 内置 python 一启动就 `dyld: Library not loaded` | 旧方案用 python.org 的**.pkg 框架式安装**再 ditto 拷副本 —— 二进制里硬编码 `/Library/Frameworks/Python.framework/Versions/3.12/Python`，用户系统框架升到 3.14 后 3.12 的 dylib 没了。**ditto 改不了二进制内的绝对路径**，重建 symlink 也救不了 | 换 **python-build-standalone**（Astral）：真自包含（`@rpath` + `@executable_path/../lib`，libpython 随包），顺带 176MB→24MB |
| 2 | 诊断面板「GUI SERVER 已停止」 | `.app` 里根本没有 `claude-gui-server`。embed 列表把 `'server'` 当**目录**找（`existsSync(dist/server)`），但它是**单文件** `claude-gui-server` → 恒为假 → 只 warn 跳过 | 从目录列表移出，作**单文件硬校验**单独嵌入（缺了 exit(1)，它是必须组件不是可选的） |
| 3 | `note_normalize_tags` 必现失败 | **两个错误叠加**：a) 缺必填 `workDir`；b) **误用返回值** —— `run_cli_print` 是两段式（invoke 只返回 request_id，输出经 `cli-translate-result` 事件回传），原代码直接当输出用 | 抽 `runCliPrintForJson()` 封装契约：先挂监听再 invoke、暂存 early payload、按 request_id 匹配、超时保护 |
| 4 | 点「新建笔记」无反应 | GUI **没处理两段式契约** —— `note_create` 不带 action 时先查重，命中返回 `conflict_detected` 且**不落库**（无 id）→ `setSelectedId(undefined)`。叠加小语料豁免（≤20 条跳过分数阈值）→ 库里仅 1 篇时必撞 | 新建时带 `action: "store"` 绕过查重（空白笔记没有"重复"语义） |
| 5 | 「打开终端」必现失败 `-2741 syntax error` | **AppleScript 转义层数搞反**：路径用 bash 双引号包裹，而那对引号**提前闭合了 AppleScript 字面量**（`do script "cd "path""`）。原代码注释写着"两层转义"但顺序是反的 | 改用 **bash 单引号**（与 update.rs 的 osascript 提权同思路），单引号不参与 AppleScript 字面量 |
| 6 | 系统菜单栏恒英文 | `Info.plist` 只写 `CFBundleDevelopmentRegion=English` 且无 `CFBundleLocalizations` → macOS 判定仅支持英文（标准菜单项的本地化**由系统提供**，应用须声明支持） | 改 `zh_CN` + 加 `CFBundleLocalizations=[zh-Hans, zh_CN, en]` |

**共性**：4 个是**"前端/构建没遵守既定契约"**。可复用的教训：
- **"缺失就跳过"只对可选组件成立** —— server 是必须组件却走了 warn 分支，问题被静默吞掉（#2）
- **两段式/事件式 API 不能当同步返回值用** —— #3 #4 都是这个
- **往 AppleScript/shell 里嵌字符串时，引号层级要想清楚** —— 优先用不冲突的引号种类（#5）
- **不要靠"看起来对"判断转义/编码类改动** —— #5 我用词法模拟验证了三种路径（普通/含空格/含单引号），旧实现在**所有**情况下都失败

**mac 待验证**：.13.7 的 mac 产物需 CI 构建后真机复验上述 6 条。清单见对话记录。

### 2026-09-13 快捷键系统（.13.6）
完整文档 `docs/gui/shortcuts.md`。要点：

- **唯一真相源** `services/shortcuts.ts`：默认表 + 键位解析/格式化 + 冲突检测 + 合并
- **三类条目**：全局 / 命令型（走 commandRegistry）/ **上下文型**
  （有焦点/挂载条件 → 设置里只读展示，改了也可能不生效）
- **软冲突**：允许同键 + 提示 + 警示色；**表内顺序决定优先级**
  （不用"后注册赢"—— 注册顺序受挂载时机影响、不确定）
- 键位存规范化字符串 `"mod+shift+p"`；`mod` = Ctrl-or-Cmd，一份配置跨平台
- 存 `gui.shortcuts`；分发器**按内容缓存**（JSON 作键）每次按键重读 → 改键立即生效

**评审抓到的四个坑（都已修，值得记住）**：
1. **注释与实现不符** —— 分发器写着"每次按键读最新值"却只读一次，
   正是 HANDOFF 记过的失败模式（"前端注释与后端实现不符是这次 bug 的根"）。
   改成按**内容**缓存，不依赖"调用方必须传新对象"的隐式契约
2. **上下文键的键位要同源** —— 表里只是"描述"、组件仍硬编码时，设置面板
   显示的键位会与实际行为悄悄脱节。加了 `entryKeysOf` 让组件从注册表读
3. **Monaco 让位要按 id 不按字面量** —— 按按键匹配时用户改键后就失配
4. **`+` 键名往返有损**（由测试发现）—— `formatKeys` 产出 `"mod++"`，
   `parseKeys` 再解析时键名被当空片段丢掉。统一表示为 `plus`

**i18n 键路径无类型安全** —— `shortcuts` 块曾被误放进 `settings` 命名空间而
代码读顶层路径，整页显示原始键名，而 **tsc 全程干净**。已加
`i18n/shortcutsKeys.test.ts` 兜底（断言 `t()` 返回值 ≠ 键名 + zh/en 键集合一致）。

### 2026-09-13 「默认值变更」的迁移模式（.13.5，可复用）
把某个**原先默认关闭**的功能改成默认开启，同时**尊重用户的手动关闭** ——
靠 `Option<bool>` 的三态天然区分，不需要额外的标记字段：

| 设置文件里的值 | 含义 | 迁移动作 |
|---|---|---|
| 字段缺失 / `null` | 从未设过 | **写入 `true`** |
| `true` | 已开启 | 不动 |
| **`false`** | **用户手动关过** | **不动**（永不再翻回） |

实现要点（`migrations.rs::migrate_message_timeline_default_on`）：
- **直接操作 `gui` 段 JSON，不走 `AppSettings` 结构** —— 只有这样才能区分
  「字段缺失」与「显式 false」（走结构体时 `None` 会被序列化成 `null`）
- 走已有 `MIGRATION_REGISTRY` 的 `Trigger::Startup`，幂等
- 前端**同时**把默认值改成 `?? true`（双保险：新装用户不写盘也对）
- 工作区覆盖全局用 `is_some()` 判定 → 工作区显式 false 能压过全局迁移的 true

> 同类需求（如某开关要从默认关改默认开）直接照抄这个模式。

### 2026-09-13 视觉缺陷只有实机能验（.13.5 复盘）
本轮有一处我**改错了却没发现**：时间线筛选按钮要修"在蓝色气泡上看不见"，
我把填充色改成了 `var(--accent)` —— 而用户气泡**本身就是** `var(--accent)`
（`MessageItem.tsx:578`），同色相叠等于没修。直到提交前复查才发现。

**正确解法**：浮在内容之上的控件，背景一律用**不透明的 `var(--bg-root)`**
（暗色近黑 / 亮色纯白），与内容形成明暗反差；"激活态"靠**描边+图标着色**
表达，不要动填充色（填充色要留给对比度）。

**教训**：改配色前先查**目标背景实际是什么 token**（`grep` 那个元素的
backgroundColor），别凭"看起来是蓝色"就动手。`tsc`/单测对配色零覆盖。

### 2026-09-13 Windows 自绘标题栏（.13.4）
把系统标题栏与工具栏合并成一条 36px（Windows 专属，mac 保留原生装饰）。
完整文档见 `docs/gui/window-chrome.md`，四个必踩的坑：

1. **`core:window:allow-start-dragging` 不在 `core:window:default` 里** ——
   漏加会让所有 `data-tauri-drag-region` 静默失效（窗口拖不动），不报错
2. **工具栏容器必须 `position: relative` + `z-index`** —— 否则被 `LayoutRenderer`
   （它是定位元素）盖住；下拉自身的 zIndex 只在**自己堆叠上下文内**有效，救不了父级
3. **全屏覆盖层必须自带窗口按钮** —— `WorkspaceSelector`(z1000) / `WelcomeWizard`
   (z2000) 盖住工具栏后就无从关窗（无装饰窗口下工具栏是唯一入口）
4. **`="deep"` 吞非 BUTTON 元素点击** —— 下拉菜单项是 `div onClick`，被
   `preventDefault()` 吞掉（表现为"菜单显示正常但点不动"）。弹层一律加
   `data-tauri-drag-region="false"` 豁免（`Toolbar.tsx` 的 `DROPDOWN_MENU_ATTRS`）

**工具栏收纳架构**（`toolbarItems.ts` 单一数组，顺序即折叠优先级）：
- **固定降级** `inMenuByDefault` —— 低频功能永远在应用菜单，与宽度无关
- **响应式折叠** —— 窗口窄了按序折叠（`useToolbarCollapse`：ResizeObserver +
  实测宽度缓存 + 80ms 防抖，**不持久化**）
- 两者汇入同一个 `AppMenu`（`AppMark` 图标点开，跨平台）

> ⚠️ **重构工具栏时的教训**：删 JSX 前先确认那个组件能不能用 `ToolbarItem`
> 表达 —— 自带弹层的（布局预设/终端/模型/面板/权限）**必须固定渲染**。
> 我把「布局预设」和「系统终端」删了却没换机制，直接丢失功能。
> 单测覆盖不到"某组件不再渲染"，**改后要做一次渲染清单比对**
> （`git show HEAD:file | grep` 对比 `<Component` 出现集合）。

### 2026-09-13 终端重复是**两个独立 bug**（重要区分）
用户第一次报"命令和结果重复"→ 修了 store 层（.13.2）。用户复测后报"当前标签仍
重复，**切一下标签重复又消失**"→ 这条线索直接排除 store 层（切标签就是从 store
全量重绘，数据若有问题切了也还在），锁定 xterm 渲染层（.13.3）。

**第二个 bug**：`TerminalPanel.renderActive` 直接 `term.reset()` + 一串 `writeln()`。
但 xterm 的 `write()/writeln()` 是**异步**的（官方 typings：*data is processed
asynchronously*），而 `reset()` 是同步清屏 —— reset 不会取消队列里未处理的写入。
流式输出时每个进度事件都触发一轮「reset + 全量重写」，队列里堆了多份 → 处理完
就是两整份。切标签时输出已停、队列排空 → 重绘正常。
**修复**：`createRenderScheduler`（`gui/src/components/chat/terminalRender.ts`），
同一帧内多次 request 合并为一次渲染（微任务调度）。

> 教训：**"切一下就恢复正常" 是极强的定位线索** —— 它说明持久层（store/DB）
> 是对的、问题在渲染/缓存层。遇到类似症状先按这条切分。

### 2026-09-13 终端重复根因（store 层）
- **后端进度回调送的是"滚动尾部窗口"，不是增量** —— `exec` 的 onProgress 传
  `lastLines`(=最近 5 行) / `allLines`(=最近 100 行)，取自 `CircularBuffer.getRecent`
  （`src/utils/task/TaskOutput.ts`；pipe 模式走 `#recentLines.getRecent(5)`）。每次 poll
  窗口滑动且与上次重叠 → 前端按注释 "append only the delta" 直接 `output += text`
  就会把重叠累积，短输出（≤5 行）整段重复。**前端那句注释与后端实现不符**，
  是这次 bug 的根。
- **修复**：`terminalStore.mergeTailWindow` —— 按**行**找 incoming 与已累积文本尾部的
  最长重叠，只追加新行。整行比较而非字符比较（否则 "…abc" 尾部的 c 会被当成
  "cde" 的重叠而丢字符）。真实重复（连续 `echo same`）无法与窗口滑动区分 → 保守保留。
- **同时修掉的寻址 bug**：`terminal.append` 原不带工具 id，永远写"最后一个条目"，
  并发工具时输出会落到别的卡片上。寻址必须用 **`parent_tool_use_id`** 而非
  `tool_use_id` —— 后者是 `bash-progress-N` 计数器（`toolExecution.ts:566` /
  `BashTool.tsx:666` 每包自增），用它寻址会永远找不到条目、终端进度整个失效。

### 发布 notes 格式（易错，已踩）
`build.ts` 的 `--notes` **不会自动加版本头** —— `vYYYY.MM.DD.N` 那行必须自己写，
否则更新面板里该版本段没有标题、累积说明断代。累积由脚本自动拼接（本版 + 上一版
manifest 的 release_notes，`MAX_RELEASE_NOTES = 5`）。13.1 漏了，13.2 已补回并
修正 13.1 段。

### 2026-09-13 三处 GUI 改动（本批）
- **切会话打断确认** —— 后端 `handleResumeSession`/`handleNewSession` 首行就是
  `interruptCurrentTurn()`（`ideMode.ts:2245`/`2486`），点会话行即静默中止在跑的回合、
  token 白烧。新增 `sessionSwitchGuard.ts`（纯函数）+ 弹窗，判定用 `isBackendBusy()`
  （**不用 `streaming`** —— 它被 `interrupt()` 乐观清空会漏判；见 `chatReduce.ts:66`）。
  重击当前会话不弹；`backendBusy === undefined`（后端未报过状态）视为不忙。
  **未覆盖**命令面板（`useCommandPalette.ts:104`）与 `@ref` 会话链接（`referenceActions.ts:37`）
  —— 那两处没有弹窗宿主，要加需先提供全局 confirm 容器
- **子代理工具卡片标记** —— 根因：后端一直给子代理消息带 `parent_tool_use_id`（=主 agent 的
  Task tool_use id，见 `queryHelpers.ts:120-156` 生成、`ideMode.ts:688-781` 广播），但 GUI
  **从未读过**（全仓仅 `chatSession.ts:177` 写入 `null`）→ 子代理 tool_use 被 `chatReduce.ts:345`
  直接 merge 进主 agent 最后一条 assistant 的 `toolUses`，视觉无区别。
  **关键约束：只能标注、不能过滤** —— 卡片按 id 去重、tool_result 靠 `updateToolByUseId` 回填、
  `tool_progress` 写最后一张卡，过滤会导致结果无处接收。故给 `ToolUse` 加 `subagent?: boolean`
  仅在 UI 显示徽章
- **时间线遮挡** —— 两个源：① 黑框是**原生 `title` tooltip**（`TimeLineBar.tsx:219`），OS 级定位
  CSS 控制不了 → 删除，改 `role="slider"` + `aria-label`；② 提问预览浮层拖动时贴右侧消息区
  随指针一路遮 → 拖动时翻到左侧（`barRect.left - PREVIEW_MAX_WIDTH - 6`，用常量偏移避免
  测量自身宽度形成循环依赖）
- ⚠️ 发布时 `dist/release/` 若为空（换机器），需先从 `GET /api/updates/latest` 拉回上一版
  manifest 落盘，否则 build.ts 的 `prevNotes` 取不到基底、更新面板的累积说明会断代。
  本次即如此处理（拉回 .4 的 manifest 作为基底，见脚本 `prevNotes` 逻辑）

### 构建命令
- GUI：`cd gui/src-tauri && cargo tauri build --no-bundle`
- 发布：`bun run scripts/build.ts --release YYYY.MM.DD.N --components gui[,claude,...] --notes "## <标题>..."`
- 上传插件/技能：`python scripts/publish-plugin.py --manifest meta.yaml --zip my.zip --api-key <key>`（urllib，无第三方依赖）

## 待办

- [x] **访问控制** —— 2026-09-12 完成：MCP + REST 加 bearer token 鉴权（此前两者**零鉴权且公网可达**，
      任何人可读写/投毒/`hard=true` 删库；Web 登录也只是前端装饰）。云已部署 `claude-memory:20260912-auth`，
      token 存 `/root/claude-memory/.env`（600），本地 `~/.claude.json` 已配 `headers.Authorization`。
      **当前会话 MCP 显示未连接属正常**（会话启动时读的旧配置），重启后生效。见部署手册 §6
- [x] **本地接入 memory MCP** —— 2026-09-12 完成：`~/.claude.json` 指向 `http://123.56.66.84:8080/mcp`；
      3 个 skills 已装新版（旧版备份在 `~/claude-skills-backup-20260912/`）
- [ ] ⚠️ **本地代理 17891 会间歇 502** —— 2026-09-12 实测：直连云服务器 5/5 正常，走 17891 代理
      5 次里 3 次返回空 body 的 502（服务器端无异常日志，容器内直连 6/6 稳定）。可能影响 MCP 连接
      稳定性；今早 docker pull 失败、HANDOFF 旧记的"死代理"疑似同源。待办：给云 IP 配 `NO_PROXY` 或修代理
- [ ] **96 同步本次修复** —— 96 的 `14020` 那份是"升级但无本次修复"版本：缺 scope 前缀搜索、
      `_ensure_meta` 并发保护、打包清单修正。端口映射是 `14020:8080`，别照抄云。见部署手册 §8
- [ ] **Web UI 复核** —— `http://123.56.66.84:40021/` 搜索走新 FTS5 + jieba
- [x] **云上跟进** —— 2026-09-12 完成（本地构建镜像 → workbench 上传 → 云端切换，见部署手册）
- [x] **云 server root 密码轮换** —— 已完成（新值在内部凭据笔记；96 内网密码无需轮换）
- [ ] （可选）**向量路** —— SPEC §10 预留：加 OpenAI 兼容 embedding 客户端 + 第三路进 `rrf_merge`，约 150 行
- [x] ~~web 密码构建注入~~ —— 2026-09-12 该机制已废弃：登录框改为输入 bearer token 并向服务端验证，
      **不再有构建期注入**，连带消除了"忘记注入导致登录全被拒"的失败模式

## 环境

- **96 server**: `192.168.186.96:8765`（release-platform）/ `:14020` + `:40021`（memory）；账号/密码见 Memory MCP `server_96.md`
- **云 server**: `123.56.66.84:8765`；ECS `i-2ze2rouoikcqrlbseu8a` / cn-beijing；通过 workbench 通道操作
- **Workbench**: `C:\Program Files\workbench\workbench.exe`；config `~/.workbench/config.json`（AK 模式）；**Python subprocess 调用**
- **GitHub**: `o2bubble/claude-code-haha-rush`（private）；push 需 `-c http.proxy= -c https.proxy=` 绕过死代理（17891）
- **凭据**: 真实值见 `.private/api-keys.md`（gitignored）；⚠️ 不要把真实值写回本文件

## 相关文档索引

| 类型 | 路径 | 一句话 |
|------|------|--------|
| SPEC | `.scratch/memory-upgrade/SPEC.md` | 本批升级完整设计（含 §10 向量路预留） |
| 研究报告 | `.scratch/memory-borrow/research-{store,pipeline,prompt}.md` | 腾讯项目三份精读报告 |
| Tickets | `tickets.md` 末尾「memory 检索 + 写入契约升级」段 | MT-T1~T8 完成记录 + code-review 修复 |
| 代码 | `extensions/memory/{tokenizer,store,search_engine,server,api}.py` | 新版实现（`tokenizer.py` 为新增） |
| 测试 | `extensions/memory/tests/test_memory.py` | 43 单测 |
| 脚本 | `scripts/sync-github-clean.sh` | 快照同步（已移除 offline-tools 特殊处理） |
| **mac 发布** | `docs/macos-build-playbook.md` · `scripts/release_mac.py` | **macOS 构建发布手册**（含 sha 算法定论、四条上传踩坑、发布历史） |
| 架构 | `docs/ARCHITECTURE.md` · `docs/agents/issue-tracker.md` | 架构与工单约定 |
| **部署** | `docs/memory-deploy-playbook.md` | **memory 服务发版手册**（本地构建→workbench 上传→云端切换；含 WAL 备份/代理/竞态三个坑） |
| PRD（本地） | `.scratch/gui-plugin-system/PRD.md` | 插件系统完整 PRD（gitignore 不入库） |

## Suggested skills

- **recall** — 接手前先搜记忆（`project:claude-code-haha-dev` + `domain:devops`）
- **implement** — 接续按 tickets 实现
- **code-review** — 大改动双轴 review（本轮 memory 升级已用）
- **tdd** — 新逻辑先写测试
