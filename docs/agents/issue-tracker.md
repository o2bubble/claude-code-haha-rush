# Issue tracker: 本地 Markdown

本仓的 issue 和 spec 都是 `.scratch/` 下的 markdown 文件。
**没有**用 GitHub / GitLab Issues（`gh` 与 `glab` 在本机都没装）。

## 目录结构

```
.scratch/<feature-slug>/
├── spec.md                    ← 推荐名。PRD.md / SPEC.md / DESIGN.md 也认（历史遗留）
└── issues/
    ├── 01-<slug>.md
    └── 02-<slug>.md
```

- **一个特性一个目录**，目录名用 kebab-case
- **一个 issue 一个文件**，编号从 `01` 起，**不要**写成一个合并的 issues 文件
- 历史目录里 spec 叫 `PRD.md` / `SPEC.md` / `DESIGN.md` 的都有，**不要为了改名去动它们**；
  新目录统一用 `spec.md`

## 状态行

每个 issue 文件顶部附近有一行：

```
Status: needs-triage
```

取值见 [triage-labels.md](triage-labels.md) 的五个角色串。
本仓历史里出现过 `Status: done`（不在五角色里）——那是手工收尾标记，
`/triage` 只认五个角色串。

## `tickets.md` 是历史归档，不是活动追踪器

仓库根有一个 2000+ 行的 `tickets.md`，结构是 `## Done: <主题> (日期)` /
`## Pending: <主题>`。它记的是 2026-07 ~ 08 那批工作的**完成记录**。

- **新工作不要写进 `tickets.md`**，写 `.scratch/<feature-slug>/`
- 读历史决策时它仍然有用（按主题归档，带日期）

## 技能说「publish to the issue tracker」时

在 `.scratch/<feature-slug>/` 下建目录（必要时），按上面的结构写文件。

## 技能说「fetch the relevant ticket」时

直接读用户给出的路径或 issue 编号。用户通常会直接给路径。

## Wayfinding 操作（`/wayfinder` 用）

**map** 是一个文件，每个 ticket 一个 child 文件。

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 三部分）
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，编号从 `01` 起，正文是那个问题。
  `Type:` 行记类型（`research`/`prototype`/`grilling`/`task`），`Status:` 行记 `claimed`/`resolved`
- **Blocking**：顶部附近 `Blocked by: NN, NN`。所列文件全部 `resolved` 才算解锁
- **Frontier**：扫 `issues/` 找「开着、未阻塞、未认领」的，编号最小的优先
- **Claim**：先把 `Status:` 改成 `claimed` 存盘，再开工
- **Resolve**：在 `## Answer` 下写答案，`Status:` 改 `resolved`，
  再把一条 context 指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far
