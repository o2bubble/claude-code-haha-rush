// ── git-viewer-server.js ──
// 插件进程：只读 git HTTP API（status/diff/log/branches/show）。
// 安全模型:
//   * 命令白名单: status/diff/log/branches/show —— 其余路径 404
//   * execFile 无 shell —— git 参数以数组传入, 永不经 shell 解析
//   * 参数校验: URL 来的参数禁 `-` 前缀(防被 git 当 flag)/`..`/绝对路径/反斜杠;
//     git 自己的开关只能由本文件硬编码(如 -c color.ui=false/--porcelain)
//   * GIT_OPTIONAL_LOCKS=0 / GIT_TERMINAL_PROMPT=0 —— 不抢锁、不弹交互
//   * 只绑 127.0.0.1（不暴露局域网）
// 启动: stdout 打 PLUGIN_PORT=<n>（GUI 从 stdout 发现端口, 20s 超时）。

const http = require("http");
const { execFile } = require("child_process");
const cp = require("child_process");

const WORKSPACE = process.env.CLAUDE_PLUGIN_WORKSPACE || process.cwd();
const GIT_BIN = process.env.GIT_BIN || "git";

// ── 上限常量 ──
const MAX_LOG = 200;
const MAX_OUT_BYTES = 400_000; // 单响应字节上限
const GIT_TIMEOUT_MS = 15_000;

// ── 参数校验（URL 输入 → git 参数; 全部纯函数, 便于测试）──

/** 校验"路径参数"(diff?file=) —— 禁绝对/盘符/`..`/反斜杠, 相对运行目录 */
function sanitizeRepoPath(p) {
  if (typeof p !== "string" || !p || p.length > 500 || p.includes("\0")) return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\")) return null;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return null;
  }
  return "./" + p; // 显式 ./ 前缀: git 不把路径当开关/选项
}

/** 校验 ref —— 禁 `-` 开头(防注入 flag)、禁空白/控制字符 */
function sanitizeRef(ref) {
  if (typeof ref !== "string" || !ref || ref.length > 200 || ref.includes("\0")) return null;
  if (ref.startsWith("-")) return null;
  if (!/^[A-Za-z0-9_/.~^@{}:+-]+$/.test(ref)) return null;
  return ref;
}

/** 校验数值 —— 空/非数字 → 默认, clamp 到 [min, max] */
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ── git 执行封装 ──

function runGit(args, cb) {
  const child = execFile(
    GIT_BIN,
    ["-C", WORKSPACE, ...args],
    {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUT_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    },
    (err, stdout, stderr) => cb(err, stdout, stderr),
  );
  // 超时 kill 用 tree-kill 语义: Windows 上 git 无子进程(纯命令), 直接 kill 即可
  return child;
}

/** git 是否可用（启动探测一次: 结果缓存到进程内标志） */
let gitOk = null;
function checkGit() {
  if (gitOk !== null) return gitOk;
  try {
    cp.execFileSync(GIT_BIN, ["--version"], {
      timeout: 5000, encoding: "utf8", env: process.env, windowsHide: true,
    });
    gitOk = true;
  } catch {
    gitOk = false;
  }
  return gitOk;
}

/** 工作区是否 git 仓库 */
function isRepo() {
  try {
    const out = cp.execFileSync(GIT_BIN, ["-C", WORKSPACE, "rev-parse", "--is-inside-work-tree"], {
      timeout: 5000, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true,
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

// ── 响应工具 ──

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*", // iframe(plugins://) 与 MCP 桥(tauri://) 跨源 fetch
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
  res.end(body);
}

function jsonErr(res, status, msg) {
  json(res, status, { error: msg });
}

function gitErr(err, stderr) {
  const detail = ((stderr || (err && err.message) || "git error") + "").toString().slice(0, 500);
  return "git 命令失败: " + detail;
}

// ── MCP 工具入口（POST /__mcp）──
//
// **为什么工具由插件自己提供**（2026-09-18 从宿主 mcpBridge 搬来）：
// 这三个工具原先写死在宿主里，于是**无论插件装没装、启没启用，都出现在 AI 的工具
// 列表里** —— 卸载插件后 AI 仍会看到并调用，只在运行时才报「进程未运行」。
// 搬到插件侧后：插件未装/被禁用 → 工具**根本不出现**，与其它插件行为一致。
// （历史原因：git-viewer 2026-09-09 诞生，而声明式 mcpTools 机制 2026-09-16 才有。）

/** 单响应 diff 上限 —— AI 上下文预算保护（原在宿主侧，随工具一起搬来） */
const DIFF_LIMIT = 40_000;

function truncateDiff(diff) {
  if (diff.length <= DIFF_LIMIT) return diff;
  return diff.slice(0, DIFF_LIMIT)
    + `\n… [diff 已截断: ${diff.length} 字符, 超出 ${DIFF_LIMIT} 上限]\n(可用 view_diff(file, context=较小编号) 看更小片段)`;
}

/** runGit 的 Promise 版 —— /__mcp 走 async（现有 /api/* 保持 callback 不动，降低回归面） */
function runGitP(args) {
  return new Promise((resolve, reject) => {
    runGit(args, (err, stdout, stderr) => {
      // git diff 退出码 1 = 有差异（不是错误）—— 与 /api/diff 同语义
      if (err && err.code !== 1) return reject(new Error(gitErr(err, stderr)));
      resolve(stdout || "");
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) { req.destroy(); reject(new Error("请求体过大")); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** /__mcp 的三个工具实现。返回 `{ok, ...}`（契约见 gui/src/services/pluginRegistry 的 PluginMcpTool）。 */
async function handleMcpTool(tool, args) {
  switch (tool) {
    // 读取工作区单文件 diff（未提交改动）
    case "view_diff": {
      const raw = typeof args.file === "string" ? args.file : "";
      const file = sanitizeRepoPath(raw);
      if (!file) return { ok: false, error: "file 非法：需仓库内相对路径（禁绝对路径/`..`/反斜杠）" };
      const context = clampInt(args.context, 3, 0, 60);
      const diff = await runGitP(["-c", "color.ui=false", "--no-pager", "diff", "-U" + context, "--", file]);
      return { ok: true, file: raw, diff: truncateDiff(diff) };
    }
    // 读取提交历史
    case "history": {
      const limit = clampInt(args.limit, 20, 1, MAX_LOG);
      const stdout = await runGitP(
        ["-c", "color.ui=false", "--no-pager", "log", "--format=%h%x09%D%x09%s", "-n", String(limit)],
      );
      const commits = stdout.split("\n").filter(Boolean).map((line) => {
        const [hash, refs, subject] = line.split("\t");
        return { hash: hash || "", refs: refs || null, subject: (subject || "").slice(0, 500) };
      });
      return { ok: true, commits };
    }
    // 读取分支列表
    case "branches": {
      const stdout = await runGitP(
        ["-c", "color.ui=false", "--no-pager", "branch", "--format=%(refname:short)%09%(HEAD)"],
      );
      const branches = stdout.split("\n").filter(Boolean).map((line) => {
        const [name, head] = line.split("\t");
        return { name, current: head === "*" };
      });
      return { ok: true, branches };
    }
    default:
      return { ok: false, error: `未知工具: ${tool}（本插件提供 view_diff / history / branches）` };
  }
}

// ── 路由（只读白名单）──

async function handle(req, res) {
  if (!checkGit()) {
    return jsonErr(res, 503, "未找到 git —— 请先安装 git");
  }
  const u = new URL(req.url, "http://localhost");
  const route = u.pathname;
  const q = u.searchParams;

  switch (route) {
    // POST /__mcp → 宿主 MCP 工具转发入口（契约固定：{tool, args, settings} → {ok, ...}）
    case "/__mcp": {
      if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 200, { ok: false, error: "请求体不是合法 JSON" });
      }
      const args = body.args && typeof body.args === "object" ? body.args : {};
      try {
        return json(res, 200, await handleMcpTool(body.tool, args));
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    }

    // GET /api/health → { ok, repo }（面板/进程探测用）
    case "/api/health":
      return json(res, 200, { ok: true, repo: isRepo() });

    // GET /api/status → 改动文件列表 { files: [{status, file}] }
    case "/api/status":
      return runGit(["status", "--porcelain", "-z"], (err, stdout) => {
        if (err) return jsonErr(res, 500, gitErr(err, stdout));
        const entries = stdout.split("\0").filter(Boolean).map((rec) => {
          const xy = rec.slice(0, 2).trim();
          let file = rec.slice(3);
          if (file.startsWith('"')) { // 复杂路径 git 用引号包裹
            file = file.replace(/^"|"$/g, "");
          }
          return { status: xy, file };
        });
        return json(res, 200, { files: entries });
      });

    // GET /api/diff?file=<rel>&context=<n> → 单文件 diff
    case "/api/diff": {
      const file = sanitizeRepoPath(q.get("file") || "");
      if (!file) return jsonErr(res, 400, "非法路径");
      const context = clampInt(q.get("context"), 3, 0, 60);
      return runGit(
        ["-c", "color.ui=false", "--no-pager", "diff", "-U" + context, "--", file],
        (err, stdout) => {
          if (err && err.code === 1) return json(res, 200, { diff: "", file }); // 无改动
          if (err) return jsonErr(res, 500, gitErr(err, stdout));
          return json(res, 200, { diff: stdout, file });
        },
      );
    }

    // GET /api/log?limit=<n> → 提交列表 { commits: [{hash, refs, subject}] }
    case "/api/log": {
      const limit = clampInt(q.get("limit"), 20, 1, MAX_LOG);
      return runGit(
        ["-c", "color.ui=false", "--no-pager", "log", "--format=%h%x09%D%x09%s", "-n", String(limit)],
        (err, stdout) => {
          if (err) return jsonErr(res, 500, gitErr(err, stdout));
          const commits = stdout.split("\n").filter(Boolean).map((line) => {
            const [hash, refs, subject] = line.split("\t");
            return { hash: hash || "", refs: refs || null, subject: (subject || "").slice(0, 500) };
          });
          return json(res, 200, { commits });
        },
      );
    }

    // GET /api/branches → { branches: [{name, current}] }
    case "/api/branches":
      return runGit(
        ["-c", "color.ui=false", "--no-pager", "branch", "--format=%(refname:short)%09%(HEAD)"],
        (err, stdout) => {
          if (err) return jsonErr(res, 500, gitErr(err, stdout));
          const branches = stdout.split("\n").filter(Boolean).map((line) => {
            const [name, head] = line.split("\t");
            return { name, current: head === "*" };
          });
          return json(res, 200, { branches });
        },
      );

    // GET /api/show?ref=<ref>&context=<n> → 单提交信息+diff { head, diff, ref }
    case "/api/show": {
      const ref = sanitizeRef(q.get("ref") || "");
      if (!ref) return jsonErr(res, 400, "非法 ref");
      const context = clampInt(q.get("context"), 3, 0, 60);
      return runGit(
        ["-c", "color.ui=false", "--no-pager", "show", "--format=raw", "-U" + context, "--stat", ref],
        (err, stdout) => {
          if (err) return jsonErr(res, 404, gitErr(err, stdout));
          // 拆分头部(header+stat)与 diff 段: show 输出 "raw header\n\nstat\n\ndiff ..."
          const idx = stdout.indexOf("\ndiff ");
          const head = idx >= 0 ? stdout.slice(0, idx) : stdout;
          const diff = idx >= 0 ? stdout.slice(idx + 1) : "";
          return json(res, 200, { head, diff, ref });
        },
      );
    }

    default:
      return jsonErr(res, 404, "未知端点: " + route);
  }
}

// ── 导出（单测用: 纯函数, 无副作用）──
module.exports = { sanitizeRepoPath, sanitizeRef, clampInt };

// ── 服务器启动（127.0.0.1 only）──
// 仅直接执行时启动(require.main === module); 被 security.test.cjs require 时
// 只导出纯函数, 不监听、不 exit —— node:test 才能正常跑断言。
if (require.main === module) {
  const server = http.createServer(handle);

  function listen(port) {
    server.listen(port, "127.0.0.1", () => {
      console.log("PLUGIN_PORT=" + port); // ← GUI 端口发现协议（stdout）
    });
  }

  const envPort = parseInt(process.env.CLAUDE_PLUGIN_PORT || "", 10);
  if (!Number.isNaN(envPort)) {
    listen(envPort);
  } else {
    // 动态选取 8300-8699 首个可用端口（Rust 侧可覆盖, 依赖方插件可显式传）
    let n = 8300;
    const tryPick = (port) => {
      if (port > 8699) {
        console.error("No free port in range 8300-8699");
        process.exit(1);
      }
      const probe = http.createServer();
      probe.once("error", () => tryPick(port + 1));
      probe.once("listening", () => probe.close(() => listen(port)));
      probe.listen(port, "127.0.0.1");
    };
    tryPick(n);
  }
}
