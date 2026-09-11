# 21 — FileGroupItem 懒加载目录树

**What to build:** FileGroupItem 从平铺列表改为可展开的懒加载文件树。初始只显示第一层，目录可点击展开/折叠，按需 `read_dir` 加载子节点。

**Why:**
- 当前 paste/drop 目录后只枚举一层平铺展示，嵌套目录以 📁 图标显示但无法进入
- 用户需要能逐层展开浏览目录结构，类似文件面板的交互

**Changes:**

### 1. `FileGroupItem.tsx` — 重写为树组件

- 初始渲染第一层条目
- 目录行添加 `▶`/`▼` 切换按钮
- 点击 `▶` → `invoke("read_dir", { path })` 懒加载 → 插入子节点
- 子节点缩进 16px，递归支持展开
- 展开状态存 `useState<Set<string>>`（路径集合）
- 保持每行的 `→ Agent` 按钮
- "Send All" 按钮仅发送当前已加载可见的文件（不包含未展开子目录内的文件）

### 2. 不需要改的文件

- `types/desktop.ts` — FileGroupContent 结构不变
- `SuperDesktopCanvas.tsx` — paste/drop 创建逻辑不变
- `DesktopItemView.tsx` — 注册不变

**Verification:**
- [ ] paste 目录 → 显示第一层，目录项有 ▶ 按钮
- [ ] 点击 ▶ → 展开子条目，按钮变为 ▼
- [ ] 点击 ▼ → 折叠
- [ ] 嵌套目录的展开/折叠正常
- [ ] 每行的 → Agent 按钮正常发送 ref chip
- [ ] Send All 只发送当前可见文件
