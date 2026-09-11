# 09 — ChartItem (uPlot) + GraphicItem (SVG) 内容子组件

**What to build:** 创建 `ChartItem.tsx` 和 `GraphicItem.tsx`

**ChartItem (uPlot):**
- [ ] uPlot 容器 `<div>` + 初始化/更新逻辑
- [ ] 支持 chartType: bar, line, pie, scatter
- [ ] 数据编辑 UI：简单 JSON 编辑 textarea（切换显示/隐藏）
- [ ] `useEffect` → `registerDataSource()` 注册 dataRegistry（keys 来自 data 结构）
- [ ] queryHandler: 按 key 返回数据集中的值
- [ ] opHandler: 支持 `update_data` 操作 → 更新 content.data → 图表重渲染

**GraphicItem (SVG):**
- [ ] 流程图模式：节点 (rect) + 边 (path with arrowhead)
- [ ] 思维导图模式：树形 SVG 布局（自顶向下）
- [ ] 拖拽节点 → 更新 definition
- [ ] 双击节点 → inline 编辑文本
- [ ] 右键菜单：添加节点、删除节点
- [ ] 自动布局按钮：重置节点位置为默认布局
- [ ] `useEffect` → `registerDataSource()` 注册 dataRegistry（keys: nodes, edges, structure）
- [ ] queryHandler: 按 key 返回节点/边数据
