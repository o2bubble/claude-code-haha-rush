---
name: computer-use
description: "READ THIS BEFORE DRIVING THE DESKTOP — practical, hard-won habits for operating a computer with the mouse-keyboard + screenshot plugins, so you don't rediscover each failure live with the user's real mouse. Covers: screenshot-verify every step (a success result means the event was dispatched, not that it landed), converting image pixels to screen-absolute coordinates, batching multi-step operations, taking exclusive input control, and recovering from common failures (wrong coordinates, blocked input, user takeover). Triggers when the user asks you to operate another application, fill a form, click through a UI, automate a GUI task, or verify what's on screen — and as a prerequisite before any computer-control action."
---

# 操作电脑（看屏幕 + 鼠标键盘）

你有一套完整的桌面操控能力，由两个插件提供：

| 能力 | 工具 | 说明 |
|---|---|---|
| **看** | `plugin_screenshot_fullscreen` / `plugin_screenshot_region` | 截屏返回图片，**你能直接看到** |
| **做** | `plugin_mouse-keyboard_control` | 移动/点击/拖拽/滚动/按键/输入中文，支持批量 |

它们是**分开的两个插件**，但只有配合起来才可靠。本技能讲的就是怎么配合。

---

## 一、心法：看 → 做 → 看

**不要盲操作。** 这是所有失败的头号来源。

```
① 看：截图，确认目标在哪、当前什么状态
② 做：操作
③ 看：再截图，确认操作生效了
```

**为什么不能省第 ① 步**：你凭印象猜的坐标几乎肯定是错的（窗口可能被移动过、分辨率变了、
程序布局和你想的不一样）。

**为什么不能省第 ③ 步**：工具返回 `ok: true` 只代表"事件发出去了"，**不代表目标响应了** ——
可能被别的窗口挡住、可能按钮是禁用态、可能点了但没生效。只有截图能证明。

### 什么时候可以省

- 连续操作同一个控件（如连点"下一页"十次）→ 开头看一次，结尾看一次
- 你已经在这一轮对话里刚截过图、且中间没人动过屏幕

### 🔴 截图前想清楚：要不要传 `clearScreen`

截图工具默认会**把本应用窗口最小化让开**（免得挡住画面）—— 因为通常你是要截 GUI **后面**的东西。

**但要截 GUI 自己时，必须显式传 `clearScreen: false`**：

| 场景 | 传什么 |
|---|---|
| 用户问「XX 面板在哪」「这个按钮在哪」（要看 GUI 本身） | **`false`** |
| 要截别的应用 / 桌面（GUI 挡着视线） | 不传或 `true` |

**不传 = 用设置默认（让开）= 把用户的窗口最小化掉**，然后你截到"没有 GUI 的桌面"、
还以为是别的程序挡着 —— 而用户看到的是"我一截图我的窗口就没了"。

⚠️ `fullscreen` 与 `region` **都支持这个参数**。不确定就传 `false`（不打扰用户更安全）。

---

## 二、坐标：最容易出错的一环

### 截图坐标 ≠ 屏幕坐标

截图工具返回的坐标是**图内像素**。鼠标工具要的是**虚拟桌面绝对坐标**。

**换算式**（对所有截图模式都成立）：

```
屏幕绝对坐标 = 返回的 meta.monitorOrigin + 图内像素坐标
```

截图返回的元数据长这样（`image.data` 会被宿主剥掉，其余你能看到）：

```jsonc
{
  "path": "…/snip-20260917-183000.png",
  "name": "snip-20260917-183000.png",
  "meta": {
    "width": 1920, "height": 1080,
    "monitorOrigin": { "x": 0, "y": 0 },   // ← 这张图左上角的**虚拟桌面绝对坐标**
    "monitorIndex": 0,
    "region": null                          // 非 null = 裁过区域（实际生效的矩形）
  }
}
```

- **主屏的 fullscreen**：`monitorOrigin` 通常是 `{0,0}`，所以图内坐标 ≈ 绝对坐标
- **非主屏 / 多显示器**：`monitorOrigin` 是**非零**的（如副屏在右边时 x=1920）—— 必须加上它
- **region 模式**：`monitorOrigin` 已经是裁切后的绝对原点 —— 同样直接相加即可

> ⚠️ **不要自己猜显示器布局**。`monitorOrigin` 就是权威答案，用它。

### 先校准，再操作

需要**所有显示器的布局**时（如"把窗口拖到另一个屏幕"、跨屏操作），
用 `plugin_mouse-keyboard_control { "action": "screen_info" }`：

```jsonc
{
  "displays": [ { "id": …, "x": 0, "y": 0, "width": 1920, "height": 1080, "isMain": true }, … ],
  "mouse": { "x": 1024, "y": 768 },        // 当前鼠标位置（想知道光标在哪时用它）
  "coordinateSpace": "virtual-desktop-absolute"
}
```

**在动手前花这一次调用，能省掉后面一串点错。**

### 定位技巧：放大看小控件

小控件（复选框、关闭箭头、下拉三角）在全屏截图里只有几像素，容易看偏。
→ 用 `region` 截那一小块（比如以目标为中心的 200×200），坐标立刻就清楚了。
注意 `region` 的 `x,y` 是**相对该显示器左上角**的（工具内部会换算成绝对坐标）。

### 🔴 会变形的目标：截完图坐标就失效了

有些控件**一被悬停就改变尺寸/位置** —— 侧边栏自动展开、悬浮卡片、下拉箭头。

```
截图（折叠态，宽 12px）→ 量出中心 x=1188 → 鼠标移到 1188
                                          ↑ 此刻它展开成 72px，中心变成 1218
                                          → 点在了错误的刻度上
```

实测教训（2026-10-29，时间线刻度）：这类目标连点 3 次全落错位置，每次都"看起来只差一点点"，
实际是整个坐标系在靠近时变了 —— 再微调 x 也永远调不中。

**判据**：目标是「悬停/聚焦时展开、加宽、位移」的控件 → 坐标不能从**操作前**的截图取。

**做法（任选，先试 ①）**：

1. **先让它展开，再截图，然后原地点击** —— 把 pointer 移到目标附近（不点），
   等动画结束，重新截图量坐标，此时点击不会再次改变布局。
2. **有键盘入口就用键盘** —— 展开/聚焦类控件通常可用 `Tab` 到它、或直接快捷键，
   完全绕开坐标问题（棋盘格、列表项、菜单项）。
3. **让被测对象自己报告坐标** —— 自家 Web 应用见下节；原生应用若有可查询接口优先用。
4. **用相对定位而非绝对像素** —— 以某个稳定锚点（窗口左边缘、某个固定按钮）为基准，
   每次操作前重新量一次偏移。

> 通用信号：**"点了没反应"或"点到了隔壁那个"连续 2 次** → 立刻怀疑目标在动，
> 而不是怀疑自己像素差了几个。停下来重新截图，对比两张图里目标是否换了位置。

### 🔴 自家 Web 应用（Tauri / Electron / 任何 webview）：别用像素，用 DOM

如果目标是**自己开发的应用**，浏览器能测的坐标比截图准得多，而且能测到小数点后。

截图量像素的误差来源太多（缩放、抗锯齿、半透明边、图片降采样）；
`getBoundingClientRect()` 返回的是**权威值**，还能直接断言"是否溢出视口"。

```js
// Playwright / CDP 连上页面后，一次拿到所有要的信息
() => {
  const btns = [...document.querySelectorAll('button[aria-label]')]
    .filter(b => /关闭|Close/i.test(b.getAttribute('aria-label') || ''));
  return {
    viewport: { w: innerWidth, h: innerHeight },
    rects: btns.map(b => { const r = b.getBoundingClientRect();
      return { l: b.getAttribute('aria-label'), x: Math.round(r.x),
               right: Math.round(r.right), w: Math.round(r.width) }; }),
    // 关键断言：有没有跑出可视区
    overflow: btns.filter(b => { const r = b.getBoundingClientRect();
      return r.x < 0 || r.right > innerWidth + 0.5; }).length,
  };
}
```

**这种方式验证"修好了没有"是决定性的** —— 比截图上目测"看起来还在"可信得多。
实测（2026-10-29 窗口按钮修复）：靠它量出「工具栏内容右边界 662 = 按钮左边界 662，
恰好相接、无重叠」，这是看图根本给不出的结论。

**代价**：需要应用跑在可连调试的环境（dev server / CDP 端口）。
拿不到时再退回截图，但**优先争取 DOM 测量**。

---

## 三、先让目标出现：启动程序与找窗口

要操作的程序可能还没开。**启动它**有两个实测出来的坑 —— 而直觉解法往往是错的。

### 坑 1：`Start-Process <名字>` 可能压根启不动

```
✗ Start-Process notepad                             → 失败："系统找不到所需的全部信息"
✓ Start-Process notepad.exe                         → 成功
✓ Start-Process "C:\Windows\System32\notepad.exe"   → 最稳
```

**原因**：PATH 里排前面的 `notepad` 可能是 **Git 自带的 POSIX shell 脚本**
（`<安装目录>\git\usr\bin\notepad`，635 字节，`#!/bin/sh`）—— 不是 exe，启动不了。

**规则**：启动程序**一律用全路径**（或至少带 `.exe`），别裸写名字。

### 坑 2：Store 应用的窗口**不在**你启动的那个 PID 上

Win11 的记事本、计算器等 **Store（打包）应用是多窗口共享进程模型**：

- 你启动的进程可能只是个转发器 —— 活着，但 `MainWindowHandle = 0`
- 真正的窗口在**另一个进程**上（常是早先就存在的实例）
- 实测：启动后 `PID A 窗口=0`、`PID B 窗口=3213918` —— 后者才是窗口

**规则**：
- **别按 PID 认窗口** —— 按 `MainWindowTitle` 找（Store 应用标题如 `无标题 - Notepad`）
- 启动后**验证**：`Get-Process <名> | Select MainWindowHandle`，**非 0 才算真起来了**

### 别把「没窗口」归咎于「进程树受限」

实测（2026-09-18）：**在 agent 自己的进程树里启动普通 GUI 程序完全正常**
（一个 tkinter 窗口有正常的 `MainWindowHandle`）。

窗口没出现时，按顺序查：① 路径对不对（坑 1）→ ② 是不是 Store 应用（坑 2）
→ ③ 程序是否需要特定工作目录/参数。

### 坑 3：同一个应用开了多个实例 —— 标题全都一样

多实例场景（浏览器多窗口、开发工具多开、Tauri 应用多开）里：

- `Get-Process` 的 `MainWindowTitle` 可能就是**空**的 —— 窗口不一定挂在那个 PID 上
- 即使有标题，**多个实例标题可能完全相同**，你分不清是哪一个
- 截图只会拿到**最上面那个**，很容易验证到"我以为的那个"其实是别的实例

**规则**：认窗口用 **(PID, class, rect)** 三元组，不要只看标题。
`scripts/find-window.ps1` 就是干这个的：

```powershell
# 列出某个进程的所有顶层窗口（含 hwnd / class / 精确 rect / zoomed / dpi）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/find-window.ps1 -Match claude-code-gui -Class "Tauri Window" -VisibleOnly
```

输出示例（注意 **hwnd 与 rect 才是唯一定位依据**）：

```
hwnd=0x50816  pid=30616  class=Tauri Window
  title=claude-code-haha-dev · 标题: 主页构建 *
  rect=40,40 960x660   visible=True iconic=False zoomed=False  dpi=96 (scale 1)
hwnd=0x230CCA  pid=29320  class=Tauri Window
  title=cloud-ui · 1b2ea971
  rect=-8,-8 1936x1048  visible=True iconic=False zoomed=True  dpi=96 (scale 1)
```

拿到 hwnd 之后，用 `scripts/window-bounds.ps1` 调整尺寸/激活（**它对最大化窗口做了
正确的还原处理**，见下节）。两个脚本都已设置 DPI 感知，坐标与截屏插件同一空间。

### 坑 4：对**最大化**的窗口 resize 会得到垃圾尺寸

```powershell
SetWindowPos($h, 0, 40, 40, 900, 700, SWP_NOZORDER)
# → 实际结果 rect=40,40 900x65535   ← 高度 65535 = 16 位无符号溢出的 -1
```

**最大化状态下 `SetWindowPos` 不生效**，返回 `true` 但尺寸是垃圾。
必须先 `ShowWindow($h, 9)`（`SW_RESTORE`）还原，等窗口退出最大化，再 resize。

```powershell
# 正确顺序：还原 → 等 → SetWindowPos → 读回验证
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/window-bounds.ps1 `
    -Hwnd 0x50816 -Left 40 -Top 40 -Width 900 -Height 640
# 输出会打印 BEFORE / AFTER 两段，直接对比是否真的生效
```

**别相信"我设了 900x700"，一定要读回实际矩形。**

### 🔴 PowerShell 单字母变量会静默互相覆盖（大小写不敏感）

这是写自动化脚本时最阴的一类 bug：**PowerShell 变量名不区分大小写**。

```powershell
param([int]$H)          # 高度
$h = [WinCtl]::FindWindow(...)   # $h 和 $H 是同一个变量！句柄把高度覆盖了
SetWindowPos(..., $W, $H, ...)   # → 传进去的是句柄，尺寸变成垃圾
```

实测（2026-10-29）：我写 `-H 660`，结果窗口高度变成 **960x65535**，
排查了两轮才发现是 `$h`（句柄）与 `$H`（高度）互相覆盖 —— **不是 API 问题**。

同理，`$Hwnd` 参数与内部 `$hwnd` 是同一个变量；如果参数声明成 `[string]`，
内部赋 IntPtr 会被强制转成字符串，再传给需要 IntPtr 的方法就报类型转换错误。

**规则**：
- 别用单字母变量，尤其 `$h` / `$H` / `$p` / `$P` / `$w` / `$W`
- 已知的保留变量还有 `$pid`（= 当前进程 ID）、`$host`、`$args`、`$input`、`$error`、`$matches`
- 参数与内部变量**取不同词**（参数 `-Hwnd`，内部就叫 `$target`）

### 🔴 .ps1 文件必须是 UTF-8 **带 BOM**（写中文注释时）

PowerShell 5.1 **没有 BOM 时按 ANSI（GBK）解码 .ps1**。文件是 UTF-8 中文注释 →
被当成 GBK → 某些字节组合会**破坏语法解析**，报出完全无关的错误：

```
+ using System;
+      ~
缺少 using 指令          ← 实际是 C# 的 using，PowerShell 却在按 PS 语法骂它
'using' 语句必须出现在脚本中的任何其他语句之前。
```

**这个报错极具误导性** —— 看起来像 C# 编译错误，实际是文件编码问题。
而且报的**行号是错的**（比真实位置靠前），会把你引向不存在的问题。

**规则**：用 `Write` / 编辑器写 `.ps1` 时，**确保 UTF-8 BOM**；或者干脆让
脚本的**输出全是 ASCII**（中文留给注释之外的地方，如 SKILL 文档）。

**同类坑（输出方向）**：脚本要打印中文（如窗口标题）时，控制台默认按 GBK 输出 →
agent 读到的是 `claude-code-haha-dev �� ����`，**窗口标题正是分辨实例的依据**，
糊了等于没用。在脚本开头显式设一次：

```powershell
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
```

```powershell
# 补 BOM（对已有文件）
$raw = [IO.File]::ReadAllBytes($path)
if ($raw[0] -ne 0xEF) { [IO.File]::WriteAllBytes($path, [byte[]](0xEF,0xBB,0xBF) + $raw) }
```

### 需要窗口在前台时（别第一时间找用户）

第七章说「前台是本 GUI」会被拒绝 —— 那是保护，但**解法不用麻烦用户**：

```powershell
# ⚠️ 别把变量名写成 $pid —— 那是 PowerShell 保留变量（= 当前进程），会静默激活错对象
$targetPid = (Get-Process notepad | Select-Object -First 1).Id
(New-Object -ComObject WScript.Shell).AppActivate($targetPid)   # 返回 True 为成功
explorer.exe "C:\path\to\app.exe"                                # 或经 explorer 中转启动（新窗口通常直接在前台）
```

**`AppActivate` 失败时**（返回 False，或应用是多实例/多窗口、`MainWindowTitle` 为空）：
改用 **hwnd 三连**，成功率明显更高：

```powershell
# ShowWindow(9) → BringWindowToTop → SetForegroundWindow，三步缺一不可
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/window-bounds.ps1 -Hwnd 0x50816
```

原因：Windows 会拒绝非前台进程的 `SetForegroundWindow`，而 `ShowWindow` /
`BringWindowToTop` 能把进程"推"进允许设置前台的状态。

### 🔴 焦点：点击和输入之前必须先确认的事

**这是与真实用户共用桌面时最大的隐形杀手。** 你截图时窗口还在前台，一秒钟后用户
点了一下微信/浏览器，你的下一次点击就落空了 —— 而且**工具不会告诉你**。

| 现象 | 真相 |
|---|---|
| `click` 返回 `ok: true`，目标毫无反应 | 事件发给了**别的窗口** |
| `type` 返回 `ok: true, chars: 5`，输入框还是空的 | 焦点不在那个 input 上 —— **字符全丢，零报错** |
| 连点同一位置 3~4 次都没反应 | 你在重复同一个错误，不是"差一点就成功" |

**`type` 到未聚焦的输入框是静默失败** —— 比坐标落在指示窗上危险得多，因为后者会
明确拒绝你，而前者安静地把字符丢进虚空，返回值仍然是漂亮的 `ok: true`。
**每次 `type` 之前都要确认输入框有焦点**（截图里能看到插入光标）。

**三步铁律**：

1. **点击前确认前台是谁** —— `(Get-Process -Id <pid>).MainWindowTitle`，或截图看标题栏
   是否高亮。别沿用几分钟前的认知（尤其在你刚眯了一眼别处之后）。
2. **激活它，别只点它** —— `AppActivate($targetPid)`（返回 True 才算成功）。
   ⚠️ **不要用"点窗口标题栏"来聚焦**：在可拖动窗口上，按住标题栏会变成**拖动窗口**，
   把用户精心摆好的布局搞乱（实测踩过）。
3. **输入后立刻验证** —— 截图看输入框有没有内容。别信 `ok: true` / `chars`。

**模态对话框会冻结整个窗口**：目标程序弹出确认框（保存、登录切换、"内容将丢失"警告）时，
**后面所有点击都落在对话框上**，表现和"点了没反应"一模一样。

**点击无反应时的诊断顺序**（照这个顺序，不要跳）：

```
① 截图 → 有没有模态框挡着？  → 有：先处理它（Esc / Enter / 点它的按钮）
② 截图 → 目标窗口在前台吗？  → 不在：AppActivate 激活
③ 截图 → 坐标真落在控件上吗？ → region 放大确认
④ 以上都排除，才怀疑"控件被禁用 / 需要管理员权限"
```

**失败 2~3 次就是硬刹车点** —— 停下重新截图、重新确认前台，而不是继续微调 x/y。
实测（2026-10-23）：连着 4 次点同一个搜索框全部无效，根因是**焦点根本不在那个窗口**，
再调多少遍坐标都没用。排查两轮仍失败 → **换验证路径**（走单测 / 请用户点一下），
别跟自动化死磕。

---

## 四、批量：一次调用做完一串

`action: "sequence"` + `steps: [...]` —— **每一步省一次 AI 往返（1~3 秒）**。

```jsonc
{ "action": "sequence", "stepDelayMs": 30, "steps": [
  { "action": "click", "x": 100, "y": 200 },
  { "action": "type", "text": "要输入的内容" },
  { "action": "key", "key": "tab" },
  { "action": "click", "x": 300, "y": 400 }
]}
```

### 三条必须知道的语义

**① 失败即停**，且返回里告诉你停在哪：
```jsonc
{ "stopped": "step_failed", "executed": 2, "failedStep": 3, "remaining": [...], "results": [...] }
```
- `results` 里的步骤 **已经执行过了** → **不要重发**
- 只重发 `remaining` 里的（修正导致失败的问题后）

**② 有 8 秒预算**：单次调用跑太久会被截断（`stopped: "budget"`），同样返回 `remaining`。
**长任务要分批**：拆成几次调用，每次几秒内完成。
（上限：单次最多 100 步、单步 `repeat` 最多 200。）

**③ 每步都会重新检查**（前台窗口、急停状态）—— 所以批量中途弹出了别的窗口，
后续步骤会被**拒绝**而不是点错地方。这是保护，不是 bug。

### 用 `repeat` 而不是写 80 遍

```jsonc
{ "action": "scroll", "dy": 3, "repeat": 10 }      // 连续滚 10 格
{ "action": "key", "key": "pagedown", "repeat": 20 }
```

---

## 五、长操作：声明独占（`lock`）

如果一批操作**中途被打断就会前功尽弃**（填表单、拖拽、多步向导），加 `lock`：

```jsonc
{ "action": "sequence", "lock": "keyboard", "steps": [...] }
```

- `"keyboard"` / `"mouse"` / `"both"` —— 期间**用户的物理输入被吞掉**（他们的键鼠动不了）
- 锁是**限时的**（约 10 秒，你持续操作会自动续期）—— 不会永久锁死
- 屏幕上会出现一个小指示窗告诉用户"键鼠已锁定"，并提示 **Ctrl+Q 可随时接管**

### 什么时候该锁，什么时候别锁

| 该锁 | 别锁 |
|---|---|
| 多步表单、拖拽、需要精确顺序的操作 | 单次点击、看一下屏幕 |
| 用户可能会碰到鼠标的长时间操作 | 用户正在跟你对话、可能想插手 |

**用户按 Ctrl+Q 接管后**：你的操作**立即停止**，且后续调用被拒绝，直到用户在面板恢复。
这时**不要重试**：用户插手意味着桌面状态可能已经变了 —— 重新截图、重新确认目标，
必要时问用户想做什么。

---

## 六、输入中文：两个必须记住的事

### ① 非 ASCII 一律 `delayMs: 100`（不是"60~100"，就是 100）

**实测（Windows 11，记事本）**：

| delayMs | 输入 | 实际落屏 |
|---|---|---|
| 60 | `电脑操作测试 OK 1234567890` | **只剩 `1234567890`**（8 个汉字 + 空格全丢） |
| 100 | `电脑操作测试（慢速重试）` | 12 字符完整 |

默认值（4ms）只会更差。**凡 `text` 含中文/emoji/全角标点 → 显式传 `delayMs: 100`**（这是上限）。
纯 ASCII 不受影响，用默认即可。

走 `sequence` 时写在**那一步自己的参数**里：
```jsonc
{ "action": "type", "text": "中文内容", "delayMs": 100 }
```
⚠️ 顶层 `stepDelayMs` 是**步骤之间**的间隔，管不着**字符之间** —— 两者极易混淆。

### ①b 预算换算：中文输入 ≈ **10 字符/秒**

`delayMs: 100` 的代价是速度 —— 实测 **42 字符耗时 ~4.2 秒**。

> **宿主 MCP 有 8 秒硬超时**（超了宿主报 timeout，而插件还在打字 → AI 误判失败并重做）。
> 所以：**单次 `type` 的中文超过 ~50 字符，就该拆成多批**（每批之间 screenshot 或继续下一步）。

算得过来就不会撞墙：`字符数 ÷ 10 = 秒数`，留操作余量。

### ② `chars` 字段**不可信** —— 它报的是"打算输入多少"

**失败时返回与成功时一模一样**：

```jsonc
// 输入 20 字符，实际只落 10 个 —— 返回值却是：
{ "step": 3, "action": "type", "ok": true, "chars": 20, "textLength": 20 }
```

`chars` / `textLength` 是**意图**，不是**结果**。**光看返回值永远发现不了丢字** ——
这正是第一章那句"`ok: true` 只代表事件发出去了"的一个具体实例，
而且更隐蔽：它连一个看着很确信的数字都给你。

**打完非 ASCII 文本必须截图核对**，别信返回值。

---

## 七、常见失败与对策

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 返回"目标坐标落在指示窗上" | AI 操作指示窗挡住了目标 | 工具返回里会告诉你，调 `move_indicator` 挪开再重试 |
| 返回"当前前台窗口是本应用" | 宿主 GUI 在前台 | **这是保护**（防止 AI 点自己的权限框）。**自己激活目标窗口即可，别麻烦用户**：`AppActivate($targetPid)` 或经 `explorer.exe` 启动新实例（完整写法见第三章末） |
| 点击成功但目标没反应 | **焦点不在目标窗口**（最常见）/ 模态框挡着 / 被遮挡 / 控件禁用 / **系统对话框不吃模拟点击** | 按第三章「焦点」的四步诊断顺序；**系统对话框（保存/打开/确认）优先走键盘**：`Tab`/方向键切换、`Enter` 确认、`Esc` 取消 —— 实测鼠标点两次无效时，键盘一次就过 |
| `type` 返回成功但输入框还是空的 | **焦点不在那个 input 上 —— 静默丢字符** | 先 `click` 输入框（确认有插入光标）再 `type`；见第三章「焦点」 |
| 连点 4 次同一位置全无反应 | 焦点/遮挡问题，不是坐标差几个像素 | **刹车**：重新截图 → 确认前台 → 确认坐标，别继续微调重试 |
| 截图里出现"AI 操作中"小窗 | **正常现象**，不是错误 | 它还能当**操作历史**用 —— 反过来核对"我刚才做过什么" |
| "输入被系统拦截" | 目标窗口以管理员权限运行 | Windows 的 UIPI 限制，**无解** —— 如实告诉用户，请他自己操作或以普通权限重开目标 |
| 输入的中文丢了几个字 | `delayMs` 太小（默认仅 4ms） | 改成 **`delayMs: 100`**（见第六章；60 也会丢） |
| 滚动方向反了 | —— | 工具语义是 **正 `dy` = 向下滚**，符合直觉，不用管 Windows 原生符号 |
| 明明瞄准了却总点偏，且「每次都差一点点」 | **目标在动**（悬停展开/加宽/位移），坐标来自操作前的截图 | 让它先展开 → 重新截图 → 原地点击；或改走键盘（见第二章「会变形的目标」） |
| 修改窗口尺寸后得到 `900x65535` 这类怪尺寸，`SetWindowPos` 却返回成功 | 窗口处于**最大化**状态，resize 不生效 | 先 `ShowWindow(h, 9)` 还原再 resize；用 `scripts/window-bounds.ps1` 自动处理 |
| 脚本里传了 `-H 660`，结果高度变成 65535 / 报类型转换错误 | **PowerShell 变量名大小写不敏感**：`$H` 与 `$h`（句柄）是同一个变量 | 别用单字母变量；参数与内部变量取不同词（见第三章） |
| `.ps1` 报 `'using' 语句必须出现在...` 之类看不懂的语法错，行号还对不上 | 文件是 **UTF-8 无 BOM**，PowerShell 5.1 按 GBK 解 → 中文注释破坏解析 | 存成 **UTF-8 with BOM**（见第三章） |
| 脚本打印的中文标题变乱码 | 控制台按 GBK 输出 | 脚本开头设 `[Console]::OutputEncoding = [UTF8]`（见第三章） |
| `AppActivate($pid)` 返回 False / 激活了错的窗口 | 多实例、`MainWindowTitle` 为空 | 用 hwnd 三连：`ShowWindow(9)` → `BringWindowToTop` → `SetForegroundWindow`（`scripts/window-bounds.ps1`） |

**失败时的第一反应应该是截图，而不是调大参数重试。**

---

## 八、组合范例

### 例：在某个应用里填一个表单

```
1. screenshot_fullscreen              → 看窗口在哪、表单什么状态
2. 换算坐标（或用 region 放大看字段）
3. sequence（一次做完，避免中途被打断）:
     click 第一个字段 → type 内容 → tab → type → ...
   若表单长/中间不能被打断 → 加 "lock": "keyboard"
4. screenshot_fullscreen              → 确认填对了
5. 需要提交时再单独一次 click（提交前让用户确认更稳妥）
```

### 例：用户说"帮我把那个弹窗关掉"

```
1. screenshot_fullscreen              → 找到弹窗和它的关闭按钮
2. click 关闭按钮
3. screenshot_fullscreen              → 确认真的关掉了（而不是点到了别处）
```

---

## 九、别做的事

- **别在没截图的情况下猜坐标**（哪怕你"刚看过"）
- **别把 `ok: true` 当成"操作生效了"** —— 尤其 `type`：焦点不在时字符全丢、依然返回 `ok: true`
- **别在 `type` 前不确认焦点** —— 这是"输入没反应"的头号原因
- **别用点击标题栏的方式聚焦窗口**（会变成拖动窗口）
- **别在同一次操作上失败 3 次还继续调坐标** —— 停下来诊断焦点和遮挡
- **别信 `type` 返回的 `chars`/`textLength`** —— 那是"打算输入多少"，不是实际落屏（见第六章）
- **别用低于 100 的 `delayMs` 打中文**（60 实测会丢字）
- **别在用户接管（Ctrl+Q）后盲目重试**
- **别对连续几十步的操作一次发完**（8 秒预算会截断）—— 分批
- **别重发 `results` 里已执行的步骤**（会重复操作）
- **别操作你无法验证结果的东西**（如不可逆的删除、支付）—— 那类操作应先问用户
- **屏幕和预期不符时别脑补** —— 停下 → 截图/查进程 → 不确定就问。
  （实测教训：看到内容变了就脑补"另一个 agent 在抢桌面"，其实是之前的测试残留）
- **收尾要清场** —— 关掉自己启动的程序、确认最终状态；
  跑清理脚本时**别用 `$pid` 这类保留变量命名**（PowerShell 里会静默失效，进程根本没关掉）

### 🔴 别绕过插件用裸 Win32 发鼠标/键盘事件

```powershell
✗ [WinCtl]::SetCursorPos($x, $y); mouse_event(LEFTDOWN...)   # 绕过了全部保护
✓ plugin_mouse-keyboard_control { action: "click", x, y }     # 走插件
```

**为什么不能图省事**：插件那层不是包装，是**保护** ——

| 保护 | 裸 API 有没有 |
|---|---|
| 屏幕上「AI 正在操作」指示窗 | ❌ |
| 点击落在指示窗上时**拒绝执行**（而不是点错地方） | ❌ |
| 用户按 **Ctrl+Q 立刻中断** | ❌ |
| `lock` 声明独占，防用户误触 | ❌ |
| 每一步重新校验前台/急停状态 | ❌ |

裸 `SetCursorPos` + `mouse_event` 动的是**用户真实的系统光标**：没有输入锁，
用户正在打字时你的点击可能落到别的窗口；用户正在用鼠标时会直接打架。

**实测事故（2026-10-29）**：验证时间线时用裸 PowerShell 点了 5 次真实鼠标，
用户事后问"你是不是操作过我的窗口" —— **他确实可能察觉到光标自己动了**，
而当时没有任何指示窗告诉他"这是 AI 在操作"。

**规则**：凡是**点击/输入**一律走插件。窗口管理类操作（`ShowWindow` /
`SetWindowPos` / 激活）不产生用户可见的鼠标动作，可以用脚本
（`scripts/window-bounds.ps1`），但**也不要在里面混入鼠标点击**。

---

## 十、辅助脚本

两个脚本都**已设置 DPI 感知**（坐标与截屏插件同一空间），输出为 ASCII。

| 脚本 | 用途 |
|---|---|
| `scripts/find-window.ps1` | 按进程名/PID 枚举顶层窗口：hwnd、class、标题、**精确 rect**、visible/iconic/zoomed、dpi。多实例分不清时用它 |
| `scripts/window-bounds.ps1` | 还原（退出最大化/最小化）→ 调整位置尺寸 → 激活到前台 → **打印前后矩形对比** |

```powershell
# 1) 先找到目标窗口（多实例时看 rect 区分）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/find-window.ps1 `
    -Match claude-code-gui -Class "Tauri Window" -VisibleOnly

# 2) 再用 hwnd 操作它（自动处理最大化、自动读回验证）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/window-bounds.ps1 `
    -Hwnd 0x50816 -Left 40 -Top 40 -Width 900 -Height 640
```

> ⚠️ 这两个脚本会**移动/调整真实窗口**。用户的窗口布局可能是他有意的
> （多屏摆位、分屏对照），改之前想一下是否必要；纯验证尽量用 Playwright/DOM 测量，
> 根本不用动窗口。

**写新的 .ps1 时记住三条**（都已写进第三章）：UTF-8 **带 BOM**、
**别用单字母变量**、路径/名字**别裸写**。

---

## 参考

- 更细的坐标换算与多显示器处理：`references/coordinates.md`
- 工具参数速查：`references/tool-reference.md`
- 辅助脚本：`scripts/find-window.ps1`、`scripts/window-bounds.ps1`
