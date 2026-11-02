---
name: office-bridge
description: 操作当前打开的 Office / WPS 文档（Excel、Word、PPT）—— 通过 office_get_context + office_execute 两个 MCP 工具，Windows 走 win32com、macOS 走 osascript。当用户要读写桌面版表格/文档/演示、或操作 WPS 时使用。
---

# Office MCP

两个工具，操作**用户当前打开**的文档（不是新建离线文件）。

| 工具 | 用途 |
|---|---|
| `office_get_context` | 检测哪个应用在跑、打开了什么。**每次动手前先调** |
| `office_execute` | 执行代码操作当前文档。**绝大多数操作走它** |

Windows 走 win32com（COM）；macOS 走 osascript（AppleScript）。
**网页版的 WPS / 金山文档 COM 够不着** —— 那走 `wps-online-sheet` 技能。

## Windows — `office_execute` 预定义变量

进 `office_execute` 时这些已经就绪，**不需要 import**：

| 变量 | 说明 |
|---|---|
| `xl` / `wd` / `ppt` | Excel / Word / PowerPoint 对象，**未打开则为 `None`** |
| `apps` | `{'excel': xl, 'word': wd, 'ppt': ppt}` |
| `Dispatch` | 启动**新** COM 实例 |
| `GetActiveObject` | 附加到**已运行**实例（查 ROT）。**WPS 直连推荐** |
| `GetObject` | ⚠️ **单参 `GetObject(progid)` 会被当文件路径解析 → "无效的语法"**。server 已包装成：单参且不含路径字符时自动转 `GetActiveObject` |
| `constants` | Office 枚举常量 |
| `RGB(r,g,b)` | 颜色 → BGR 整数 |
| **`result`** | **必须赋值才能把数据返回给模型**（`result = data`） |

**WPS 自动适配**：`Excel.Application` → `KET.Application.9`，Word → `KWPS.Application.9`，
PPT → `KWPP.Application.9`。**COM 对象模型完全相同，不用写分支。**

可见性：`xl`/`wd`/`ppt` 已附加到用户窗口，**不要设 Visible**；`Dispatch()` 建的新实例
默认隐藏，要用户看到才 `xl2.Visible = True`。

## 七条硬规则

1. **先 `office_get_context`**，别猜当前开的是哪个应用。
2. **`result = ...`** 否则模型什么都拿不到（这是最常见的"没反应"）。
3. **索引全部 1-based** —— 行、列、幻灯片编号从 1 开始。
4. **Word 的 UI 类操作需要窗口前台** —— `TypeText` / `Font` 前先 `wd.Activate()` + `time.sleep(0.2)`。
5. **新建实例要收尾** —— `xl2.Quit()` 释放，否则残留后台进程。
6. **COM 会因文档状态抛 `COMError`** —— 包 try/except 并把错误写进 `result`。
7. **应用没开 / 无权限时** —— 回退文件级：`openpyxl` / `python-docx` / `python-pptx`。

## 常用操作（Windows / Python COM）

```python
# Excel 读
result = xl.ActiveSheet.UsedRange.Value        # tuple of tuples
# Excel 写
xl.ActiveSheet.Range("A2:C2").Value = ["列1","列2","列3"]
# Excel 格式
rng = xl.ActiveSheet.Range("A1:C1")
rng.Font.Bold = True; rng.Interior.Color = RGB(255,255,0); rng.Columns.AutoFit()
# Excel 公式 / 排序
xl.ActiveSheet.Range("D2").Formula = "=SUM(A2:C2)"
xl.ActiveSheet.Range("A1:D10").Sort(Key1=xl.ActiveSheet.Range("D2"), Order1=1)

# Word 读 / 追加
result = wd.ActiveDocument.Content.Text
wd.ActiveDocument.Content.InsertAfter("\n新内容")
# Word 格式（需前台）
sel = wd.Selection; sel.Font.Bold = True; sel.ParagraphFormat.Alignment = 1   # 1=居中

# PPT 读
for shape in ppt.ActivePresentation.Slides(1).Shapes:
    if shape.HasTextFrame: print(shape.TextFrame.TextRange.Text)
# PPT 写
slide = ppt.ActiveWindow.View.Slide
slide.Shapes.AddTextbox(1, 100, 100, 400, 100).TextFrame.TextRange.Text = "新文本"
```

## macOS（仅当平台是 mac 时读这一节）

**动手前先查 `.sdef` 字典** —— AppleScript 属性名容易臆造：
```
/Applications/Microsoft Word.app/Contents/Resources/Word.sdef
/Applications/Microsoft Excel.app/Contents/Resources/Excel.sdef
/Applications/Microsoft PowerPoint.app/Contents/Resources/PowerPoint.sdef
```
读法：`sdef "/Applications/Microsoft Word.app"` 或 `plutil -convert xml1 -o - "<path>.sdef"`。
不确定就先跑只读探测（`properties of <element>`、`count of <collection>`）再改。

**已踩的坑**：

| 写法 | 结果 |
|---|---|
| `set text of paragraph N ...` | 报"成功"但**不写入**（text range 没有 `text` 属性）→ 改用 **`content`** |
| `set content of active document` | `-10006`（active document 的 content 是 missing value） |
| `make new text` | `-2710`，不支持该类 |
| 逐段 `set content` + `make new paragraph` | 文字串接/错位、段数乱变（text object 连着整个主文本 story） |
| 一条脚本连读多格 `A1 & B1 & ...` | 可能 `-10006` → 用 `try/on error`，或一次一格 |
| `make new presentation` 后 `count of slides` | = **0** → 先 `make new slide at end of active presentation` |
| 单行 `try` 块 | `-2741` → **必须多行** |
| 用中间变量 / `repeat ... count` 循环 | `-2753 变量未定义` → 多用 `return <表达式>` |
| 写 `return` / `result` 变量 | `-2753`（那是 Windows COM 的约定，mac 不需要） |

**大原则**：查 `.sdef` 确认属性 → 用真实属性 → 读回验证后再改。
