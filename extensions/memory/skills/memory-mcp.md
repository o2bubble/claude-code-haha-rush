---
name: memory-mcp
description: Memory MCP 跨会话记忆库（memory_store / memory_search / memory_get / memory_update / memory_associate / memory_traverse / memory_tags / memory_stats / memory_forget / memory_normalize_tags）。当需要跨项目检索经验与事实、保存踩坑教训、或用户说"记一下 / 查记忆 / 之前遇到过吗"时使用。
---

# Memory MCP

跨会话、跨项目的记忆库。**与 auto-memory（本项目 `memory/` 下的 markdown 文件）是两套独立系统**：
auto-memory 是随仓库/会话走的本地笔记，Memory MCP 是可全文检索、带知识图谱的数据库。

工具 schema 由 `ToolSearch` 提供，本文只讲**参数里看不出来的判据**。

## 什么时候用

| 场景 | 做什么 |
|---|---|
| 开始非平凡任务前 | `memory_search` 2~3 个角度，看有没有前人的经验/教训 |
| 解决了一个问题 | `memory_store` 存成 `experience` |
| 踩了坑 / 做错事 | `memory_store` 存成 `lesson`，importance ≥ 0.7 |
| 发现某个反直觉的事实 | `memory_store` 存成 `fact` |
| 用户说"记一下" | 按上面的分类存，别存成流水账 |
| 用户说"查一下之前…" | 先 `memory_search`，别凭印象答 |

## scope 怎么选（唯一需要判断的）

```
global            任何项目都成立的方法论        ← "先读代码再改"
domain:<name>     某个技术栈的通用经验          ← domain:rust、domain:devops
project:<name>    只在这个项目有意义            ← project:claude-code-haha-dev
```

判断顺序：**换个项目还成立吗？** 成立 → 再问**换个技术栈还成立吗？** 成立 → `global`。
拿不准就用 `project:<当前>` —— 太窄比太宽安全（宽了会在无关项目里刷屏）。

⚠️ 项目名用**实际的仓库目录名**。本项目是 `project:claude-code-haha-dev`（不是 `claude-code`）。

## 存记忆：两阶段冲突流程（核心）

`memory_store` 有两阶段，**第二次调用不是可选的**：

```
① 不带 action 调用
   ├─ {status:"stored", id}                    → 完成
   └─ {status:"conflict_detected", candidates} → 什么都没存，看 ②
② 带 action 再调一次
```

| 情况 | 动作 |
|---|---|
| 真新信息 | `action="store"` |
| 同一件事，措辞更好/更准 | `action="update"` + `target_ids=[id]` |
| 互补的两条应合成一条 | `action="merge"` + `target_ids=[...]` + `merged_content` |
| 没有新信息 | `action="skip"` |

`exact: true` 的候选（content_hash 完全相同）几乎一定是 skip 或 merge。

## 检索技巧

- **`mode`**：默认 `hybrid`（BM25 + 标签，RRF 融合）。
  **`mode="semantic"` 不可用** —— 服务端没有 embedding provider，只会返回一条说明。
- **看 `strategy` 字段**：返回里会告诉你实际走了哪条路（`hybrid` / `fts` / `tag` / `like` / `none`）。
  如果结果是 `like` 或 `none`，说明索引/分词降级了，该换个词重搜而不是相信这次的结果。
- **`content_hash` 省 token**：结果里带 SHA256。若这条记忆你已经 `memory_get` 过且 hash 没变，
  跳过重读。
- **搜不到就换词**：检索是关键词驱动（中文走 jieba 分词 + 字符二元组），**短而独特的词**效果好于整句。
  最多试 3 次，还不行就说明没有，别硬凑。
- **`tags` 在 hybrid/tag 模式下是 AND** —— 传多个标签会同时要求全部命中。

## 反模式

| 别这样 | 因为 |
|---|---|
| 存"foo 函数有 3 个参数" | 代码搜索能查到的，不该进记忆 |
| 存"构建出了点问题" | 没有可执行信息，等于没存 |
| 存完不建关联 | 孤立记忆永远搜不到（图谱靠边） |
| 把 Docker 的通用知识存成 `project:xxx` | 换项目就失联 |
| 跳过任务前的搜索 | 记忆最大价值是**阻止你重复犯错** |
| 每存一条就 `memory_normalize_tags` | 那是批量清理操作，不是日常动作 |

## 相关技能

**不要在本文里找"怎么开始/怎么总结"的流程** —— 那两套流程各在独立的技能里：

| 场景 | 技能 |
|---|---|
| 开工前的系统化检索（多角度、traverse、沿用发现） | `recall` |
| 一次会话结束后的批量沉淀（合并、关联、汇报） | `remember` |
| 看记忆库健康度（条数/类型/标签卫生/规范化建议） | `memory-status` |
