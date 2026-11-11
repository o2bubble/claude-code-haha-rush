# Triage 标签

技能用五个规范化的 triage 角色说话。这份文件把角色映射到本仓实际用的标签串。

| 技能里的角色 | 本仓标签串 | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 维护者需要评估 |
| `needs-info` | `needs-info` | 等报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可交给无人值守的 agent |
| `ready-for-human` | `ready-for-human` | 需要人来实现 |
| `wontfix` | `wontfix` | 不做 |

五个字符串与角色名一一对应，**没有改名**。

## 在哪里写

本地 markdown tracker，所以标签就是 issue 文件顶部那行：

```
Status: ready-for-agent
```

见 [issue-tracker.md](issue-tracker.md)。

## 注意

- 本仓历史里有 `Status: done` 这种手工收尾标记，**不在**上表五个之内。
  `/triage` 不认它；如果一个 issue 已经做完，正确做法是把它标记成
  `wontfix` 之外的方式归档（例如直接移出 `.scratch/`），别指望 triage 处理。
- 每个已 triage 的 issue **应当同时带一个类别角色**（`bug` / `enhancement`）
  **和一个状态角色**。本地 tracker 里类别写成 `Category: bug` 行。
  ⚠️ **不要用 `Type:`** —— 那个字段已被 wayfinding 占用（`research`/`prototype`/
  `grilling`/`task`），见 [issue-tracker.md](issue-tracker.md)。
