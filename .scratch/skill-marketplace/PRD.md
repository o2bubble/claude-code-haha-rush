# Skill Marketplace — 在线技能市场

**Status:** implemented

---

## Problem Statement

当前 Claude Code 的技能（Skills）安装完全依赖手动操作：用户需要找到技能目录、通过 npm/git 等命令行工具获取文件、再手动放置到 `~/.claude/skills/` 目录下。这对不熟悉命令行的用户门槛极高，也阻碍了技能生态的分享和传播。

## Solution

构建一个两层系统：
1. **在线技能注册服务**（Python FastAPI）— 托管技能包，提供浏览/搜索/下载 API
2. **GUI 内置技能市场** — SkillsPanel 新增"在线库"Tab，浏览在线技能包，一键安装到本地 `~/.claude/skills/`

技能以"包（Package）→ 技能（Skill）"层级组织，用户可安装整个技能包或选择其中单个技能。

## User Stories

1. As a 普通用户, I want to 在 GUI 的技能面板中切换到一个"在线库"标签页，so that 我可以浏览社区分享的技能
2. As a 普通用户, I want to 看到技能包的名称、描述、作者、标签、包含技能数、下载量，so that 我能判断哪些技能值得安装
3. As a 普通用户, I want to 展开一个技能包查看里面包含的所有技能，so that 我了解安装后能得到哪些具体功能
4. As a 普通用户, I want to 点击"安装"按钮一键安装某个技能，so that 我不需要手动操作命令行
5. As a 普通用户, I want to 点击"安装全部"按钮一次性安装整个技能包，so that 我能快速获取一组相关技能
6. As a 普通用户, I want to 看到安装进度反馈（按钮状态变化 + 成功/失败通知），so that 我知道安装是否完成
7. As a 普通用户, I want to 已安装的技能在在线库中显示为"已安装"状态，so that 我不会重复安装
8. As a 普通用户, I want to 安装完成后技能自动出现在"已安装"列表中，so that 我可以立即使用新技能
9. As a 技能作者, I want to 通过 API 上传技能包（manifest + SKILL.md + 辅助文件），so that 我可以分享自己的技能给社区
10. As a 管理员, I want to 通过 API key 控制上传权限，so that 只有授权用户可以发布技能包
11. As a GUI 用户, I want to 在设置中修改技能注册服务器的 URL，so that 我可以切换到不同的技能源
12. As a 普通用户, I want to 在加载失败时看到错误信息和重试按钮，so that 我知道服务不可用并能手动重试
13. As a 普通用户, I want to 技能名称和描述支持中文翻译，在线浏览时就能看到中文，so that 语言不是障碍
14. As a 普通用户, I want to 安装技能后翻译自动合并到本地，打开技能对话框也能看到中文描述，so that 全链路体验一致
15. As a 普通用户, I want to 悬停截断的描述文字时看到完整内容，so that 我不需要打开面板才能看全
16. As a 技能作者, I want to 上传翻译文件（zh.json）到技能包，so that 用户安装后自动获得本地化体验

## Implementation Decisions

### 1. Web 服务技术栈
- **Python FastAPI + SQLite** — 简单、性能满足需求
- 端口 8765，CORS 全开
- 技能文件存储在 `skills-store/<slug>/` 目录下
- 首次启动自动生成随机 API key 打印到控制台
- 依赖：`fastapi`, `uvicorn`, `python-multipart`, `pyyaml`

### 2. 部署方案
- 最终采用 **Python venv + systemd** 部署，而非 Docker
- 原因：阿里云服务器无法稳定访问 Docker Hub，国内镜像也不可靠
- 服务器：123.56.66.84 (阿里云 北京)
- 安全组放行 TCP 8765

### 3. 技能传输格式
- 目录打包为 `.zip` 传输
- 服务端按标准 Claude Code 格式存储：`<skill-name>/SKILL.md` + 辅助文件
- 服务端额外有 `manifest.yaml` 描述包元数据

### 4. 元数据管理
- 上传者手动填写 `manifest.yaml`：name, description, author, version, tags
- 服务端不引入 LLM — 外部预处理后再提交
- 技能包的 `skill_count` 从解压后的目录结构自动计算

### 5. 安装目标
- 仅安装到用户级 `~/.claude/skills/`，不涉及项目级 `.claude/skills/`
- 安装即覆盖（同名技能直接替换）

### 6. 安装流程
- 前端 `fetch()` 下载 zip → Tauri `invoke("install_skill")` → Rust 端 `reqwest::blocking` 重新下载到临时目录 → `zip` crate 解压 → 移动到 `~/.claude/skills/<name>/`
- 安装完成后前端调用 `requestPluginRefresh()` 触发 CLI 重载技能列表
- 同时自动拉取翻译并合并到本地 `skills-i18n.json`

### 7. 认证策略
- 浏览/下载：公开，无需认证
- 上传：需要 `X-API-Key` 请求头
- API key 在服务端数据库中 SHA256 哈希存储

### 8. GUI 集成方式
- SkillsPanel 顶部加 Tab 栏："已安装" | "在线库"
- "已安装" Tab 保持现有功能不变
- "在线库" Tab 是全新的 `MarketplaceTab` 组件
- 设置面板有独立的"技能"分类 Tab，包含技能库地址配置

### 9. 已安装检测
- 通过 Rust 命令 `get_skills_dir` + `read_dir` 获取 `~/.claude/skills/` 子目录名
- 与在线技能名比对，匹配则显示"已安装"

### 10. 翻译系统
- 服务端：每个包可选 `translations/<lang>.json`（如 `zh.json`），格式为 `{"/skill-name": {"title": "中文", "desc": "描述"}}`
- API 端点：`GET /api/packages/{slug}/translations/{lang}` + `GET /api/packages/{slug}/translations`
- 包详情响应包含 `translations` 字段标注可用语言
- GUI 在线库：展开包时自动拉取翻译并显示中文名称和描述
- GUI 安装时：自动将翻译合并到本地 `skills-i18n.json`
- SkillDialog：打开时从本地 i18n 加载翻译显示中文描述

### 11. 命令名展示约定
- 命令名保持原始 `/command-name` 格式，不翻译
- 中文标题作为补充显示在命令名旁边

### 12. 布局优化
- 技能列表项使用 flex 布局：命令名（不缩放）+ 描述（可截断）+ 操作按钮（固定宽度）
- 描述使用 `min-width: 0` 保证 flex 截断生效
- 操作区域统一 `min-width` 避免"安装"/"已安装"布局跳动
- 所有截断描述添加 `title` 属性支持悬停查看完整内容

### 13. Rust 新增命令
- `get_skills_dir` — 获取技能目录路径
- `install_skill` — 下载并安装单个技能
- `install_package` — 下载并安装整个包
- `delete_skill` — 删除已安装技能
- 新增依赖：`zip = "0.6"`, `reqwest = { version = "0.12", features = ["blocking"] }`

### 14. 设置持久化
- `AppSettings` 新增 `skillRegistryUrl` 字段（TypeScript + Rust 双端同步）
- 默认值 `"http://123.56.66.84:8765"`
- SettingsPanel "技能"分类下可修改
- Rust 启动时自动迁移：检测到 `localhost` URL 自动替换为云地址

### 15. 文件清单

**新建：**
- `skills-server/` — Python FastAPI 服务（6 文件）
- `gui/src/services/skillMarketplace.ts` — API 客户端
- `gui/src-tauri/` — Cargo.toml + lib.rs（4 命令 + 迁移逻辑）

**修改：**
- `gui/src/components/chat/SkillsPanel.tsx` — Tab + MarketplaceTab + 翻译 + 布局
- `gui/src/components/chat/SkillDialog.tsx` — 翻译加载 + 中文展示
- `gui/src/components/chat/SettingsPanel.tsx` — "技能"分类 Tab
- `gui/src/stores/settingsStore.ts` — skillRegistryUrl 字段
- `gui/src/i18n/zh.ts` + `gui/src/i18n/en.ts` — 20+ marketplace key

## API Contract

### Response envelope
```json
{"ok": true, "data": {...}}
{"ok": false, "error": "message"}
```

### GET /api/packages
返回所有包摘要列表，按下载量降序。

### GET /api/packages/{slug}
返回包详情 + 所含技能列表（从文件系统读取 SKILL.md 的 YAML frontmatter）。
响应包含 `translations` 字段（可用语言列表）。

### GET /api/packages/{slug}/download
返回整个包目录的 zip 流，Content-Type: `application/zip`。

### GET /api/packages/{slug}/skills/{name}/download
返回单个技能目录的 zip 流。

### GET /api/packages/{slug}/translations
列出可用翻译语言。返回 `{"ok": true, "data": ["zh"]}`。

### GET /api/packages/{slug}/translations/{lang}
返回指定语言的翻译 JSON，格式与 skills-i18n.json 一致：
```json
{"/skill-name": {"title": "中文标题", "desc": "中文描述"}}
```

### POST /api/packages (需要 X-API-Key)
Multipart: `manifest` (YAML 文本) + `skills` (zip 文件)。
自动从 name 生成 slug（小写、空格转连字符、去特殊字符）。

## Schema

### packages 表
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| slug | TEXT UNIQUE NOT NULL | URL 标识 |
| name | TEXT NOT NULL | 显示名称 |
| description | TEXT | |
| author | TEXT NOT NULL | |
| version | TEXT NOT NULL | semver |
| tags | TEXT | JSON array |
| download_count | INTEGER DEFAULT 0 | |
| skill_count | INTEGER DEFAULT 0 | |
| created_at | TEXT | ISO datetime |
| updated_at | TEXT | ISO datetime |

### api_keys 表
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| key_hash | TEXT UNIQUE NOT NULL | SHA256 |
| label | TEXT | |
| created_at | TEXT | ISO datetime |

### manifest.yaml 格式
```yaml
name: "Python Utilities"
description: "Python 开发辅助技能集合"
author: "Alice"
version: "1.2.0"
tags:
  - python
  - development
  - testing
```

### translations/zh.json 格式
```json
{
  "/code-review": {
    "title": "代码审查",
    "desc": "从两个维度审查代码变更..."
  }
}
```

## Testing Decisions

### 测试接缝（seams）
1. **HTTP API 层** — `pytest` + `httpx` / `curl` 直接测 REST 端点
2. **Rust 命令层** — Tauri invoke 边界，输入（URL + 技能名）→ 输出（文件系统状态）
3. **前端服务层** — `skillMarketplace.ts` 是 UI 和 API 之间的接缝，可 mock 测试 UI
4. **GUI 组件层** — SkillsPanel Tab 状态切换，"已安装" vs "在线库" 视图

### 测什么
- API 返回正确的 JSON 结构和状态码
- zip 下载内容完整可解压
- Rust 命令在文件系统中正确创建/删除技能目录
- 前端在加载中/错误/成功/空数据等各种状态下的渲染
- 安装按钮的状态转换：安装 → 安装中 → 已安装
- 翻译端点的 CRUD
- 翻译合并逻辑

### 不测什么
- Python 标准库 `zipfile` / `sqlite3` 的内部实现
- `reqwest` / `zip` crate 的内部逻辑
- CSS 样式细节
- 服务的高并发性能

## Out of Scope

- **搜索/筛选** — v1 只做列表展示，不做关键词搜索或标签筛选
- **技能版本管理** — 不支持升级/降级，安装即覆盖
- **依赖管理** — 不处理技能之间的依赖关系
- **用户评价/评分** — 没有评分系统
- **安装进度条** — 仅用按钮状态文字反馈（安装中...）
- **OAuth/用户系统** — 仅用 API key 做简单的写保护
- **HTTPS/生产部署** — v1 只支持 HTTP
- **技能卸载的 UI** — Rust 命令有 `delete_skill`，但前端先不加卸载按钮

## Published Content

### Matt Pocock Skills (22 skills)

| 包名 | Slug | 技能数 | 描述 |
|------|------|--------|------|
| Engineering Skills | `matt-pocock-engineering-skills` | 17 | 日常编码工作流：代码审查、写SPEC、实现、原型、调试诊断等 |
| Productivity Skills | `matt-pocock-productivity-skills` | 5 | 非编码效率工具：设计追问、会话交接、教学、技能编写等 |

来源：https://github.com/mattpocock/skills — promoted buckets (engineering + productivity)

## Further Notes

- 技能重载双重保障：主动 `requestPluginRefresh()` + 被动 chokidar 文件监听
- Rust `AppSettings` struct 新增字段必须带 `#[serde(default)]`，否则 layout 自动保存会覆盖为默认值（历史教训：permissionMode）
- `cargo check` 验证后再启动 GUI，Rust 编译错误会阻塞整个 Tauri 构建
- Web 服务是可独立运行的组件，不依赖 GUI
- 服务管理：`systemctl status/restart skills-registry`
- 日志查看：`journalctl -u skills-registry -f`
- 服务器重启后服务会自动启动（systemd enable）
