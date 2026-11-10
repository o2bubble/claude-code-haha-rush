# 仓库拆分说明（2026-11-04）

> **给接手的人**：如果你在一台新机器上打开这个仓库，发现 `gui/`、`plugins/`、
> `extensions/` 都不见了 —— 它们没丢，被拆到了独立仓库。本文档说明发生了什么、
> 代码现在在哪、怎么把它们一起构建。

## 一句话总结

原先的单体仓库拆成了三个：

| 仓库 | 内容 | 协议 | gitee | GitHub |
|---|---|---|---|---|
| **claude-code-haha-dev**（本仓） | Claude Code CLI 引擎 | 无（泄露源码衍生，仅学习研究） | `randomlife/claude-code-haha-dev` | `o2bubble/claude-code-haha-rush`（**孤儿快照分支**） |
| **lumen-agent-desktop** | 桌面 GUI 客户端 | MIT | `randomlife/lumen-agent-desktop` | `o2bubble/lumen-agent-desktop`（直接推 `main`） |
| **self-homepage** | 17lumen 备案主页 | 无 | `randomlife/self-homepage` | — |

GitHub 两端形态不同不是配置疏漏：本仓老历史里有明文凭据和大文件，只能靠
**孤儿快照**（`github-clean` 无共同祖先，那些提交从它出发不可达）；
GUI 仓历史干净，直接推 `main`。

拆分动机：GUI 与主页都是独立可维护的部分，混在引擎仓里导致
① 想给 GUI 加开源协议时，整个仓库都沾着泄露源码；
② 引擎仓的体积和构建复杂度被 GUI 拖累。

## 代码现在在哪

### 从本仓移出的内容

| 原路径 | 现在在哪 |
|---|---|
| `gui/` | `lumen-agent-desktop/apps/gui/` |
| `extensions/` | `lumen-agent-desktop/apps/extensions/` |
| `claude-code-gui-release-platform/` | `lumen-agent-desktop/apps/release-platform/` |
| `plugins/` | `lumen-agent-desktop/packages/plugins/` |
| `skills-src/` | `lumen-agent-desktop/packages/skills-src/` |
| `installer/` | `lumen-agent-desktop/build/installer/` |
| `updater/` | `lumen-agent-desktop/build/updater/` |
| `docs/gui/` | `lumen-agent-desktop/docs/gui/` |
| `docs/architecture/` `docs/diagrams/` `docs/agents/` 等 | `lumen-agent-desktop/docs/` |
| `homepage/` | `self-homepage/` |
| `docs/17lumen-homepage-playbook.md` | `self-homepage/DEPLOY.md` |
| `scripts/build.ts` | 拆成两半，见下 |

### 本仓保留的

```
src/                 引擎主体（泄露源码修复版）
build/               构建脚本
  build-claude.ts      入口：编译 src/ → claude 二进制
  engine.ts            发布引擎（manifest / zip / 复用校验）
  componentPlan.ts     平台构建规划
bin/                 启动脚本 + 工具二进制
stubs/               Bun 下缺失原生模块的替身
docs/                架构分析、逆向记录、构建手册
scripts/             辅助脚本（工具安装、诊断、发布）
```

## 构建脚本的拆分

原 `scripts/build.ts`（1200 行）同时管 10 个组件：claude、gui、server、updater、
tools、python、git、extensions、bun。拆分后：

### 本仓：`build/build-claude.ts`

只做一件事 —— 编译 `src/` 成 `claude` 二进制，可选生成发布 manifest。

```bash
bun run build/build-claude.ts                              # 编译 → dist/claude.exe
bun run build/build-claude.ts --release 2026.11.05.1 --notes "改了什么"   # + 发布包
```

**为什么换文件名而不是改 `build.ts`**：那 1200 行里大部分是 `cargo tauri build`、
打包 extensions、组装 `.app`，随 GUI 一起走了。硬留一半只会留下半死的代码。

### GUI 仓：`build/build.ts`

管其余 8 个组件。它**不编译 claude**，只消费：

```bash
# 从外部指定已构建好的 claude 二进制
bun run build/build.ts --claude-from <path/to/claude.exe>

# 或不给这个参数 —— 也能构建，产物可运行但没有聊天后端
```

### 两仓联合构建

`build/joint.ts` 放在本仓并已入库。GUI 仓路径由 `--gui-repo` 传入，脚本不绑定任何机器。

GUI 仓如果是独立 clone（没有 `dist/`），第一次联合构建前要把基线产物准备好：
未选中的组件由 GUI 仓按 sha 从上一版本复制，那份基线得在 GUI 仓的 `dist/release/<上一版>/`
里。可以从本仓 `dist/release/<上一版>/` 拷过去，或者直接放弃复用、全量重建（很慢）。

```bash
bun run build/joint.ts --gui-repo ../lumen-agent-desktop --release 2026.11.05.1
```

一条命令产出完整一套（CLI + GUI + Python + Git + 工具链），manifest 统一生成。

流程：先编译 claude → 再让 GUI 仓跑完整构建（`--claude-from` 指向前一步产物）→
最后把 GUI 仓的 `dist/` 同步回本仓。

## 一个必须知道的耦合点

`lumen-agent-desktop/apps/gui/src-tauri/src/lib.rs` 里有三行：

```rust
const GUI_AGENT_GUIDE: &str = include_str!("../../../../docs/gui/gui-agent-guide.md");
const GUI_REF_SYSTEM:  &str = include_str!("../../../../docs/gui/ref-system.md");
const GUI_CONFIG_FILES: &str = include_str!("../../../../docs/gui/config-files.md");
```

`docs/gui/*.md` 是 GUI 的**编译期输入**，不是普通文档。改 GUI 仓的目录层级时，
这几行相对路径必须同步改，否则 `cargo build` 直接失败。

## 引擎的 shared 副本

`build/engine.ts`（约 450 行）只管组件无关的事：manifest 生成、zip 压缩、
`--expect-prev` 复用校验、semver 排序、release_notes 拼接。它**不 import 任何
`src/` 或 GUI 的代码**，所以在两个仓各存一份副本，行为一致。

改引擎逻辑时**两个仓都要改**。这是刻意的取舍 —— 让 GUI 仓能独立构建，
代价是漂移风险。

## 本次拆分的时间线

| 提交 | 内容 |
|---|---|
| `d3c0577b` | 发布引擎从 `build.ts` 抽出（字节级验证产物一致） |
| `6652d9be` | 目录重排为 `apps/` `packages/` `build/` |
| `0536f507` | 剥离 GUI，本仓回归纯 CLI 引擎 |
| `c0c4d025` | 移除主页部署手册（已迁到 self-homepage） |

拆分过程中做过的工作区清理：`gui/` `extensions/` `plugins/` `installer/`
`updater/` `tools/` `temp/` `claude-code-gui-release-platform/` 等目录在 `git mv`
之后只剩空壳，已删除。

## 遗留 / 待办

1. **`github-clean` 快照分支**（GitHub 上的 `o2bubble/claude-code-haha-rush`）
   每轮同步跑 `bash scripts/sync-github-clean.sh`。
   **2026-11-10 对齐过 GitHub 端**：CLI 快照推到 `main@` 当时的最新提交，GUI 仓
   新建 `o2bubble/lumen-agent-desktop`（public，MIT）。
   ⚠️ 不要把 `macos-build.yml` / `codemagic.yaml` 加回本仓——拆仓后它们调的
   `scripts/build.ts`、`gui/` 都已不在本仓，**跑起来必然失败**。mac CI 在 GUI 仓。
2. **`offline-tools/`** 已清空。里面原本是 `python-3.12.10-amd64.zip`，只有 GUI 构建需要，
   现在在 `lumen-agent-desktop/offline-tools/windows/`。
3. **记忆系统按目录名绑定**：Memory MCP 的 scope 是 `project:claude-code-haha-dev`。
   本仓目录名**不要改**，改了所有记忆的 scope 都要跟着迁移。

## 法律与授权

- 本仓**不附带开源协议**。`src/` 是 2026-03-31 从 Anthropic npm registry 泄露的源码，
  版权归 Anthropic 所有，本仓作者无权授权。仅作学习研究，不商用。
- `lumen-agent-desktop` 采用 MIT —— 因为它不含任何泄露源码，只消费编译出的二进制。
  这是拆分的**主要动机之一**。
