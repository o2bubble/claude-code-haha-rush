# 11. 模型、Profile 与权限

### 11.1 模型下拉（工具栏）

- **是什么**：模型相关设置的统一入口——模型列表、思考模式、Effort 档位、Profile 管理。
- **怎么用**：点工具栏的模型名按钮：
  - 点某个 Profile 即切换（切换中显示「切换中…」，成功/失败有状态消息）；
  - 「思考模式」开/关（仅当模型支持 thinking/reasoning 时出现）；
  - 「Effort 强度」低/中/高/最大（仅支持的模型出现；不同模型可用档位不同）；
  - 底部「Profile 管理」打开管理面板。
- **来源**：`gui/src/components/Toolbar.tsx`（`ModelDropdown`、`ModelTuningSections`）

### 11.2 Profile 管理

- **是什么**：模型配置文件（用哪个服务、哪个模型、API Key、超时、上下文窗口、能力勾选）。
- **怎么用**：工具栏模型下拉 →「Profile 管理」，或在应用菜单里进。列表里每条可「切换 / 设为默认 / 编辑 / 删除（二次确认，会删对应 .env 文件）」；「新建 Profile」选服务商（或自定义）→ 填名称、API Key/Token、模型、MAX_TOKENS、上下文窗口、超时 → 「创建」。
  - 「模型能力」勾选决定后端发哪些请求参数（thinking / adaptive / effort / 最大 effort / reasoning），**不确定就留空**（按模型名默认判断），勾错可能导致请求参数发错。
- **来源**：`gui/src/components/chat/ProfileDialog.tsx`

### 11.3 权限模式

- **是什么**：控制 AI 执行操作的授权级别。
- **怎么用**：点工具栏的权限下拉，选：默认（仅危险操作询问）/ 接受编辑（自动批准文件编辑）/ 计划模式（先规划再执行）/ 绕过（自动批准所有）/ 不再询问（记住上次选择）。
- **来源**：`gui/src/components/Toolbar.tsx`（`PermModeDropdown`）

---
