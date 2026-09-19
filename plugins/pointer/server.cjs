// ── pointer-server.cjs ──
// 屏幕指示器（教鞭）的插件进程。
//
// 职责：**保管"当前要画什么"，并拉起绘制进程**。
// 真正画图的是 render.py（它轮询本进程的 /state，用 PIL 画完经
// UpdateLayeredWindow 直接上屏）。
//
// ## 为什么是 Python 而不是 WebView2（2026-09-19 的决定）
//
// 原先走宿主 `open_plugin_overlay` 开 WebView2 覆盖层画 SVG，**透明始终不成功**：
// 窗口层指标全对（`WS_EX_NOREDIRECTIONBITMAP`、exstyle 实测 0x00240118），
// 但 WebView2 **内容层**恒定渲染成实心黑/白。试过且无效的有：tao transparent /
// `WS_EX_LAYERED`+属性 / `SetWindowCompositionAttribute` / `DwmEnableBlurBehindWindow` /
// `with_background_color(0,0,0,0)` / `--disable-gpu-compositing` / vendored wry 补丁。
// 而**纯 Win32 + PIL**（layered + `UpdateLayeredWindow(AC_SRC_ALPHA)` 逐像素 alpha）
// 用户亲眼确认透明可见 —— 于是改走原生绘制，**完全绕开 WebView2**。
//
// ## 为什么要常驻进程（而不是一次性塞数据画完就退）
//   AI 可能分步指（"先点这里"→ 用户点了 → "再点那里"）。每次重开窗口会闪屏。
//   进程常驻 + render.py 轮询 /state 后，**窗口常驻、数据热更新**。
//
// 端到端流程：
//   AI 调 plugin_pointer_point
//     → POST /__mcp  {tool:"point", args:{...}}
//     → 更新 state；若绘制进程没在跑，spawn render.py
//     → render.py 轮询 GET /state → 画 → UpdateLayeredWindow 上屏
//     → duration 到期（/state 回 gone:true）→ render.py 淡出退出 → 报 /bye
//
// 安全：只绑 127.0.0.1；只 spawn **自己目录内**的 render.py；state 只在内存。

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/** 允许的形状键（与 plugin.json 的 inputSchema 对应） */
const SHAPE_KEYS = ["arrows", "rects", "circles", "labels"];
/** 默认停留秒数（AI 可覆盖） */
const DEFAULT_DURATION = 8;
/** 上限：防止 AI 传个巨大数字把覆盖层永久钉在屏幕上 */
const MAX_DURATION = 120;
/** 坐标系与形状数量的上限（防滥用：schema 白名单化了，但值本身还能很大） */
const MAX_ITEMS_PER_KIND = 24;

/** 当前状态 —— 进程内内存，重启即清空 */
let state = {
  arrows: [],
  rects: [],
  circles: [],
  labels: [],
  dim: true,
  duration: DEFAULT_DURATION,
  /** 到期时间戳（ms）；0 = 不自动消失 */
  expiresAt: 0,
  /** 版本号：overlay 用它判断"数据变了没"（避免每轮无谓重绘） */
  rev: 0,
};

/** 绘制进程是否在跑（由 /hello /bye 握手维护，决定要不要再 spawn） */
let overlayOpen = false;

/** 绘制进程句柄（spawn 出来的 python），退出时置空 */
let renderProc = null;

// ── 定位 python ──
//
// 内置 python 在**宿主安装目录**下（`<install>/python/python.exe`）。插件进程的
// PATH 里**没有**它（宿主只给插件注入了 nodejs runtime，见 plugin_process.rs 的
// CLAUDE_PLUGIN_PATH_PREPEND），所以必须显式定位。
//
// 定位依据：宿主的既定约定 —— `CLAUDE_CODE_HAHA_HOME` 环境变量 = 安装目录
// （Machine 级，所有进程可见；宿主自己的 diagnostics.rs 也用它）。
//
// 回退链：HAHA_HOME → 常见安装路径 → PATH 上的 python。全找不到才报错。
function findPython() {
  const home = process.env.CLAUDE_CODE_HAHA_HOME;
  const candidates = [];
  if (home) {
    candidates.push(path.join(home, "python", "python.exe"));
    candidates.push(path.join(home, "python", "python"));   // 非 Windows 布局
  }
  // 生产环境必有 HAHA_HOME；以下只是开发机/异常时的兜底
  candidates.push("C:\\Program Files (x86)\\Claude Code Haha\\python\\python.exe");
  candidates.push("C:\\Program Files\\Claude Code Haha\\python\\python.exe");
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  // 最后退回 PATH（用户自己装了 python 时）
  return process.platform === "win32" ? "python" : "python3";
}

/** 只保留数值；非有限数一律丢弃（防 NaN/Infinity 进 SVG 属性） */
function num(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

function clampDuration(v) {
  const n = num(v, DEFAULT_DURATION);
  if (n <= 0) return 0;                       // 显式 0 = 不自动消失
  return Math.min(MAX_DURATION, Math.max(1, Math.round(n)));
}

/** 规整单个形状数组：丢掉缺关键字段的条目，数值转有限数 */
function normalizeShapes(raw, kind) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw.slice(0, MAX_ITEMS_PER_KIND)) {
    if (!it || typeof it !== "object") continue;
    const o = it;
    if (kind === "arrows") {
      const a = { fromX: num(o.fromX, NaN), fromY: num(o.fromY, NaN), toX: num(o.toX, NaN), toY: num(o.toY, NaN) };
      if ([a.fromX, a.fromY, a.toX, a.toY].every(Number.isFinite)) out.push(a);
    } else if (kind === "rects") {
      const r = { x: num(o.x, NaN), y: num(o.y, NaN), w: num(o.w, NaN), h: num(o.h, NaN) };
      if ([r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0) {
        r.label = typeof o.label === "string" ? o.label.slice(0, 8) : "";
        out.push(r);
      }
    } else if (kind === "circles") {
      const c = { x: num(o.x, NaN), y: num(o.y, NaN), r: num(o.r, NaN) };
      if ([c.x, c.y, c.r].every(Number.isFinite) && c.r > 0) {
        c.label = typeof o.label === "string" ? o.label.slice(0, 8) : "";
        out.push(c);
      }
    } else if (kind === "labels") {
      const l = { x: num(o.x, NaN), y: num(o.y, NaN) };
      if ([l.x, l.y].every(Number.isFinite) && typeof o.text === "string" && o.text.trim()) {
        l.text = o.text.trim().slice(0, 120);
        out.push(l);
      }
    }
  }
  return out;
}

/** 是否画了东西（决定要不要开窗 —— 空 + clear 就只关窗） */
function shapeCount() {
  return SHAPE_KEYS.reduce((n, k) => n + state[k].length, 0);
}

// ── 工具实现 ──

/**
 * `point` —— 画/清除指示器。
 * @returns {{ok: boolean, error?: string, host?: Array<{kind: string, payload: object}>}}
 */
function handlePoint(args) {
  const a = args && typeof args === "object" ? args : {};
  const clear = a.clear === true;

  if (clear) {
    // ⚠️ 与形状参数同时传 → **报错**，而不是静默只清。
    // 静默丢弃形状会让调用方以为"清掉重画了"，实际屏幕上什么都没有（实测踩过）。
    const alsoHasShapes = SHAPE_KEYS.some((k) => Array.isArray(a[k]) && a[k].length > 0);
    if (alsoHasShapes) {
      return {
        ok: false,
        error: "clear 与形状参数不能同时传：clear:true 只做清除。想重画请分两次调用（先 clear，再画）。",
      };
    }
    state = { ...state, arrows: [], rects: [], circles: [], labels: [], rev: state.rev + 1 };
    // 清空后如果窗口还开着，让 overlay 自己淡出（它看到空数据即可）；
    // 不主动关窗 —— overlay 侧发现"空 + 已过期"会自己收尾并 /bye。
    return { ok: true, cleared: true };
  }

  const next = {};
  for (const k of SHAPE_KEYS) next[k] = normalizeShapes(a[k], k);
  const total = SHAPE_KEYS.reduce((n, k) => n + next[k].length, 0);
  if (total === 0) {
    return { ok: false, error: "没有可画的形状：请提供 arrows / rects / circles / labels 之一（或用 clear:true 清除）" };
  }

  const duration = clampDuration(a.duration);
  state = {
    ...state,
    ...next,
    dim: a.dim !== false,                    // 默认 true
    duration,
    expiresAt: duration > 0 ? Date.now() + duration * 1000 : 0,
    rev: state.rev + 1,
  };

  // 绘制进程没在跑才 spawn（在跑则只更新数据，render.py 轮询即刷新 —— 避免重开闪烁）
  if (overlayOpen) return { ok: true, count: total, reopened: false };

  const monitor = num(a.monitor, -1);

  // ── 主路径：Python 原生绘制（透明可用）──
  const err = spawnRenderer(monitor >= 0 ? monitor : 0);
  if (!err) return { ok: true, count: total, reopened: true };

  // ── 回退路径：宿主 overlay（WebView2）──
  //
  // ⚠️ **为什么保留**：Python 路径依赖「能找到内置 python」+「PIL 可用」+「layered
  // 窗口能建」三个前提，任一不成立就彻底画不出东西 —— 而这是个**画给人看**的插件，
  // 静默失败等于"AI 说点了、用户什么都没看到"，比"不透明"更糟。
  // 回退到 overlay 至少能画出内容（只是背景不透明，用户看得见指示器）。
  //
  // 触发条件很窄：只在 spawn 本身失败时走（找不到 python / 脚本缺失 / spawn 抛错）。
  // render.py 起来后又失败（如 PIL 缺失）不在此列 —— 那种情况由它自己退出，
  // 下次调用会重新 spawn（overlayOpen 被 /bye 复位）。
  console.error("[pointer] Python 路径不可用，回退 overlay:", err);
  const hardTtlSec = duration > 0 ? duration + 15 : 300;
  return {
    ok: true,
    count: total,
    reopened: true,
    /** 告诉调用方走了哪条路 —— AI 可据此提醒用户"这次不透明" */
    degraded: "python-unavailable",
    degradedReason: err,
    host: [{
      kind: "open-overlay",
      payload: {
        src: "overlay.html",
        params: `port=${actualPort()}`,
        transparent: true,
        clickThrough: true,
        hardTtlSec,
        ...(monitor >= 0 ? { monitor } : {}),
      },
    }],
  };
}

/**
 * 拉起 render.py。失败返回错误字符串，成功返回 null。
 *
 * ⚠️ `stdio: "ignore"` + `detached: false`：绘制进程的生命周期由本进程管
 * （本进程被宿主 kill 时它也退出）。**不能 detached** —— 否则宿主杀插件进程后，
 * 一个无人管理的全屏窗口会留在屏幕上（那种"关不掉"是最恶劣的故障）。
 */
function spawnRenderer(monitor) {
  if (renderProc) return null;
  const script = path.join(__dirname, "render.py");
  if (!fs.existsSync(script)) return `找不到绘制脚本: ${script}`;

  const py = findPython();
  try {
    renderProc = spawn(py, [script, "--port", String(actualPort()), "--monitor", String(monitor)], {
      cwd: __dirname,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (e) {
    renderProc = null;
    return `拉起绘制进程失败: ${String((e && e.message) || e)}`;
  }

  renderProc.on("exit", () => { renderProc = null; });
  renderProc.on("error", (e) => {
    console.error("[pointer] render.py 启动失败:", String((e && e.message) || e));
    renderProc = null;
    overlayOpen = false;
  });
  return null;
}

// ── HTTP ──

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 512 * 1024) { req.destroy(); reject(new Error("请求体过大")); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    // overlay 是 plugins://（或 http://plugins.localhost）来源，跨源取数据要放行
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

async function handle(req, res) {
  const u = new URL(req.url, "http://localhost");
  const route = u.pathname;

  if (req.method === "OPTIONS") return json(res, 204, {});

  switch (route) {
    // 宿主 MCP 工具转发入口（契约固定：{tool, args, settings} → {ok, ...}）
    case "/__mcp": {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "仅支持 POST" });
      let body;
      try { body = JSON.parse((await readBody(req)) || "{}"); }
      catch { return json(res, 200, { ok: false, error: "请求体不是合法 JSON" }); }
      if (body.tool !== "point") {
        return json(res, 200, { ok: false, error: `未知工具: ${body.tool}（本插件只提供 point）` });
      }
      try { return json(res, 200, handlePoint(body.args)); }
      catch (e) { return json(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }

    // render.py 轮询这个拿"当前要画什么"
    case "/state": {
      const expired = state.expiresAt > 0 && Date.now() > state.expiresAt;
      const gone = expired || shapeCount() === 0;
      return json(res, 200, {
        rev: state.rev,
        dim: state.dim,
        duration: state.duration,
        /** render.py 见到 gone 就淡出退出（清空/到期都会走到） */
        gone,
        // 形状嵌在 shapes 下 —— render.py 的解析按这个结构（见其 render_state）
        shapes: {
          arrows: state.arrows,
          rects: state.rects,
          circles: state.circles,
          labels: state.labels,
        },
      });
    }

    // 绘制进程生命周期握手：起来 / 即将退出
    case "/hello":
      overlayOpen = true;
      return json(res, 200, { ok: true });
    case "/bye":
      overlayOpen = false;
      // 窗口没了就清数据，避免下次开窗瞬间闪出旧指示器
      state = { ...state, arrows: [], rects: [], circles: [], labels: [], rev: state.rev + 1 };
      return json(res, 200, { ok: true });

    case "/health":
      return json(res, 200, { ok: true, overlayOpen, count: shapeCount() });

    default:
      return json(res, 404, { error: "not found" });
  }
}

// ── 启动 ──

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { json(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch { /* 已发送 */ }
  });
});

let boundPort = 0;
function actualPort() { return boundPort; }

function listen(port) {
  server.listen(port, "127.0.0.1", () => {
    boundPort = server.address().port;
    // 宿主从 stdout 发现端口（PLUGIN_PORT 协议）
    console.log("PLUGIN_PORT=" + boundPort);
  });
}

const envPort = parseInt(process.env.CLAUDE_PLUGIN_PORT || "", 10);
if (!Number.isNaN(envPort)) {
  listen(envPort);
} else {
  // 无指定端口时**让系统分配**（listen(0)）。
  //
  // ⚠️ 别用"固定起点 + 顺延"：Windows 有**系统保留端口段**（Hyper-V/WSL 动态范围，
  // `netsh interface ipv4 show excludedportrange protocol=tcp` 可查），撞上会直接
  // `EACCES: permission denied` —— 而不是 EADDRINUSE，顺延逻辑根本不触发（实测踩过）。
  // 端口由 listen 回调里的 `boundPort` 拿（PLUGIN_PORT 输出它）。
  listen(0);
}

// 兜底：进程退出前**必须杀掉绘制进程**。
//
// 为什么关键：绘制进程持有全屏置顶窗口。若本进程被宿主 kill 而绘制进程残留，
// 屏幕上会留一个**无人管理的全屏覆盖层** —— 用户只能重启电脑（这类故障最恶劣）。
// render.py 自己也有硬 TTL（5 分钟）兜底，但那是最后一道，不能依赖它。
function killRenderer() {
  if (!renderProc) return;
  try { renderProc.kill(); } catch { /* 已退出 */ }
  renderProc = null;
}
process.on("SIGTERM", () => { killRenderer(); try { server.close(); } catch { /* ignore */ } process.exit(0); });
process.on("SIGINT", () => { killRenderer(); try { server.close(); } catch { /* ignore */ } process.exit(0); });
// 宿主强杀时 Node 可能直接退出（不触发 SIGTERM）—— exit 钩子里同步 kill，
// 能覆盖大多数情况（kill() 是同步发信号，不必等回调）。
process.on("exit", killRenderer);
