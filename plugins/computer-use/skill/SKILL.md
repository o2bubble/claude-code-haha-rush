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

### 需要窗口在前台时（别第一时间找用户）

第七章说「前台是本 GUI」会被拒绝 —— 那是保护，但**解法不用麻烦用户**：

```powershell
# ⚠️ 别把变量名写成 $pid —— 那是 PowerShell 保留变量（= 当前进程），会静默激活错对象
$targetPid = (Get-Process notepad | Select-Object -First 1).Id
(New-Object -ComObject WScript.Shell).AppActivate($targetPid)   # 返回 True 为成功
explorer.exe "C:\path\to\app.exe"                                # 或经 explorer 中转启动（新窗口通常直接在前台）
```

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
| 点击成功但目标没反应 | 窗口不在前台 / 被遮挡 / 控件禁用 / **系统对话框不吃模拟点击** | **截图看**（第一章第 ③ 步的道理）；**系统对话框（保存/打开/确认）优先走键盘**：`Tab`/方向键切换、`Enter` 确认、`Esc` 取消 —— 实测鼠标点两次无效时，键盘一次就过 |
| 截图里出现"AI 操作中"小窗 | **正常现象**，不是错误 | 它还能当**操作历史**用 —— 反过来核对"我刚才做过什么" |
| "输入被系统拦截" | 目标窗口以管理员权限运行 | Windows 的 UIPI 限制，**无解** —— 如实告诉用户，请他自己操作或以普通权限重开目标 |
| 输入的中文丢了几个字 | `delayMs` 太小（默认仅 4ms） | 改成 **`delayMs: 100`**（见第六章；60 也会丢） |
| 滚动方向反了 | —— | 工具语义是 **正 `dy` = 向下滚**，符合直觉，不用管 Windows 原生符号 |

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
- **别把 `ok: true` 当成"操作生效了"**
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

---

## 参考

- 更细的坐标换算与多显示器处理：`references/coordinates.md`
- 工具参数速查：`references/tool-reference.md`
