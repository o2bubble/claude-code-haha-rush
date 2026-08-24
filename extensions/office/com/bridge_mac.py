"""
Claude Code — macOS Office Bridge
JSON-RPC over stdin/stdout, AppleScript (osascript) backend.

Drives MS Office for Mac (Microsoft Excel / Word / PowerPoint) via Apple Events.
No COM on macOS — this is the AppleScript equivalent of the Windows COM bridge
(extensions/office/com/bridge.py).

Contract is intentionally identical to the Windows bridge:
  - get_context   : detect which MS Office for Mac app is running + active doc context
  - execute_code  : execute an AppleScript snippet against the Office app

No built-in fallback to file-level manipulation. If Office is not installed /
not running / not authorized, explicit errors are returned so the AI can decide
on its own to fall back to file-level Python libraries (openpyxl/python-docx/
python-pptx). The AI owns that decision.
"""

import sys, json, subprocess

sys.stderr = sys.__stderr__

# MS Office for Mac app names (AppleScript application identifiers)
APPS = {
    'excel': 'Microsoft Excel',
    'word':  'Microsoft Word',
    'ppt':   'Microsoft PowerPoint',
}
PLATFORM_NAMES = {
    'excel': 'MS Excel (mac)',
    'word':  'MS Word (mac)',
    'ppt':   'MS PowerPoint (mac)',
}


def log(msg):
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


def run_osascript(script, timeout=60):
    """Run an AppleScript snippet via osascript (script from stdin).

    Returns (ok: bool, output_or_error: str). osascript reads the script from
    stdin when no `-e` flag is given, so multi-line AppleScript is supported.
    """
    try:
        r = subprocess.run(['osascript'], input=script, capture_output=True,
                           text=True, timeout=timeout)
    except FileNotFoundError:
        return False, "osascript not found — this bridge requires macOS"
    except subprocess.TimeoutExpired:
        return False, "osascript timed out"

    if r.returncode == 0:
        return True, r.stdout.strip()

    err = (r.stderr or '').strip()
    return False, _friendly_error(err)


def _friendly_error(err):
    """Map common osascript/AppleScript errors to actionable messages."""
    if '-1743' in err:
        return ("Not authorized to control Office (macOS Automation permission). "
                "Grant it in System Settings → Privacy & Security → Automation, "
                "then retry. Alternatively, fall back to file-level manipulation "
                "with Python libraries (openpyxl/python-docx/python-pptx).")
    low = err.lower()
    if 'not running' in low or '-600' in err:
        return "MS Office app not running — open it first."
    if 'not installed' in low or 'app not found' in low or '-10810' in err:
        return "MS Office app not installed on this Mac."
    return f"AppleScript error: {err}"


def _app_running(app_name):
    """Check if an app is running via Standard Additions (no System Events)."""
    ok, out = run_osascript(f'application "{app_name}" is running', timeout=15)
    if not ok:
        return False
    return out.strip().lower() == 'true'


# ═══════════════════════════════════════════════════════════════════════════
# get_context
# ═══════════════════════════════════════════════════════════════════════════

def get_context(params):
    """Detect which MS Office for Mac app is running and return active-doc context."""
    ctx = {"platform": "ms-office-mac"}
    for name, app_name in APPS.items():
        if not _app_running(app_name):
            continue
        try:
            if name == 'excel':
                ok, wb = run_osascript(
                    f'tell application "{app_name}" to get name of active workbook')
                if not ok:
                    continue
                ctx['app'] = name
                ctx['docName'] = wb or '(no workbook open)'
                ok2, sheet = run_osascript(
                    f'tell application "{app_name}" to get name of active sheet')
                ctx['sheetName'] = sheet if ok2 else ''
                ok3, sel = run_osascript(
                    f'tell application "{app_name}" to get address of selection')
                ctx['selection'] = sel if ok3 else ''
            elif name == 'word':
                ok, doc = run_osascript(
                    f'tell application "{app_name}" to get name of active document')
                if not ok:
                    continue
                ctx['app'] = name
                ctx['docName'] = doc or '(no document open)'
                ok2, paras = run_osascript(
                    f'tell application "{app_name}" to get count of paragraphs of active document')
                ctx['paragraphCount'] = int(paras) if ok2 and paras.isdigit() else 0
            elif name == 'ppt':
                ok, pres = run_osascript(
                    f'tell application "{app_name}" to get name of active presentation')
                if not ok:
                    continue
                ctx['app'] = name
                ctx['docName'] = pres or '(no presentation open)'
                ok2, slides = run_osascript(
                    f'tell application "{app_name}" to get count of slides of active presentation')
                ctx['slideCount'] = int(slides) if ok2 and slides.isdigit() else 0
            ctx['platform'] = PLATFORM_NAMES[name]
            break
        except Exception as e:
            log(f"context probe {name}: {e}")
            continue

    if 'app' not in ctx:
        ctx['error'] = ("No MS Office for Mac app running. Open Excel, Word, or "
                        "PowerPoint first. If Office is not installed, fall back to "
                        "file-level manipulation with Python libraries.")
    return ctx


# ═══════════════════════════════════════════════════════════════════════════
# execute_code
# ═══════════════════════════════════════════════════════════════════════════

def execute_code(params):
    """Execute an AppleScript snippet against MS Office for Mac.

    The AI writes plain AppleScript, e.g.:
      tell application "Microsoft Excel"
          set value of cell "B2" of active sheet to 42
      end tell
    osascript's stdout is returned as `result`.
    """
    code = params.get("code", "")
    if not code:
        return {"error": "No AppleScript code provided"}
    ok, out = run_osascript(code)
    if ok:
        return {"success": True, "result": out}
    return {"error": out}


# ═══════════════════════════════════════════════════════════════════════════
# Method Router + JSON-RPC main loop
# ═══════════════════════════════════════════════════════════════════════════

METHODS = {
    "get_context": get_context,
    "execute_code": execute_code,
}


def main():
    log("Bridge started (macOS/AppleScript), waiting for commands...")
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
            log(f"handler error: {e}")
            print(json.dumps({"id": req_id, "error": str(e)}), flush=True)
    log("Bridge stopped.")


if __name__ == "__main__":
    main()
