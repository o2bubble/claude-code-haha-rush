# 17 — ChartItem + GraphicItem 转为 AI 驱动纯展示组件

**What to build:** 移除用户手动编辑 UI，内容由 AI 通过 data registry 的 `opHandler.update_data` 管理。用户只查看 + 必要微调。

**Status:** completed

**ChartItem:**
- [x] 移除 chart type 选择器
- [x] 移除 Edit Data 按钮 + JSON textarea + Apply 按钮
- [x] 移除 editing/jsonText state 和 handleSaveJson
- [x] 仅保留 uPlot 渲染 div
- [x] data registry `opHandler.update_data` 支持 `{ data }` 更新

**GraphicItem:**
- [x] 移除 +Node / Delete Node 按钮
- [x] 移除 Flowchart/Mind Map 类型选择器
- [x] 移除 Example 按钮
- [x] 移除双击标签编辑
- [x] 移除箭头节点和外边框渲染冗余
- [x] 保留：SVG 渲染 + 节点拖拽 + Auto Layout 按钮 + SVG 缩放/平移
- [x] 简化为 ~180 行纯展示代码
- [x] data registry `opHandler.update_data` 支持 `{ nodes, edges }` 更新

**字体统一:**
- [x] 内容块内所有 UI 字体从 11px → 12px，10px → 11px
- [x] 按钮/下拉框 padding 统一加大
