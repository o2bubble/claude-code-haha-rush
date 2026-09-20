# 透明窗口 Playbook —— Windows / WebView2 / Tauri

> **什么时候看这个**：要做「浮在屏幕上、能看见背后内容」的窗口时（教鞭指示器、
> 屏幕标注、悬浮工具栏、取色器、放大镜…）。
>
> **结论先行**：
> 1. **要透明 + 要穿透** → 用**原生绘制窗口**（`UpdateLayeredWindow`），别用 WebView2
> 2. **只透明 + 不需要穿透**（或接受不穿透）→ WebView2 可行，但注意下面的三个坑
> 3. WebView2 的透明**窗口层早就通了**，坑几乎都在**页面层**

来源：2026-09-18 ~ 09-20 为 pointer 插件做教鞭的完整排查（含 10+ 种失败尝试）。

---

## 一、决策树（先看这个）

```
需要一个浮在屏幕上的窗口
│
├─ 需要点击穿透吗？（用户要能点到底下的东西）
│   │
│   ├─ 需要 → 【原生绘制窗口】
│   │         · Python: PIL + UpdateLayeredWindow（见 plugins/pointer/render.py）
│   │         · Rust:  UpdateLayeredWindow 或 Direct2D
│   │         · ✅ 透明 ✓ 穿透 ✓ 光标 ✓
│   │         · ❌ 只有前端能力之外的东西要做（动画/滤镜要手写）
│   │         · 但注意：**纯 Win32 窗口天然可穿透**（无子窗口树）
│   │
│   └─ 不需要 → 【WebView2 / Tauri 窗口】
│               · ✅ 完整前端能力（动画/渐变/滤镜/字体）
│               · ⚠️ 必须处理下面第二节的三个坑
│
└─ 只是想要圆角/异形？→ 也需要透明，同上
```

**关键洞察**：穿透之所以在 WebView2 上无解，是因为 **WebView2 会创建自己的
子窗口树，且渲染进程是独立的**（见第三节）。**纯 Win32 layered 窗口没有这个问题**。

---

## 二、WebView2 透明：三个必须知道的坑

### 坑 ① 页面背景色（**最常见、最难查**）

**症状**：窗口层指标全对（exstyle 正常、`transparent(true)` 已设），但屏幕上
**全黑 / 全白**。

**根因**：**页面自己画了背景色**。窗口透明了，但页面不透明 —— 一样看不到背后。

本项目实例（两处叠加）：
```javascript
// gui/index.html —— 为截图框选防白闪而【故意】加的
if (location.hash.indexOf("#overlay/") === 0)
  document.documentElement.style.backgroundColor = "#000";
```
```css
/* gui/src/tokens.css —— 主题背景，所有窗口共用 */
html { background: var(--bg-root); }
```

**修法**：给"要透明的窗口"的 URL 带标记，页面据此**不铺任何底色**：
```
https://.../index.html?overlay-clear=1#overlay/...
```
```javascript
if (location.search.indexOf("overlay-clear=1") >= 0)
  document.documentElement.style.background = "transparent";
```
（内联样式优先于 CSS 文件，且运行时没有 JS 覆盖它）

**⚠️ 排查铁律**：
> 窗口"全黑/全白"时，**先问一句"是不是页面自己画的"**。
> 在页面里 `document.body.style.background` 一查便知 ——
> 比读窗口 API / 试合成方案**快一个数量级**。

**这个坑我绕了 3 天才发现** —— 期间试了 10 种窗口层方案（见第五节），全无效，
因为方向从一开始就偏了。

### 坑 ② `WS_EX_NOREDIRECTIONBITMAP`（DComp 合成路径）

**症状**：窗口带 `transparent` 也没用，WebView2 内容仍渲染成实心。

**根因**：没有该标志时，窗口走 **GDI 重定向表面**，WebView2 的透明背景不生效。

**⚠️ 关键限制**：**该标志只能在 `CreateWindowEx` 时设**。
运行时用 `SetWindowLongPtrW` 补设**无效**（实测：写入后读回仍是旧值）。

**tao/Tauri 的现状**：
- tao 有 `WindowBuilder::with_no_redirection_bitmap(true)`，**默认 false**
- Tauri 2.11.5 **未暴露** → 需要 patch `tauri-runtime-wry`
- 本项目已 vendor + patch：`gui/src-tauri/vendor/tauri-runtime-wry/`
  （改动标 `PATCH(gui:overlay-transparency)`，共 3 处；**升级 Tauri 时必须重打**）

### 坑 ③ 框架自己铺的"防闪烁底色"

**症状**：透明窗口仍显示为一层不透明色（黑或白）。

**根因**：`tauri-runtime-wry` 对透明窗口会创建 softbuffer surface 并
`fill(color) + present()`，而 **softbuffer 的 buffer 是 XRGB（无 alpha）**：
```rust
// tauri-runtime-wry/src/window/windows.rs  draw_surface
let color = background_color.map(|(r,g,b,_)| ..)   // ← `_` 丢掉了 alpha
  .unwrap_or(0);                                    // ← 兜底黑色
buffer.fill(color);
```
它的本意是"内容就绪前防白闪"，但对真透明窗口只会坏事。

**修法**：对透明窗口**跳过** surface 创建（`create_window` 的两条路径各一处）。
本项目已在 vendor 里 patch。

---

## 三、穿透：为什么 WebView2 做不到（**硬限制**）

### 实测数据

```
WindowFromPoint(目标点) 的返回：
  输入目标: pid=16156  Chrome_RenderWidgetHostHWND   ← WebView2 浏览器进程的子窗口
  我能操作: pid=5540   Tauri Window / WRY_WEBVIEW     ← 宿主进程的窗口
                        ↑ 完全不同的进程，不在一条窗口树上
```

### 三条路都试过，都无效

| 方案 | 为什么失败 |
|---|---|
| `WS_EX_TRANSPARENT`（顶层 + 全部子窗口，轮询设置）| `HTTRANSPARENT` 的"继续传给下层"**只在同线程窗口链内有效**；WebView2 子窗口在另一个进程 → **链路断掉** |
| `EnableWindow(FALSE)`（顶层 + 全部子窗口）| MSDN 说 disabled 窗口不接收输入 —— 但**只作用于本进程窗口**；输入目标是别的进程 |
| 两者并施 | 同上 |

### 结论

**要让另一个进程的窗口"吐回"鼠标输入，只能 hook 它的窗口过程（DLL 注入）** ——
成本极高、脆弱、不值得。

**⚠️ 不穿透 = 绑架用户操作**（用户原话："弹出期间用户完全无法做其他任何交互，
有点绑架的意思…万一 AI 做错了什么，我就只能等逃生了"）。**不要发布这样的覆盖层。**

### 纯 Win32 窗口为什么没这个问题

`render.py` 建的 layered 窗口**没有子窗口树**，`WS_EX_TRANSPARENT` 直接作用在它身上
→ 穿透正常 ✓（本项目实测）。

---

## 四、诊断方法（能省下大量时间）

### ✅ 推荐：决定性对照实验

**把页面换成完全空白**（不画任何东西）再开窗：
- 仍是**纯白/纯黑** → 来自 **WebView2 内容层**（坑 ①②③）
- 变**透明** → 来自页面内容

这一步能把问题**一刀劈成两半**（窗口层 vs 页面层），我靠它才锁定了方向。

### ✅ 推荐：直接读窗口状态

```python
# exstyle 的关键位
WS_EX_NOREDIRECTIONBITMAP = 0x00200000   # DComp 合成路径（透明的前提）
WS_EX_TRANSPARENT         = 0x00000020   # 鼠标穿透
WS_EX_LAYERED             = 0x00080000   # 经典分层窗口
```
本项目宿主有诊断日志：`overlay <label> bits: exstyle=0x... NOREDIR=1 CLICKTHRU=1`

### ❌ 不要用：GDI 截图判断透明

截图工具对 layered / DComp 窗口常把**透明区域渲染成黑** → 会得出**反向结论**。
**本项目被骗过两次**（我一度以为"透明成功了"，其实截图骗人）。

**窗口颜色一律以人眼实测为准**，或用 `GetPixel` 读实际屏幕像素。

---

## 五、已试过且无效的方案（**别再走弯路**）

以下都是**窗口层**方案，在"页面层才是真根因"的场景下**注定无效**：

| 方案 | 结果 |
|---|---|
| `with_transparent(true)` 建窗（tao 的 DwmEnableBlurBehindWindow 路径）| ❌ |
| `WS_EX_LAYERED` + `SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)` | ❌ |
| `SetWindowCompositionAttribute`（ACCENT_ENABLE_*，DWM 合成）| ❌ |
| `DwmEnableBlurBehindWindow`（空区域 / 整窗口区域两种）| ❌ |
| `with_background_color(0,0,0,0)`（不声明 transparent）| ❌ |
| `--disable-gpu-compositing`（禁用 GPU 合成）| ❌ |

⚠️ **不要在 DComp 路径上再叠经典 `WS_EX_LAYERED`** —— 两套合成机制混用，
行为不可预期。

**唯一有效的是**：`WS_EX_NOREDIRECTIONBITMAP`（建窗时设）+ 页面不铺底色 + 跳过
softbuffer 底色 —— 三件事**同时成立**。

---

## 六、如果要做透明窗口插件：可直接复用的东西

| 资产 | 位置 | 说明 |
|---|---|---|
| **原生绘制 + 推送** | `plugins/pointer/render.py` | PIL 绘制 → 预乘 alpha → `UpdateLayeredWindow`。**透明 + 穿透 + 光标全正常** |
| 裸 wry 实验工程 | `temp/wry-probe/`（gitignored）| 11 种方案一键跑（`cargo run -- <方案名>`），**与宿主同版本** |
| 纯 Win32 对照 | `temp/probe_layered.py` | 证明系统支持透明（不经过任何框架）|
| 原生绘制验证 | `temp/probe_native_pointer.py` | 最小可用的教鞭绘制 |
| vendor patch | `gui/src-tauri/vendor/tauri-runtime-wry/` | 3 处补丁（NOREDIRECTIONBITMAP + 跳过 softbuffer）|

### 若要用 WebView2 做透明窗口（不做穿透）

1. 建窗时：`with_transparent(true)` + `with_no_redirection_bitmap(true)`
   （Tauri 需 patch；或用裸 wry）
2. 页面：**不铺任何底色**（`html, body { background: transparent }`，
   并检查有没有别的地方设了背景 —— 见坑 ①）
3. **不要**设 `cursor: none`（会隐藏用户光标，且它自证了"鼠标事件到了页面"）
4. 预期限制：**点击会被窗口吃掉**（用户点不到底下的东西）

### 若要用原生绘制（推荐，穿透可用）

参考 `plugins/pointer/render.py` 的结构：
```
PIL 画图（超采样抗锯齿）→ 预乘 alpha → CreateDIBSection → UpdateLayeredWindow
+ 窗口用 WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT
+ 硬超时兜底（防"关不掉锁死屏幕"）
```

---

## 七、快速检查清单

做透明窗口时逐项核对：

- [ ] **穿透需求**明确了吗？（要穿透 → 别用 WebView2）
- [ ] 页面里**所有**背景色都查了吗？（`index.html`、全局 CSS、组件内联样式）
- [ ] 建窗时设了 `WS_EX_NOREDIRECTIONBITMAP` 吗？（只能在建窗时）
- [ ] 框架有没有给透明窗口铺"防闪烁底色"？（softbuffer / 类似机制）
- [ ] **没有**用 GDI 截图判断透明（会被骗）
- [ ] 有**硬超时兜底**吗？（万一同层出错，别让用户等）
- [ ] 如果做了覆盖层：**不穿透会绑架用户**，确认可接受吗？

---

## 相关

- `docs/HANDOFF.md` 2026-09-18 / 09-20 章节（完整排查过程）
- 记忆 `domain:tauri`「WebView2 窗口透明」条目（结案版）
- `plugins/pointer/AI_NOTES.md`（pointer 侧的实现细节）
