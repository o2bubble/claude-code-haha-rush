# AI_NOTES — pointer（屏幕指示器 / 教鞭）

给 AI 用的**教鞭**：在用户屏幕上画箭头/方框/圆圈/文字，指给他「点这里」。

## 什么时候用

**用户问「XX 在哪」「怎么点」「我不会用」时** —— 别只用文字描述位置，**画给他看**。

标准闭环（三步）：
1. **查**：`gui-manual` 技能（用户问的是 GUI 功能时）—— 知道功能在哪个面板/菜单
2. **看**：截图工具（`computer-use` / `screenshot` 插件）—— 定位目标的**实际屏幕坐标**
3. **指**：本插件的 `point` 工具 —— 画出来

```
plugin_pointer_point({
  rects: [{ x: 1580, y: 42, w: 120, h: 36, label: "1" }],
  arrows: [{ fromX: 1400, fromY: 200, toX: 1600, toY: 80 }],
  labels: [{ x: 1200, y: 260, text: "① 先点这里的齿轮" }]
})
```

## 坐标（最容易错的地方）

**要传的是"该显示器内的物理像素"** —— 与截图工具同一坐标系：

```
point 的坐标 = 截图里的绝对坐标 − meta.monitorOrigin
```

- 截图工具返回的 `meta.monitorOrigin` 是**像素原点**（如 `{x:0,y:0}` 或 `{x:1920,y:0}`）
- **忘了减 origin 会偏到另一块屏幕**（多屏时最常犯）
- 换算细节见 `computer-use` 技能的 `references/coordinates.md`

## 关键参数

| 参数 | 说明 |
|---|---|
| `duration` | 停留秒数（默认 8；**0 = 不自动消失**，适合"等你照着做完"的多步操作） |
| `dim` | 默认 true = 压暗全屏、只留亮指示区域。**指"你要读的文字"时设 false**（压暗会看不清） |
| `monitor` | 画在哪块屏（默认主屏）。用截图的 `meta.monitorIndex` |
| `clear` | `true` = 只清除，不画新的 |

## 行为/故障模式

### 1. 画了但用户说"没看到"

- **多半是坐标跑到屏幕外了** —— 最常见的错误是**没减 `monitorOrigin`**（多屏时直接用了绝对坐标）
- 次常见：`monitor` 传的索引与实际不符（指示器画在另一块屏上）
- 自查：调完再截一次图，看指示器在不在目标位置

### 2. 指示器没消失 / 一直在

- `duration: 0` 是**故意不消失**（用于"等你操作完"）。用完记得 `clear: true`
- 若窗口卡住不关：宿主侧有超时兜底，但可 `clear` 一次强制收尾

### 3. 工具返回 ok 但屏幕没变化

- 覆盖层窗口可能没开起来 —— 看**工作进程**面板里 `pointer-server` 是否在跑
- 宿主 GUI **< 2026.09.18.2** 时不支持透明+穿透覆盖层 → 会开出**不透明**的窗口（挡住用户操作）。
  本插件依赖该版本；旧版 GUI 上请勿使用

### 4. 连续调用时屏幕闪

- **不该闪**：插件进程用 `/hello` `/bye` 握手记住"窗口开着"，后续调用**只更新数据**不重开窗
- 若闪：说明握手没生效（overlay 没成功 fetch 到 `/hello`）→ 查 `/health` 的 `overlayOpen`

## 日志与状态位置

- 无独立日志；进程 stdout/stderr 进 **GUI 日志**（`%APPDATA%/claude-code-gui/claude-code-gui.log`）
- 状态自查：`curl http://127.0.0.1:<port>/health` → `{ok, overlayOpen, count}`
  （端口在 GUI 日志里找 `[plugin:pointer-server stdout] PLUGIN_PORT=`）
- 数据：`GET /state`（overlay 轮询的就是它）

## 配置依赖

- dependencies: 无（**但实际使用建议配合 `computer-use` 或 `screenshot`** —— 不截图就不知道该指哪）
- installType: `standard`
- platforms: 未声明 = 全平台（透明覆盖层目前主要在 Windows 实测）
- 版本兼容: **需要宿主 ≥ 2026.09.18.2**（`open_plugin_overlay` 的 `transparent`/`clickThrough` 参数）
