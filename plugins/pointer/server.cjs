// ── pointer-server.cjs ──
// 屏幕指示器（教鞭）的插件进程。
//
// 职责很小：**保管"当前要画什么"，并把"要开覆盖层"这件事回报给宿主**。
// 真正画图的是 overlay.html（它轮询本进程的 /state）。
//
// 为什么要进程（而不是一次性把数据塞 URL 给 overlay）：
//   AI 可能分步指（"先点这里"→ 用户点了 → "再点那里"）。若每次都重开窗口，
//   屏幕会闪。有进程 + /state 轮询后，**窗口常驻、数据热更新**，只有真需要时才开/关窗。
//
// 端到端流程：
//   AI 调 plugin_pointer_point
//     → POST /__mcp  {tool:"point", args:{...}}
//     → 更新 state；若窗口没开，响应里带 host:[{kind:"open-overlay", ...transparent+clickThrough}]
//     → 宿主开透明穿透覆盖层 → overlay.html 加载
//     → overlay 轮询 GET /state 画 SVG
//     → duration 到期 → overlay 淡出 → fetch /bye → 下次调用会重新开窗
//
// 安全：只绑 127.0.0.1；无文件/进程操作；state 只在内存。

const http = require("http");

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

/** overlay 窗口是否已开（由 /hello /bye 握手维护，决定要不要再请求宿主开窗） */
let overlayOpen = false;

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

  // 窗口没开才请求宿主开（已开则只更新数据，overlay 轮询即刷新 —— 避免重开闪烁）
  if (overlayOpen) return { ok: true, count: total, reopened: false };

  const monitor = num(a.monitor, -1);
  return {
    ok: true,
    count: total,
    reopened: true,
    host: [{
      kind: "open-overlay",
      payload: {
        src: "overlay.html",
        params: `port=${actualPort()}`,
        // 教鞭形态的关键两参数：透明背景 + 点击穿透（见宿主 open_plugin_overlay）
        transparent: true,
        clickThrough: true,
        ...(monitor >= 0 ? { monitor } : {}),
      },
    }],
  };
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

    // overlay 轮询这个拿"当前要画什么"
    case "/state": {
      const expired = state.expiresAt > 0 && Date.now() > state.expiresAt;
      const gone = expired || shapeCount() === 0;
      return json(res, 200, {
        rev: state.rev,
        dim: state.dim,
        duration: state.duration,
        /** overlay 见到 gone 就淡出收尾（清空/到期都会走到） */
        gone,
        arrows: state.arrows,
        rects: state.rects,
        circles: state.circles,
        labels: state.labels,
      });
    }

    // overlay 生命周期握手：加载完成 / 即将关闭
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

// 兜底：进程退出前别留悬空（overlay 侧还有自己的超时兜底）
process.on("SIGTERM", () => { try { server.close(); } catch { /* ignore */ } process.exit(0); });
