// Content for the cross-session bundled skill.
//
// ⚠️ `with { type: 'text' }` 不能省。裸 `import x from './x.md'` 在本仓库的
// Bun 版本下会走**Markdown → HTML** 的 loader：frontmatter 的 `---` 变成
// `<hr />`、`## 标题` 变成 `<h2>`，技能正文会变成一堆 HTML 标签。
//
// （`verifyContent.ts` 就踩了这个坑 —— 它只对 USER_TYPE=ant 注册，所以一直
// 没人发现。改它之前先确认 verify 技能确实需要原文。）

import skillMd from './cross-session/SKILL.md' with { type: 'text' }

export const SKILL_MD: string = skillMd
