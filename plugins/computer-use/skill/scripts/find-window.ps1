<#
.SYNOPSIS
  列出窗口及其精确几何信息（DPI 感知，坐标与截屏插件同一空间）。

.DESCRIPTION
  解决三个反复踩到的问题：

  1. 多实例/多窗口应用里，`Get-Process | Select MainWindowTitle` 常常是**空**的
     （Tauri/Electron 的窗口不一定挂在主 PID 上，Store 应用更是多窗口共享进程）。
     本脚本用 EnumWindows 按 PID 枚举，能列出**所有**顶层窗口。
  2. 外部工具默认是 DPI unaware，读到的是**逻辑像素**（÷缩放比），
     与截屏插件的物理像素对不上。本脚本先 SetProcessDpiAwareness(2) 再测量。
  3. 只看标题分不清是哪一个（同款应用开三个实例标题可能一样），
     而 **rect + class** 能唯一确定。

  输出为 ASCII，避免控制台代码页把中文变成乱码（实测 GBK 控制台会）。

.PARAMETER Match
  PID（纯数字）或进程名片段（如 claude-code-gui）。**必填**。

.PARAMETER Class
  可选。按窗口类名过滤（如 "Tauri Window" / "Chrome_WidgetWin_1"）。
  不填则列出全部顶层窗口。

.PARAMETER VisibleOnly
  只列出可见窗口。

.EXAMPLE
  .\find-window.ps1 -Match claude-code-gui
  .\find-window.ps1 -Match 20272 -Class "Tauri Window"
  .\find-window.ps1 -Match chrome -VisibleOnly
#>
param(
  [Parameter(Mandatory = $true)][string]$Match,
  [string]$Class = "",
  [switch]$VisibleOnly
)

$ErrorActionPreference = "Stop"

# 让控制台按 UTF-8 输出中文标题 —— 否则 GBK 控制台下标题变成乱码，
# 而窗口标题正是我们用来分辨"这是哪一个实例"的依据，糊了就等于没用。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8


# DPI 感知必须在**任何**窗口 API 调用之前设置，否则读到的全是逻辑像素。
# 2 = PROCESS_PER_MONITOR_DPI_AWARE（Win8.1+）。失败不致命（老系统），继续。
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinProbe {
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);

  public static string List(uint[] pids, string classFilter, bool visibleOnly) {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      bool pidMatch = false;
      foreach (var p in pids) { if (p == pid) { pidMatch = true; break; } }
      if (!pidMatch) return true;

      var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
      string cname = cls.ToString();
      if (classFilter.Length > 0 &&
          cname.IndexOf(classFilter, StringComparison.OrdinalIgnoreCase) < 0) return true;

      bool vis = IsWindowVisible(h);
      if (visibleOnly && !vis) return true;

      var ttl = new StringBuilder(512); GetWindowTextW(h, ttl, 512);
      RECT r; GetWindowRect(h, out r);
      uint dpi = GetDpiForWindow(h);
      double scale = dpi > 0 ? dpi / 96.0 : 1.0;

      sb.AppendFormat(
        "hwnd=0x{0:X}  pid={1}  class={2}\n  title={3}\n  rect={4},{5} {6}x{7}   visible={8} iconic={9} zoomed={10}  dpi={11} (scale {12:0.##})\n",
        h.ToInt64(), pid, cname, ttl.ToString().Trim(),
        r.L, r.T, (r.R - r.L), (r.B - r.T), vis, IsIconic(h), IsZoomed(h),
        dpi, scale);
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
'@

try { [void][WinProbe]::SetProcessDpiAwareness(2) } catch { try { [void][WinProbe]::SetProcessDPIAware() } catch {} }

# 解析 Match：纯数字 = PID；否则按进程名模糊匹配
$procs = @()
if ($Match -match '^\d+$') {
  $one = Get-Process -Id ([int]$Match) -ErrorAction SilentlyContinue
  if ($one) { $procs = @($one) }
} else {
  $procs = @(Get-Process | Where-Object { $_.ProcessName -like "*$Match*" })
}

if ($procs.Count -eq 0) {
  Write-Output "NO-PROCESS: '$Match' not found"
  exit 1
}

$pids = [uint32[]]($procs | ForEach-Object { [uint32]$_.Id })
Write-Output ("MATCH: {0} process(es) -> pids {1}" -f $procs.Count, ($pids -join ', '))

$out = [WinProbe]::List($pids, $Class, [bool]$VisibleOnly)
if ([string]::IsNullOrWhiteSpace($out)) {
  Write-Output "NO-WINDOW: processes exist but no matching top-level window"
  Write-Output "  hints: drop -Class, or the app may still be starting"
  exit 2
}
Write-Output $out
