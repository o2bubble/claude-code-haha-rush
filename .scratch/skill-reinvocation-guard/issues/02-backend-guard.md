# Fix C: Skill Tool 后端拦截

Status: ready-for-agent

## 问题

Fix A+B 是自然语言 guard——靠模型自己读指令别调 Skill tool。`/grill-with-docs` 和 `/to-prd` 生效了，
但 `/handoff` 无视了 guard 仍然去调 Skill tool，输出一句无用的 "Skill can't be invoked"。

## 方案

Skill tool 在收到调用请求时，后端检查：**这个 skill 是否已经通过斜杠命令在当前回合加载过了？**

如果是 → 直接返回 `"Skill already loaded via slash command — proceed directly with the injected instructions."`
（不调用真正的 skill handler，不报错，就返回一个提示文本）。

不需要模型配合理解 guard 指令——工具层直接截住。

## 实现思路

1. 在 `tryHandleSlashCommand` 中，调用 `runPromptCommand` 之前，把当前命令名记录到 AppState 或当前回合状态
2. 在 `Agent` tool 或 `Skill` tool 的 handler 中，检查请求的 skill 名是否匹配已加载的
3. 如果匹配 → 返回提示消息并 `return`（不执行 skill handler）
4. 在 `runPromptCommand` 完成后（或新回合开始时），清除标记

## 相关文件

- `src/entrypoints/ideMode.ts` — 记录已加载的 skill 名
- `src/commands.ts` — Skill tool handler 检查标记

## 备注

Fix A+B 保留——它们是通用防护，对大部分模型有效。Fix C 是兜底，堵死不听话的模型。
