"""
Claude Code — Unified Office/WPS COM Bridge
JSON-RPC over stdin/stdout, Python win32com backend.

Auto-detects MS Office (Excel.Application) or WPS (KET.Application.9).
Supports: Excel, Word, PowerPoint / WPS Spreadsheet, Writer, Presentation.
Strategy: GetObject first (attach to running instance), Dispatch fallback.
"""

import sys, json, traceback

sys.stderr = sys.__stderr__

try:
    import pythoncom
    import win32com.client
    from win32com.client import Dispatch, GetObject, constants
except ImportError as e:
    print(json.dumps({"error": f"win32com not installed: {e}"}), flush=True)
    sys.exit(1)

# ── ProgIDs (Office first, WPS fallback) ───────────────────────────────
PROGIDS = {
    'excel': ['Excel.Application', 'KET.Application.9'],
    'word':  ['Word.Application',  'KWPS.Application.9'],
    'ppt':   ['PowerPoint.Application', 'KWPP.Application.9'],
}
PLATFORM_NAMES = {
    'excel': {'Excel.Application': 'MS Excel', 'KET.Application.9': 'WPS Spreadsheet'},
    'word':  {'Word.Application': 'MS Word',   'KWPS.Application.9': 'WPS Writer'},
    'ppt':   {'PowerPoint.Application': 'MS PPT', 'KWPP.Application.9': 'WPS Presentation'},
}

# ── State ──────────────────────────────────────────────────────────────
_apps = {'excel': None, 'word': None, 'ppt': None}
_platforms = {'excel': None, 'word': None, 'ppt': None}
_instances_created = False

def log(msg):
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)

def _get_app(app_type, launch=False):
    global _instances_created
    if _apps[app_type] is not None:
        return _apps[app_type]

    for progid in PROGIDS[app_type]:
        try:
            app = GetObject(None, progid)
            app.Visible = True
            _apps[app_type] = app
            _platforms[app_type] = progid
            log(f"Attached to {PLATFORM_NAMES[app_type][progid]}")
            return app
        except Exception:
            continue

    if launch:
        for progid in PROGIDS[app_type]:
            try:
                app = Dispatch(progid)
                app.Visible = True
                _apps[app_type] = app
                _platforms[app_type] = progid
                _instances_created = True
                log(f"Launched {PLATFORM_NAMES[app_type][progid]}")
                return app
            except Exception:
                continue

    raise Exception(
        f"{app_type.title()} is not running. "
        f"Open it first (MS Office or WPS). "
        f"If using WPS, ensure WPS COM is available (32-bit Python)."
    )

def fmt_val(v, max_len=5000):
    """Truncate large string values."""
    if isinstance(v, str) and len(v) > max_len:
        return v[:max_len] + f"\n...(truncated, {len(v)} total chars)"
    return v

# ═══════════════════════════════════════════════════════════════════════════
# get_context
# ═══════════════════════════════════════════════════════════════════════════

def get_context(params):
    """Detect which Office app is active and return context."""
    ctx = {"platform": "ms-office"}
    for name in ["excel", "word", "ppt"]:
        try:
            app = _get_app(name, launch=False)
            ctx["app"] = name
            ctx["version"] = app.Version
            ctx["platform"] = _platforms.get(name, "ms-office")

            if name == "excel":
                wb = app.ActiveWorkbook
                if wb:
                    ctx["docName"] = wb.Name
                    ctx["fullName"] = wb.FullName
                    sheet = app.ActiveSheet
                    ctx["sheetName"] = sheet.Name if sheet else ""
                    sel = app.Selection
                    ctx["selection"] = sel.Address if sel else ""
                else:
                    ctx["docName"] = "(no workbook open)"

            elif name == "word":
                doc = app.ActiveDocument
                if doc:
                    ctx["docName"] = doc.Name
                    ctx["fullName"] = doc.FullName
                    sel = app.Selection
                    ctx["selection"] = sel.Text[:500] if sel and sel.Text else ""
                    ctx["paragraphCount"] = doc.Paragraphs.Count if doc.Paragraphs else 0
                else:
                    ctx["docName"] = "(no document open)"

            elif name == "ppt":
                pres = app.ActivePresentation
                if pres:
                    ctx["docName"] = pres.Name
                    ctx["fullName"] = pres.FullName
                    ctx["slideCount"] = pres.Slides.Count if pres.Slides else 0
                    try:
                        ctx["currentSlide"] = app.ActiveWindow.View.Slide.SlideIndex if app.ActiveWindow else 0
                    except:
                        ctx["currentSlide"] = 0
                else:
                    ctx["docName"] = "(no presentation open)"
            break
        except:
            continue

    if "app" not in ctx:
        ctx["error"] = "No Office application running. Open Excel, Word, or PPT first."
    return ctx

# ═══════════════════════════════════════════════════════════════════════════
# execute_code
# ═══════════════════════════════════════════════════════════════════════════

def execute_code(params):
    """Execute arbitrary Python code with live COM app objects.

    Predefined in scope:
      apps      -> dict with 'excel', 'word', 'ppt' keys
      xl, wd, ppt  -> shorthand for each app
      constants  -> win32com.constants
      RGB(r,g,b) -> color helper
    Set `result = <value>` to return a result.
    """
    code = params.get("code", "")
    if not code:
        return {"error": "No code provided"}
    # Auto-connect to any running apps (doesn't change visibility)
    for t in ("excel", "word", "ppt"):
        if _apps[t] is None:
            try:
                _apps[t] = GetObject(None, PROGIDS[t][0])
            except:
                try:
                    _apps[t] = GetObject(None, PROGIDS[t][1])
                except:
                    pass
    xl = _apps.get("excel")
    wd = _apps.get("word")
    ppt = _apps.get("ppt")
    def RGB(r, g, b): return r + (g << 8) + (b << 16)
    # GetObject(progid) with a SINGLE arg treats it as a file path/moniker and
    # fails with "invalid syntax" — attach to a RUNNING app via GetObject(None,
    # progid) / GetActiveObject(progid). Wrap GetObject so single-arg ProgID
    # means "attach to running", matching how callers actually use it.
    def safe_get_object(*args):
        if len(args) == 1 and not (":" in args[0] or "/" in args[0] or "\\" in args[0]):
            return win32com.client.GetActiveObject(args[0])
        return GetObject(*args)
    scope = {"apps": _apps, "xl": xl, "wd": wd, "ppt": ppt,
             "Dispatch": Dispatch, "GetObject": safe_get_object,
             "GetActiveObject": win32com.client.GetActiveObject,
             "constants": constants, "RGB": RGB, "result": None}
    try:
        exec(code, {"__builtins__": __builtins__}, scope)
        r = scope.get("result")
        return {"success": True, "result": r}
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        return {"error": f"Code execution error: {e}"}

# ═══════════════════════════════════════════════════════════════════════════
# Method Router
# ═══════════════════════════════════════════════════════════════════════════

METHODS = {
    "get_context": get_context,
    "execute_code": execute_code,
}

# ═══════════════════════════════════════════════════════════════════════════
# Main Loop — JSON-RPC over stdin/stdout
# ═══════════════════════════════════════════════════════════════════════════

def main():
    log("Bridge started, waiting for commands...")
    pythoncom.CoInitialize()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            if line == "EXIT":
                log("Shutting down...")
                break
            if line == "PING":
                print(json.dumps({"pong": True}), flush=True)
                continue

            try:
                req = json.loads(line)
            except json.JSONDecodeError as e:
                print(json.dumps({"error": f"Invalid JSON: {e}"}), flush=True)
                continue

            req_id = req.get("id", "")
            method = req.get("method", "")
            params = req.get("params", {})

            handler = METHODS.get(method)
            if not handler:
                print(json.dumps({"id": req_id, "error": f"Unknown method: {method}"}), flush=True)
                continue

            try:
                result = handler(params)
                print(json.dumps({"id": req_id, "result": result}, default=str), flush=True)
            except Exception as e:
                traceback.print_exc(file=sys.stderr)
                print(json.dumps({"id": req_id, "error": str(e)}), flush=True)
    finally:
        log("Cleaning up COM...")
        global _apps, _instances_created
        if _instances_created:
            for app_type, app in _apps.items():
                try:
                    if app: app.Quit()
                except: pass
        pythoncom.CoUninitialize()
        log("Bridge stopped.")

if __name__ == "__main__":
    main()
