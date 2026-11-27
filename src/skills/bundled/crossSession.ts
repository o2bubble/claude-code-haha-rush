import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_MD } from './crossSessionContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Work with other Claude sessions on this machine: discover them, delegate to them, wake them, or inspect one read-only.'

/**
 * 同机多会话协作技能。
 *
 * ## 为什么做成 claude 内置（而不是像 GUI 那样投影到 ~/.claude/skills）
 *
 * 它讲的全是 **CLI 自己的能力**：`ListAgents` / `SendMessage` / `~/.claude/sessions`
 * / transcript jsonl / `--ide-mode --resume`。纯 CLI 用户开两个终端同样需要它。
 * （GUI 侧 `builtinSkills/` 的约定相反：那里只放 `desktop_*` 这类 GUI 独占的能力。）
 *
 * ## 为什么无条件注册
 *
 * 单会话用户多看一份技能索引的代价可以忽略；而需要它的场景（多开、多任务并行）
 * 恰恰是模型最容易"不知道自己能做什么"的时候。
 */
export function registerCrossSessionSkill(): void {
  registerBundledSkill({
    name: 'cross-session',
    description: DESCRIPTION,
    userInvocable: true,
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      if (args) {
        parts.push(`## User Request\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
