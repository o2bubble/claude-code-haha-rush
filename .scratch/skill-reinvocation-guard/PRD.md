# PRD: Skill Tool 重复调用加固

Status: done (A+B 已实施，验证通过)

## Problem Statement

用户在 IDE 插件中通过斜杠命令 `/skill-name` 使用 skill 时，skill 的 prompt 已经被 `/` 命令
正确注入到对话上下文。但模型看到上下文里有 skill 名称后，**又尝试通过 Skill tool 再次调用同一个
skill**。如果该 skill 设了 `disable-model-invocation: true`，Skill tool 拒绝调用，模型输出
一句 "This skill can't be invoked via the Skill tool"，虽然大部分模型随后会继续执行已加载的
指令，但这造成了：
1. 无意义的报怨，用户误以为功能故障
2. 部分小模型可能直接放弃而不继续执行

## Solution

在两条路径上加防重复调用声明，告诉模型 **斜杠命令已加载，不要再用 Skill tool**。

## User Stories

1. As a user, I want `/grill-with-docs` to execute immediately without the agent complaining about Skill tool, so that I don't think the feature is broken.
2. As a user, I want any `/skill-name` with disableModelInvocation to work smoothly, so that I can use all installed skills without friction.
3. As a skill author, I want disableModelInvocation to mean "users trigger this, not models" without breaking the IDE slash command workflow, so that interactive interview skills remain usable by real users.
4. As a plugin user, I want the agent to silently follow slash-command-loaded instructions, so that my conversation stays clean and focused on the task.

## Implementation Decisions

1. **Fix A — Skill prompt prefix**: When `disableModelInvocation` is true, prepend a natural-language
   guard to the skill prompt telling the model the instructions are already active and not to use
   the Skill tool. Implemented in `getPromptForCommand` in the skill loader. Only applies to
   commands with the flag set, zero token overhead for regular skills.

2. **Fix B — Universal slash command guard**: In `runPromptCommand` (called by ALL IDE slash
   commands), prepend a text content block to the prompt instructing the model that this is a slash
   command and not to invoke referenced skills via the Skill tool. This is a broad safety net that
   covers commands without disableModelInvocation too.

3. **Verified**: After implementing A+B, running `/grill-with-docs` in IDE mode produces
   "Let me proceed with the grilling approach directly" instead of "This skill can't be invoked via
   the Skill tool". Both `/grill-with-docs` and `/to-prd` tested and working.

## Testing Decisions

- **What makes a good test**: Send a `/skill-name` with disableModelInvocation in IDE mode;
  the agent should NOT output "cannot invoke via Skill tool". Instead it should proceed
  directly with the skill instructions.
- **Test subjects**: `/grill-with-docs`, `/to-prd`, `/setup-matt-pocock-skills`
- **Not tested**: No automated tests exist for ideMode slash command handling.
  Manual testing in VS Code plugin confirmed correct behavior.

## Out of Scope

- **Fix C (backend enforcement)**: A full backend-level guard that marks active skill names
  and blocks Skill tool calls at the tool level. Not needed unless models ignore the
  natural-language guards from Fix A+B.
- **Any changes to the VS Code extension VSIX**: The fix is in the source (`src/`),
  the extension is unchanged.

## Further Notes

The root cause is two independent code paths that have no coordination:
- Slash command path (`tryHandleSlashCommand`) injects prompt directly without checking
  disableModelInvocation
- Skill tool path (`getSkillToolCommands`) filters out disabled commands

Fix A+B add natural-language coordination between the two paths rather than backend enforcement,
which is lighter-weight and works across all current models tested (DeepSeek v4).
