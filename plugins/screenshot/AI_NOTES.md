# AI_NOTES — screenshot（截屏插件）

截屏工具。贡献：1 个面板（截屏历史 + 手动触发）、3 条命令（区域/全屏/窗口，区域那条带全局热键）、
1 个后台进程 `screenshot-server`（Node，负责抓屏/裁剪/落盘）。**不产生其它进程。**

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

### 5. 截完没送进聊天框
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
- **截图没进聊天框但文件在**：见上面 5，输入框面板当时没挂载。
