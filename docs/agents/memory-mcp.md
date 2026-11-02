# Memory MCP — Agent Instruction（已迁移）

> **2026-11-02：内容已迁移，本文件只保留指针。**

Agent 指南现在是**技能**，源文件在：

```
extensions/memory/skills/memory-mcp.md
```

由 `scripts/memory-setup.ts` 安装到 `~/.claude/skills/memory-mcp/SKILL.md`。

## 为什么迁移

旧版把它当作 `@memory-mcp.md` 注入 `~/.claude/CLAUDE.md` —— 约 **16K 字符**进**每个**
会话的每一轮上下文。作为技能后，常驻的只有技能列表里的一行 `description`，正文在
模型真正需要时（`Skill` 调用）才加载。

## 相关技能（各管一段，不要重复实现）

| 场景 | 技能源 |
|---|---|
| 工具参考 / scope 选择 / 两阶段冲突流程 | `extensions/memory/skills/memory-mcp.md` |
| 开工前的系统化检索 | `extensions/memory/skills/recall.md` |
| 会话结束后的批量沉淀 | `extensions/memory/skills/remember.md` |
| 记忆库健康度 | `extensions/memory/skills/memory-status.md` |
