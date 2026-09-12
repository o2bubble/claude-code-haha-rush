# Handoff — Claude Code GUI 开发 · 2026-09-11（main @8e84f04）

> 跨机器 / 跨会话继续用。当前状态以 git 为准；架构细节在 `docs/ARCHITECTURE.md`；**本文件不含凭据**——服务器账号/密码/密钥见内部凭据记录（`.private/api-keys.md`，gitignored）与 Memory MCP（`server_96.md`）。
> ⚠️ 维护本文件时：**不要把任何真实密码/密钥写进来**。历史版本曾因疏漏把云 server root 密码写在此处并推到了公开 gitee（2026-09-11 发现，见「密钥泄露」条）。

## 当前状态

- **分支**: `main`（`8e84f04`）；远端全同步（gitee `main` = `8e84f040`；gitee `github-clean` = GitHub `main` = `a2fc887e`，私有快照分支）。
- **本批主题**: **Memory MCP 检索层重写**（FTS5 + jieba + RRF，修复"假语义检索"）+ **密钥泄露闭环** + **仓库瘦身**（offline-tools 移出）。
- **Memory 服务（96）**: 容器 `claude-memory` 已跑新版，端口 **`14020`(MCP) / `40021`(Web)**（40020 因落在内核 ephemeral 端口范围被征用，已迁移；**仅 96 改了**，云仍是 8080）；303 条记忆迁移成功；真机验收 6 项全过。
- **Memory 服务（云 123.56.66.84）**: 2026-09-12 **已从 7-30 旧版升级到 `claude-memory:20260912`**，端口不变（`8080` MCP / `40021` Web），18 条记忆完整保留。流程 = 本地构建镜像 → workbench 上传 → 云端 `docker load` + compose 切 `image:`（**线上永不构建**，见 `docs/memory-deploy-playbook.md`）。回滚镜像 `rollback-20260730` + 库备份 `claude-memory.db.bak.20260912` 均保留在云上。
- **凭据脱敏收尾（`e9495ca`）**: 文档/源码中最后的明文凭据已清理（详见「脱敏收尾」条）。

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
- branch `main`，HEAD `8e84f04`；工作区 2 处未提交（见上）。

```text
8e84f04 chore: offline-tools/ 移出仓库 — 167MB 二进制不再随源码分发
9aed0f3 chore: registry.db 的 WAL 附属文件纳入忽略 — 原只忽略主文件
7617598 feat(memory): FTS5+jieba 中文检索 + 两段式写入契约 — 修复「假语义检索」
efc1a7d security: 文档里的明文密钥改为占位符 — 真实值移到 .private/（已 gitignore）
088bbe1 docs: README 补「构建」章节 — 原只讲开发模式，没讲怎么出包
```

### Memory 服务（96）
- 容器 `claude-memory`，镜像 `192.168.186.96:5000/claude-memory:latest`
- 端口 `14020`→容器 8080(MCP) / `40021`(Web+REST)；96 宿主库 `/data/claude-memory/claude-memory.db`（云为 `/data/memory/claude-memory.db`，挂载路径两边不同）
- 数据 303 条（fact 83 / experience 87 / lesson 133）；`capabilities={fts:true, jieba:true, tags:true, like_fallback:false, embedding:false}`
- 部署前备份：`claude-memory.db.bak.20260911`

### 测试基线
- Memory MCP：`cd extensions/memory && python -m unittest discover -s tests` → **43 passed**
- GUI 前端：`node node_modules/vitest/vitest.mjs run` → 437 通过（前批基线）· `tsc --noEmit` 干净
- Rust：`cargo check`（gui/src-tauri）通过

### 发布版本 (dist/release)
- 2026.09.10.5 ~ 2026.09.10.9（含 bun/claude/extensions/git/gui/python/server/tools/updater zip + manifest）

### 构建命令
- GUI：`cd gui/src-tauri && cargo tauri build --no-bundle`
- 发布：`bun run scripts/build.ts --release YYYY.MM.DD.N --components gui[,claude,...] --notes "## <标题>..."`
- 上传插件/技能：`python scripts/publish-plugin.py --manifest meta.yaml --zip my.zip --api-key <key>`（urllib，无第三方依赖）

## 待办

- [x] **本地接入 memory MCP** —— 2026-09-12 完成：`~/.claude.json` 指向 `http://123.56.66.84:8080/mcp`
      （**无需改配置** —— 服务端升级后自动生效，无需重启）；3 个 skills 已装新版（旧版备份在
      `~/claude-skills-backup-20260912/`）
- [ ] **96 同步本次修复** —— 96 的 `14020` 那份是"升级但无本次修复"版本：缺 scope 前缀搜索、
      `_ensure_meta` 并发保护、打包清单修正。端口映射是 `14020:8080`，别照抄云。见部署手册 §8
- [ ] **Web UI 复核** —— `http://123.56.66.84:40021/` 搜索走新 FTS5 + jieba
- [x] **云上跟进** —— 2026-09-12 完成（本地构建镜像 → workbench 上传 → 云端切换，见部署手册）
- [x] **云 server root 密码轮换** —— 已完成（新值在内部凭据笔记；96 内网密码无需轮换）
- [ ] （可选）**向量路** —— SPEC §10 预留：加 OpenAI 兼容 embedding 客户端 + 第三路进 `rrf_merge`，约 150 行
- [ ] （可选）**web 密码构建注入** —— 见「未提交改动」条

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
| 架构 | `docs/ARCHITECTURE.md` · `docs/agents/issue-tracker.md` | 架构与工单约定 |
| **部署** | `docs/memory-deploy-playbook.md` | **memory 服务发版手册**（本地构建→workbench 上传→云端切换；含 WAL 备份/代理/竞态三个坑） |
| PRD（本地） | `.scratch/gui-plugin-system/PRD.md` | 插件系统完整 PRD（gitignore 不入库） |

## Suggested skills

- **recall** — 接手前先搜记忆（`project:claude-code-haha-dev` + `domain:devops`）
- **implement** — 接续按 tickets 实现
- **code-review** — 大改动双轴 review（本轮 memory 升级已用）
- **tdd** — 新逻辑先写测试
