# 02 — 引用解析器与格式化器

**What to build:** `gui/src/utils/referenceParser.ts` — 解析文本中的 `@ref{...}` 语法，以及反向格式化。

**Blocked by:** 01 — Reference 类型定义

**Status:** ready-for-agent

- [ ] `parseReferences(text: string): ParsedReference[]` — 正则提取 `@ref{type:path[:range][|label]}`，返回带位置的引用列表
- [ ] `formatReference(ref: Reference): string` — 将 Reference 序列化为 `@ref{...}` 字符串
- [ ] 正则使用 `/@ref\{([^}]+)\}/g` 全局匹配，捕获组内部按 `:` 切割解析
- [ ] 健壮性：格式错误时跳过不 crash，`:` 和 `|` 在 path 中的转义处理
- [ ] Unit test 覆盖：基本 file/dir/line、带 label、带行范围、格式错误、多个引用混合

**实现说明：**
- 解析顺序：先找 `|label`（最后一个 `|`），再按 `:` 切分 `type:path:range`
- range 格式：`:42` 或 `:10-20`
- path 如果含 `:` 或 `|`，用户需在 label 中提供可读名称，path 用 URI 编码
