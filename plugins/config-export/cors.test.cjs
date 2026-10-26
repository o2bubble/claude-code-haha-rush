// ── CORS：面板能 fetch 到本进程 ──
//
// 🔴 2026-10-25 实测故障：面板报「扫描失败：Failed to fetch」。
//
// 根因：面板 iframe 的源是 `plugins.localhost`（或 `plugins://localhost`），
// 而插件进程在 `127.0.0.1:<port>` —— **跨源**。响应缺
// `Access-Control-Allow-Origin` 时浏览器直接拦掉，面板只看到
// `Failed to fetch`，**看不出真正原因**（这是最耗时的那类 bug）。
//
// 所以这两条必须锁死：普通响应带头 + OPTIONS 预检能过。

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cors-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.APPDATA;
process.env.CLAUDE_PLUGIN_WORKSPACE = "";
const CLAUDE = path.join(HOME, ".claude");
fs.mkdirSync(CLAUDE, { recursive: true });
fs.writeFileSync(path.join(CLAUDE, "CLAUDE.md"), "# x\n");

const SERVER = path.join(__dirname, "export-server.cjs");
let child;
let port;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: "127.0.0.1", port, path: p, method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test.before(async () => {
  child = spawn(process.execPath, [SERVER], {
    cwd: __dirname,
    env: { ...process.env, CLAUDE_PLUGIN_PORT: "0" },
  });
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("端口超时")), 15000);
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c.toString();
      const m = buf.match(/PLUGIN_PORT=(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on("data", () => {});
  });
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test("GET /api/scan 带 CORS 头（面板才能跨源读）", async () => {
  const r = await req("GET", "/api/scan");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(
    r.headers["access-control-allow-origin"], "*",
    "缺这个头 → 浏览器拦响应 → 面板只看到 Failed to fetch",
  );
});

test("OPTIONS 预检能过（POST 前浏览器会先问）", async () => {
  const r = await req("OPTIONS", "/api/export");
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers["access-control-allow-origin"], "*");
  const methods = r.headers["access-control-allow-methods"] || "";
  assert.ok(methods.includes("POST"), `应允许 POST，实际: ${methods}`);
  assert.ok(
    (r.headers["access-control-allow-headers"] || "").toLowerCase().includes("content-type"),
    "POST 带 JSON body 必须允许 Content-Type 头",
  );
});

test("POST /api/audit-custom 也带 CORS 头", async () => {
  const r = await req("POST", "/api/audit-custom", { customItems: [] });
  assert.strictEqual(r.headers["access-control-allow-origin"], "*");
});

test("POST /api/inspect-package 也带 CORS 头", async () => {
  const r = await req("POST", "/api/inspect-package", { path: "" });
  assert.strictEqual(r.headers["access-control-allow-origin"], "*");
});

test("错误响应也带 CORS 头（否则面板看不到错误信息）", async () => {
  const r = await req("GET", "/api/no-such-route");
  assert.strictEqual(r.status, 404);
  assert.strictEqual(
    r.headers["access-control-allow-origin"], "*",
    "4xx 不带 CORS → 面板同样只看到 Failed to fetch，看不到原因",
  );
});
