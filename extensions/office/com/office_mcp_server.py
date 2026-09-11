"""
Claude Code — Office MCP Server (stdio transport, official mcp SDK)
===================================================================
Unified Office tooling for Claude Code via MCP (Model Context Protocol),
built on the official `mcp` Python SDK (same as the memory MCP server).

One server, two backends, auto-detected by platform:
  - Windows : win32com (COM) — drives MS Office / WPS apps
  - macOS   : osascript (Apple Events) — drives MS Office for Mac

Tools:
  - office_get_context : detect running Office app + return active-doc context
  - office_execute     : execute code against the live Office app
      * Windows: Python code with xl/wd/ppt COM objects
      * macOS  : AppleScript code (osascript)

The official SDK handles the MCP protocol (handshake/session/response), which
the hand-rolled JSON-RPC loop could not — execute runs in a worker thread via
asyncio.to_thread so the asyncio loop keeps answering claude.exe's concurrent
requests (ping/…), and Word UI calls (TypeText etc.) work reliably.

No built-in fallback to file-level manipulation: if Office is unavailable /
not authorized, explicit errors are returned so the AI decides on its own to
fall back to file-level Python libraries (openpyxl/python-docx/python-pptx).
"""

import sys, json, asyncio, platform

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

sys.stderr = sys.__stderr__
IS_MAC = platform.system() == 'Darwin'

app = Server("office")

# ═══════════════════════════════════════════════════════════════════════════
# macOS backend — osascript / Apple Events
# ═══════════════════════════════════════════════════════════════════════════

MAC_APPS = {
    'excel': 'Microsoft Excel',
    'word':  'Microsoft Word',
    'ppt':   'Microsoft PowerPoint',
}


def _mac_run(script, timeout=60):
    import subprocess
    try:
        r = subprocess.run(['osascript'], input=script, capture_output=True,
                           text=True, timeout=timeout)
    except FileNotFoundError:
        return False, "osascript not found — this bridge requires macOS"
    except subprocess.TimeoutExpired:
        return False, "osascript timed out"
    if r.returncode == 0:
        return True, r.stdout.strip()
    return False, _mac_friendly_error((r.stderr or '').strip())


def _mac_friendly_error(err):
    if '-1743' in err:
        return ("Not authorized to control Office (macOS Automation permission). "
                "Grant it in System Settings → Privacy & Security → Automation, then "
                "retry. Alternatively, fall back to file-level manipulation with "
                "Python libraries (openpyxl/python-docx/python-pptx).")
    low = err.lower()
    if 'not running' in low or '-600' in err:
        return "MS Office app not running — open it first."
    if 'not installed' in low or '-10810' in err:
        return "MS Office app not installed on this Mac."
    return f"AppleScript error: {err}"


def _mac_app_running(app_name):
    ok, out = _mac_run(f'application "{app_name}" is running', timeout=15)
    return ok and out.strip().lower() == 'true'


# ═══════════════════════════════════════════════════════════════════════════
# Windows backend — win32com / COM
# ═══════════════════════════════════════════════════════════════════════════

WIN_PROGIDS = {
    'excel': ['Excel.Application', 'KET.Application.9'],
    'word':  ['Word.Application',  'KWPS.Application.9'],
    'ppt':   ['PowerPoint.Application', 'KWPP.Application.9'],
}
_win_apps = {'excel': None, 'word': None, 'ppt': None}
_win_platforms = {'excel': None, 'word': None, 'ppt': None}


def _win_init():
    """Import win32com lazily; return error string or None."""
    try:
        import pythoncom  # noqa: F401
        import win32com.client  # noqa: F401
        return None
    except ImportError as e:
        return f"win32com not installed: {e}"


def _win_get_app(app_type):
    if _win_apps[app_type] is not None:
        return _win_apps[app_type], None
    import win32com.client
    for progid in WIN_PROGIDS[app_type]:
        try:
            app = win32com.client.GetObject(None, progid)
            app.Visible = True
            _win_apps[app_type] = app
            _win_platforms[app_type] = progid
            return app, None
        except Exception:
            continue
    return None, (f"{app_type.title()} is not running. Open it first (MS Office or WPS). "
                  "If using WPS, ensure WPS COM is available (32-bit Python).")


def _win_attach(progids):
    """独立附加运行中的实例（worker 线程用，避免跨线程访问 _win_apps）。"""
    import win32com.client
    for p in progids:
        try:
            return win32com.client.GetActiveObject(p)
        except Exception:
            continue
    return None


# ═══════════════════════════════════════════════════════════════════════════
# office_get_context
# ═══════════════════════════════════════════════════════════════════════════

def _get_context(_args):
    if IS_MAC:
        ctx = {"platform": "ms-office-mac"}
        for name, app_name in MAC_APPS.items():
            if not _mac_app_running(app_name):
                continue
            if name == 'excel':
                ok, wb = _mac_run(f'tell application "{app_name}" to get name of active workbook')
                if not ok:
                    continue
                ctx['app'] = name
                ctx['docName'] = wb or '(no workbook open)'
                ok2, sheet = _mac_run(f'tell application "{app_name}" to get name of active sheet')
                ctx['sheetName'] = sheet if ok2 else ''
            elif name == 'word':
                ok, doc = _mac_run(f'tell application "{app_name}" to get name of active document')
                if not ok:
                    continue
                ctx['app'] = name
                ctx['docName'] = doc or '(no document open)'
            elif name == 'ppt':
                ok, pres = _mac_run(f'tell application "{app_name}" to get name of active presentation')
                if not ok:
                    continue
                ctx['app'] = name
                ctx['docName'] = pres or '(no presentation open)'
            ctx['platform'] = f'MS {name.title()} (mac)'
            break
        if 'app' not in ctx:
            ctx['error'] = ("No MS Office for Mac app running. Open Excel, Word, or "
                            "PowerPoint first. If Office is not installed, fall back "
                            "to file-level manipulation with Python libraries.")
        return ctx

    # Windows — asyncio.to_thread 的 worker 线程执行，独立附加 COM。
    # 用 MTA：Word 是 STA 服务器，MTA 调用由系统 marshal 到其 UI 线程处理，
    # 不依赖 worker 线程的消息泵（否则 GetActiveObject 在无消息泵的线程会卡）。
    err = _win_init()
    if err:
        return {"error": err}
    import pythoncom
    pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)
    try:
        ctx = {"platform": "ms-office"}
        for name in ['excel', 'word', 'ppt']:
            app = _win_attach(WIN_PROGIDS[name])
            if app is None:
                continue
            ctx['app'] = name
            ctx['platform'] = 'WPS ' + name if 'K' in (WIN_PROGIDS[name][0]) else 'MS Office'
            try:
                if name == 'excel':
                    wb = app.ActiveWorkbook
                    ctx['docName'] = wb.Name if wb else '(no workbook open)'
                    sheet = app.ActiveSheet
                    ctx['sheetName'] = sheet.Name if sheet else ''
                    sel = app.Selection
                    ctx['selection'] = sel.Address if sel else ''
                elif name == 'word':
                    doc = app.ActiveDocument
                    ctx['docName'] = doc.Name if doc else '(no document open)'
                elif name == 'ppt':
                    pres = app.ActivePresentation
                    ctx['docName'] = pres.Name if pres else '(no presentation open)'
            except Exception:
                ctx['docName'] = '(error reading active doc)'
            break
        if 'app' not in ctx:
            ctx['error'] = "No Office application running. Open Excel, Word, or PPT first."
        return ctx
    finally:
        pythoncom.CoUninitialize()


# ═══════════════════════════════════════════════════════════════════════════
# office_execute
# ═══════════════════════════════════════════════════════════════════════════

def _execute(args):
    code = (args or {}).get('code', '')
    if not code or not isinstance(code, str):
        return {"error": "No code provided. Pass an AppleScript (macOS) or Python/COM (Windows) snippet in `code`."}

    if IS_MAC:
        ok, out = _mac_run(code)
        return {"success": True, "result": out} if ok else {"error": out}

    # Windows — 在调用线程（asyncio.to_thread 的 worker 线程）独立附加 COM，
    # 不跨线程访问主线程 get_context 附加的 _win_apps。
    # 注意：TypeText/Font 等 UI 自动化要求 Office 窗口在前台，后台窗口会阻塞。
    err = _win_init()
    if err:
        return {"error": err}
    import win32com.client
    from win32com.client import Dispatch, GetObject, constants
    import pythoncom
    pythoncom.CoInitializeEx(pythoncom.COINIT_MULTITHREADED)
    try:
        wd = _win_attach(WIN_PROGIDS['word'])
        xl = _win_attach(WIN_PROGIDS['excel'])
        ppt = _win_attach(WIN_PROGIDS['ppt'])
        if wd is None:
            try:
                wd = Dispatch(WIN_PROGIDS['word'][0])
            except Exception:
                wd = None

        def RGB(r, g, b):
            return r + (g << 8) + (b << 16)

        def safe_get_object(*a):
            if len(a) == 1 and not (":" in a[0] or "/" in a[0] or "\\" in a[0]):
                return win32com.client.GetActiveObject(a[0])
            return GetObject(*a)

        apps = {'excel': xl, 'word': wd, 'ppt': ppt}
        scope = {"apps": apps, "xl": xl, "wd": wd, "ppt": ppt,
                 "Dispatch": Dispatch, "GetObject": safe_get_object,
                 "GetActiveObject": win32com.client.GetActiveObject,
                 "constants": constants, "RGB": RGB, "result": None}
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            exec(code, {"__builtins__": __builtins__}, scope)
        captured = buf.getvalue()
        result = scope.get("result")
        if result is None and captured.strip():
            result = captured.strip()
        return {"success": True, "result": result}
    except Exception as e:
        return {"error": f"Code execution error: {e}"}
    finally:
        pythoncom.CoUninitialize()


# ═══════════════════════════════════════════════════════════════════════════
# Tool definitions + MCP server (official SDK)
# ═══════════════════════════════════════════════════════════════════════════

TOOLS = [
    Tool(
        name="office_get_context",
        description=(
            "Detect the running MS Office app (Windows: COM, macOS: AppleScript) and "
            "return the active document context. Always call this first to see what is open."
        ),
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    Tool(
        name="office_execute",
        description=(
            "Execute code against the live MS Office app. On Windows: Python code with "
            "xl/wd/ppt COM objects (set `result` to return data). On macOS: AppleScript "
            "code via osascript (e.g. `tell application \\\"Microsoft Excel\\\" to set value of cell ...`). "
            "On Windows, TypeText/Font UI automation requires the Office window to be "
            "foreground — activate it (wd.Activate()) before writing. "
            "If Office is unavailable/not authorized, an error is returned — fall back to "
            "file-level manipulation with Python libraries (openpyxl/python-docx/python-pptx)."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "On Windows: Python code with xl/wd/ppt COM objects. On macOS: AppleScript snippet.",
                }
            },
            "required": ["code"],
        },
    ),
]


@app.list_tools()
async def list_tools() -> list[Tool]:
    return TOOLS


def _run_sync_thread(fn, *args):
    """win32com 在每次新建的线程执行（asyncio.to_thread 复用线程池线程会卡）。
    独立线程 CoInitialize + 操作 + CoUninitialize，干净且可靠。"""
    import threading
    result_box = {}
    def runner():
        try:
            result_box['r'] = fn(*args)
        except Exception as e:
            result_box['e'] = str(e)
    t = threading.Thread(target=runner, daemon=True)
    t.start()
    t.join()
    if 'e' in result_box:
        raise RuntimeError(result_box['e'])
    return result_box.get('r')


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "office_get_context":
            r = _run_sync_thread(_get_context, arguments or {})
        elif name == "office_execute":
            r = _run_sync_thread(_execute, arguments or {})
        else:
            raise ValueError(f"Unknown tool: {name}")
        return [TextContent(type="text", text=json.dumps(r, ensure_ascii=False, default=str))]
    except Exception as exc:
        return [TextContent(type="text", text=json.dumps({"error": str(exc)}, ensure_ascii=False))]


async def main():
    async with stdio_server() as (read, write):
        await app.run(read, write, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
