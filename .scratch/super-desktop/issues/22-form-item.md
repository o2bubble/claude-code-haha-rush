# 22 — FormItem：可编辑表单块

**Status:** completed (draft — 凑活用)

**What to build:** 新增 `form` 内容块类型，用户可手动添加字段（10 种控件），经典 label: input 纵向布局。双模式设计——正常模式纯展示+填写，配置模式调整字段参数。AI 可构造/修改表单，用户以 `@ref{desktop-item:form/<uuid>}` 发给 AI。

---

## Design

### 数据模型

```ts
type FormFieldType = "text" | "textarea" | "number" | "checkbox" | "select"
  | "date" | "switch" | "radio" | "color" | "slider";

interface FormField {
  id: string;
  name: string;         // 中文名
  type: FormFieldType;
  value: unknown;
  options?: string[];   // select/radio 选项
  placeholder?: string;
  required?: boolean;
  min?: number;         // number/slider
  max?: number;
  step?: number;
  maxlength?: number;   // text
  rows?: number;        // textarea
}

interface FormContent {
  type: "form";
  fields: FormField[];
}
```

### 双模式

| 模式 | 显示 |
|------|------|
| **正常模式** | label + 控件（纯填写） |
| **配置模式** (⚙) | [⠿] label + 配置区（提示文字、必填、类型专属参数）+ [×] |

### 配置模式 — 每字段类型专属配置

| 字段类型 | 配置项 |
|----------|--------|
| text | 提示文字、必填、最大长度 |
| textarea | 提示文字、必填、行数 |
| number | 提示文字、必填、最小值、最大值、步长 |
| checkbox/date/switch/color | 提示文字、必填 |
| select | 选项(chip编辑器)、提示文字 |
| radio | 选项(chip编辑器) |
| slider | 最小值、最大值、步长 |

### 选项编辑器

select/radio 用 chip 标签式编辑器：
- 每个选项显示为蓝色 tag `[选项名 ×]`，点 × 删除
- 尾部输入框 + `+` 按钮添加新选项，回车也可添加

### 交互

| 操作 | 方式 |
|------|------|
| 模式切换 | 底部 `⚙ 配置` / `✓ 完成` 按钮 |
| 添加字段 | 配置模式下 "+ 添加字段" → popover（类型+中文名） |
| 删除字段 | 配置模式下 × 按钮 |
| 字段排序 | 配置模式下拖 ⠿ 手柄（mouse 事件，非 HTML5 DnD） |
| 编辑字段名 | 配置模式下双击 label |
| Reset | 底部按钮，重置所有值为默认 |
| Send to Agent | 右键 → `@ref{desktop-item:form/<uuid>}` chip |

### AI 操作

通过 data registry `executeOperation`：
```ts
{ op: "update_fields", data: FormField[] }         // 替换整个 fields
{ op: "set_values", data: { [fieldId]: value } }   // 批量设值
```

---

## Files Changed

| File | What |
|------|------|
| `types/desktop.ts` | `FormFieldType`, `FormField`, `FormContent`, `ItemContentType += "form"` |
| `components/desktop/FormItem.tsx` | ~400 lines: 双模式、10种控件、配置面板、chip选项编辑器、mouse拖拽排序 |
| `components/desktop/DesktopItemView.tsx` | `case "form": <FormItem>` |
| `components/desktop/SuperDesktopCanvas.tsx` | 右键菜单 +"Add Form" |
