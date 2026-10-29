# 操作电脑（computer-use）

把两个插件的能力**组合**成一套完整的「看屏幕 + 操作电脑」，并附赠一份**实战心得技能**。

| 项 | 说明 |
|----|------|
| 形态 | 纯组合包——**本身没有进程、没有面板**，只是依赖 + 一份技能 |
| 依赖 | [`mouse-keyboard`](../mouse-keyboard/)（操作）+ [`screenshot`](../screenshot/)（看屏幕） |
| 贡献 | 一个技能 `computer-use`（链接到 `~/.claude/skills/`） |
| 平台 | Windows |

## 它解决什么

单装那两个插件，AI 也能操作电脑 —— 但会**反复踩同几个坑**：

- 拿截图的图内坐标直接去点击（**没加上显示器偏移**）→ 点到别处
- 把 `ok: true` 当成"操作生效了"（其实只代表事件发出去了）
- 十步操作分十次调用（每次等 AI 想一轮，1~3 秒）
- 长操作中途被用户碰鼠标打断，前功尽弃
- 出错了盲目重试，而不是先截图看发生了什么

这份技能把这些经验**固化下来**，AI 一装上就知道该怎么做。

## 装上之后

AI 在做任何"操作另一个应用"的任务时会自动使用这个技能，表现为：

- 动手前先截图定位（而不是猜坐标）
- 一次调用做完一串操作（快得多）
- 需要不被打断时声明独占（你会看到"键鼠已锁定"浮标，**Ctrl+Q 可随时接管**）
- 做完再截一张确认

## 技能内容

```
skill/
  SKILL.md                      ← 核心心法（看→做→看 / 坐标换算 / 批量 / 独占 / 恢复）
  references/coordinates.md     ← 坐标换算细节（多显示器、高 DPI）
  references/tool-reference.md  ← 两个工具的完整参数速查
  scripts/
    find-window.ps1             ← 按进程/PID 枚举窗口：hwnd / class / 精确 rect / dpi
    window-bounds.ps1           ← 还原→改尺寸→激活，打印前后矩形对比
```

### 两个辅助脚本（0.1.7 起）

都是**实测踩坑后写的**，解决「知道该怎么做、但真做起来总会错」的那部分：

| 脚本 | 解决什么 |
|---|---|
| `find-window.ps1` | 多实例分不清是哪个窗口（标题可能相同、甚至为空）；DPI 感知读取，坐标与截屏插件同一空间 |
| `window-bounds.ps1` | 对**最大化**窗口 resize 会得到 `900x65535` 垃圾尺寸；`AppActivate` 在多实例下静默失败 |

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/find-window.ps1 `
    -Match claude-code-gui -Class "Tauri Window" -VisibleOnly

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/window-bounds.ps1 `
    -Hwnd 0x50816 -Left 40 -Top 40 -Width 900 -Height 640
```

### 0.1.7 技能新增的坑（都是实测）

- **会变形的目标**：悬停展开的控件（侧边栏、悬浮卡片）坐标会在鼠标靠近时失效
- **PowerShell 变量名大小写不敏感**：`$H` 与 `$h` 是同一个变量，静默互相覆盖
- **`.ps1` 必须 UTF-8 带 BOM**，否则中文注释会让 PowerShell 报出无关的 C# 语法错
- **自家 Web 应用优先 DOM 测量**（`getBoundingClientRect`），比截图量像素准得多
- **别绕过插件用裸 Win32 发鼠标事件**（没有指示窗、没有 Ctrl+Q、没有输入锁）

## 实现说明（给好奇的人）

技能目录是**链接**进 `~/.claude/skills/` 的（Windows 用 junction，免管理员权限）：

```
~/.claude/skills/computer-use  ──链接──▶  <插件目录>/computer-use/skill/
```

这样**插件目录是唯一来源**：改插件里的技能文件立刻生效，不会出现"技能目录里还是旧副本"。
卸载插件时链接会被自动清掉（宿主在每次插件重扫时同步）。

## 卸载

直接卸载即可。**依赖它的东西没有**；但反过来 —— 卸载 `mouse-keyboard` 或 `screenshot`
**会失败**（本插件依赖它们），要先卸载本插件。
