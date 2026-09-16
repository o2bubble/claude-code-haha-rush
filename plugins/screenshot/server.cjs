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
  const pickBounds = which === "cursor"
    ? `$pt = [System.Windows.Forms.Cursor]::Position
$scr = [System.Windows.Forms.Screen]::FromPoint($pt)
$b = $scr.Bounds
$idx = [System.Windows.Forms.Screen]::AllScreens.IndexOf($scr)`
    : `$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$idx = -1`;

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
async function prepareRegion() {
  fs.mkdirSync(targetDir(), { recursive: true });
  const tmp = path.join(os.tmpdir(), `snipfrozen-${crypto.randomUUID()}.png`);
  const shot = await captureWindows(tmp, "cursor"); // 只有 Windows 走这条路
  const token = crypto.randomUUID();
  pending.set(token, {
    file: shot.path, width: shot.width, height: shot.height,
    x: shot.x, y: shot.y, at: Date.now(),
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

/** 裁剪待框选图并落盘。坐标为**物理像素**（overlay 侧已乘 dpr）。 */
async function commitRegion(token, rect) {
  const p = pending.get(token);
  if (!p) throw new Error("框选已超时或不存在，请重新截图");

  const x = Math.max(0, Math.min(Math.round(rect.x), p.width - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), p.height - 1));
  const w = Math.max(1, Math.min(Math.round(rect.w), p.width - x));
  const h = Math.max(1, Math.min(Math.round(rect.h), p.height - y));

  const out = uniquePath(targetDir(), stampName());
  if (IS_MAC) await cropMac(p.file, out, x, y, w, h);
  else await cropWindows(p.file, out, x, y, w, h);

  pending.delete(token);
  try { fs.unlinkSync(p.file); } catch {}

  if (settings.copyToClipboard !== false) void toClipboard(out);
  return { path: out, name: path.basename(out), width: w, height: h };
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
    // 宿主命令直达（快捷键触发时面板可能没开 —— 见宿主侧 forwardToPluginProcess）
    if (route === "/__command" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.settings && typeof body.settings === "object") {
        settings = { ...settings, ...body.settings };
      }
      const cmd = body.command;

      if (cmd === "region" && IS_WIN) {
        const prep = await prepareRegion();
        // 让宿主开一个 overlay 显示冻结图（本进程开不了窗口）
        return json(res, 200, {
          ok: true,
          host: [{
            kind: "open-overlay",
            payload: {
              src: "overlay.html",
              params: `port=${actualPort()}&token=${prep.token}`,
              // 开在**冻结图所属的那块显示器**上；多屏下错开会让坐标对不上
              ...(prep.monitor !== undefined ? { monitor: prep.monitor } : {}),
            },
          }],
        });
      }
      // mac 的区域/窗口走系统原生交互；全屏直接抓
      const shot = await captureDirect(cmd === "window" ? "window" : cmd === "region" ? "region" : "fullscreen");
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

    // 框选提交（overlay 调用）—— 坐标为物理像素
    if (route === "/crop" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.settings && typeof b.settings === "object") settings = { ...settings, ...b.settings };
      const shot = await commitRegion(b.token, b);
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
      if (mode === "region" && IS_WIN) {
        const prep = await prepareRegion();
        return json(res, 200, {
          ok: true,
          host: [{
            kind: "open-overlay",
            payload: {
              src: "overlay.html",
              params: `port=${actualPort()}&token=${prep.token}`,
              ...(prep.monitor !== undefined ? { monitor: prep.monitor } : {}),
            },
          }],
        });
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
      const dir = path.resolve(targetDir());
      const full = path.resolve(p);
      if (!full.startsWith(dir + path.sep)) return json(res, 403, { error: "outside screenshot dir" });
      if (!fs.existsSync(full)) return json(res, 404, { error: "not found" });
      const buf = fs.readFileSync(full);
      res.writeHead(200, {
        "Content-Type": "image/png", "Content-Length": buf.length,
        "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
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
