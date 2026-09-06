# Office MCP — AI 操作指南

你拥有两个 MS Office / WPS 工具，通过 **MCP**（office MCP server）操作用户当前打开的文档。
server 在 GUI 启动时自动注册到 `~/.claude.json`（user scope，stdio 传输），以 `office_*` 工具暴露。
**Windows** 走 win32com（COM）驱动 MS Office / WPS；**macOS** 走 osascript（AppleScript）驱动 MS Office。

## 可用工具

| 工具 | 用途 |
|------|------|
| `office_get_context` | 检测当前运行的 Office/WPS 应用，返回文档信息。**每次操作前先调用它**，了解当前打开的是什么 |
| `office_execute` | 执行代码操作当前文档。**这是主要工具，几乎所有操作都通过它** |

## 使用流程

```
1. office_get_context  →  了解哪个应用在运行、打开了什么文档
2. office_execute      →  执行代码进行读写操作
```

## 平台差异

| 平台 | office_execute 执行内容 |
|------|------------------------|
| Windows | Python 代码，用 `xl`/`wd`/`ppt` COM 对象（见下方预定义变量） |
| macOS | AppleScript（osascript），如 `tell application "Microsoft Excel" to set value of cell 1 of row 1 to "hi"` |

## macOS — 操作前先查 .sdef 字典（重点）

AI 对 AppleScript 属性名不熟，**写脚本前先读对应 app 的 Scripting Definition 字典**（`.sdef`，mac Office 自带），确认元素/属性/命令名再写，不要臆造：

- Word: `/Applications/Microsoft Word.app/Contents/Resources/Word.sdef`
- Excel: `/Applications/Microsoft Excel.app/Contents/Resources/Excel.sdef`
- PowerPoint: `/Applications/Microsoft PowerPoint.app/Contents/Resources/PowerPoint.sdef`
- WPS: 类似 `.../Contents/Resources/*.sdef`（通过 `office_get_context` 拿到 app 路径后定位）

读 `.sdef` 的方式：`sdef "/Applications/Microsoft Word.app"`（打印字典）、或 `plutil -convert xml1 -o - "<path>.sdef"`；不确定的元素属性，先用 `office_execute` 跑只读探测，如 `properties of <element>` / `count of <collection>` 读回来确认。

## macOS — AppleScript 已踩的坑

- ❌ Word 文本：`set text of paragraph N ...` → 报"成功"但**不写入**；text range 无 `text` 属性，应改用 **`content`**
- ❌ `set content of active document` → `-10006`（active document 的 content 是 missing value）
- ❌ `make new text` → `-2710`，AppleScript 不支持该类
- ❌ 逐段 `set content` + `make new paragraph` → text object 连着整个主文本 story，会**文字串接/错位、段数乱变**
- ⚠️ Excel 一条脚本连续读多格（`A1 & B1 & ...`）可能 `-10006`，要 `try/on error` 或**一次只读一格**
- ⚠️ PPT `make new presentation` 后 `count of slides` = **0**，要先 `make new slide at end of active presentation`
- ⚠️ **AppleScript `try` 块必须多行**，单行报 `-2741`
- ⚠️ **少用中间变量**、少用 `repeat ... count` 循环，多用 `return <表达式>` 直接取值（否则 `-2753 变量未定义`）
- ⚠️ **mac 不需要写 `return`/`result` 变量**（那是 Windows COM 的约定），写了反而触发 `-2753`

**大原则**：先查 `.sdef` 确认属性 → 用真实属性 → 读回验证。不确定就先跑只读探测（`properties of ...`）确认再改，不要边猜边写。

## Windows — office_execute 预定义变量

进入 `office_execute`（Windows）时，以下变量已就绪：

| 变量 | 说明 |
|------|------|
| `xl` | Excel/WPS 表格对象，未打开则为 `None` |
| `wd` | Word/WPS 文字对象，未打开则为 `None` |
| `ppt` | PowerPoint/WPS 演示对象，未打开则为 `None` |
| `apps` | `{'excel': xl, 'word': wd, 'ppt': ppt}` |
| `Dispatch` | `win32com.client.Dispatch` — 启动**新** COM 实例 |
| `GetObject` | 附加到**已运行**实例。**单参 `GetObject(progid)` 会被当文件路径解析 → `无效的语法` 报错**；server 已包装成：单参且不是路径时自动转 `GetActiveObject(progid)`。想显式附加用 `GetActiveObject('KWPS.Application.9')` |
| `GetActiveObject` | `win32com.client.GetActiveObject` — 查 ROT 附加到已运行实例，**WPS 直连推荐**（`GetObject(None, progid)` 等价） |
| `constants` | `win32com.constants` — Office 枚举常量 |
| `RGB(r,g,b)` | 颜色转换函数，返回 BGR 整数 |
| `result` | **设置这个变量来返回数据给 AI**（如 `result = data`） |

## 可见性控制

- `xl`/`wd`/`ppt` 已附加到用户打开的窗口，**无需设置 Visible**
- `Dispatch()` 创建的新实例**默认隐藏**（`Visible=False`）
- 需要用户看到时：`xl2.Visible = True`

## MS Office vs WPS

server 自动检测：Excel.Application → KET.Application.9，Word.Application → KWPS.Application.9，PowerPoint.Application → KWPP.Application.9。
**COM 对象模型完全相同**，不需要写分支代码。

## 常用操作速查（Windows / Python COM）

### Excel — 读取数据
```python
ws = xl.ActiveSheet
data = ws.UsedRange.Value      # tuple of tuples
result = data                   # 返回给 AI
```

### Excel — 写入数据
```python
ws = xl.ActiveSheet
ws.Range("A1").Value = "标题"
ws.Range("A2:C2").Value = ["列1", "列2", "列3"]
```

### Excel — 格式化
```python
rng = ws.Range("A1:C1")
rng.Font.Bold = True
rng.Font.Color = RGB(255, 0, 0)          # 红字
rng.Interior.Color = RGB(255, 255, 0)    # 黄底
rng.Columns.AutoFit()
```

### Excel — 公式、排序、筛选
```python
ws.Range("D2").Formula = "=SUM(A2:C2)"
ws.Range("A1:D10").Sort(Key1=ws.Range("D2"), Order1=1)  # 1=升序
ws.Range("A1:D10").AutoFilter()
```

### Excel — 新建工作簿
```python
xl2 = Dispatch("Excel.Application")
xl2.Visible = True
wb = xl2.Workbooks.Add()
ws = wb.Worksheets(1)
ws.Cells(1, 1).Value = "Hello"
result = "新建完成"
```

### Word — 读写
```python
doc = wd.ActiveDocument
text = doc.Content.Text            # 读取全文
doc.Content.InsertAfter("\n新内容")  # 文末追加
wd.Selection.TypeText("选中位置")    # 光标处插入
```

### Word — 格式
```python
sel = wd.Selection
sel.Font.Bold = True
sel.Font.Size = 14
sel.ParagraphFormat.Alignment = 1   # 1=居中, 0=左, 2=右
```

### PPT — 读取幻灯片
```python
pres = ppt.ActivePresentation
slide = pres.Slides(1)              # 1-based
for shape in slide.Shapes:
    if shape.HasTextFrame:
        print(shape.TextFrame.TextRange.Text)
```

### PPT — 写入文本
```python
slide = ppt.ActiveWindow.View.Slide
tb = slide.Shapes.AddTextbox(1, 100, 100, 400, 100)
tb.TextFrame.TextRange.Text = "新文本"
```

### 检查应用是否打开
```python
if xl is None:
    result = "Excel 未打开，请先打开 Excel/WPS 表格"
else:
    result = f"当前工作表: {xl.ActiveSheet.Name}"
```

## 注意事项

1. **先 office_get_context 再操作** — 确认哪个应用在运行
2. **设置 result** — 代码执行完后必须 `result = ...` 才能返回数据
3. **1-based 索引** — Office COM 的行、列、幻灯片编号都从 1 开始
4. **错误处理** — COM 可能因文档状态异常而抛出 COMError
5. **关闭清理** — 如果启动了新实例，操作完考虑 `xl2.Quit()` 释放资源
6. **Word UI 写需窗口前台** — TypeText/Font 等 UI 自动化要求 Office 窗口在前台，先 `wd.Activate()` + `time.sleep(0.2)`
7. **Office 未打开/无权限** — 工具返回错误时，回退文件级操作：openpyxl / python-docx / python-pptx
