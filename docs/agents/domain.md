# 领域文档

工程技能在探索本仓代码库时，应当怎样使用这里的领域文档。

**布局：single-context**（单上下文）。本仓不是 monorepo ——
没有 `workspaces` 字段、没有 `pnpm-workspace.yaml`、没有多包 `src/`。

## 探索之前先读这些

- **`GLOSSARY.md`**（仓库根）
- **`CONTEXT.md`**（仓库根）—— 本仓用来写项目级上下文
- **`docs/adr/`** —— 读跟你即将改动的区域相关的 ADR

**这三个目前一个都不存在，遇到就读下一项，不要停下来问。**
不要主动提议创建它们；`/domain-modeling` 技能会在术语或决策真正定下来时
按需创建。

## 本仓已有的领域资料（优先读这些）

在 `GLOSSARY.md` 和 `docs/adr/` 建立之前，领域知识散在这几处：

| 想了解 | 去读 |
| --- | --- |
| 整体架构、启动流程、子系统划分 | `CLAUDE.md` |
| 架构细节与参考 | `docs/architecture-reference.md`、`docs/architecture/` |
| 跨机器 / 跨会话的当前状态 | `docs/HANDOFF.md` |
| 反向工程的结论与方法 | `docs/reverse-engineering/` |
| 事故复盘 | `docs/postmortems/` |
| 构建与发布 | `docs/windows-build-playbook.md`、`docs/repo-split.md` |

## 目录结构（目标形态）

```
/
├── GLOSSARY.md          ← 还没有
├── CONTEXT.md           ← 还没有
├── docs/
│   ├── adr/             ← 还没有
│   └── agents/          ← 本文件所在处
└── src/
```

## 使用术语表的词汇

产出里提到某个领域概念时（issue 标题、重构提案、假设、测试名），
用 `GLOSSARY.md` 定义的那个词，不要滑向它明确避免的同义词。

概念不在表里，是个信号：要么你在发明项目不用的说法（重新想），
要么这里真有缺口（记下来留给 `/domain-modeling`）。

## 遇到 ADR 冲突要明说

产出如果与既有 ADR 矛盾，**明确指出来**，不要默默覆盖：

> _与 ADR-0007（事件溯源订单）冲突，但值得重开，因为……_
