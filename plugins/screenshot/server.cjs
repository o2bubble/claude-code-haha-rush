#!/usr/bin/env node
// ── 截屏插件 · 后台进程 ──
//
// 职责：抓屏、区域的冻结/裁剪、落盘、列历史。**投递**（送聊天/超桌）不在这里 ——
// 那些能力只有宿主有，本进程通过 HTTP 响应里的 `host` 数组请求宿主执行（见
// 宿主侧 pluginCommandBridge.forwardToPluginProcess）。
//
// ## 三条硬约束（违反会静默出问题，都实测踩过）
//
// 1. `PLUGIN_PORT=` 必须是 **stdout 的第一行、也是最后一行**。
//    宿主读到端口后**停止读 stdout**（plugin_process.rs），之后任何 stdout 写入
//    都会 EPIPE；而"宿主没读出端口"会让进程永远停在 starting（它的 20s 超时只在
//    **收到行**时才检查，一行不打印就永不触发）。→ 日志一律走 stderr。
// 2. spawn 任何系统命令都要 `windowsHide: true`，否则 Windows 上闪黑框
//    （宿主的 CREATE_NO_WINDOW 只作用于直接子进程，不传给孙子进程）。
// 3. 抓屏后**强制 alpha=255** —— GDI 抓屏常返回全 0 的 alpha，PNG 看着是透明的。

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

/** 插件设置（宿主随每次命令下发；面板也可 PUT 过来）。 */
let settings = {
  saveDir: "",
  defaultDest: "chat",
  copyToClipboard: true,
};

/** 工作区（宿主在 spawn 时经 env 注入）—— 默认保存位置就是它下面的 .claude/screenshots */
const WORKSPACE = process.env.CLAUDE_PLUGIN_WORKSPACE || "";

/** 待框选的冻结截图：token → { file, width, height, monX, monY, dpr } */
const pending = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function log(...a) {
  // 见文件头约束 1：stderr 才是安全的日志通道
  console.error("[screenshot]", ...a);
}

// ── 让位：截图时把宿主窗口最小化 ──────────────────────────────────────
//
// 为什么需要：截图要拿到"没有被 GUI 挡着"的画面。GUI 在前台时冻结图里就是 GUI，
// 想截它**后面**的窗口根本做不到 —— 而按热键本身又要求 GUI 在前台，是个死循环。
// 让位把这个环打开：先让开，再抓屏。
//
// 为什么在**进程侧**做（而不是宿主）：抓屏发生在这里，而触发路径有三条
// （快捷键 / 面板按钮 / AI 调用），其中**面板那条是 iframe 直接 fetch，绕过宿主 JS** ——
// 只有放在进程侧才能三条统一。
//
// 宿主 PID 由宿主 spawn 时注入（见 plugin_process.rs 的 CLAUDE_PLUGIN_HOST_PID）。
// ⚠️ 不能用 `process.ppid` 顶替：宿主退出后的**孤儿进程**其 ppid 指向的是已被
// 回收复用的 PID，会去最小化毫不相干的窗口。实测确认这种情况真实存在。

/** 被我们最小化的宿主窗口句柄。恢复时只动这些 —— 用户自己最小化的窗口不碰。 */
let hiddenHostWindows = [];

/** 让位是否开启（设置项，缺省开）。 */
function clearScreenEnabled() {
  return settings.clearScreen !== false;
}

/**
 * 最小化宿主窗口（让开位置）。
 *
 * 最小化宿主 PID 的**全部可见顶层窗口**（主窗 + 开着的浮窗），而不是只挑主窗：
 * 插件进程分不清哪个是主窗（Tauri 的 label 在 Win32 层看不到），而且"让开位置"
 * 本来就该让 GUI 整体让开。已经是最小化的窗口**不动**（那可能是用户自己收起来的）。
 *
 * @returns 被最小化的窗口数（0 = 没让位 / 失败）
 */
async function hideHost() {
  if (!IS_WIN) return 0;                 // 让位走 Win32 窗口 API，mac 未实现
  const pid = Number(process.env.CLAUDE_PLUGIN_HOST_PID) || 0;
  if (!pid) return 0;                    // 没有宿主 PID（手动跑的实例）→ 跳过，不阻塞截图

  // 兜底：上一次让位没走到恢复（overlay 被 Alt+F4 强关、宿主异常退出等）——
  // 先把残留还回去再重新让位。不这么做的话句柄列表会被这次的覆盖，
  // 那批窗口就永远回不来了（用户只能手动点任务栏）。
  if (hiddenHostWindows.length) await restoreHost();

  try {
    const r = await run("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HIDE_HOST_SCRIPT(pid),
    ]);
    if (r.code !== 0) {
      log("hideHost failed:", r.err || r.out);
      return 0;
    }
    hiddenHostWindows = r.out.trim().split(",").filter((s) => s && s !== "0");
    if (hiddenHostWindows.length) {
      // 等最小化动画播完再抓屏 —— 动画期间抓会拿到半透明/中间态的窗口，
      // 那比"有没有 GUI"更难看出问题（画面看着正常，其实糊了一层）。
      await new Promise((res) => setTimeout(res, HIDE_SETTLE_MS));
    }
    return hiddenHostWindows.length;
  } catch (e) {
    log("hideHost error:", e && e.message);
    return 0;
  }
}

/** 恢复那些被我们最小化的宿主窗口（没让位过则 no-op）。 */
async function restoreHost() {
  if (!hiddenHostWindows.length) return;
  const ids = hiddenHostWindows.join(",");
  hiddenHostWindows = [];
  try {
    await run("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", RESTORE_HOST_SCRIPT(ids),
    ]);
  } catch (e) {
    log("restoreHost error:", e && e.message);
  }
}

/** 最小化动画的等待时长。太短会抓到中间态，太长则用户干等。 */
const HIDE_SETTLE_MS = 380;

/** 枚举宿主进程的可见顶层窗口并最小化（纯 ASCII —— PowerShell 5.1 按 GBK 读脚本）。 */
function HIDE_HOST_SCRIPT(pid) {
  return `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class HostWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);

  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const int SW_MINIMIZE = 6;

  static uint target;
  static List<IntPtr> found;

  public static string Hide(uint pid) {
    target = pid;
    found = new List<IntPtr>();
    EnumWindows(new EnumWindowsProc(Cb), IntPtr.Zero);
    var ids = new List<string>();
    foreach (var h in found) {
      ShowWindow(h, SW_MINIMIZE);
      ids.Add(h.ToInt64().ToString());
    }
    return ids.Count == 0 ? "0" : string.Join(",", ids);
  }

  static bool Cb(IntPtr h, IntPtr l) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid != target) return true;
    if (!IsWindowVisible(h)) return true;
    if (IsIconic(h)) return true;
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    if ((ex & WS_EX_TOOLWINDOW) != 0) return true;
    found.Add(h);
    return true;
  }
}
'@
[HostWin]::Hide(${pid})
`;
}

/** 恢复指定的窗口句柄（SW_RESTORE）。 */
function RESTORE_HOST_SCRIPT(ids) {
  return `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class HostRestore {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  const int SW_RESTORE = 9;

  public static int Restore(string ids) {
    int n = 0;
    foreach (var s in ids.Split(',')) {
      long v;
      if (!long.TryParse(s, out v)) continue;
      ShowWindow(new IntPtr(v), SW_RESTORE);
      n++;
    }
    return n;
  }
}
'@
[HostRestore]::Restore('${ids}')
`;
}

// ── 抓屏 ─────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

/**
 * 用 PowerShell 抓屏（Windows）。
 *
 * @param which `"virtual"` = 整个虚拟桌面（所有显示器并集）；`"cursor"` = **光标
 *              所在的那一块**显示器。
 *
 * ⚠️ 区域框选必须用 `"cursor"`：冻结图要显示在 overlay 窗口里，而 overlay 只覆盖
 * **一块**显示器 —— 抓整个虚拟桌面的话，多显示器下用户看到的只是其中一块，坐标
 * 与图片对不上（静默截错区域）。单显示器时两者等价，所以这个坑只在多屏暴露。
 *
 * 返回 { path, x, y, width, height, monitorIndex }（x/y 是虚拟桌面坐标）。
 */
async function captureWindows(outPath, which = "virtual") {
  // which:
  //   "virtual"  整个虚拟桌面（所有显示器并集）
  //   "cursor"   光标所在那块（区域框选用）
  //   "primary"  主显示器（AI 调用默认 —— AI 没有"光标在哪"的语义）
  //   "screen:N" 第 N 块显示器（AllScreens 下标，越界回落主屏）
  let pickBounds;
  if (which === "cursor") {
    pickBounds = `$pt = [System.Windows.Forms.Cursor]::Position
$scr = [System.Windows.Forms.Screen]::FromPoint($pt)
$b = $scr.Bounds
$idx = [System.Windows.Forms.Screen]::AllScreens.IndexOf($scr)`;
  } else if (which === "primary") {
    pickBounds = `$scr = [System.Windows.Forms.Screen]::PrimaryScreen
$b = $scr.Bounds
$idx = [System.Windows.Forms.Screen]::AllScreens.IndexOf($scr)`;
  } else if (/^screen:\d{1,2}$/.test(which)) {
    // 限 1~2 位数字：既够任何真实显示器配置，也避免超长数字被 PowerShell
    // 解析成科学计数法（`1e+21`）而语法出错
    const n = Number(which.slice("screen:".length));
    // 脚本里做越界保护，避免拿到 undefined 直接崩
    pickBounds = `$all = [System.Windows.Forms.Screen]::AllScreens
$n = ${n}
if ($n -ge $all.Length) { $n = 0 }
$scr = $all[$n]
$b = $scr.Bounds
$idx = $n`;
  } else {
    pickBounds = `$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$idx = -1`;
  }

  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
${pickBounds}
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
# 强制不透明：GDI 抓屏的 alpha 常为 0，PNG 会显示成全透明
$op = New-Object System.Drawing.Imaging.ImageAttributes
$mx = New-Object System.Drawing.Imaging.ColorMatrix
$mx.Matrix33 = 1.0
$op.SetColorMatrix($mx)
$dst = New-Object System.Drawing.Rectangle(0, 0, $b.Width, $b.Height)
$g.DrawImage($bmp, $dst, 0, 0, $b.Width, $b.Height, [System.Drawing.GraphicsUnit]::Pixel, $op)
$bmp.Save('${outPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($b.X),$($b.Y),$($b.Width),$($b.Height),$idx"
$g.Dispose(); $bmp.Dispose()
`;
  const r = await run("powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ]);
  if (r.code !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`抓屏失败: ${r.err || r.out || `exit ${r.code}`}`);
  }
  const [x, y, w, h, idx] = r.out.trim().split(",").map(Number);
  return { path: outPath, x, y, width: w, height: h, monitorIndex: idx };
}

// ── 窗口模式（Windows）：枚举顶层窗口 ────────────────────────────────

/**
 * 枚举当前可见的顶层窗口。
 *
 * 返回 `[{ hwnd, x, y, w, h, pid, title }]`，坐标为**虚拟桌面**像素，
 * 顺序 = Z-order（**最上层在前** —— 前端命中测试靠它取"肉眼看得见的那个"）。
 *
 * 过滤掉：不可见 / 最小化 / 无标题 / 桌面与任务栏 / 工具窗口（WS_EX_TOOLWINDOW，
 * 能滤掉输入法候选窗、托盘弹窗这类"看不见的全屏窗口"）。
 * UWP 应用会**同时**暴露外框（`ApplicationFrameWindow`）与内容
 * （`Windows.UI.Core.CoreWindow`），只保留外框 —— 否则「设置」会列两条。
 * ⚠️ 两者 **pid 不同**（外框由 `ApplicationFrameHost.exe` 托管），
 * 所以只能按**标题**配对，不能按 pid。
 *
 * ⚠️ 脚本内容**必须纯 ASCII**：PowerShell 5.1 按系统代码页（GBK）读脚本，
 * 中文注释会让内嵌的 C# 编译失败，且报错极具误导性（"名称不存在"之类，
 * 行号还指向无辜的空行）。这个坑踩过两次。
 */
async function enumWindows() {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;

  class W {
    public IntPtr h;
    public string cls = "";
    public string title = "";
    public uint pid;
    public int x, y, w, hh;
  }

  public static List<string> List() {
    var all = new List<W>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (IsIconic(h)) return true;

      var cn = new StringBuilder(256);
      GetClassName(h, cn, 256);
      string cls = cn.ToString();
      if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return true;

      int ex = GetWindowLong(h, GWL_EXSTYLE);
      if ((ex & WS_EX_TOOLWINDOW) != 0) return true;

      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      string title = sb.ToString().Trim();
      if (title.Length == 0) return true;

      RECT r;
      int hr = DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT)));
      if (hr != 0) { if (!GetWindowRect(h, out r)) return true; }

      int w = r.Right - r.Left;
      int hh = r.Bottom - r.Top;
      if (w <= 0 || hh <= 0) return true;

      uint pid; GetWindowThreadProcessId(h, out pid);
      all.Add(new W { h = h, cls = cls, title = title, pid = pid, x = r.Left, y = r.Top, w = w, hh = hh });
      return true;
    }, IntPtr.Zero);

    var keep = new List<W>();
    foreach (var cand in all) {
      bool dup = false;
      if (cand.cls == "Windows.UI.Core.CoreWindow") {
        foreach (var other in all) {
          if (other.cls == "ApplicationFrameWindow" && other.title == cand.title) { dup = true; break; }
        }
      }
      if (!dup) keep.Add(cand);
    }

    var order = new Dictionary<IntPtr, int>();
    for (int i = 0; i < all.Count; i++) order[all[i].h] = i;
    keep.Sort(delegate(W a, W b) { return order[a.h].CompareTo(order[b.h]); });

    var res = new List<string>();
    foreach (var k in keep) {
      res.Add(k.h.ToInt64() + "\\t" + k.x + "\\t" + k.y + "\\t" + k.w + "\\t" + k.hh + "\\t" + k.pid + "\\t" + k.title);
    }
    return res;
  }
}
'@
[WinEnum]::List() | ForEach-Object { Write-Output $_ }
`;
  const r = await run("powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ]);
  if (r.code !== 0) {
    log("enumWindows failed:", r.err || r.out);
    return [];   // 枚举失败 → 空列表；上层据此退化为"不可用"，不打断主流程
  }
  return r.out.split(/\r?\n/)
    .filter((l) => l.includes("\t"))
    .map((l) => {
      const p = l.split("\t");
      // 前 6 段是数字，剩下的是标题（标题里可能含 tab，拼回去）
      return {
        hwnd: Number(p[0]), x: +p[1], y: +p[2],
        w: +p[3], h: +p[4], pid: +p[5], title: p.slice(6).join("\t"),
      };
    })
    .filter((w) => w.hwnd > 0 && w.w > 0 && w.h > 0);
}

/** 用系统 screencapture（macOS）。mode: "" 全屏 | "-i" 交互区域 | "-w" 交互窗口。 */
async function captureMac(outPath, mode = "") {
  // -x 静音；-t png 指定格式
  const args = ["-x", "-t", "png"];
  if (mode) args.push(mode);
  args.push(outPath);
  const r = await run("/usr/sbin/screencapture", args);
  // 用户按 Esc 取消时不会生成文件（或生成 0 字节）—— 视为取消而不是错误
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    fs.existsSync(outPath) && fs.unlinkSync(outPath);
    return null;
  }
  if (r.code !== 0) throw new Error(`screencapture 失败: ${r.err || r.code}`);
  const dim = await imageSize(outPath);
  return { path: outPath, x: 0, y: 0, width: dim.width, height: dim.height };
}

/** 读图片尺寸 —— 解析 PNG 头（IHDR），不解码像素。 */
function imageSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    // PNG: 8 字节签名 + 4 长度 + "IHDR" + 4 宽 + 4 高（大端）
    if (buf.slice(12, 16).toString("ascii") !== "IHDR") {
      throw new Error("不是 PNG（或格式未识别）");
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

// ── 裁剪 ─────────────────────────────────────────────────────────────

/** Windows：用 System.Drawing 裁一个矩形出来（无需额外图像库）。 */
async function cropWindows(src, dst, x, y, w, h) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src.replace(/'/g, "''")}')
$rect = New-Object System.Drawing.Rectangle(${x}, ${y}, ${w}, ${h})
$crop = New-Object System.Drawing.Bitmap(${w}, ${h})
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0,0,${w},${h})), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$crop.Save('${dst.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $crop.Dispose(); $src.Dispose()
`;
  const r = await run("powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ]);
  if (r.code !== 0 || !fs.existsSync(dst)) {
    throw new Error(`裁剪失败: ${r.err || r.out || `exit ${r.code}`}`);
  }
}

/**
 * 抓**指定窗口**的内容（Windows）—— 窗口模式用。
 *
 * 用 `PrintWindow(PW_RENDERFULLCONTENT)`：它让窗口**把自己画到内存 DC**，
 * 所以**被别的窗口盖住也能抓到真实内容**。这点对窗口模式是决定性的 ——
 * 否则"从屏幕上裁那块区域"只会得到遮挡物的画面（用户想截微信，截出来是 GUI）。
 *
 * 代价：部分 GPU 加速窗口（Chromium 内核、部分 UWP）会画成**纯黑**且不报错。
 * 故抓完采样几个像素检测，全黑返回 false，由调用方回退到"从冻结图裁剪"。
 *
 * @returns true = 抓到了有内容的图；false = 失败或全黑（调用方应回退）
 */
async function captureWindow(hwnd, outPath) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class WinCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);

  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static string Capture(long hwndVal, string outPath) {
    IntPtr h = new IntPtr(hwndVal);
    RECT r;
    int hr = DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT)));
    if (hr != 0) { if (!GetWindowRect(h, out r)) return "FAIL"; }
    int w = r.Right - r.Left;
    int hh = r.Bottom - r.Top;
    if (w <= 0 || hh <= 0) return "FAIL";

    using (Bitmap bmp = new Bitmap(w, hh))
    using (Graphics g = Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc();
      bool ok = PrintWindow(h, dc, 2);
      g.ReleaseHdc(dc);

      bool black = true;
      int[] xs = new int[] { 2, w / 2, w - 3 };
      int[] ys = new int[] { 2, hh / 2, hh - 3 };
      for (int i = 0; i < 3; i++) {
        int px = xs[i] < 0 ? 0 : (xs[i] >= w ? w - 1 : xs[i]);
        int py = ys[i] < 0 ? 0 : (ys[i] >= hh ? hh - 1 : ys[i]);
        Color c = bmp.GetPixel(px, py);
        if (c.R > 4 || c.G > 4 || c.B > 4) { black = false; break; }
      }
      bmp.Save(outPath, ImageFormat.Png);
      if (!ok) return "FAIL";
      return black ? "BLACK" : "OK";
    }
  }
}
'@
[WinCap]::Capture(${hwnd}, '${outPath.replace(/'/g, "''")}')
`;
  const r = await run("powershell", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ]);
  const verdict = (r.out || "").trim();
  if (verdict !== "OK") log(`captureWindow(${hwnd}) -> ${verdict || r.err || "no output"}`);
  return verdict === "OK";
}

/** macOS：优先用 screencapture -R 直接从屏幕截该矩形。
 *  ⚠️ 这会**重新抓屏**而不是裁冻结图 —— 与 Windows 的语义略有差异（若屏幕在
 *  框选期间变化，mac 拿到的是新画面）。但 mac 上区域模式走的是系统原生 -i，
 *  根本不经过这条路，所以这里只是兜底。 */
async function cropMac(src, dst, x, y, w, h) {
  const r = await run("/usr/sbin/screencapture", ["-x", "-t", "png", `-R${x},${y},${w},${h}`, dst]);
  if (r.code !== 0 || !fs.existsSync(dst)) throw new Error(`裁剪失败: ${r.err || r.code}`);
}

// ── 命名与落盘 ───────────────────────────────────────────────────────

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

/** 生成不重名的文件名：snip-YYYYMMDD-HHMMSS.png（同秒重复则加 -2/-3…）。 */
function uniquePath(dir, base) {
  let p = path.join(dir, `${base}.png`);
  if (!fs.existsSync(p)) return p;
  for (let i = 2; i < 1000; i++) {
    p = path.join(dir, `${base}-${i}.png`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}.png`);
}

function targetDir() {
  const custom = String(settings.saveDir || "").trim();
  if (custom) return custom;
  if (WORKSPACE) return path.join(WORKSPACE, ".claude", "screenshots");
  return path.join(os.tmpdir(), "claude-screenshots");
}

function stampName() {
  const d = new Date();
  return `snip-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 写系统剪贴板（best-effort —— 失败不影响主流程）。 */
async function toClipboard(file) {
  try {
    if (IS_WIN) {
      const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; `
        + `$i=[System.Drawing.Image]::FromFile('${file.replace(/'/g, "''")}'); `
        + `[System.Windows.Forms.Clipboard]::SetImage($i)`]);
      return r.code === 0;
    }
    if (IS_MAC) {
      // osascript 用 PNG 的原始数据写剪贴板
      const r = await run("osascript", ["-e",
        `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
      return r.code === 0;
    }
  } catch (e) {
    log("clipboard failed:", e.message);
  }
  return false;
}

// ── 截图主流程 ───────────────────────────────────────────────────────

/** 全屏（或 mac 上的交互式区域/窗口）—— 直接出结果。 */
async function captureDirect(mode) {
  fs.mkdirSync(targetDir(), { recursive: true });
  const out = uniquePath(targetDir(), stampName());

  let shot;
  if (IS_MAC) {
    // mac：三种模式全部交给系统（原生框选/点选体验最好，跨显示器天然正确）
    shot = await captureMac(out, mode === "region" ? "-i" : mode === "window" ? "-w" : "");
  } else {
    shot = await captureWindows(out);
  }
  if (!shot) return { cancelled: true };

  if (settings.copyToClipboard !== false) void toClipboard(shot.path);

  return {
    cancelled: false,
    path: shot.path,
    name: path.basename(shot.path),
    width: shot.width,
    height: shot.height,
  };
}

/** 冻结抓屏 → 准备框选。只抓**光标所在那块显示器**（见 captureWindows 注释）。 */
async function prepareRegion(opts = {}) {
  fs.mkdirSync(targetDir(), { recursive: true });
  const tmp = path.join(os.tmpdir(), `snipfrozen-${crypto.randomUUID()}.png`);
  const shot = await captureWindows(tmp, "cursor"); // 只有 Windows 走这条路

  // 窗口模式才枚举（区域模式用不上，省掉一次 PowerShell 往返 ≈ 数百毫秒）。
  // ⚠️ 必须在本函数里（= overlay 建出来**之前**）枚举：overlay 是铺满全屏的窗口，
  // 等它出现后再枚举，它自己就会混进列表、且是 Z-order 最上层 —— 那用户永远
  // 只能选中 overlay。同理，冻结图也是在这一刻抓的，两者状态一致。
  const windows = opts.windows ? await enumWindows() : [];

  const token = crypto.randomUUID();
  pending.set(token, {
    file: shot.path, width: shot.width, height: shot.height,
    x: shot.x, y: shot.y, windows, at: Date.now(),
  });
  // 顺手清理过期项
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL_MS) {
    try { fs.unlinkSync(v.file); } catch {}
    pending.delete(k);
  }
  return {
    token, width: shot.width, height: shot.height,
    x: shot.x, y: shot.y,
    // overlay 要用它把窗口开在**同一块**显示器上（-1 = 未知 → 宿主开全部）
    monitor: shot.monitorIndex >= 0 ? shot.monitorIndex : undefined,
  };
}

/** 把矩形收进 `[0, maxW] × [0, maxH]`，保证至少 1×1。 */
function clampRect(rect, maxW, maxH) {
  const x = Math.max(0, Math.min(Math.round(rect.x), maxW - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), maxH - 1));
  const w = Math.max(1, Math.min(Math.round(rect.w), maxW - x));
  const h = Math.max(1, Math.min(Math.round(rect.h), maxH - y));
  return { x, y, w, h };
}

/**
 * 把枚举到的窗口换算成**冻结图内**坐标并裁进图内。
 *
 * 窗口 rect 是虚拟桌面坐标，冻结图只覆盖**光标所在那块显示器**（原点 p.x/p.y），
 * 两者相减才是图内坐标。完全落在这块屏之外的窗口直接丢弃
 * （多显示器下，别的屏上的窗口不该出现在本屏的可选列表里）。
 */
function windowsInShot(p) {
  return (p.windows || [])
    .map((w) => {
      // 虚拟桌面坐标 → 冻结图内坐标（冻结图只覆盖光标所在那块显示器）
      const ix = w.x - p.x;
      const iy = w.y - p.y;
      // 与冻结图求交（窗口可能有一部分在本屏之外）
      const x1 = Math.max(0, ix);
      const y1 = Math.max(0, iy);
      const x2 = Math.min(p.width, ix + w.w);
      const y2 = Math.min(p.height, iy + w.h);
      const cw = x2 - x1;
      const ch = y2 - y1;
      if (cw < 8 || ch < 8) return null;   // 交出来的部分太小，不值得列
      return { hwnd: w.hwnd, title: w.title, x: x1, y: y1, w: cw, h: ch };
    })
    .filter(Boolean);
}

/** 裁剪待框选图并落盘。坐标为**物理像素**（overlay 侧已乘 dpr）。 */
async function commitRegion(token, rect) {
  const p = pending.get(token);
  if (!p) throw new Error("框选已超时或不存在，请重新截图");

  const { x, y, w, h } = clampRect(rect, p.width, p.height);

  const out = uniquePath(targetDir(), stampName());
  if (IS_MAC) await cropMac(p.file, out, x, y, w, h);
  else await cropWindows(p.file, out, x, y, w, h);

  pending.delete(token);
  try { fs.unlinkSync(p.file); } catch {}

  if (settings.copyToClipboard !== false) void toClipboard(out);
  return { path: out, name: path.basename(out), width: w, height: h };
}

/**
 * 抓**指定窗口**并落盘（窗口模式点击后调用）。
 *
 * 先用 `PrintWindow` 直接抓该窗口（**被遮挡也能抓到真实内容**）；失败或全黑
 * （GPU 加速窗口的已知限制）则回退为"从冻结图裁那块区域" —— 画面可能被遮挡物
 * 盖着，但至少能出图，不会让用户点了没反应。
 */
async function commitWindow(token, hwnd, rect) {
  const p = pending.get(token);
  if (!p) throw new Error("框选已超时或不存在，请重新截图");

  const out = uniquePath(targetDir(), stampName());
  let ok = false;
  if (IS_WIN && hwnd) ok = await captureWindow(hwnd, out);

  let dim;
  if (ok) {
    dim = await imageSize(out);
  } else {
    const r = clampRect(rect || { x: 0, y: 0, w: p.width, h: p.height }, p.width, p.height);
    if (IS_MAC) await cropMac(p.file, out, r.x, r.y, r.w, r.h);
    else await cropWindows(p.file, out, r.x, r.y, r.w, r.h);
    dim = { width: r.w, height: r.h };
  }

  pending.delete(token);
  try { fs.unlinkSync(p.file); } catch {}

  if (settings.copyToClipboard !== false) void toClipboard(out);
  return { path: out, name: path.basename(out), width: dim.width, height: dim.height };
}

// ── AI 截屏（MCP 工具）：无 UI ───────────────────────────────────────
//
// 与区域/窗口模式**本质不同**：那两条要开 overlay 让人来选，AI 没有鼠标。
// 这里 AI 直接给参数（区域矩形 / 显示器），进程抓屏→裁→落盘→返回 base64。

/**
 * AI 调用的截屏。返回给宿主的**元数据 + base64**。
 *
 * @param args.region  `{x,y,w,h}` 物理像素、**相对目标显示器左上角**；缺省 = 整块显示器
 * @param args.monitor 显示器序号（0 = 主屏，缺省）；越界回落主屏
 *
 * 坐标系刻意选"相对显示器左上角"而不是虚拟桌面绝对坐标：AI 通常只关心"截这块屏的
 * 这一块"，绝对坐标要它自己知道每块屏的原点，容易错。返回值里给 `monitorOrigin`
 * 供需要绝对坐标的场合换算。
 */
async function mcpCapture(args = {}) {
  fs.mkdirSync(targetDir(), { recursive: true });
  const out = uniquePath(targetDir(), stampName());

  // 归一化 monitor：非负整数，缺省 0（主屏）
  const idx = Number.isInteger(args.monitor) && args.monitor >= 0 ? args.monitor : 0;
  const which = idx === 0 ? "primary" : `screen:${idx}`;

  // 是否让开位置：**调用方可显式指定**（AI 工具的 clearScreen 参数），
  // 不指定则跟随插件设置。让 AI 自己决定是有意的 —— 它可能知道用户正在看 GUI
  // （那就别打扰），也可能正是要截 GUI 后面的东西（那就必须让开）。
  // 这条路径没有 overlay 遮挡，所以**抓完立即恢复**。
  const shouldHide = args.clearScreen === undefined
    ? clearScreenEnabled()
    : args.clearScreen === true;
  const hidden = shouldHide ? await hideHost() : 0;

  let shot;
  try {
    if (IS_MAC) {
      shot = await captureMac(out, "");   // mac 全屏（-x 静音）
    } else {
      shot = await captureWindows(out, which);
    }
  } finally {
    if (hidden) await restoreHost();      // 抓屏失败也要还回去，否则 GUI 卡在最小化
  }
  if (!shot) return { cancelled: true };

  // 区域：从刚抓的整屏图上裁。坐标由调用方给成**相对该显示器左上角**，
  // 正好等于图内坐标，不需要换算。
  const region = args.region;
  let final = shot;
  let applied = null;   // 实际生效的区域（clamp 之后）
  if (region && typeof region === "object") {
    const want = {
      x: Number(region.x) || 0,
      y: Number(region.y) || 0,
      w: Number(region.w) || 0,
      h: Number(region.h) || 0,
    };
    // ⚠️ 必须在 clamp **之前**校验：clampRect 会把宽高抬到至少 1，
    // 若先 clamp 再检查，调用方给 w=0 会被静默截成 1×1 的图（而不是报错）。
    if (want.w < 1 || want.h < 1) {
      throw new Error(`region 的宽高必须为正数（收到 ${want.w}×${want.h}）`);
    }
    const r = clampRect(want, shot.width, shot.height);
    const dst = uniquePath(targetDir(), stampName());
    if (IS_MAC) await cropMac(shot.path, dst, r.x, r.y, r.w, r.h);
    else await cropWindows(shot.path, dst, r.x, r.y, r.w, r.h);
    // 整屏临时图用完即删（AI 只关心裁出来的那块）
    try { fs.unlinkSync(shot.path); } catch {}
    final = { path: dst, x: shot.x + r.x, y: shot.y + r.y, width: r.w, height: r.h };
    applied = r;
  }

  if (settings.copyToClipboard !== false) void toClipboard(final.path);

  // base64 给 AI 看图；path 给它后续引用
  const b64 = fs.readFileSync(final.path).toString("base64");
  return {
    cancelled: false,
    path: final.path,
    name: path.basename(final.path),
    // 图片本体（宿主把它转成 MCP image content，**不进文本**）
    image: { data: b64, mimeType: "image/png" },
    // 元数据 —— 宿主转给 AI 时剥掉 image.data，只留这些
    meta: {
      width: final.width,
      height: final.height,
      // 这张图左上角在**虚拟桌面**里的坐标（相对显示器坐标 → 绝对坐标用得上）
      monitorOrigin: { x: final.x, y: final.y },
      monitorIndex: idx,
      // 是否裁过区域（null = 整块显示器）
      region: applied,
    },
  };
}

/**
 * 请求宿主开 overlay 显示冻结图（本进程开不了窗口）。
 * `mode === "window"` 时 overlay 走"悬停选窗口"而不是"拖框选区域"。
 */
function overlayHostActions(prep, mode, restoreOnClose = false) {
  return [{
    kind: "open-overlay",
    payload: {
      src: "overlay.html",
      params: `port=${actualPort()}&token=${prep.token}${mode === "window" ? "&mode=window" : ""}`,
      // 开在**冻结图所属的那块显示器**上；多屏下错开会让坐标对不上
      ...(prep.monitor !== undefined ? { monitor: prep.monitor } : {}),
      // 让位过的，请宿主在**关闭 overlay 时**回来敲 /restore-host 把窗口还回去。
      // 为什么不让宿主直接 unminimize 自己：让位时最小化的是**该进程的全部可见
      // 窗口**（主窗 + 浮窗，插件分不清哪个是主窗），宿主的前端 API 只能操作
      // 自己那个窗口 → 句柄列表在进程手里，恢复也得由进程做。
      ...(restoreOnClose ? { restoreHostOnClose: true, hostPort: actualPort() } : {}),
    },
  }];
}

/**
 * 把外部传入的路径解析到**截图目录内**；越界（目录穿越 / 绝对路径指到别处）
 * 返回 null。读与删共用这一处校验 —— 分两份写迟早有一份漏掉。
 */
function resolveInTargetDir(p) {
  if (!p) return null;
  const dir = path.resolve(targetDir());
  const full = path.resolve(String(p));
  return full.startsWith(dir + path.sep) ? full : null;
}

/** 按设置决定投递动作，返回给宿主的 host actions。 */
function deliverActions(shot) {
  const dest = String(settings.defaultDest || "chat");
  const ref = { path: shot.path, label: shot.name };
  if (dest === "desktop") return [{ kind: "desktop-image", payload: ref }];
  if (dest === "file") return [];  // 已经落盘了，无需再投
  return [{ kind: "chat-reference", payload: ref }];
}

// ── HTTP ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 64 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // iframe 的 origin 与 127.0.0.1 不同源 —— fetch 需要这个头
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    });
    return res.end();
  }

  try {
    // AI 调用的 MCP 工具（宿主转发）—— **固定契约**：
    //   POST /__mcp  body { tool, args, settings }  →  { ok, ...结果 }
    // 不复用 /__command：那个返回的是 host actions（要宿主再执行一轮），语义不同。
    if (route === "/__mcp" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.settings && typeof body.settings === "object") {
        settings = { ...settings, ...body.settings };
      }
      const tool = body.tool;
      const args = body.args && typeof body.args === "object" ? body.args : {};
      try {
        switch (tool) {
          // 全屏/指定显示器的截图
          case "fullscreen":
            return json(res, 200, {
              ok: true,
              // ⚠️ clearScreen 必须透传 —— 漏掉它的话 mcpCapture 里
              // `args.clearScreen === undefined` 成立，会**回落成设置默认值**，
              // 于是 AI 显式传的 false 被静默忽略（想不打扰却还是最小化了窗口）。
              ...(await mcpCapture({
                monitor: args.monitor,
                clearScreen: args.clearScreen,
              })),
            });
          // 指定区域的截图
          case "region":
            return json(res, 200, {
              ok: true,
              ...(await mcpCapture({
                monitor: args.monitor,
                region: args.region,
                clearScreen: args.clearScreen,
              })),
            });
          default:
            return json(res, 404, { ok: false, error: `未知工具: ${tool}` });
        }
      } catch (e) {
        // 工具级失败：返回结构化错误（宿主会把它包成 MCP 错误给 AI），
        // 不要走外层 catch 变成 500 —— AI 需要看到"为什么失败"而不是"服务器错误"
        log(`__mcp ${tool} failed:`, e && e.stack || e);
        return json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    }

    // 宿主命令直达（快捷键触发时面板可能没开 —— 见宿主侧 forwardToPluginProcess）
    if (route === "/__command" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.settings && typeof body.settings === "object") {
        settings = { ...settings, ...body.settings };
      }
      const cmd = body.command;

      // Windows 上"区域"与"窗口"都要先冻结抓屏、再交给 overlay 交互。
      // 让位在抓屏**之前** —— 抓屏在进程侧，所以让位也在这里（面板触发时 iframe
      // 直接调本进程，绕过宿主 JS，只有放这里三条路径才统一）。
      // 这两个模式**不在返回前恢复**：overlay 还开着，让宿主在关闭它时回来敲
      // /restore-host（见 overlayHostActions 的 restoreHostOnClose）。
      if ((cmd === "region" || cmd === "window") && IS_WIN) {
        const hidden = await hideHost();
        const prep = await prepareRegion({ windows: cmd === "window" });
        return json(res, 200, { ok: true, host: overlayHostActions(prep, cmd, hidden > 0) });
      }
      // mac 的区域/窗口走系统原生交互；全屏直接抓。
      // 全屏与 mac 都要让位 → 抓 → **立即恢复**：这条路径没有 overlay 遮挡，
      // 抓完就该把窗口还回去（否则要等下一次命令才恢复）。
      const hidden = await hideHost();
      const shot = await captureDirect(cmd === "window" ? "window" : cmd === "region" ? "region" : "fullscreen");
      if (hidden) await restoreHost();
      if (shot.cancelled) return json(res, 200, { ok: true, cancelled: true });
      return json(res, 200, { ok: true, shot, host: deliverActions(shot) });
    }

    if (route === "/ping") return json(res, 200, { ok: true, platform: process.platform, workspace: WORKSPACE });

    // 冻结图（overlay 用 <img> 加载；img 不受同源限制，但仍给 CORS 以防 fetch）
    if (route === "/frozen" && req.method === "GET") {
      const p = pending.get(url.searchParams.get("token"));
      if (!p || !fs.existsSync(p.file)) return json(res, 404, { error: "no such frozen shot" });
      const buf = fs.readFileSync(p.file);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": buf.length,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    }

    // 宿主关闭 overlay 时来敲 —— 把让位时最小化的窗口还回去。
    // 句柄列表在进程内存里（让位时记的），所以恢复只能由进程做；宿主只负责时机。
    if (route === "/restore-host" && req.method === "POST") {
      await restoreHost();
      return json(res, 200, { ok: true });
    }

    // 可选窗口列表（overlay 的窗口模式用）—— 坐标已转成**冻结图内**坐标
    if (route === "/windows" && req.method === "GET") {
      const p = pending.get(url.searchParams.get("token"));
      if (!p) return json(res, 404, { error: "框选已超时或不存在，请重新截图" });
      return json(res, 200, { ok: true, windows: windowsInShot(p) });
    }

    // 框选提交（overlay 调用）—— 坐标为物理像素
    if (route === "/crop" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.settings && typeof b.settings === "object") settings = { ...settings, ...b.settings };
      const shot = await commitRegion(b.token, b);
      return json(res, 200, { ok: true, shot, host: deliverActions(shot) });
    }

    // 窗口提交（overlay 的窗口模式点击后调用）—— 优先 PrintWindow 直抓该窗口
    if (route === "/crop-window" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.settings && typeof b.settings === "object") settings = { ...settings, ...b.settings };
      const shot = await commitWindow(b.token, b.hwnd, b.rect);
      return json(res, 200, { ok: true, shot, host: deliverActions(shot) });
    }

    if (route === "/cancel" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const p = pending.get(b.token);
      if (p) { try { fs.unlinkSync(p.file); } catch {} pending.delete(b.token); }
      return json(res, 200, { ok: true });
    }

    // 面板直接触发的截图（面板自己 fetch；结果里的 host actions 由面板转投）
    if (route === "/capture" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.settings && typeof b.settings === "object") settings = { ...settings, ...b.settings };
      const mode = b.mode || "fullscreen";
      if ((mode === "region" || mode === "window") && IS_WIN) {
        const prep = await prepareRegion({ windows: mode === "window" });
        return json(res, 200, { ok: true, host: overlayHostActions(prep, mode) });
      }
      const shot = await captureDirect(mode);
      if (shot.cancelled) return json(res, 200, { ok: true, cancelled: true });
      // 面板场景：投递由面板自己发（它已有 postMessage 通道），故不返回 host
      return json(res, 200, { ok: true, shot });
    }

    // 历史列表（直接列目录 —— 用户手删文件后列表自动一致，无需额外持久化）
    if (route === "/history" && req.method === "GET") {
      const dir = targetDir();
      if (!fs.existsSync(dir)) return json(res, 200, { ok: true, dir, items: [] });
      const items = fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".png"))
        .map((f) => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          let dim = { width: 0, height: 0 };
          try { dim = imageSize(full); } catch {}
          return { name: f, path: full, mtime: st.mtimeMs, size: st.size, ...dim };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 200);
      return json(res, 200, { ok: true, dir, items });
    }

    // 缩略图 / 原图（面板展示用）
    if (route === "/file" && req.method === "GET") {
      const p = url.searchParams.get("path");
      if (!p) return json(res, 400, { error: "path required" });
      // ⚠️ 只允许读**截图目录内**的文件 —— 否则就是无认证的任意文件读取
      const full = resolveInTargetDir(p);
      if (!full) return json(res, 403, { error: "outside screenshot dir" });
      if (!fs.existsSync(full)) return json(res, 404, { error: "not found" });
      const buf = fs.readFileSync(full);
      res.writeHead(200, {
        "Content-Type": "image/png", "Content-Length": buf.length,
        "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    }

    // 删除截图（面板多选/单张删除用）。**只删截图目录内**的文件。
    // 逐个删、逐个记结果：某一张被别的程序占用不该让整批失败。
    if (route === "/delete" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const list = Array.isArray(b.paths) ? b.paths : (b.path ? [b.path] : []);
      const deleted = [];
      const failed = [];
      for (const raw of list) {
        const full = resolveInTargetDir(raw);
        if (!full) { failed.push({ path: raw, error: "不在截图目录内" }); continue; }
        try {
          fs.unlinkSync(full);
          deleted.push(path.basename(full));
        } catch (e) {
          failed.push({ path: path.basename(String(raw)), error: e && e.message || String(e) });
        }
      }
      log(`delete: ${deleted.length} ok, ${failed.length} failed`);
      return json(res, 200, { ok: true, deleted, failed });
    }

    if (route === "/settings" && req.method === "PUT") {
      const b = JSON.parse((await readBody(req)) || "{}");
      settings = { ...settings, ...(b.settings || {}) };
      return json(res, 200, { ok: true, settings });
    }

    json(res, 404, { error: `no route: ${route}` });
  } catch (e) {
    log("handler error:", e && e.stack || e);
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

// ── 启动 ─────────────────────────────────────────────────────────────

// 端口优先固定值（便于调试），被占则随机
const preferred = Number(process.env.SCREENSHOT_PORT || 0);
/** 实际监听端口 —— 不能在 handler 里引用启动前的常量（那时还是 0）。 */
function actualPort() {
  const a = server.address();
  return a && typeof a === "object" ? a.port : 0;
}

// 先 listen 再打印端口 —— 顺序不能反
let started = false;
server.listen(preferred, "127.0.0.1", () => {
  if (started) return;
  started = true;
  const actual = server.address().port;
  // ⚠️ 见文件头约束 1：这一行必须是 stdout 的第一行、也是最后一行
  console.log(`PLUGIN_PORT=${actual}`);
  log(`listening on 127.0.0.1:${actual}; platform=${process.platform}; workspace=${WORKSPACE || "(none)"}`);
});

server.on("error", (e) => {
  // 端口被占：换随机端口再试一次
  if (e && e.code === "EADDRINUSE" && !started) {
    server.listen(0, "127.0.0.1");
  } else {
    log("server error:", e && e.message);
    process.exit(1);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`got ${sig}, exiting`);
    for (const [, v] of pending) { try { fs.unlinkSync(v.file); } catch {} }
    process.exit(0);
  });
}
