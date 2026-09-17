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

### 0. 🔴 输入锁定（AI 独占键鼠）—— 四个坑

AI 用工具参数 `lock` 声明独占时，插件用**低级钩子**（`WH_KEYBOARD_LL` / `WH_MOUSE_LL`）
吞掉用户的**物理**输入，同时放行**注入**输入（`LLKHF_INJECTED` / `LLMHF_INJECTED` 标志区分）。
逃生键 **Ctrl+Q**。改这块最容易踩的四处：

#### ① 钩子回调里未定义的常量会被 try/catch 静默吞掉

回调里用了 `WM_KEYDOWN` 等消息常量却没在文件里定义（只在测试脚本里有）→ 每次回调抛
ReferenceError → 被 catch 吞掉 → 走到 `callNextHookEx` → **事件既不吞、也不检测逃生键**。
表现极具迷惑性：钩子装上了、事件计数器还在涨、日志里只有一行"键盘钩子异常"。

**所以**：回调的 catch 里必须 `log(完整堆栈)` **并把异常计入 stats**（`/activity` 的
`hookEvents.kbErrors` 可见）—— 否则"锁定失效"会伪装成"什么都没发生"。

#### ② 被吞掉的按键**读不到** `GetAsyncKeyState`

逃生键早期实现是 `GetAsyncKeyState(Q) && GetAsyncKeyState(Ctrl)` —— 在锁定时**必然失效**，
因为被钩子吞掉的键不会进入系统键状态表。
**改法**：钩子自己跟踪 Ctrl 状态（keydown/keyup 维护一个 Set）。未锁定时没有钩子，
才用 `GetAsyncKeyState`（`checkAbort` 里轮询）。

#### ③ 续期绝不能挂在只读接口上

`/activity` 是指示窗每 250ms 轮询的只读接口。曾经在里面 `renewLock()` → **租约永远不过期**
（实测 `remaining` 恒为 10000ms 不减少），"忘了解锁自动解开"的兜底直接失效。
**改法**：续期独立成 `/lock/renew`，且服务端**再校验一次"AI 真的在活跃"**（用进程自己的
`lastActivityAt`，请求方无从伪造）。

#### ④ 探针必须自证可用，否则"被吞"是假象

验证"输入被吞"时我用裸 `SendInput`（只给 VK、无 scan code）发按键 —— 它**本来
就进不去 tkinter**，于是"内容没变"被误读成"被吞了"。同理 robotjs 的 `keyTap` 也进不去
那个窗口。**改法**：用**插件自己的 `type`/`click` 工具调用**当探针（测试模式下注入=物理，
判定路径完全相同），并加一条**基线自检**（未锁定时探针必须能进）+ 一条**解锁后恢复**的对照。

#### 其他事实（备查）

- `BlockInput(TRUE)` **实测返回 false**（要求调用线程是前台线程）→ 不可用，且它不区分
  输入来源、会把 AI 自己也锁住。低级钩子是唯一选择，且**失败方向安全**：回调超时
  （`LowLevelHooksTimeout`）系统会忽略钩子、进程退出自动卸载。
- 钩子回调在**安装它的线程**上执行，该线程必须抽 Win32 消息。Node 事件循环不抽 →
  用 `setInterval(4ms)` 里 `PeekMessage(PM_REMOVE)` 手动抽（实测可行）。
- 回调的 `wParam` 是 `uintptr_t`：koffi 这里给的是 **number**，但为稳妥仍应 `Number(wParam)`
  后比较（不同 koffi 版本/平台上 64 位整数可能是 BigInt，`256n === 256` 为 false）。
- 用户按键 `VK_CONTROL`(0x11) 在钩子里可能被规范化成 `VK_LCONTROL`(0xA2) / `VK_RCONTROL`(0xA3)
  —— Ctrl 的判定要三个都认。
- 吞掉鼠标事件**不能阻止光标移动**（光标由系统按原始输入移动，钩子只过滤消息）——
  用户会觉得"光标能动但点不了东西"，所以指示窗必须显著提示，否则会被当成死机。

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

### 9. 🔴 长操作期间会卡住 HTTP：**不能用同步 sleep**
本进程同时是 HTTP 服务。用 `Atomics.wait` 做同步 sleep 会把**事件循环整个卡住** ——
拖拽 / 长文本输入期间 `/activity`（指示窗轮询）与 `/abort`（停止按钮）**都得不到响应**。
实测数据：修复前 `/activity` 延迟 513ms（且随操作时长恶化），修复后 241ms、且
`/abort` 220ms 即时返回并**真的中断了操作**。

**代价与配套**：改成 `await sleep()` 后并发调用会在 await 处**交错**（一个的
`mouseToggle('down')` 和另一个的移动搅在一起）→ 故有 `withOpLock` 串行锁
（`OPERATE_ACTIONS` 集合内的动作才走锁；只读/自停/挪窗不需要）。
已有操作在进行时**直接拒绝**而不是排队 —— 排队会让调用方等到天荒地老且看不出原因。

### 10. ⚠️ 动作列表是**历史**，不要加任何"当前步"的暗示

用户问：「前面那个 `>` 又不会随着具体到哪一步更新状态啊 你弄那个干啥？」

`›` 是我拿来标"列表最新一条"的，可它长得像"当前步"的指示符 —— 用户合理地以为
它是进度标记，而它**永远不会"走到下一步"**（列表是倒序历史，不是待办清单）。
更糟的是那条还与第二行**重复**（第二行 `刚完成：` 就是取的 `s.log[0].text`）。

**现在的做法**：`相对时间 + 动作`，时间右对齐成一列。语义一目了然 ——
**这些都是过去发生过的**。没有 `›`、没有编号、不标当前。

**通用规则**：给用户看"历史记录"时别用进度类符号（`›` `→` 高亮当前项）。
想表达进度就得真能推进；不能推进就老老实实做成带时间的日志。

⚠️ 时间标签要进**渲染指纹**（用 `ago(t)` 的结果而非原始 `t`）—— 否则内容"没变"
时不会重绘，时间会永远停在第一次渲染的样子（`t` 没变，但"5 秒前"该变"10 秒前"）。

### 11. 🔴 显示层也别只看瞬时状态 —— "AI 空闲"与"步骤不更新"的同一个根因

用户报：「指示器里一直显示 AI 空闲 啥意思」「步骤列表里当前的操作步骤好像也没有
随着更改」。**同一个根因**：页面拿 `currentAction`（**瞬时**字段）当"忙不忙"用。
而一批操作可能**几百毫秒**就跑完 —— 页面**根本轮询不到**它非空的那一瞬 →
永远显示"AI 空闲"、步骤列表也像没在动。

修法（**进程侧给语义，页面只做展示**）：
- `/activity` 增加 **`active`** = `!!currentAction || (距上次操作 < ACTIVE_WINDOW_MS)`
  （`ACTIVE_WINDOW_MS = 3000`）。页面用它判断忙闲，不再自己看 `currentAction`。
- 文案分两级：正在跑 → **「正在：xxx」**；刚做完 → 「刚完成：xxx」。
- 轮询 **600ms → 250ms**（一批操作才几百毫秒，600ms 会整批漏掉）。
- 配套：DOM 重建加**指纹去重**（250ms 重建 `logEl` 会闪）；新动作加 `.fresh`
  高亮动画（几百毫秒的变化，不加动效用户注意不到）。

⚠️ **关闭判定必须放在"指纹相同就 return"之前** —— 它依赖时间流逝而内容可能不变
（画面静止时倒计时照跑），放后面会被 return 跳过 → 窗口永不关闭。

**教训**：这类"显示跟不上"的 bug 根因都是**用瞬时状态表示持续性**。凡是
"用户看到的"与"实际发生的"对不上，先问：**我用来渲染的那个字段，是不是只在
某一瞬间为真？**

### 12. 🔴 窗口寿命必须按**进程侧时间戳**算，不能按页面轮询到的状态
用户报：「第二批操作中间就自动淡出了」。根因是页面这样判断"忙不忙"：

```js
if (busy || stopped) lastBusyAt = now;    // busy = !!s.currentAction（轮询到的瞬时状态）
else if (now - lastBusyAt > IDLE_CLOSE_MS) closeSelf();
```

**本页每 600ms 才轮询一次，而一批操作可能几百毫秒就跑完** → 本页**根本轮询不到**
`currentAction` 非空的那一瞬 → 以为"一直空闲" → 倒计时照跑 → 第二批做到一半就到点关闭。

**正确做法**：关闭判定用**进程侧**的 `lastActivityMs`（进程在**每次操作时**更新
`lastActivityAt`，与轮询节奏无关）：
```js
if (!busy && !stopped) {
  var idleFor = typeof s.lastActivityMs === "number" ? s.lastActivityMs : Date.now() - openedAt;
  if (idleFor > IDLE_CLOSE_MS) closeSelf();
}
```
（`openedAt` 兜底：进程还没记录过任何操作时——如只调过 screen_info——按窗口年龄算。）

**配套**：`setAborted` 也要刷新 `lastActivityAt` —— 否则用户刚点「停止」，窗口按
"上次操作"的时间算，可能立刻消失，用户看不到"已停止"这个反馈。

**验证手法**（可复用）：静置观察，记下窗口在"距上次操作 29s"时还在、34s 时不在
（= 按 30 秒关闭）；再起一次操作，确认 `lastActivityMs` 被重置为 ~0。

### 13. 指示窗相关机制
- **窗口由宿主建**（进程开不了窗口）：AI 调用时 `/__mcp` 的响应里带
  `host:[{kind:"open-indicator",...}]`，宿主 `mcpBridge` 派发。
  已存在就不重复请求（`open` 是"关掉重建"，重复请求会让窗口闪）
- **标题必须带宿主 PID**（`indicator::<插件名>::<宿主PID>`）：多开时每个实例各有
  一个指示窗，标题只含插件名会让 `FindWindow` 找到**另一个实例**的窗口
- **窗口 `focusable(false)`（WS_EX_NOACTIVATE）**：它属于宿主进程，若点击能让它成为
  前台窗口，会触发"前台是宿主就拒绝操作"的防护 → 用户点一次停止按钮之后 AI 全被拒，
  且原因看不出来
- **挡操作的处理**：`assertNotOnIndicator` 拒绝落在其矩形内的 move/click/drag，
  错误信息里告诉 AI 用 `move_indicator` 自己挪（这是用户提的方案，比我原本想的
  "只拒绝"好）。矩形靠 `FindWindowW` + `GetWindowRect` 查，所以用户拖动窗口也自动跟上
- **指示窗页面跨源读不到宿主坐标** —— 但不需要：页面只管展示与调 `/abort`，
  几何判断全在进程侧（进程能查 Win32）

### 14. 🔴 批量里每一步都要重新过 guard（别改成只查一次）
`actSequence` 在**每次重复**前都调 `guard(step.action)`。这不是冗余：
执行途中前台窗口可能变成宿主（弹出了工具权限确认框），后续步骤**必须被拦** ——
这正是防"AI 一边调工具弹确认框、一边点允许给自己授权"的机制。
实测验证过：第 1 步点击把靶子带到前台后，第 2 步立刻被拒。

改成"开头查一次"会让长序列在中途弹框后继续操作那个框。

### 15. 🔴 逐项绑定 Win32 API，不要一把 try 包住
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
