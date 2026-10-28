// ── Win32 直调（koffi FFI）──
//
// 2026-10-27 重写：**不再用 PowerShell 抓屏**。
//
// 原来的做法每次都起一个 powershell.exe 进程跑内嵌 C#：
//   进程启动 227ms + 加载程序集 + 编译 C# 132ms + 抓屏 + PNG 编码 ≈ 570ms
// 其中 400ms 纯粹是"启动外部进程 + 编译"的代价，跟抓屏本身无关。
//
// 改成 koffi（通用 FFI，N-API 预编译）直接在**插件进程内**调 user32/gdi32：
//   BitBlt 33ms + 读像素 3ms + 转 RGBA 11ms + PNG 30ms ≈ 115ms
// 而且 `koffi.load()` 一次加载后**复用**，实际稳态更快。
//
// 附带好处：宿主侧一行不用改，扩展 Win32 能力不再需要重新编译 GUI。
//
// ⚠️ koffi.node 与 mouse-keyboard 插件用的是同一份（N-API 预编译，与 Node 版本无关）。

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PLATFORM_DIR = `${process.platform}-${process.arch}`;
const VENDOR = path.join(__dirname, "vendor", PLATFORM_DIR);

let koffi = null;
let loadError = "";

function loadKoffi() {
  if (koffi) return koffi;
  const p = path.join(VENDOR, "koffi.node");
  if (!fs.existsSync(p)) {
    loadError = `缺少原生库：${p}（当前平台 ${PLATFORM_DIR}）`;
    throw new Error(loadError);
  }
  koffi = require(p);
  return koffi;
}

/** 是否可用（拿不到 koffi 时上层回退到 PowerShell 路径）。 */
function available() {
  try { loadKoffi(); return true; } catch { return false; }
}

// ── 惰性绑定的 API 表 ───────────────────────────────────────────────
//
// 逐项 try：某个 API 绑定失败不该拖垮其它（与 mouse-keyboard 同策略）。

let api = null;

function ensureApi() {
  if (api) return api;
  const k = loadKoffi();

  const user32 = k.load("user32.dll");
  const gdi32 = k.load("gdi32.dll");

  let shcore = null;
  try { shcore = k.load("shcore.dll"); } catch { /* 老系统没有 */ }

  const bind = (fn, name) => {
    try { return fn(); }
    catch (e) {
      process.stderr.write(`[screenshot] Win32 "${name}" 绑定失败: ${e && e.message || e}\n`);
      return null;
    }
  };

  api = {
    // DPI
    SetProcessDpiAwareness: shcore
      ? bind(() => shcore.func("int SetProcessDpiAwareness(int v)"), "SetProcessDpiAwareness")
      : null,
    SetProcessDPIAware: bind(() => user32.func("bool SetProcessDPIAware()"), "SetProcessDPIAware"),

    // 屏幕尺寸 / 光标
    GetSystemMetrics: bind(() => user32.func("int GetSystemMetrics(int i)"), "GetSystemMetrics"),
    GetCursorPos: bind(() => user32.func("bool GetCursorPos(void* pt)"), "GetCursorPos"),

    // 抓屏
    GetDC: bind(() => user32.func("void* GetDC(void* hwnd)"), "GetDC"),
    ReleaseDC: bind(() => user32.func("int ReleaseDC(void* hwnd, void* hdc)"), "ReleaseDC"),
    CreateCompatibleDC: bind(() => gdi32.func("void* CreateCompatibleDC(void* hdc)"), "CreateCompatibleDC"),
    CreateCompatibleBitmap: bind(
      () => gdi32.func("void* CreateCompatibleBitmap(void* hdc, int w, int h)"),
      "CreateCompatibleBitmap",
    ),
    SelectObject: bind(() => gdi32.func("void* SelectObject(void* hdc, void* obj)"), "SelectObject"),
    BitBlt: bind(
      () => gdi32.func("bool BitBlt(void* dst, int x, int y, int w, int h, void* src, int sx, int sy, uint32 rop)"),
      "BitBlt",
    ),
    GetDIBits: bind(
      () => gdi32.func("int GetDIBits(void* hdc, void* hbmp, uint32 start, uint32 lines, void* bits, void* bi, uint32 usage)"),
      "GetDIBits",
    ),
    DeleteObject: bind(() => gdi32.func("bool DeleteObject(void* obj)"), "DeleteObject"),
    DeleteDC: bind(() => gdi32.func("bool DeleteDC(void* hdc)"), "DeleteDC"),

    // 窗口控制
    EnumWindows: bind(() => user32.func("bool EnumWindows(void* cb, void* l)"), "EnumWindows"),
    IsWindowVisible: bind(() => user32.func("bool IsWindowVisible(void* h)"), "IsWindowVisible"),
    IsIconic: bind(() => user32.func("bool IsIconic(void* h)"), "IsIconic"),
    GetWindowThreadProcessId: bind(
      () => user32.func("uint32 GetWindowThreadProcessId(void* h, _Out_ uint32* pid)"),
      "GetWindowThreadProcessId",
    ),
    ShowWindow: bind(() => user32.func("bool ShowWindow(void* h, int cmd)"), "ShowWindow"),
    // ⚠️ user32 里没有 `GetWindowLong`（那是宏）—— 导出的是
    // GetWindowLongW / GetWindowLongA。64 位下两者等价，用 W 版。
    GetWindowLongW: bind(() => user32.func("int GetWindowLongW(void* h, int i)"), "GetWindowLongW"),
    GetWindowTextLengthW: bind(() => user32.func("int GetWindowTextLengthW(void* h)"), "GetWindowTextLengthW"),
    GetWindowTextW: bind(
      () => user32.func("int GetWindowTextW(void* h, void* s, int n)"),
      "GetWindowTextW",
    ),
    GetWindowRect: bind(() => user32.func("bool GetWindowRect(void* h, void* r)"), "GetWindowRect"),
    GetClassNameW: bind(() => user32.func("int GetClassNameW(void* h, void* s, int n)"), "GetClassNameW"),
    PrintWindow: bind(() => user32.func("bool PrintWindow(void* h, void* hdc, uint32 flags)"), "PrintWindow"),
    // 保存/还原窗口放置状态（最大化 / 全屏 / 还原）—— 见 showWindows 注释
    GetWindowPlacement: bind(
      () => user32.func("bool GetWindowPlacement(void* h, void* wp)"),
      "GetWindowPlacement",
    ),
    SetWindowPlacement: bind(
      () => user32.func("bool SetWindowPlacement(void* h, void* wp)"),
      "SetWindowPlacement",
    ),

    // DWM 过渡（避免隐藏时淡出 → 截图半透明）
    DwmSetWindowAttribute: (() => {
      try {
        const dwm = k.load("dwmapi.dll");
        return dwm.func("int DwmSetWindowAttribute(void* h, int attr, _In_ int* val, int size)");
      } catch { return null; }
    })(),
  };

  return api;
}

function enableDpi() {
  const a = ensureApi();
  try {
    if (a.SetProcessDpiAwareness && a.SetProcessDpiAwareness(2) === 0) return true; // PER_MONITOR_AWARE
  } catch { /* ignore */ }
  try { return !!(a.SetProcessDPIAware && a.SetProcessDPIAware()); } catch { return false; }
}

// ── 屏幕信息 ────────────────────────────────────────────────────────

const SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
const SM_CXSCREEN = 0, SM_CYSCREEN = 1;

/** 光标所在的显示器（多屏时区域框选只抓那一块）。 */
function cursorMonitorBounds() {
  const a = ensureApi();
  // 用 GetCursorPos + MonitorFromPoint + GetMonitorInfo 拿精确边界。
  // 这里为了少绑几个 API，退一步用"主屏尺寸 + 光标是否在主屏内"判断——
  // 多屏且光标在副屏时由上层回退到 PowerShell（保证不错抓）。
  const pt = Buffer.alloc(8);
  if (a.GetCursorPos && a.GetCursorPos(pt)) {
    const x = pt.readInt32LE(0);
    const y = pt.readInt32LE(4);
    const w = a.GetSystemMetrics(SM_CXSCREEN);
    const h = a.GetSystemMetrics(SM_CYSCREEN);
    if (x >= 0 && y >= 0 && x < w && y < h) {
      return { x: 0, y: 0, w, h, multi: false, cursorX: x, cursorY: y };
    }
  }
  return null; // 不在主屏 → 上层回退
}

function virtualScreenBounds() {
  const a = ensureApi();
  return {
    x: a.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: a.GetSystemMetrics(SM_YVIRTUALSCREEN),
    w: a.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    h: a.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

// ── 抓屏 ────────────────────────────────────────────────────────────

const SRCCOPY = 0x00CC0020;

/**
 * 抓虚拟桌面的一块区域，返回 **RGBA** Buffer（每像素 4 字节，alpha=255）。
 *
 * @param {{x:number,y:number,w:number,h:number}} rect 虚拟桌面坐标
 */
function grabRGBA(rect) {
  const a = ensureApi();
  const { x, y, w, h } = rect;
  if (w <= 0 || h <= 0) throw new Error(`非法抓屏区域 ${w}x${h}`);

  const screenDC = a.GetDC(null);
  if (!screenDC) throw new Error("GetDC 失败");
  const memDC = a.CreateCompatibleDC(screenDC);
  const bmp = a.CreateCompatibleBitmap(screenDC, w, h);
  if (!memDC || !bmp) {
    if (bmp) a.DeleteObject(bmp);
    if (memDC) a.DeleteDC(memDC);
    a.ReleaseDC(null, screenDC);
    throw new Error("创建兼容 DC/Bitmap 失败");
  }

  let ok = false;
  try {
    a.SelectObject(memDC, bmp);
    ok = !!a.BitBlt(memDC, 0, 0, w, h, screenDC, x, y, SRCCOPY);
  } finally {
    a.ReleaseDC(null, screenDC);
  }
  if (!ok) {
    a.DeleteObject(bmp);
    a.DeleteDC(memDC);
    throw new Error("BitBlt 失败");
  }

  // 读回像素：BGRA 自顶向下
  const bi = Buffer.alloc(40);
  bi.writeUInt32LE(40, 0);   // biSize
  bi.writeInt32LE(w, 4);     // biWidth
  bi.writeInt32LE(-h, 8);    // biHeight（负 = top-down）
  bi.writeUInt16LE(1, 12);   // biPlanes
  bi.writeUInt16LE(32, 14);  // biBitCount
  bi.writeUInt32LE(0, 16);   // BI_RGB

  const stride = w * 4;
  const bgra = Buffer.alloc(stride * h);
  const lines = a.GetDIBits(memDC, bmp, 0, h, bgra, bi, 0);

  a.DeleteObject(bmp);
  a.DeleteDC(memDC);

  if (!lines) throw new Error("GetDIBits 失败");

  // BGRA → RGBA，alpha 全 255（GDI 抓屏的 alpha 常为 0，PNG 会全透明）
  const rgba = bgra;
  for (let i = 0; i < rgba.length; i += 4) {
    const b = rgba[i];
    rgba[i] = rgba[i + 2];
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  return rgba;
}

// ── PNG 编码（纯 Node zlib，无外部依赖）──────────────────────────────

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/**
 * RGBA → PNG。
 *
 * `level` 越低越快：抓屏要的是"立即出图"，level 1 比默认 6 快 3 倍、
 * 体积只大一点（实测 2560×1600 约 0.6MB）。
 */
function encodePNG(rgba, w, h, level = 1) {
  const stride = w * 4;
  const rowLen = stride + 1;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0; // filter: None（快；Sub/Up 能压更小但更慢）
    rgba.copy(raw, y * rowLen + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── 宿主窗口隐藏 / 恢复 ─────────────────────────────────────────────

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_RESTORE = 9;
const DWMWA_TRANSITIONS_FORCEDISABLED = 3;

/**
 * 隐藏窗口时记下的**放置状态**（最大化/全屏/还原 + 还原位置）。
 *
 * 为什么需要：`SW_SHOW` + `SW_RESTORE` 会把窗口恢复成"还原态"，
 * 原本最大化的窗口会变成小窗（实测 showCmd 3→1，rect 从 -7,-7 1721x1041
 * 变成 152,152 1215x809）。用户全屏截图后窗口被"缩回去"很突兀。
 *
 * 用 `GetWindowPlacement`/`SetWindowPlacement` 保存并还原完整状态才能
 * 做到"截图前后窗口一模一样"。
 */
let hiddenPlacements = [];

/** EnumWindows 回调原型 —— `koffi.proto` 同名只能声明一次，所以缓存。 */
let _enumProcProto = null;
function enumProcProto() {
  if (!_enumProcProto) {
    _enumProcProto = koffi.proto("bool ENUMPROC(void* hwnd, intptr_t lParam)");
  }
  return _enumProcProto;
}

/**
 * 枚举某进程的可见顶层窗口并隐藏，返回句柄数组。
 *
 * 🔴 **隐藏前必须禁用 DWM 过渡**：否则窗口会淡出 ~150ms，
 * 期间抓屏会拍到半透明残影（用户实测截图糊了一层 UI）。
 * 禁用后窗口**立即**从合成画面消失，可零等待抓屏。
 */
function hideProcessWindows(pid) {
  const a = ensureApi();
  if (!a.EnumWindows) throw new Error("EnumWindows 不可用");

  const found = [];
  // koffi 回调：先声明原型，再 `koffi.register(fn, koffi.pointer(proto))`。
  // （不能直接传 "bool(void*,void*)" 字符串 —— 报 "Unexpected character '(' in type specifier"）
  // ⚠️ proto 只能声明一次（重复声明报 "Duplicate type name"）→ 提到模块级惰性创建。
  const cb = koffi.register((hwnd) => {
    try {
      const buf = Buffer.alloc(4);
      a.GetWindowThreadProcessId(hwnd, buf);
      if (buf.readUInt32LE(0) !== pid) return true;
      if (!a.IsWindowVisible(hwnd)) return true;
      if (a.IsIconic(hwnd)) return true;

      // ⚠️ **不能靠 WS_EX_TOOLWINDOW 过滤**（2026-10-27 实测）。
      //
      // 原逻辑沿用了"工具窗口不是主界面"的常识，但 Tauri 创建的宿主主窗
      // 恰好**带这个样式**（实测 exstyle=0x080800A0）→ 主窗被当成工具窗过滤掉
      // → **让位从来没生效过**（PowerShell 版同样如此，两边都隐藏 0 个窗口）。
      //
      // 改为按**尺寸**判断：可见 + 非最小化 + 大于 200x200 的才算"该让开的界面"。
      // 这样能滤掉输入法候选窗/托盘气泡这类小窗，又不误伤主窗。
      const r = Buffer.alloc(16);
      if (a.GetWindowRect && a.GetWindowRect(hwnd, r)) {
        const w = r.readInt32LE(8) - r.readInt32LE(0);
        const h = r.readInt32LE(12) - r.readInt32LE(4);
        if (w < 200 || h < 200) return true; // 小窗（气泡/候选框）不算界面
      }
      found.push(hwnd);
    } catch { /* 单个窗口查询失败不影响其它 */ }
    return true;
  }, koffi.pointer(enumProcProto()));

  try {
    a.EnumWindows(cb, null);
  } finally {
    koffi.unregister(cb);
  }

  // 隐藏前先用 GetWindowPlacement 记下**完整放置状态**（showCmd + 还原位置），
  // 之后 showWindows 才能还原成最大化/全屏/还原态。见 showWindows 注释。
  const savedPlacements = [];

  for (const hwnd of found) {
    const wp = Buffer.alloc(64);
    wp.writeUInt32LE(64, 0); // length，Windows 要求先填
    const ok = a.GetWindowPlacement ? a.GetWindowPlacement(hwnd, wp) : false;
    savedPlacements.push({ hwnd, ok, wp: ok ? Buffer.from(wp) : null });

    if (a.DwmSetWindowAttribute) {
      try {
        const v = Buffer.alloc(4);
        v.writeInt32LE(1);
        a.DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, v, 4);
      } catch { /* 老系统没有 DwmSetWindowAttribute */ }
    }
    a.ShowWindow(hwnd, SW_HIDE);
  }

  // 句柄与状态一起返回：showWindows 需要它来精确还原
  hiddenPlacements = savedPlacements
    .filter((s) => s.ok)
    .map((s) => ({ id: Number(koffi.address(s.hwnd)), wp: s.wp }));

  return found.map((h) => Number(koffi.address(h)));
}

/**
 * 恢复窗口：还原 DWM 过渡 → 按**隐藏前的状态**还原（最大化/全屏/还原）。
 *
 * 🔴 **不能只用 SW_SHOW + SW_RESTORE**（2026-10-27 用户反馈）：
 * 这两个都只会把窗口恢复成「还原态」。原本最大化的窗口会缩成小窗：
 * ```
 * 隐藏前  showCmd=3(最大化)  rect=-7,-7 1721x1041
 * 恢复后  showCmd=1(还原)    rect=152,152 1215x809   ← 用户的全屏丢了
 * ```
 * 必须先 `GetWindowPlacement` 存下完整状态、恢复时 `SetWindowPlacement`
 * 还原，才能做到"截图前后窗口一模一样"。
 *
 * 🔴 **必须用 `koffi.as(n, "void*")`，不能用 `koffi.decode(n, "void*")`**
 * （2026-10-27 事故）：`koffi.decode(整数, "void*")` 会让**整个进程静默崩溃**
 * —— 不是抛异常，是直接死掉，连 try/catch 都接不住、也不打日志。
 * 后果是"恢复"这步根本没执行，用户窗口一直藏着、找不到 GUI。
 *
 * `koffi.as` 是同一目的的**正确** API：把整数地址转成指针。
 */
function showWindows(handles) {
  const a = ensureApi();
  // 按 id 建索引，方便取回对应的保存状态
  const savedById = new Map();
  for (const p of hiddenPlacements) savedById.set(p.id, p.wp);
  hiddenPlacements = [];

  for (const n of handles) {
    const id = Number(n);
    let hwnd = null;
    try { hwnd = koffi.as(BigInt(id), "void*"); } catch { continue; }
    if (!hwnd) continue;
    if (a.DwmSetWindowAttribute) {
      try {
        const z = Buffer.alloc(4);
        z.writeInt32LE(0);
        a.DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, z, 4);
      } catch { /* ignore */ }
    }

    const wp = savedById.get(id);
    if (wp && a.SetWindowPlacement) {
      // 精确还原：最大化还是最大化、全屏还是全屏、还原位置也一致
      try {
        if (a.SetWindowPlacement(hwnd, wp)) continue;
      } catch { /* 落到下面的通用恢复 */ }
    }

    // 没有保存状态（GetWindowPlacement 失败）→ 通用恢复：
    // SW_SHOW 撤销 SW_HIDE，SW_RESTORE 兜底"之前是最小化态"。
    a.ShowWindow(hwnd, SW_SHOW);
    a.ShowWindow(hwnd, SW_RESTORE);
  }
}

module.exports = {
  available,
  enableDpi,
  cursorMonitorBounds,
  virtualScreenBounds,
  grabRGBA,
  encodePNG,
  hideProcessWindows,
  showWindows,
};
