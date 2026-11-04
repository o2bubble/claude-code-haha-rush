import { isCompactLinePrefixEnabled } from '../../utils/file.js'

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + arrow'
  const minimalUniquenessHint =
    process.env.USER_TYPE === 'ant'
      ? `\n- Use the smallest old_string that's clearly unique — usually 2-4 adjacent lines is sufficient. Avoid including 10+ lines of context when less uniquely identifies the target.`
      : ''
  // ⚠️ 2026-11-02 精简（官方 2.1.316 同名工具 360 字符）：只保留
  // 「先读」「缩进要按行号前缀之后的内容匹配」「old_string 必须唯一」三条 ——
  // 每条都对应一个会让调用失败的实际原因。别建新文件 / 别加 emoji 由系统提示覆盖。
  return `Performs exact string replacement in a file.

- You must Read the file in this conversation before editing, or the call will fail.
- \`old_string\` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (${prefixFormat}) before matching.
- \`replace_all: true\` replaces every occurrence.${minimalUniquenessHint}`
}
