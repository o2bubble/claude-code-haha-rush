import { isPDFSupported } from '../../utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// Use a string constant for tool names to avoid circular dependencies
export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'

// 官方 2.1.316 把「只读需要的部分」变成**默认**建议 —— 旧版（2.1.89 基线）
// 是"建议通读全文"。方向相反，而后者在长文件上会白白烧掉大量上下文。
// 两个常量都保留：GrowthBook 下发的 targetedRangeNudge 仍可切换。
export const OFFSET_INSTRUCTION_DEFAULT =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'

export const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  // ⚠️ 2026-11-04 精简（1779 → ~790 字符，对齐官方量级）。
  //
  // 删掉的都是**模型默认就会做 / 做了也没代价**的：
  //   · "Assume this tool can read all files… it's okay to read a file that does
  //     not exist" —— 模型本来就会直接试
  //   · "You will regularly be asked to read screenshots… ALWAYS use this tool"
  //     —— 传图片路径时没有别的工具可选
  //   · "can only read files, not directories" —— 读目录会直接报错
  //   · "empty contents → system reminder" —— 是通知不是行为指引
  //
  // 保留的是**会改变行为**的：绝对路径要求、默认读多少行、offset/limit 策略、
  // 图片/PDF/notebook 的能力边界（模型需要知道"我能读这些"才会去用）。
  return `Reads a file from the local filesystem.

- \`file_path\` must be an absolute path.
- Reads up to ${MAX_LINES_TO_READ} lines by default${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- Reads images (PNG, JPG, …) and presents them visually. Reads PDFs via the \`pages\` parameter (e.g. "1-5", max 20 pages/request; required for PDFs over 10 pages). Reads Jupyter notebooks (.ipynb) as cells with outputs.${
    isPDFSupported() ? '' : ` (PDF reading unavailable in this build.)`
  }
- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.
- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.`
}
