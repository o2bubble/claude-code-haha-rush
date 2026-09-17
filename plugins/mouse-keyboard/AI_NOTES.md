# AI_NOTES — 鼠标键盘插件

给 AI 的排障文档。**动手改之前先读完**，这里记的都是踩过的坑。

## 概览

- **贡献**：1 个面板（状态/急停/测试区）、1 个 MCP 工具 `plugin_mouse_keyboard_control`、
  1 个后台进程 `mouse-keyboard-server`（Node，`server.cjs`）
- **原生依赖**：`vendor/win32-x64/` 里两个预编译 `.node`（robotjs / koffi），
  **直接 `require` 二进制文件**，不走 npm、不需要 node_modules
- **平台**：仅 Windows（manifest `platforms: ["windows"]`）

## 端口 / 日志 / 状态

- 端口：`PLUGIN_PORT=` 打印在 **stdout 第一行**（也是唯一一行；宿主读完就停读 stdout，
  之后写 stdout 会 EPIPE —— 日志一律走 stderr）
- 日志：stderr（宿主收进进程状态）
- 状态：`GET /status`（急停态 / 鼠标位置 / 按住的键 / 急停键配置）
- 端点：`POST /__mcp`（AI 工具，固定契约 `{tool, args, settings}`）、
  `/abort`、`/resume`、`/release`、`PUT /settings`

## 故障模式

### 1. 装完 AI 看不到工具 / 调用报「未知工具」
- **工具表在会话加载时刷新** → 装完/启用后**重开会话**（或让 AI 跑 `/mcp-refresh`）
- 进程没起：`startOn: workspace_bound` —— **未绑工作区时进程不启动**
- 直接验证插件侧（绕开宿主）：
  ```bash
  curl -X POST http://127.0.0.1:<port>/__mcp -H "Content-Type: application/json" \
    -d '{"tool":"control","args":{"action":"screen_info"}}'
  ```

### 2. 启动即失败 / 日志报「原生库加载失败」
`vendor/<platform>/` 里缺对应的 `.node`。当前只附带 **win32-x64**。

要加平台：从 npm 包拷对应预编译件（robotjs 的在 `prebuilds/<platform>/node.napi.node`，
koffi 的在 `@koromix/koffi-<platform>/`），放进 `vendor/<platform>/`，
文件名保持 `robotjs.node` / `koffi.node`。

### 3. 🔴 用了 robotjs 的 scrollMouse → 滚轮没反应（**已修，别改回去**）
**实测数据**：`robot.scrollMouse(0, -1)` 连发多次，目标窗口的 `<MouseWheel>` 事件数
**保持 0**、内容纹丝不动；而自己用 SendInput 发一次就生效。

两个原因叠加：
1. robotjs 把 `mouseData` 直接设成 ±1，而 **Windows 标准一格是 `WHEEL_DELTA = 120`**
2. 上面那条还只是"量太小"，实测连事件都没送达

所以滚轮**用 koffi 自己发 SendInput**（见 `w32.sendWheel`）。附带两个好处：
用标准 120、拿得到 SendInput 返回值（被 UIPI 拦截时返回 0，能如实上报而不是假装成功）。

**符号要取反**：Windows 原生约定是"正 delta = 向上/向左"，而工具面向 AI 的语义是
"正 dy = 向下、正 dx = 向右"（robotjs 也是这个约定）。实测踩过：不取反会把
"向下滚 3 格"变成滚回顶部。

### 4. 滚轮测试时"没反应"—— 先查**窗口焦点**
实测教训：从终端跑 curl 验证滚动时，**终端窗口抢了焦点**，目标窗口收不到滚轮消息，
表现为"滚轮完全无效"。把目标窗口 `AppActivate` 到前台后立刻生效。

> 滚轮消息虽然理论上发给光标下的窗口，但**很多应用（含 tkinter）要求自己是活动窗口**
> 才处理。测试滚动类功能时务必先激活目标窗口。

### 5. 按键报 `Invalid key flag specified.`
**robotjs 的参数陷阱**：`keyTap(key, undefined)` 会走"解析 flags"分支 →
`GetFlagsFromValue(undefined)` 返回 -2 → 抛这个错。
**没有修饰键时必须少传一个参数**，不能传 `undefined` 占位（见 `actKey` 里的 `hasMods` 分支）。

另：修饰键名 robotjs 只认 `control`（不是 `ctrl`），键名是 `escape`（不是 `esc`）。
`actKey` 里有别名表做翻译，**别删** —— AI 与人都会用更自然的写法。

### 6. 点击"成功"但目标没反应
- **前台窗口是本应用** → 被防护拦了（返回里有明确说明，不是 bug）
- **目标是管理员权限窗口** → UIPI 静默拦截。`actMove` 会在鼠标没到位时给出 warning；
  click 的拦截靠 `sendWheel` 那类返回 0 判断
- **坐标算错**：屏幕坐标系是**虚拟桌面绝对坐标**；tkinter 的 `winfo_rooty()` 返回
  **客户区**顶部（不含标题栏），拿它当窗口顶部会偏 ~31px。用 `GetWindowRect` 才准。

### 7. 急停不生效
- **急停检测只在长操作循环里**（`drag` 每步、`type` 每字符）—— 短操作（一次 click）
  来不及按，这是设计
- 组合键要**全部按住**（`GetAsyncKeyState` 要求每个键的高位都是 1）
- 键名改错 → `parseHotkey` 返回 null → 面板会显示"急停键无效"
- 验证手法（可复用）：用 `temp/press_hotkey.cjs` 那套 koffi SendInput 注入键盘事件，
  **注入的按键 `GetAsyncKeyState` 能读到**（实测 0x8001）——可以用它做自动化测试

### 8. 批量（sequence）相关的行为，别误会成故障
- **`stopped: "budget"`**：不是失败，是"快撞宿主 10 秒超时了，主动停下"。
  宿主硬超时是 `gui/src-tauri/src/mcp.rs` 的 `recv_timeout(10s)`；超了宿主返回
  timeout 而**插件其实还在做** → AI 会误判失败并重做。所以这里自己掐 8s 预算
  （`SEQ_BUDGET_MS`），留 2s 给协议往返。
- **`remaining` 里的 `repeat` 是"剩余次数"不是原始值**：停在半途时会把
  `repeat:200` 改写成 `repeat:71`（已做 129 次）—— 见 `seqStop` 的 `halfStep` 参数。
  不这么改，AI 直接重发就会把已做过的再做一遍。**改这块代码时别把这个修正弄丢**。
- **`failedStep` 是 1-based**，等于 `results.length + 1`。
- **`executed` 是动作数（repeat 展开后），不是步数**；要步数看 `steps`。
  别拿 `executed` 和 `steps` 比（3 步各 repeat 5 会显示 7/4 这种看着像 bug 的数）。
- **sequence 里不允许嵌套 sequence**（防失控），但**允许 `abort`**（安全出口）。

### 9. 🔴 批量里每一步都要重新过 guard（别改成只查一次）
`actSequence` 在**每次重复**前都调 `guard(step.action)`。这不是冗余：
执行途中前台窗口可能变成宿主（弹出了工具权限确认框），后续步骤**必须被拦** ——
这正是防"AI 一边调工具弹确认框、一边点允许给自己授权"的机制。
实测验证过：第 1 步点击把靶子带到前台后，第 2 步立刻被拒。

改成"开头查一次"会让长序列在中途弹框后继续操作那个框。

### 10. 🔴 逐项绑定 Win32 API，不要一把 try 包住
曾因一个笔误（`u.func` 应为 `user32.func`）导致**整个 w32 为 null** ——
前台防护、急停轮询、滚轮**全部静默降级**（只打了一行日志，功能看着"能用"但防护没了）。
现在 `bind()` 逐项独立 try，一项失败不影响其它，并在启动日志里报"已绑定 N 项"。

## 测试手法（可复用，工具就在 `test/`）

- **靶子窗口**：`test/target.py <state_file>` —— tkinter 窗口，带按钮/输入框/可滚动区，
  持续把**自身状态与控件绝对坐标**写进 state 文件。
  于是点击/输入/拖拽/滚动的验证都是**读回真实状态**判定（点了几次、内容是什么、
  窗口移到哪、滚动到哪），不靠"看起来成功了"
- **假宿主**：`CLAUDE_PLUGIN_HOST_PID=<某窗口的 PID>` 启动进程，把那个窗口当"宿主"，
  验证前台防护
- **注入按键**：`test/press_hotkey.cjs down|up [ms]` —— koffi SendInput 按住/释放组合键
- **读键状态**：`GetAsyncKeyState(vk) & 0x8000` 判断某键是否按下 —— 验证 hold 与 release
  （实测：**SendInput 注入的按键 GetAsyncKeyState 能读到**，所以急停可以自动化测试）

## 设计要点（改代码前先理解）

- **坐标**：虚拟桌面绝对像素（robotjs 用 `MOUSEEVENTF_VIRTUALDESK`）；
  与截屏插件换算 = `绝对 = 该显示器 (x, y) + 图内坐标`
- **`INPUT.size` 必须 = 40**（x64/arm64）——cbSize 传错 SendInput 直接失败
- **中文输入**：按 **UTF-16 码元**（`charCodeAt`）逐个 `unicodeTap`，
  不能按码点（`wScan` 是 WORD，非 BMP 字符会被截断成垃圾）；按码元天然处理代理对
- **急停后不自动恢复** —— 用户的"我已经停了"必须是可预测的
