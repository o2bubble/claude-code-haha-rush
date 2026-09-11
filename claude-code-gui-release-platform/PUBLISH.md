# 技能发布指南

## 快速开始

```bash
# API 地址
REGISTRY="http://123.56.66.84:8765"
# 上传密钥：真实值见 .private/api-keys.md（该目录已 gitignore）
API_KEY="<上传密钥>"

# 上传技能包
curl -X POST "$REGISTRY/api/packages" \
  -H "X-API-Key: $API_KEY" \
  -F "manifest=@manifest.yaml" \
  -F "skills=@skills.zip"
```

## 技能包结构

```
my-skills.zip
└── <skill-1>/
    ├── SKILL.md           # 必需：Claude Code 标准技能文件（YAML frontmatter + Markdown）
    └── helper/            # 可选：辅助文件（脚本、模板等）
└── <skill-2>/
    └── SKILL.md
```

zip 解压后，每个包含 `SKILL.md` 的子目录会被识别为一个技能。

## manifest.yaml 格式

```yaml
name: "技能包名称"
description: "简短的包描述"
author: "作者名"
version: "1.0.0"
tags:
  - 分类1
  - 分类2
```

`name`、`author`、`version` 为必填字段。`slug` 由 `name` 自动生成（小写+连字符）。

## 翻译（可选）

在技能包目录下创建 `translations/zh.json`，安装时自动合并到用户本地翻译：

```json
{
  "/my-skill": {
    "title": "我的技能",
    "desc": "这是一个技能的简短中文描述"
  }
}
```

或者通过 API 单独上传翻译到已发布的包（需 API key）。

## API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/packages` | 无 | 列出所有包 |
| GET | `/api/packages/:slug` | 无 | 包详情 |
| GET | `/api/packages/:slug/download` | 无 | 下载整个包(zip) |
| GET | `/api/packages/:slug/skills/:name/download` | 无 | 下载单个技能(zip) |
| GET | `/api/packages/:slug/translations` | 无 | 列出可用翻译语言 |
| GET | `/api/packages/:slug/translations/:lang` | 无 | 获取翻译 JSON |
| POST | `/api/packages` | API key | 上传新包 |

## 注意事项

- **命令名不可翻译**：翻译 JSON 中的 `title` 仅作为显示补充，命令名 `/cmd` 始终保留英文
- **SKILL.md 必须有 frontmatter**：建议至少包含 `name` 和 `description` 字段
- **同名 slug 不可重复上传**：如需更新，需先联系管理员删除旧包
- **API key**：联系服务器管理员获取
