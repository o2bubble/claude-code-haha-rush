# 插件模板目录

**这不是插件** —— 是本仓库的插件脚手架参考，供写新插件时复制/裁剪。

## 为什么它不会被 GUI 当成插件

两条独立防线（改这个目录前请保持）：

1. 目录名以 `_` 开头（约定俗成：非插件目录）
2. **目录内没有 `plugin.json`** —— 扫描器读到清单失败即跳过该目录

> ⚠️ 因此：**不要在此目录放 `plugin.json`**（哪怕是模板改名的）。
> 清单模板叫 `plugin.json.template` 就是为了避开扫描。

## 里面有什么

| 文件 | 用途 |
|------|------|
| `AI_NOTES.template.md` | **给 AI 的排查/执行文档**（重点）。开工前先读它的「章节选用表」，按插件形态裁剪 |
| `README.template.md` | 给用户的插件说明（市场详情页正文） |
| `plugin.json.template` | manifest 骨架，含全部字段说明（JSONC 风格，复制后删注释） |

## 怎么用

### 新插件最小步骤

1. 建目录 `plugins/<新插件名>/`（**不要**用 `_` 前缀——那是保留给非插件目录的）
2. 复制 `plugin.json.template` → `plugin.json`，删注释、填字段
   （**注释务必删干净**——含行尾注释；JSON 不允许注释，残留会导致插件加载失败。
   自检：`python -c "import json;json.load(open('plugin.json',encoding='utf-8'));print('OK')"`）
3. 复制 `README.template.md` → `README.md`，填功能与用法
4. 复制 `AI_NOTES.template.md` → `AI_NOTES.md`，**按章节选用表裁剪**后填写
5. 实现插件代码（面板 html / 进程脚本），在 manifest 里声明
6. 参考现有三个插件作为实例：
   - `git-viewer` —— standard 插件，有面板 + 后台进程 + MCP 工具，零第三方依赖
   - `nodejs` —— ai-guided + `runtimes` 声明，AI 代装运行时（依赖落点知识的权威来源）
   - `playwright-mcp` —— ai-guided，纯配置型（写 `~/.claude.json` + 用户级大件）

### AI_NOTES 写作要点

- **写给 AI 排查/执行用**，不是营销文案 —— 聚焦"AI 拿到什么信号、按什么顺序做什么"
- **症状从用户视角描述**（"装了但面板没出现"），不是内部机制
- **幂等是硬要求**：AI 会被反复调用，安装节必须"已装且可用 → 直接跳过"
- **诚实写"X 是预期行为不是故障"** —— 减少 AI 的无效排查
- 建议 ≤ 4KB（AI 每次排查都读全文）；事实要有出处（实测过的机制才写死）

## 相关文档

- 插件系统通用指南（AI 读）：MCP 工具 `plugin_docs`（不带 `name`）——
  含目录布局、manifest schema、生命周期、排查清单
- 插件专属文档（AI 读）：`plugin_docs name=<插件名>` → 该插件的 AI_NOTES.md
- 发布：`python scripts/publish-plugin.py --manifest meta.yaml --zip <name>.zip --api-key <key>`
