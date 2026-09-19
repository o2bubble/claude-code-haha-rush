# AI_NOTES — screenshot（截屏插件）

截屏工具。贡献：2 个面板（`main` 截屏历史 + 手动触发；`preview` 独立预览浮窗）、
3 条命令（区域/全屏/窗口，区域那条带全局热键）、1 个后台进程 `screenshot-server`
（Node，负责抓屏/裁剪/落盘）。**不产生其它进程。**

## 平台检测（先做）

支持的平台见 plugin.json 的 `platforms`（windows/macos/linux）。各平台实现不同，**先确认当前平台**再往下走：
`node -p process.platform` → `win32` / `darwin` / `linux`。

> ⚠️ **Linux 当前是未实现状态**：抓屏走的是 Windows(PowerShell+.NET) 与 macOS(`screencapture`)
> 两条系统路径，Linux 上两者都没有 → 截图会失败。若用户在此平台提问，如实说明**不支持**，
> 不要尝试安装 X11/Wayland 抓屏工具去凑。

## 架构（理解这个才能排查）

```
快捷键/面板 → 插件命令 → 宿主
                         ├─ 广播给已挂载的面板 iframe（面板打开时才有人收）
                         └─ HTTP 直达插件进程 POST /__command（**面板没开也能用**）
                              ↓ 进程返回 { host: [动作…] }
                            宿主执行这些动作：open-overlay / chat-reference / desktop-image …
                              ↓
                        需要框选时：宿主开全屏 overlay 窗口 → 加载 overlay.html
                              ↓ 用户拖框
                        overlay → 插件进程 /crop → 裁剪落盘 → overlay 把 host 动作回传宿主
```

**关键点**：插件进程**开不了窗口**，也**够不到聊天框/超桌**。所以"要窗口"和"要投递"都得请宿主做
（`host` 动作数组 / overlay 的 postMessage）。进程只做它独有的两件事：**抓屏**与**裁剪**。

## 故障模式与诊断

### 1. 按快捷键没反应
按这个顺序查（**别跳步**）：

1. **进程起来了吗** —— 调 `plugin_list`，看 screenshot 的 processes 里 `screenshot-server` 是不是
   `running`。若卡在 `starting`，见下面第 3 条。
2. **工作区绑定了吗** —— 进程声明的是 `startOn: "workspace_bound"`。**没绑定工作区时进程根本不会启动**
   （这是设计，不是故障）。绑定后 GUI 会自动拉起它。
3. **快捷键注册上了吗** —— 设置 → 快捷键，找「截屏：区域」那一行。
   - 显示红色「注册失败」→ **被别的软件占用了**（微信/QQ/其它截图工具的默认键常常就是 Ctrl+Shift+*）。
     让用户改一个键即可。
   - 全局热键是**进程级独占**的：多开一个 GUI 实例也会抢占。若用户开了两个 GUI，只有先注册的那个能用。
4. **宿主的直达通道通不通** —— 命令是经 `POST http://127.0.0.1:<port>/__command` 送到进程的。
   手动验：
   ```
   curl -s http://127.0.0.1:<port>/ping      # 应返回 {"ok":true,...}
   curl -s -X POST http://127.0.0.1:<port>/__command -H "Content-Type: application/json" -d '{"command":"fullscreen"}'
   ```
   第二条应返回 `{ok:true, shot:{...}, host:[...]}`。拿到了说明**插件侧全好**，问题在宿主侧
   （命令没转发 / host 动作没执行）。

### 2. 截出来是空白 / 全黑 / 只有壁纸
**macOS 上是权限问题**（最常见）：没有「屏幕录制」授权。
- 查：系统设置 → 隐私与安全性 → 屏幕录制，看本应用有没有勾选
- 修：勾选后**必须重启本应用**（macOS 不会给已运行的进程补权限）
- 也可以让用户跑 diagnostics：GUI 的诊断面板有屏幕录制权限检查项

**Windows 上**若全黑，通常是抓到了受保护内容（DRM 视频、独占全屏游戏）—— GDI 抓屏对这类内容无能，
如实说明是系统限制，别改代码。

### 3. 进程一直 starting / 报"未在超时内报告端口"
本插件的 server.cjs **必须在 stdout 第一行打印 `PLUGIN_PORT=<port>`**。宿主读到端口后就不再读 stdout。
- 若有人改过 server.cjs 让别的代码先写 stdout（比如加了 `console.log`），端口就永远读不到 →
  **这条是历史踩过的坑**，日志一律走 `console.error`（stderr）。
- 空端口/端口非数字也会被判失败（宿主只取 `PLUGIN_PORT=` 后的连续 ASCII 数字）。

### 4. 框选窗口没弹出来 / 弹了但图是黑
- **没弹**：查宿主日志里有没有 `open_plugin_overlay`。该动作由进程返回 `host:[{kind:"open-overlay"}]`
  触发，宿主再建窗口。若进程返回了但窗口没出现，看宿主日志的 `overlay build FAILED`。
- **弹了但图黑**：overlay 里的 `<img>` 指向 `http://127.0.0.1:<port>/frozen?token=...`。
  该 token 5 分钟过期；过期/不存在会返回 404（overlay 会显示"无法加载截图"）。重新触发一次即可。
- **多显示器**：overlay 只开在**光标所在那块**显示器（进程用 `Screen::FromPoint(cursor)` 定），
  冻结图也**只抓那一块** —— 所以坐标天然对齐。**不要**把抓屏改成抓整个虚拟桌面，那会让多屏错位。

### 5. 框选时选框**不跟鼠标**（松手才跟一下，然后窗口就关了、什么都没截到）
**这是 `<img>` 原生拖拽造成的，2026-09-16 实际踩过（v0.1.0 的 bug，v0.1.1 修复）。**

现象（用户的原话描述，非常有辨识度）：「点击进入拖动后，拖动鼠标框选不跟鼠标，
然后松开鼠标后这时候才跟，然后再点一下鼠标就结束了」。

**机理**：overlay 里那张铺满屏幕的冻结图是 `<img>`，而 `<img>` **默认 `draggable=true`**。
在图上按下左键拖动 → 浏览器把它当成**"拖拽图片"**：
- 拖拽期间浏览器**不再派发 `mousemove`**（只发 `drag` 系列事件）→ 选框纹丝不动
- 松手那一刻拖拽结束，坐标才更新一次 → 于是"松开后才跟"
- mouseup 时算出的宽高≈0 → 命中代码里的**误触保护** `if (w < 4 || h < 4)` → 走 `cancel()`
- 结果：冻结图被删、overlay 关闭、**没有任何裁剪文件产生**

**修法**（三处缺一不可，见 overlay.html）：
```css
#shot { pointer-events: none; -webkit-user-drag: none; user-select: none; }
```
```html
<img id="shot" alt="" draggable="false">
```
```js
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();   // 阻止原生拖拽 / 文本选择
  ...
});
```
`pointer-events: none` 让 `mousedown`/`mousemove` 冒泡到 `document`（框选逻辑本来就在
document 上，**不用改**）；`draggable="false"` + `-webkit-user-drag: none` 是双保险。

**怎么确认是这个 bug**（而不是别的问题）：
1. 操作一次后看系统临时目录有没有**残留** `snipfrozen-*.png`
   —— 冻结图**消失**说明走了 crop 或 cancel；**没有裁剪文件产生** → 一定是 cancel
2. 用真实鼠标输入拖框（**合成事件测不出来**，因为合成事件不触发浏览器原生拖拽），
   读 `#sel` 的 `style.width/height`：若拖了 260px 却只有 12px，就是这个 bug

### 6. 窗口模式：列表为空 / 点了没反应 / 截出来是黑图
窗口模式（Windows）的链路：**枚举窗口 → 冻结抓屏 → overlay 悬停高亮 → 点击 → `PrintWindow` 直抓**。
列表在**建 overlay 之前**就枚举好（否则 overlay 自己会混进列表、还占着 Z-order 最上层）。

- **列表为空** → `enumWindows()` 的 PowerShell 失败了（失败会打 stderr 日志）。
  ⚠️ 该脚本**必须纯 ASCII**：PowerShell 5.1 按系统代码页（GBK）读脚本，中文注释会让
  内嵌的 C# 编译失败，报错极具误导性（"名称不存在"、行号还指向无关的空行）。**这个坑踩过两次。**
- **点了没反应** → 命中测试用**物理像素**（`clientX * devicePixelRatio`）与窗口 rect 比对。
  DPI 缩放 ≠ 100% 时先确认 dpr 取对；用 `GET /windows?token=` 看列表坐标是否合理。
- **截出来是黑图** → `PrintWindow` 对部分 GPU 加速窗口（Chromium 内核 / 部分 UWP）返回全黑
  且**不报错**。代码已防护：采样像素检测全黑 → 上层回退为"从冻结图裁那块区域"
  （画面可能被遮挡物盖着，但能出图）。用户若反馈"窗口模式截到的是别的窗口"，就是回退生效了，
  属**已知限制而非 bug**。
- **验证 PrintWindow 真的生效**（而不是在回退）：把目标窗口**完全盖住**再截，
  看结果是不是目标窗口自己的内容。这是最可靠的判别方式。

### 7. 删不掉 / 点了「删除」没反应
- **只删截图目录内**的文件（`resolveInTargetDir` 一处校验，读与删共用）。目录外的
  一律拒绝并在 `failed` 里返回原因 —— 这是**设计**，不是 bug。
- **要点两次**才真删（第一次变「确认删除?」，3 秒不点自动收回）。
  ⚠️ 之所以不用原生 `confirm()`：插件面板的 iframe sandbox **没有 `allow-modals`**，
  原生弹窗会被浏览器**静默拦掉**（返回 false 且不报错）→ 表现为"点了没反应"。
  同理 **`window.open` / `alert` 也不可用**（sandbox 没有 `allow-popups`）——
  这就是「预览」必须走浮窗面板、不能在面板内开新窗口的原因。
- **某一张删不掉**：被别的程序占用（预览浮窗还开着那张图、或图片查看器开着）。
  进程会跳过它并返回 `failed`，其余照删。

### 8. AI 调用截屏工具失败
工具名是 `plugin_screenshot_fullscreen` / `plugin_screenshot_region`（宿主加命名空间
前缀；插件自己声明的只是短名 `fullscreen` / `region`）。

排查顺序：

1. **AI 看得到工具吗** —— 工具表在**会话加载时**刷新（`ideMode.ts` 的 `handleLoadSession`
   → `refreshMcpTools`）。装完/启用插件后**必须重开会话**，或让 AI 跑 `/mcp-refresh`。
   没重开 → AI 压根不知道有这两个工具（是刷新时机，不是故障）。
2. **进程在跑吗** —— 与快捷键那节同因：`startOn: workspace_bound`，**未绑工作区时进程
   不启动**。此时工具会报「插件「screenshot」的后台进程未运行」。
3. **平台** —— 清单 `platforms: ["windows","macos"]`。Linux 上宿主**不会暴露**这两个工具
   （聚合时按平台过滤），AI 看不到是正常的。
4. **直接打端点**（绕开宿主，判断是插件侧还是宿主侧）：
   ```bash
   curl -X POST http://127.0.0.1:<port>/__mcp -H "Content-Type: application/json" \
     -d '{"tool":"fullscreen"}'
   curl -X POST http://127.0.0.1:<port>/__mcp -H "Content-Type: application/json" \
     -d '{"tool":"region","args":{"region":{"x":100,"y":100,"w":320,"h":240}}}'
   ```
   返回 `{ok:true, path, image:{data,mimeType}, meta:{...}}` 说明插件侧全好。

**坐标约定**：`region` 是**物理像素、相对目标显示器左上角**（不是虚拟桌面绝对坐标）。
返回值里 `meta.monitorOrigin` 是这张图在虚拟桌面中的绝对原点，需要换算时用。
`meta.width/height` 是截图的实际像素尺寸 —— AI 若先截全屏再据此估区域，注意客户端可能
把大图 downsample（超 2000px 会缩），**别拿看到的图像尺寸当物理像素用**。

**返回值为什么分两块**：图片走 MCP image content（模型能直看），元数据走 text 块。
**base64 绝不能同时出现在 text 里** —— 1920×1080 的 PNG base64 约 30 万字符 ≈ 数十万
token，会瞬间撑爆上下文。宿主 `buildToolContent` 负责剥离，有单测锁住。

### 9. 让位（截图时最小化宿主窗口）：不生效 / 窗口回不来
「让位」= 截图前把宿主窗口最小化，让出被它挡住的画面（截图后恢复）。三条路径都走它：
快捷键/面板命令、AI 工具调用。

- **不生效** → 按顺序查：
  1. **设置关了吗** —— 设置 → 插件 → 截屏 的「截图时让开位置」（AI 调用还可能被
     工具参数 `clearScreen` 显式覆盖）
  2. **有没有宿主 PID** —— 靠 env `CLAUDE_PLUGIN_HOST_PID`（宿主 spawn 时注入）。
     手动跑起来的实例没有这个变量 → 静默跳过让位（不阻塞截图，是设计）。
     ⚠️ **不能用 `process.ppid` 顶替**：宿主退出后的孤儿进程其 ppid 指向已被复用的
     PID，会去最小化毫不相干的窗口（实测确认过这种情况真实存在）。
  3. **平台** —— 让位走 Win32 窗口 API，**只在 Windows 实现**；mac 上直接跳过。
- **窗口回不来** →
  - 区域/窗口模式：宿主在**关闭 overlay 时**回调 `POST /restore-host`。若 overlay 被
    Alt+F4 强关，宿主走不到那一步 → 窗口留在最小化，**用户点任务栏即可**；插件侧另有
    兜底（下次让位前先恢复残留，见 `hideHost` 开头）。
  - 全屏 / AI 调用：没有 overlay，抓完**立即恢复**（写在 `finally` 里，抓屏失败也恢复）。
- **验证手法**（可复用）：别只看调用前后的窗口状态 —— 那时已经恢复了，证明不了什么。
  用**并发轮询** `IsIconic(hwnd)`（Python `ctypes.windll.user32`，20ms 一次）抓最小化
  的瞬间。测试时**用一个假宿主窗口**（如 tkinter 起的窗口）当靶子，别拿真实 GUI 做实验。

### 10. 截完没送进聊天框
进程返回 `host:[{kind:"chat-reference",...}]`，宿主执行时调 `windowBus.emit(CHAT_ADD_REFERENCE)`。
- 该事件**不是 sticky**：若聊天输入框面板此刻没挂载，事件无人接收 → 静默丢失。
- **这是已知边界**，不是故障。图**一定已经落盘**了（去 `.claude/screenshots/` 找），
  用户可以从截屏面板的缩略图重新投递。

## 日志与状态位置

- 安装目录：`%APPDATA%/com.claudecode.gui/plugins/screenshot/`（mac：`~/Library/Application Support/`）
- 进程：`screenshot-server`（1 个）。**健康标志** = 能 `curl /ping` 通
- 进程日志：**stderr** → GUI 日志里带 `[plugin:plugin:screenshot:screenshot-server stderr]` 前缀
- 截图落盘：默认 `<工作区>/.claude/screenshots/`；若设置里填了「保存目录」则用那个绝对路径
- 冻结临时图：系统临时目录下的 `snipfrozen-*.png`（成功后即删；异常退出可能残留，可安全删除）
- GUI 主日志：`%APPDATA%/claude-code-gui/claude-code-gui.log`

## 配置依赖

- **dependencies**：无（`node` 由宿主解析：优先用 `nodejs` 插件提供的运行时，否则用系统 node）
- **platforms**：windows / macos 已实现；**linux 未实现**（见上）
- **installType**：standard
- **设置项**（在 设置 → 插件 → 截屏）：
  - `saveDir` 保存目录（留空 = 工作区 `.claude/screenshots/`）
  - `defaultDest` 默认去向（chat / desktop / file）—— **只影响快捷键与命令触发的路径**；
    从面板里点按钮时以面板上的选择器为准
  - `copyToClipboard` 同时写系统剪贴板

## 明确不是故障的现象

- **收不到更新检查提示**：插件版本变化不影响 GUI 版本，是两条独立的线。
- **注册失败标红**：见上面 1.3，是键被占了，不是插件坏了。
- **面板里写着"插件进程未就绪"**：多半是没绑定工作区（进程按设计不启动）。
- **截图没进聊天框但文件在**：见上面 10，输入框面板当时没挂载。
