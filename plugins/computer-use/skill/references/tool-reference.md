# 参数速查

两个插件在宿主里的工具全名（前缀 `plugin_<插件名>_`）：

| 工具 | 用途 |
|---|---|
| `plugin_screenshot_fullscreen` | 截整个显示器 |
| `plugin_screenshot_region` | 截指定矩形 |
| `plugin_mouse-keyboard_control` | 所有鼠标键盘操作（下面详述） |

---

## `plugin_screenshot_fullscreen`

| 参数 | 类型 | 说明 |
|---|---|---|
| `monitor` | number | 显示器索引，**0 = 主屏**（默认）。多屏时按 `screen_info` 的 `displays` 顺序 |
| `clearScreen` | boolean | 截图前把本应用窗口最小化让开（避免挡着画面）。不传 = 用设置里的默认 |

返回：`{ path, name, meta: { width, height, monitorOrigin, monitorIndex, region } }` + 图片本体。

## `plugin_screenshot_region`

| 参数 | 类型 | 说明 |
|---|---|---|
| `region` | `{x, y, w, h}` | **必填**。坐标**相对该显示器左上角**（不是虚拟桌面）；`w`/`h` 必须 ≥ 1 |
| `monitor` | number | 同上，默认 0 |
| `clearScreen` | boolean | 同上 |

返回同 fullscreen，但 `meta.region` 是**实际生效的矩形**（越界部分会被裁到显示范围内）。

---

## `plugin_mouse-keyboard_control`

### 通用参数

| 参数 | 说明 |
|---|---|
| `action` | **必填**，见下表 |
| `lock` | `"keyboard"` / `"mouse"` / `"both"` —— 声明独占（吞掉用户输入）。见 SKILL.md 第四章 |

### `action` 一览

| action | 主要参数 | 说明 |
|---|---|---|
| `screen_info` | — | 返回 `displays[]` + 当前鼠标位置。**只读，不算操作** |
| `move` | `x,y` 或 `dx,dy`；`smooth` `speed` | 绝对或相对移动 |
| `click` | `x,y` 或 `dx,dy`；`button` `double` | `button`: `left`(默认)/`right`/`middle` |
| `drag` | `fromX,fromY,toX,toY`；`button` `duration` | 按下→平滑移动→松开；`duration` 毫秒（默认 400） |
| `scroll` | `dx,dy`（**正 dy = 向下**） | 一格 = 120 单位，工具已换算 |
| `key` | `key`；`modifiers[]`；`hold` | 如 `{key:"a", modifiers:["ctrl"]}`、`{key:"shift", hold:true}` |
| `type` | `text`；`delayMs` | 含**非 ASCII**（中文/emoji/全角）时**必须传 `delayMs: 100`**（60 实测会丢字）。⚠️ 返回的 `chars` **不是实际落屏数** —— 必须截图核对 |
| `sequence` | `steps[]`；`stepDelayMs` | 批量，见下 |
| `move_indicator` | `x,y` | 把"AI 操作中"小浮标挪走（它挡住目标时用） |
| `abort` | — | 自己喊停（之后需用户在面板解除） |

### `sequence` 的 steps

`steps` 是 action 的数组，每项可带 `repeat`（上限 200）：

```jsonc
{
  "action": "sequence",
  "stepDelayMs": 30,          // 步间停顿（默认 30，上限 2000）
  "lock": "keyboard",         // 可选：整批期间独占
  "steps": [
    { "action": "click", "x": 100, "y": 200 },
    { "action": "key", "key": "a", "modifiers": ["ctrl"] },
    { "action": "type", "text": "hello" },
    { "action": "key", "key": "pagedown", "repeat": 10 }
  ]
}
```

约束：单次最多 **100 步**；不许嵌套 `sequence`；`abort` 允许出现在里面（安全出口）。

### `sequence` 的返回（三种停止方式）

```jsonc
{
  "ok": true,
  "executed": 3, "total": 10,
  "stopped": "step_failed" | "budget" | "invalid",   // 或没这个字段 = 全部做完
  "failedStep": 4,                                     // 失败时的步号（1-based）
  "remaining": [ /* 未执行的步骤 */ ],
  "results": [ /* 已执行的，含每步的 ok/耗时 */ ]
}
```

- `results` 里的**已经做过** → 重发时只发 `remaining`
- `budget` = 8 秒预算用尽（不是失败，是"分批继续"的信号）

### 单项操作的返回

大多形如 `{ ok: true, ... }`；失败是 `{ ok: false, error: "..." }`。
⚠️ `ok: true` 只表示**事件发出去了**，不代表目标响应了 —— 用截图验证。

### 失败时的可读信息

| error 里出现 | 含义 |
|---|---|
| `落在指示窗上` | 目标被 AI 浮标挡住 → 先 `move_indicator` |
| `本应用` / `宿主` | 目标窗口是本 GUI 自己 → **保护机制**，换目标或让用户操作 |
| `被系统拦截` / 返回 0 | 目标以管理员权限运行（UIPI）→ 无解，告知用户 |
| `已急停` | 用户按了 Ctrl+Q 或点了停止 → **重新截图确认状态**，别盲目重试 |
