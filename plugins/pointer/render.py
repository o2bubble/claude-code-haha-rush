# -*- coding: utf-8 -*-
"""pointer 插件的**原生绘制**后端 —— 绕开 WebView2，直接画到屏幕。

## 为什么不用 HTML（2026-09-19 的决定）

原先用宿主 `open_plugin_overlay` 开一个 WebView2 覆盖层画 SVG。**透明始终不成功**：
窗口层全部正确（`WS_EX_NOREDIRECTIONBITMAP` = DComp 路径 ✓、exstyle 实测
`0x00240118`），但 WebView2 **内容层**始终渲染成实心黑/白。

排查中试过且**无效**的：`tao transparent 建窗` / `WS_EX_LAYERED +
SetLayeredWindowAttributes`（反而全黑）/ `SetWindowCompositionAttribute` /
`DwmEnableBlurBehindWindow` / `with_background_color(0,0,0,0)` /
`--disable-gpu-compositing` / vendored wry 补丁把窗口 transparent 同步给 webview。

**而纯 Win32 + PIL 的路子是通的**（用户亲眼确认半透明可见）：
`WS_EX_LAYERED` + `UpdateLayeredWindow(AC_SRC_ALPHA)` 逐像素 alpha 上屏，
**完全不经过 WebView2**。所以本文件取代 `overlay.html`。

⚠️ 注意区分两种透明（我一度把结论套错，浪费一轮）：
  · `WS_EX_LAYERED` + `SetLayeredWindowAttributes` = 整窗**统一** alpha
  · `WS_EX_LAYERED` + `UpdateLayeredWindow(AC_SRC_ALPHA)` = **逐像素** alpha ← 本文件用这个
  前者对 WebView2 内容无效，且与 NOREDIR 冲突会全黑。

## 契约（与 server.cjs 的 /state 对齐）

轮询 `GET /state` → 画 → `UpdateLayeredWindow` 推送。**窗口常驻、数据热更新**，
所以 AI 分步指示时不会闪屏。`gone=true` 时退出；另有硬 TTL 兜底防锁屏。

## 用法（由 server.cjs 拉起）

    python render.py --port <server端口> --monitor <显示器索引>
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import math
import sys
import time
import urllib.request

from PIL import Image, ImageChops, ImageDraw, ImageFont

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ── Win32 常量 ──
WS_EX_LAYERED = 0x00080000
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TRANSPARENT = 0x00000020          # 点击穿透：教鞭不该挡住用户操作
WS_POPUP = 0x80000000
SW_SHOW = 5
ULW_ALPHA, AC_SRC_ALPHA, DIB_RGB_COLORS = 0x02, 0x01, 0
PM_REMOVE = 0x0001
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77

# 视觉常量（与 overlay.html 保持一致，避免换后端后"看起来不是同一个东西"）
ACCENT = (255, 59, 48)                  # #ff3b30
HALO = (255, 255, 255, 235)
LABEL_BG = (20, 24, 32, 225)
DIM_COLOR = (8, 10, 16, 107)            # rgba(8,10,16,.42)
SS = 2                                  # 超采样倍数（PIL 无抗锯齿，2x 画完缩回）

LRESULT = ctypes.c_ssize_t
WNDPROCTYPE = ctypes.WINFUNCTYPE(LRESULT, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint), ("style", ctypes.c_uint), ("lpfnWndProc", WNDPROCTYPE),
        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
        ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON), ("hCursor", wt.HANDLE),
        ("hbrBackground", ctypes.c_void_p), ("lpszMenuName", wt.LPCWSTR),
        ("lpszClassName", wt.LPCWSTR), ("hIconSm", wt.HICON),
    ]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
                ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]


# ── 函数签名（不声明 argtypes 时 64 位传参会截断，句柄变垃圾值）──
user32.CreateWindowExW.restype = ctypes.c_void_p
user32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
user32.DefWindowProcW.restype = LRESULT
user32.DefWindowProcW.argtypes = [ctypes.c_void_p, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
user32.GetDC.restype = ctypes.c_void_p
user32.GetDC.argtypes = [ctypes.c_void_p]
user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.DestroyWindow.argtypes = [ctypes.c_void_p]
user32.UpdateLayeredWindow.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wt.POINT),
                                       ctypes.POINTER(wt.SIZE), ctypes.c_void_p,
                                       ctypes.POINTER(wt.POINT), wt.DWORD,
                                       ctypes.POINTER(BLENDFUNCTION), wt.DWORD]
user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_uint]
gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
gdi32.CreateDIBSection.restype = ctypes.c_void_p
gdi32.CreateDIBSection.argtypes = [ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), ctypes.c_uint,
                                   ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, wt.DWORD]
gdi32.SelectObject.restype = ctypes.c_void_p
gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
gdi32.DeleteObject.argtypes = [ctypes.c_void_p]

# 其余 Win32 函数的签名 —— 64 位下句柄/指针不声明 argtypes 会被当 int 截断成垃圾值。
user32.GetMonitorInfoW.restype = wt.BOOL
user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.EnumDisplayMonitors.restype = wt.BOOL
user32.EnumDisplayMonitors.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_void_p, wt.LPARAM]
user32.PeekMessageW.restype = wt.BOOL
user32.PeekMessageW.argtypes = [ctypes.POINTER(wt.MSG), ctypes.c_void_p,
                                ctypes.c_uint, ctypes.c_uint, ctypes.c_uint]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wt.MSG)]
user32.DispatchMessageW.restype = LRESULT
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wt.MSG)]
user32.PostQuitMessage.argtypes = [ctypes.c_int]

# ── DPI 感知（**坐标正确的前提**）──
#
# 若进程是 DPI **unaware**，Windows 会对窗口坐标做虚拟化缩放：我们传入物理像素，
# 系统按 1/scale 缩小后落点 → 画出来系统性偏移（实测：整体被放大 1.5 倍错位）。
#
# ⚠️ 两个坑（都踩过）：
#   1. `SetProcessDpiAwareness` **失败时返回非 0 而不抛异常** —— 用 try/except 包它
#      等于没检查，静默留在 unaware 状态。必须**看返回值**。
#   2. **子进程继承父进程的 DPI 感知**（Win10 1607+）。本脚本由 GUI（宿主 node）
#      spawn，若父进程是 unaware，我们**已经是** unaware，此时任何 Set 调用都会
#      返回 E_ACCESSDENIED 且**无法改变** → 只能退而求其次：**读实际缩放比，
#      自己把坐标换算回去**。
#
# 所以这里：先尝试设 aware（校验返回值），再**无条件检测真实状态** —— 因为
# 设成功与失败都要知道当前 scale 是多少。

def _try_set_dpi_aware():
    """尝试把自己设成 DPI aware。返回是否成功（**返回值要校验**）。

    ⚠️ `SetProcessDpiAwareness` 失败时**返回非 0 而不抛异常** —— 用 try/except
    包起来等于没检查。这里显式比对返回值。
    另：**子进程继承父进程的 DPI 感知**（Win10 1607+），若父进程已是 unaware
    并被锁定，这几次调用都会失败 —— 那种情况由 `_dpi_scale()` 的补偿兜住。
    """
    try:
        ctx = ctypes.WinDLL("user32").SetProcessDpiAwarenessContext
        ctx.restype = wt.BOOL
        ctx.argtypes = [ctypes.c_void_p]
        # PER_MONITOR_AWARE_V2 = -4（其余：-3 per-monitor, -2 system aware）
        if ctx(ctypes.c_void_p((-4) & 0xFFFFFFFFFFFFFFFF)):
            return True
    except Exception:
        pass
    try:
        sh = ctypes.WinDLL("shcore")
        sh.SetProcessDpiAwareness.restype = ctypes.c_int
        sh.SetProcessDpiAwareness.argtypes = [ctypes.c_int]
        if sh.SetProcessDpiAwareness(2) == 0:    # 0 = S_OK
            return True
    except Exception:
        pass
    try:
        if user32.SetProcessDPIAware():
            return True
    except Exception:
        pass
    return False


def _dpi_scale():
    """返回「AI 给的物理坐标 → 本进程窗口坐标」的换算系数。

    ## 判据：比「窗口 API 报的屏幕宽」与「显示器真实物理宽」
      · 相等  → 本进程是 DPI aware，窗口坐标**就是**物理像素 → 系数 **1.0**
      · 更小  → 被虚拟化，系数 = 真实宽 / 报的宽

    ## 🔴 别再用系统 DPI（`dmLogPixels / 96`）—— 2026-09-20 踩过
    那个值（本机 1.5）测的是**系统缩放比**，不是**本进程有没有被虚拟化**。
    本进程其实已被 `_try_set_dpi_aware()` 设成 aware（实测 `aware_ok=True`、
    `GetSystemMetrics` 报 2560），窗口就是 1:1 物理 —— 再除一次 1.5 就**多除了**，
    所有图形落到"目标 ÷ 1.5"的位置。

    实测证据（传 4 个角，全落 1/1.5）：
        传 2400 → 落 1604      传 200 → 落 139
        传 1400 → 落  932      传 200(纵向) → 落 133
    而换回本判据（两者相等 → 1.0）后，之前那轮验证过"偏差 0px"。

    ⚠️ 教训：**"觉得某个判据不准"时要先实测，别直接换** —— 我就是换掉了
    本来正确的实现，引入了这个多除一次的 bug。
    """
    class DEVMODEW(ctypes.Structure):
        _fields_ = [
            ("dmDeviceName", wt.WCHAR * 32), ("dmSpecVersion", wt.WORD),
            ("dmDriverVersion", wt.WORD), ("dmSize", wt.WORD), ("dmDriverExtra", wt.WORD),
            ("dmFields", wt.DWORD), ("dmPositionX", ctypes.c_long),
            ("dmPositionY", ctypes.c_long), ("dmDisplayOrientation", wt.DWORD),
            ("dmDisplayFixedOutput", wt.DWORD), ("dmColor", ctypes.c_short),
            ("dmDuplex", ctypes.c_short), ("dmYResolution", ctypes.c_short),
            ("dmTTOption", ctypes.c_short), ("dmCollate", ctypes.c_short),
            ("dmFormName", wt.WCHAR * 32), ("dmLogPixels", wt.WORD),
            ("dmBitsPerPel", wt.DWORD), ("dmPelsWidth", wt.DWORD),
            ("dmPelsHeight", wt.DWORD), ("dmDisplayFlags", wt.DWORD),
            ("dmDisplayFrequency", wt.DWORD), ("dmICMMethod", wt.DWORD),
            ("dmICMIntent", wt.DWORD), ("dmMediaType", wt.DWORD),
            ("dmDitherType", wt.DWORD), ("dmReserved1", wt.DWORD),
            ("dmReserved2", wt.DWORD), ("dmPanningWidth", wt.DWORD),
            ("dmPanningHeight", wt.DWORD),
        ]

    user32.EnumDisplaySettingsW.restype = wt.BOOL
    user32.EnumDisplaySettingsW.argtypes = [wt.LPCWSTR, wt.DWORD, ctypes.POINTER(DEVMODEW)]
    dm = DEVMODEW()
    dm.dmSize = ctypes.sizeof(DEVMODEW)
    if not user32.EnumDisplaySettingsW(None, 0xFFFFFFFF, ctypes.byref(dm)):
        return 1.0
    real_w = dm.dmPelsWidth
    seen_w = user32.GetSystemMetrics(0)      # SM_CXSCREEN（unaware 时会被虚拟化）
    if real_w <= 0 or seen_w <= 0 or seen_w >= real_w:
        return 1.0
    return real_w / seen_w


_set_dpi_aware_ok = _try_set_dpi_aware()
SCALE = _dpi_scale()
# =1.0 → 进程是 aware，窗口坐标就是物理像素，直接用
# >1.0 → 进程仍是 unaware（Set 失败，通常因为**父进程已是 unaware 且被子进程继承**），
#        窗口坐标被虚拟化，传物理像素会被系统按 1/SCALE 缩小 → 必须**除以** SCALE
VIRTUALIZED = SCALE > 1.01

if VIRTUALIZED:
    print(f"[pointer] DPI 虚拟化检测到 scale={SCALE}（set_aware_ok={_set_dpi_aware_ok}）"
          f" → 坐标将按 1/{SCALE} 补偿", file=sys.stderr)


def _monitors():
    """枚举显示器，返回 [(x, y, w, h), ...]（物理像素，虚拟屏坐标系）。

    用 EnumDisplayMonitors 而不是 GetSystemMetrics —— 后者只给虚拟屏总尺寸，
    多屏时无法定位"第 N 块"。顺序与系统一致（主屏通常索引 0）。
    """
    monitors = []
    MONITORENUMPROC = ctypes.WINFUNCTYPE(
        ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.POINTER(wt.RECT), ctypes.c_double)

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT),
                    ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

    def cb(hmon, hdc, lprc, data):
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            r = mi.rcMonitor
            monitors.append((r.left, r.top, r.right - r.left, r.bottom - r.top))
        return 1

    user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(cb), 0)
    return monitors


def _font(size_px, bold=False):
    """中文字体 —— 教鞭的标注基本都是中文，用雅黑；取不到再退回默认。"""
    for name in (("msyhbd.ttc", "msyh.ttc") if bold else ("msyh.ttc", "simhei.ttf")):
        try:
            return ImageFont.truetype("C:/Windows/Fonts/" + name, size_px)
        except OSError:
            continue
    return ImageFont.load_default()


class Canvas:
    """把一次 /state 画成一张 RGBA 位图（坐标是**该显示器内**的物理像素）。

    实现要点：
      · **2x 超采样**：PIL 的 ImageDraw 没有抗锯齿，放大 2 倍画完再 LANCZOS 缩回
      · **预乘 alpha**：UpdateLayeredWindow + AC_SRC_ALPHA 的硬要求，不预乘会出现黑边
    """

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.img = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)
        self.font = _font(15 * SS)
        self.font_bold = _font(15 * SS, bold=True)
        self.font_badge = _font(14 * SS, bold=True)

    def _s(self, *vals):
        """逻辑（CSS 等价）值 → 超采样画布坐标"""
        return tuple(v * SS for v in vals)

    def dim(self, holes):
        """暗幕：整屏轻微压暗，但**指示区域挖空**（那里保持原样亮着）。

        实现：单独一层纯色 → 用 mask 把洞抹掉（alpha=0）→ 合成到主图之下。
        """
        layer = Image.new("RGBA", (self.w * SS, self.h * SS), DIM_COLOR)
        mask = Image.new("L", (self.w * SS, self.h * SS), 255)   # 255 = 保留暗幕
        md = ImageDraw.Draw(mask)
        for hx, hy, hw, hh, hr in holes:
            md.rounded_rectangle(self._s(hx, hy, hx + hw, hy + hh),
                                 radius=max(0, int(hr * SS)), fill=0)
        layer.putalpha(mask.point(lambda v: v * DIM_COLOR[3] // 255))
        self.img.alpha_composite(layer)

    def arrow(self, a):
        x1, y1, x2, y2 = a["fromX"], a["fromY"], a["toX"], a["toY"]
        ang = math.atan2(y2 - y1, x2 - x1)
        head = 22
        # 线画到"箭头根部"一点（而非尖端），避免线头戳出箭头
        bx = x2 - math.cos(ang) * head * 0.72
        by = y2 - math.sin(ang) * head * 0.72
        back = ang + math.pi
        p1 = (x2 + math.cos(back - 0.42) * head, y2 + math.sin(back - 0.42) * head)
        p2 = (x2 + math.cos(back + 0.42) * head, y2 + math.sin(back + 0.42) * head)
        # 白描边打底 → 红主色（halo 效果：在任何背景上都看得清）
        self.d.line(self._s(x1, y1, bx, by), fill=HALO, width=9 * SS)
        self.d.polygon([self._s(x2, y2), self._s(*p1), self._s(*p2)], fill=HALO)
        self.d.line(self._s(x1, y1, bx, by), fill=ACCENT + (255,), width=int(4.5 * SS))
        self.d.polygon([self._s(x2, y2), self._s(*p1), self._s(*p2)], fill=ACCENT + (255,))

    def rect(self, r):
        x, y, w, h = r["x"], r["y"], r["w"], r["h"]
        self.d.rounded_rectangle(self._s(x, y, x + w, y + h), radius=8 * SS,
                                 outline=HALO, width=9 * SS)
        self.d.rounded_rectangle(self._s(x, y, x + w, y + h), radius=8 * SS,
                                 outline=ACCENT + (255,), width=4 * SS)
        self.badge(x, y, r.get("label"))

    def circle(self, c):
        cx, cy, r = c["x"], c["y"], c["r"]
        self.d.ellipse(self._s(cx - r, cy - r, cx + r, cy + r), outline=HALO, width=9 * SS)
        self.d.ellipse(self._s(cx - r, cy - r, cx + r, cy + r), outline=ACCENT + (255,), width=4 * SS)
        off = r * 0.707
        self.badge(cx - off, cy - off, c.get("label"))

    def badge(self, x, y, text):
        """角标：画在(x,y)左上外侧的小圆 + 白字（如步骤序号 "1"）"""
        if not text:
            return
        r = 13
        cx, cy = x - r + 2, y - r + 2
        self.d.ellipse(self._s(cx - r - 2.5, cy - r - 2.5, cx + r + 2.5, cy + r + 2.5), fill=HALO)
        self.d.ellipse(self._s(cx - r, cy - r, cx + r, cy + r), fill=ACCENT + (255,))
        self.d.text(self._s(cx, cy), str(text)[:8], font=self.font_badge,
                    fill=(255, 255, 255, 255), anchor="mm")

    def label(self, l):
        """文字标签：先量文字尺寸再补圆角气泡（SVG 版用 getBBox，这里用 textbbox）"""
        x, y = l["x"], l["y"]
        text = l["text"]
        pad = 9
        tb = self.d.textbbox((0, 0), text, font=self.font)
        tw, th = (tb[2] - tb[0]) / SS, (tb[3] - tb[1]) / SS
        self.d.rounded_rectangle(
            self._s(x - pad, y - th * 0.5 - pad * 0.6, x + tw + pad, y + th * 0.5 + pad * 0.8),
            radius=7 * SS, fill=LABEL_BG, outline=ACCENT + (255,), width=2 * SS)
        self.d.text(self._s(x, y), text, font=self.font,
                    fill=(255, 255, 255, 255), anchor="lm")

    def finish(self):
        """缩回原尺寸 → 预乘 alpha → BGRA 字节（UpdateLayeredWindow 要的格式）"""
        img = self.img.resize((self.w, self.h), Image.LANCZOS)
        r, g, b, a = img.split()
        img = Image.merge("RGBA", (ImageChops.multiply(r, a), ImageChops.multiply(g, a),
                                   ImageChops.multiply(b, a), a))
        return img.tobytes("raw", "BGRA")


def render_state(st, monitor_rect, scale=1.0):
    """把 /state 画成位图字节。

    ## 坐标系（容易搞错，2026-09-20 踩过）
    - `st` 里的坐标是**屏幕绝对物理像素**（AI 从截图算出来的，与截图工具同坐标系）
    - `monitor_rect` 来自 `_monitors()`，是**窗口坐标系**的——进程 DPI unaware 时
      它是被虚拟化过的值（如 1707×1067 而非 2560×1600）
    - 位图按 monitor_rect 的尺寸建，最终由 `UpdateLayeredWindow` 铺满屏幕，
      **单位是窗口坐标**

    所以物理坐标要**除以 scale** 才落到位图的正确位置。不除就是系统性放大
    （实测 scale=1.5 时整体偏到 1.5 倍处 —— 圈画到了搜索框上而不是标签上）。
    """
    ox, oy, w, h = monitor_rect
    sh = st.get("shapes") or {}
    arrows = sh.get("arrows") or []
    rects = sh.get("rects") or []
    circles = sh.get("circles") or []
    labels = sh.get("labels") or []

    def loc(x, y):
        """物理像素 → 位图坐标（先除以 scale，再减本显示器原点）"""
        return (x / scale - ox, y / scale - oy)

    cv = Canvas(w, h)
    if st.get("dim") is not False:
        holes = []
        for r in rects:
            x, y = loc(r["x"], r["y"])
            holes.append((x - 6, y - 6, r["w"] / scale + 12, r["h"] / scale + 12, 10))
        for c in circles:
            x, y = loc(c["x"], c["y"])
            rr = c["r"] / scale + 6
            holes.append((x - rr, y - rr, rr * 2, rr * 2, c["r"] / scale + 6))
        cv.dim(holes)
    for a in arrows:
        p1 = loc(a["fromX"], a["fromY"])
        p2 = loc(a["toX"], a["toY"])
        cv.arrow({"fromX": p1[0], "fromY": p1[1], "toX": p2[0], "toY": p2[1]})
    for r in rects:
        x, y = loc(r["x"], r["y"])
        cv.rect({"x": x, "y": y, "w": r["w"] / scale, "h": r["h"] / scale,
                 "label": r.get("label")})
    for c in circles:
        x, y = loc(c["x"], c["y"])
        cv.circle({"x": x, "y": y, "r": c["r"] / scale, "label": c.get("label")})
    for l in labels:
        x, y = loc(l["x"], l["y"])
        cv.label({"x": x, "y": y, "text": l["text"]})
    return cv.finish()


class Overlay:
    """一个覆盖某块显示器的 layered 穿透窗口。"""

    def __init__(self, rect, class_name):
        self.rect = rect
        ox, oy, w, h = rect
        hinst = kernel32.GetModuleHandleW(None)

        def _proc(h, m, wp, lp):
            if m == 0x0002:          # WM_DESTROY
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(h, m, wp, lp)

        self._proc_ref = WNDPROCTYPE(_proc)     # 必须留引用，否则回调被 GC 掉
        wc = WNDCLASSEXW(cbSize=ctypes.sizeof(WNDCLASSEXW), lpfnWndProc=self._proc_ref,
                         hInstance=hinst, hbrBackground=None, lpszClassName=class_name)
        if not user32.RegisterClassExW(ctypes.byref(wc)):
            err = ctypes.get_last_error()
            if err not in (0, 1410):            # 1410 = 类已注册（同一进程多显示器时正常）
                raise OSError(f"RegisterClassExW 失败 err={err}")

        self.hwnd = user32.CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT,
            class_name, "pointer", WS_POPUP, ox, oy, w, h, None, None, hinst, None)
        if not self.hwnd:
            raise OSError(f"CreateWindowExW 失败 err={ctypes.get_last_error()}")

        self.screen_dc = user32.GetDC(None)
        self.mem_dc = gdi32.CreateCompatibleDC(self.screen_dc)
        self._bitmap = None

    def push(self, buf):
        ox, oy, w, h = self.rect
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth, bmi.bmiHeader.biHeight = w, -h   # 负高度 = 自顶向下
        bmi.bmiHeader.biPlanes, bmi.bmiHeader.biBitCount = 1, 32
        bits = ctypes.c_void_p()
        hbmp = gdi32.CreateDIBSection(self.screen_dc, ctypes.byref(bmi), DIB_RGB_COLORS,
                                      ctypes.byref(bits), None, 0)
        if not hbmp:
            return False
        gdi32.SelectObject(self.mem_dc, hbmp)
        ctypes.memmove(bits.value, buf, len(buf))
        blend = BLENDFUNCTION(0, 0, 255, AC_SRC_ALPHA)
        size, src, dst = wt.SIZE(w, h), wt.POINT(0, 0), wt.POINT(ox, oy)
        ok = user32.UpdateLayeredWindow(self.hwnd, self.screen_dc, ctypes.byref(dst),
                                        ctypes.byref(size), self.mem_dc, ctypes.byref(src),
                                        0, ctypes.byref(blend), ULW_ALPHA)
        # 旧位图换下来后必须释放，否则每次重绘泄漏一个 ~10MB 的 DIB
        if self._bitmap:
            gdi32.DeleteObject(self._bitmap)
        self._bitmap = hbmp
        return bool(ok)

    def show(self):
        user32.ShowWindow(self.hwnd, SW_SHOW)
        # 保险：置顶（某些 shell 下 TOPMOST 建窗会被重置）
        HWND_TOPMOST = ctypes.c_void_p(-1)
        user32.SetWindowPos(self.hwnd, HWND_TOPMOST, self.rect[0], self.rect[1],
                            self.rect[2], self.rect[3], 0x0010 | 0x0040)  # SWP_NOACTIVATE|SHOWWINDOW

    def close(self):
        if self._bitmap:
            gdi32.DeleteObject(self._bitmap)
        gdi32.DeleteObject(self.mem_dc)
        user32.ReleaseDC(None, self.screen_dc)
        user32.DestroyWindow(self.hwnd)


def pump():
    """跑消息泵 —— layered 窗口本身靠 UpdateLayeredWindow 推送，
    但窗口销毁/系统事件仍要消息循环才处理得掉（探针阶段踩过：不跑泵窗口是空白）。"""
    msg = wt.MSG()
    while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True, help="pointer-server 的端口")
    ap.add_argument("--monitor", type=int, default=0, help="显示器索引（0=主屏）")
    args = ap.parse_args()

    mons = _monitors()
    if not mons:
        print("没有检测到显示器", file=sys.stderr)
        return 1
    idx = args.monitor if 0 <= args.monitor < len(mons) else 0
    rect = mons[idx]

    # 诊断落盘 —— 被 GUI spawn 时 stdio 是 ignore（stderr 看不到），
    # 排查"坐标偏移"必须先知道进程的真实 DPI 状态。文件：`%TEMP%/pointer-dpi.txt`
    try:
        import os as _os
        _diag = _os.path.join(_os.environ.get("TEMP", "."), "pointer-dpi.txt")
        with open(_diag, "a", encoding="utf-8") as _f:
            _f.write(
                f"scale={SCALE} virtualized={VIRTUALIZED} aware_ok={_set_dpi_aware_ok} "
                f"SM={user32.GetSystemMetrics(0)}x{user32.GetSystemMetrics(1)} "
                f"monitors={mons} picked={rect}\n"
            )
    except Exception:
        pass
    base = f"http://127.0.0.1:{args.port}"

    def get(path):
        try:
            with urllib.request.urlopen(base + path, timeout=3) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            return None

    def hello_bye(path):
        try:
            urllib.request.urlopen(base + path, timeout=3).read()
        except Exception:
            pass

    ov = Overlay(rect, f"PointerOverlay{idx}")
    hello_bye("/hello")
    last_rev, hard_deadline = -1, time.time() + 300   # 硬 TTL 兜底（防锁屏）
    try:
        while time.time() < hard_deadline:
            pump()
            st = get("/state")
            if st is None:
                break                       # server 没了 —— 别再挂着遮屏
            if st.get("gone"):
                break
            if st.get("rev") != last_rev:
                ov.push(render_state(st, rect, SCALE))
                if last_rev < 0:
                    ov.show()               # 首帧才 show，避免闪一下空白
                last_rev = st["rev"]
            time.sleep(0.12)
        # 淡出：把整层推到全透明再撤窗（直接 DestroyWindow 会"啪"地消失）
        try:
            from PIL import Image as _I
            ox, oy, w, h = rect
            blank = _I.new("RGBA", (w, h), (0, 0, 0, 0)).tobytes("raw", "BGRA")
            for step in range(4):
                pump()
                ov.push(blank)
                time.sleep(0.05)
        except Exception:
            pass
    finally:
        try:
            ov.close()
        except Exception:
            pass
        hello_bye("/bye")
        print("rendered and exited", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
