# 用户反馈系统

**Status:** implemented (2026-07-28)

---

## Problem Statement

目前 GUI 没有用户反馈渠道。用户遇到 bug 或有改进建议时无处表达，开发者也无法系统性地收集和处理反馈。

## Solution

构建两层系统：
1. **反馈 API**（复用现有 skills-server）— 接收反馈、存储、查询、状态管理
2. **GUI 反馈弹窗** — Toolbar 入口按钮，浮动表单，选择类型/填写描述/上传截图，完全匿名

反馈数据全部公开（类似 GitHub Issues），用户和开发者都可以通过管理页面浏览。修改状态需要 API key 认证。

## User Stories

1. As a 用户, I want to 点击 Toolbar 上的反馈按钮打开反馈表单，so that 我能快速提交反馈
2. As a 用户, I want to 选择反馈类型（问题反馈 / 改进建议），so that 我的反馈能被正确分类
3. As a 用户, I want to 输入详细的文字描述并可选上传截图，so that 我能准确表达问题
4. As a 用户, I want to 上传截图时自动压缩到合适大小（1024px），so that 不会因图片过大导致上传失败
5. As a 用户, I want to 提交反馈时自动附带 GUI 版本号，so that 开发者知道问题发生在哪个版本
6. As a 用户, I want to 看到隐私警告提醒我对截图敏感数据打码，so that 我不会意外泄露隐私
7. As a 用户, I want to 提交后看到成功/失败提示，so that 我知道反馈是否发送成功
8. As a 用户/开发者, I want to 在浏览器中浏览所有已提交的反馈，so that 我能了解其他人的问题和建议
9. As a 开发者, I want to 通过管理页面标记反馈状态（待处理/处理中/已解决/已关闭），so that 我能管理反馈进度
10. As a 开发者, I want to 通过 API key 保护状态修改操作，so that 只有授权者可以修改

## Implementation Decisions

### 1. 部署架构
- 复用现有 skills-server（同一 FastAPI 进程，同一 8765 端口）
- 无需新端口、新进程、新 systemd service
- 反馈图片存储于 `skills-server/feedback-images/` 目录

### 2. 数据模型

**feedback 表**：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| type | TEXT | bug / suggestion |
| message | TEXT | 文字描述（max 5000 chars） |
| image_path | TEXT NULL | 图片文件名（UUID.ext） |
| app_version | TEXT | GUI 版本号 |
| status | TEXT | open / in_progress / resolved / closed |
| created_at | TEXT | ISO 8601 |

### 3. 安全性

**图片上传防护**：
- magic bytes 校验：仅允许 PNG/JPEG/GIF/WebP 的真实图片文件
- UUID 文件名，不保留原始文件名
- 大小限制 10MB
- 仅允许通过 `/api/feedback/images/` 静态路由访问，禁止目录遍历

**认证**：
- GET 端点公开（列表/详情/图片）
- PATCH 状态修改需 `X-API-Key` 头（复用已有的 API key 认证中间件）

**匿名性**：
- 不记录 IP、User-Agent 或任何用户身份信息
- 服务端日志不记录反馈内容

### 4. GUI 图片处理
- 读取图片：Tauri `invoke("read_bytes")` → base64 → `atob` → `Uint8Array`
- 压缩策略：Canvas 缩放至长边 1024px，转 JPEG quality 0.85
- 预览：`URL.createObjectURL(blob)`
- 原因：`@tauri-apps/plugin-fs` 在 WebView2 中读取二进制不直接支持

### 5. 管理页面
- 单文件 HTML：`skills-server/static/admin.html`
- 路由：`GET /admin` → `FileResponse`
- 无需构建工具，纯 HTML/CSS/JS
- 公开浏览 + API key 修改状态
- 点击图片放大查看

## API Reference

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/feedback` | 无 | 提交反馈（multipart: type, message, app_version, image?） |
| GET | `/api/feedback` | 无 | 列表（?status=&offset=&limit=） |
| GET | `/api/feedback/{id}` | 无 | 单条详情 |
| PATCH | `/api/feedback/{id}?status=xxx` | API key | 修改状态 |
| GET | `/api/feedback/images/{filename}` | 无 | 查看图片 |

## File Manifest

### Server（skills-server/）
- `server/models.py` — feedback 表 + CRUD 函数
- `server/routes.py` — 5 个反馈端点 + 图片校验
- `main.py` — `/admin` 路由 + `feedback-images/` 目录创建
- `static/admin.html` — 管理页面

### GUI（gui/src/）
- `services/feedbackService.ts` — 反馈 API 客户端
- `components/chat/FeedbackDialog.tsx` — 反馈表单（含图片压缩、隐私警告、浏览链接）
- `services/panelDefs.tsx` — 注册 feedback 面板（userManaged: false）
- `components/Toolbar.tsx` — 🐛 按钮 + `openFeedbackFloat()`
- `utils/icons.tsx` — feedback icon (Bug)
- `i18n/zh.ts` + `en.ts` — 10 个 feedback.* key
- `stores/settingsStore.ts` — `_version` 字段（`1.0.0-preview`）
- `src-tauri/capabilities/default.json` — `shell:allow-open` 权限
