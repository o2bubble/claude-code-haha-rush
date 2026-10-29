<#
.SYNOPSIS
  安全地还原 / 移动 / 调整窗口尺寸，并激活到前台。

.DESCRIPTION
  为什么需要这个脚本 —— 直接用 SetWindowPos 有两个静默陷阱：

  1. **对最大化的窗口 SetWindowPos 会得到垃圾尺寸**。
     实测：`SetWindowPos(-, -, 900, 700)` 于最大化窗口 → 结果
     `rect=60,60 900x65535`（高度 65535 = 16 位无符号溢出 -1）。
     必须先 `ShowWindow(SW_RESTORE=9)` 还原，等窗口退出最大化，再 resize。

  2. **AppActivate(pid) 可能静默失败**。
     多实例 / 多窗口 / Tauri 应用里主进程 `MainWindowTitle` 常为空，
     AppActivate 会激活错误对象或直接返回 False。
     本脚本按 **hwnd** 操作：ShowWindow + BringWindowToTop + SetForegroundWindow 三连，
     三连比单独 SetForegroundWindow 成功率高得多
     （Windows 会拒绝非前台进程的 SetForegroundWindow，ShowWindow/BringWindowToTop
     能把进程"推"进允许设置前台的状态）。

  操作后**必读回实际矩形**，别相信"我设了 900x700 所以就是 900x700"。

.PARAMETER Hwnd
  窗口句柄。从 find-window.ps1 的 `hwnd=0x...` 取，支持十进制或 0x 十六进制。

.PARAMETER Match
  代替 -Hwnd：进程名片段 + 可选 -Class，取**第一个可见**匹配窗口。

.PARAMETER Left / Top / Width / Height
  可选，Width 与 Height 必须同时给才 resize。只 -Activate 则只激活不改尺寸。

  ⚠️ 刻意用长名而不用 -X/-Y/-W/-H：PowerShell 变量名**大小写不敏感**，
  单字母 `$H` 会和句柄变量 `$h` 静默互相覆盖（实测：resize 出来 960x65535）。

.PARAMETER Activate
  resize 之后是否激活到前台。默认**是**（用 -NoActivate 关闭）。

.EXAMPLE
  .\window-bounds.ps1 -Match claude-code-gui -Class "Tauri Window"
  .\window-bounds.ps1 -Hwnd 0x50816 -Left 40 -Top 40 -Width 900 -Height 640
  .\window-bounds.ps1 -Hwnd 0x50816 -Activate
#>
param(
  [string]$Hwnd = "",
  [string]$Match = "",
  [string]$Class = "",
  [int]$Left, [int]$Top, [int]$Width, [int]$Height,
  [switch]$NoActivate
)

$ErrorActionPreference = "Stop"

# 让控制台按 UTF-8 输出中文标题 —— 否则 GBK 控制台下标题变成乱码，
# 而窗口标题正是我们用来分辨"这是哪一个实例"的依据，糊了就等于没用。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8


Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinCtl {
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId2(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  public static IntPtr FindFirst(uint[] pids, string classFilter) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool ok = false;
      foreach (var p in pids) { if (p == pid) { ok = true; break; } }
      if (!ok) return true;
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
      if (classFilter.Length > 0 &&
          cls.ToString().IndexOf(classFilter, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  public static string Describe(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
    var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
    return string.Format("hwnd=0x{0:X} class={1} rect={2},{3} {4}x{5} zoomed={6} iconic={7} fg={8}\n  title={9}",
      h.ToInt64(), cls, r.L, r.T, (r.R - r.L), (r.B - r.T), IsZoomed(h), IsIconic(h),
      (GetForegroundWindow() == h), t.ToString().Trim());
  }
}
'@

try { [void][WinCtl]::SetProcessDpiAwareness(2) } catch { try { [void][WinCtl]::SetProcessDPIAware() } catch {} }

# ---- 解析目标窗口 ----
if ($Hwnd -ne "") {
  $target = if ($Hwnd -match '^0x') { [IntPtr]([int64]::Parse($Hwnd.Substring(2), 'HexNumber')) }
       else { [IntPtr]([int64]$Hwnd) }
} elseif ($Match -ne "") {
  $procs = @(Get-Process | Where-Object { $_.ProcessName -like "*$Match*" })
  if ($procs.Count -eq 0) { Write-Output "NO-PROCESS: '$Match'"; exit 1 }
  $pids = [uint32[]]($procs | ForEach-Object { [uint32]$_.Id })
  $target = [WinCtl]::FindFirst($pids, $Class)
  if ($target -eq [IntPtr]::Zero) { Write-Output "NO-WINDOW (try without -Class, or run find-window.ps1)"; exit 2 }
} else {
  Write-Output "NEED: -Hwnd <hex> or -Match <process>"
  exit 3
}

Write-Output "BEFORE:"
Write-Output ([WinCtl]::Describe($target))

# ---- 关键：先退出最大化 / 最小化 ----
# 对最大化窗口直接 SetWindowPos 会得到 900x65535 这类垃圾尺寸（实测）。
if ([WinCtl]::IsIconic($target)) { [void][WinCtl]::ShowWindow($target, 9); Start-Sleep -Milliseconds 400 }
if ([WinCtl]::IsZoomed($target)) { [void][WinCtl]::ShowWindow($target, 9); Start-Sleep -Milliseconds 600 }

$resized = $false
if ($PSBoundParameters.ContainsKey('Width') -and $PSBoundParameters.ContainsKey('Height')) {
  $px = if ($PSBoundParameters.ContainsKey('Left')) { $Left } else { 40 }
  $py = if ($PSBoundParameters.ContainsKey('Top')) { $Top } else { 40 }
  # SWP_NOZORDER(0x4)
  $resized = [WinCtl]::SetWindowPos($target, [IntPtr]::Zero, $px, $py, $Width, $Height, 0x0004)
  Start-Sleep -Milliseconds 700
}

# ---- 激活到前台（三连，成功率远高于单独 SetForegroundWindow）----
if (-not $NoActivate) {
  [void][WinCtl]::ShowWindow($target, 9)
  Start-Sleep -Milliseconds 200
  [void][WinCtl]::BringWindowToTop($target)
  [void][WinCtl]::SetForegroundWindow($target)
  Start-Sleep -Milliseconds 500
}

Write-Output "AFTER:"
Write-Output ([WinCtl]::Describe($target))
if ($resized -eq $false -and ($PSBoundParameters.ContainsKey('Width'))) {
  Write-Output "WARN: SetWindowPos returned false"
}
