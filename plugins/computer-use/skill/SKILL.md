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

## 三、批量：一次调用做完一串

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

## 四、长操作：声明独占（`lock`）

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

## 五、输入中文：两个必须记住的事

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

## 六、常见失败与对策

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 返回"目标坐标落在指示窗上" | AI 操作指示窗挡住了目标 | 工具返回里会告诉你，调 `move_indicator` 挪开再重试 |
| 返回"当前前台窗口是本应用" | 宿主 GUI 在前台 | **这是保护**（防止 AI 点自己的权限框）。先让用户切走，或操作别的窗口 |
| 点击成功但目标没反应 | 窗口不在前台 / 被遮挡 / 控件禁用 | **截图看**（第一章第 ③ 步的道理）；必要时先 `click` 一次把它带到前台 |
| "输入被系统拦截" | 目标窗口以管理员权限运行 | Windows 的 UIPI 限制，**无解** —— 如实告诉用户，请他自己操作或以普通权限重开目标 |
| 输入的中文丢了几个字 | `delayMs` 太小（默认仅 4ms） | 改成 **`delayMs: 100`**（见第五章；60 也会丢） |
| 滚动方向反了 | —— | 工具语义是 **正 `dy` = 向下滚**，符合直觉，不用管 Windows 原生符号 |

**失败时的第一反应应该是截图，而不是调大参数重试。**

---

## 七、组合范例

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

## 八、别做的事

- **别在没截图的情况下猜坐标**（哪怕你"刚看过"）
- **别把 `ok: true` 当成"操作生效了"**
- **别信 `type` 返回的 `chars`/`textLength`** —— 那是"打算输入多少"，不是实际落屏（见第五章）
- **别用低于 100 的 `delayMs` 打中文**（60 实测会丢字）
- **别在用户接管（Ctrl+Q）后盲目重试**
- **别对连续几十步的操作一次发完**（8 秒预算会截断）—— 分批
- **别重发 `results` 里已执行的步骤**（会重复操作）
- **别操作你无法验证结果的东西**（如不可逆的删除、支付）—— 那类操作应先问用户

---

## 参考

- 更细的坐标换算与多显示器处理：`references/coordinates.md`
- 工具参数速查：`references/tool-reference.md`
