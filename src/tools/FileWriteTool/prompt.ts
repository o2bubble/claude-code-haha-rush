export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = 'Write a file to the local filesystem.'

// ⚠️ 2026-11-02 精简（官方 2.1.316 同名工具仅 240 字符）。
// 保留的两条都有实际后果：不先读就覆盖会失败；局部改动走 Edit 才只发 diff。
// "别创建 .md / 别加 emoji" 已由系统提示覆盖，这里不再重复。
// Read-first 规则由工具运行时强制（FileWriteTool 自身会校验），提示里只需说明后果。
export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.`
}
