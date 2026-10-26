// ── config-export-server.cjs ──
// 插件进程：扫描本机的 Claude / GUI 个人资料，按勾选打成 tar.gz。
//
// ## 安全模型（最重要的一条）
//
// **凭据类文件绝不进包**，即使调用方显式要求：
//   · ~/.claude/.credentials.json      —— 登录态
//   · ~/.claude/plugin-signing.key     —— 插件发布签名私钥
//   · <workspace>/.claude/profile.env  —— 可能含 API key
// 这一类在 `NEVER_EXPORT` 里硬编码，不是"默认不勾"，是**压根不提供**。
//
// 另外 `settings.json` 的 `env` 段**永远剥离**（换机本来就要重配 key，
// 而泄露代价极高）。剥离记录写进 manifest 的 `redactions`，恢复端能看出来少了什么。
//
// ## 为什么要 tar 而不是 zip
//
// 会话历史（projects/<slug>/*.jsonl）实测可达数百 MB。用 Node 纯 JS 打 zip
// 要把整包读进内存；tar 是流式的，且 Windows 10+ 自带 GNU tar。
//
// ## 启动协议
//
// stdout 打 `PLUGIN_PORT=<n>`（宿主据此发现端口，20s 超时）。
// 只绑 127.0.0.1。
//
// ⚠️ **绝不写 console.log 到 stdout**（除了 PLUGIN_PORT 那一行）——
// 宿主把 stdout 当管道读，管道断开时写入会 EPIPE **打死整个进程**
// （pointer 插件踩过，见 commit c84ffb0）。日志一律走 stderr。

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");
const { packDirectory, listArchive } = require("./tar-writer.cjs");

// stdout 兜底：宿主停止读管道后写入会 EPIPE —— 那是 socket 的 error 事件，
// try/catch 抓不住，会直接干掉进程。日志丢了无所谓，进程必须活着。
for (const s of [process.stdout, process.stderr]) {
  s.on("error", () => {});
}

const WORKSPACE = process.env.CLAUDE_PLUGIN_WORKSPACE || "";
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const CLAUDE_JSON = path.join(HOME, ".claude.json");
const GUI_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, "com.claudecode.gui")
  : "";

const log = (...a) => { try { console.error("[config-export]", ...a); } catch { /* EPIPE */ } };

// ══════════════════════════════════════════════════════════════
// 纯函数区（可单测，不碰文件系统）
// ══════════════════════════════════════════════════════════════

/**
 * 路径 slug 化 —— **照抄** `src/utils/sessionStoragePortable.ts:311` 的
 * `sanitizePath`。必须与 `~/.claude/projects/<slug>/` 完全一致，否则工作区数据
 * 和它自己的记忆/会话目录对不上号。
 *
 * 非字母数字一律 '-'; 超长时截断并追加 hash。
 */
const MAX_SANITIZED_LENGTH = 200;
function sanitizePath(name) {
  const sanitized = String(name).replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  // 与主仓一致：Bun.hash 的 base36；插件侧没有 Bun，用等价稳定的简单 hash
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${simpleHash(name)}`;
}
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

/** 凭据类文件 —— 无论调用方怎么说，永不导出（见文件头「安全模型」） */
const NEVER_EXPORT = [
  path.join(CLAUDE_DIR, ".credentials.json"),
  path.join(CLAUDE_DIR, "plugin-signing.key"),
  // ⚠️ `profile.env` 里有 `ANTHROPIC_AUTH_TOKEN=sk-...`（实测）。它现在没被任何
  // 分类采集，但**必须列进来** —— 否则以后谁加一个"工作区全量文件"的分类，
  // 它就会悄悄混进包里。黑名单的意义是防"未来的采集范围扩大"。
  path.join(CLAUDE_DIR, "profile.env"),
  path.join(CLAUDE_DIR, ".env.active"),
  path.join(CLAUDE_DIR, ".env.profiles"),
];

/** 按**文件名**判定的黑名单 —— 用于工作区等"路径不固定"的场景
 *  （`<ws>/.claude/profile.env` 在每个工作区各有一份）。 */
const NEVER_EXPORT_NAMES = new Set(["profile.env", ".credentials.json", "plugin-signing.key"]);

function isNeverExport(absPath) {
  const base = path.basename(absPath).toLowerCase();
  if (NEVER_EXPORT_NAMES.has(base)) return true; // 按名的兜底（工作区等路径不固定）
  const norm = path.resolve(absPath).toLowerCase();
  return NEVER_EXPORT.some((p) => path.resolve(p).toLowerCase() === norm);
}

/** 从 settings 对象里剥掉 env 段（返回新对象 + 剥离记录，不改原对象） */
function stripEnv(settings) {
  if (!settings || typeof settings !== "object") return { value: settings, stripped: false };
  if (!("env" in settings)) return { value: settings, stripped: false };
  const copy = { ...settings };
  delete copy.env;
  return { value: copy, stripped: true };
}

/** 目录/文件排除规则：安装产物与临时物不进包 */
function shouldSkip(name) {
  if (name === "node_modules" || name === "__pycache__") return true;
  if (name === "runtime") return true; // 插件的 runtime（几十 MB 二进制，可重下）
  if (name.endsWith(".zip")) return true;
  if (name.endsWith(".pyc")) return true;
  if (name === "gui-instance.lock") return true;
  // 临时文件：`.tmp` 这类是**写入过程中**产生的半成品（实测记忆目录里会出现
  // 一个 0 字节 `.tmp`）。带上它只会让"零字节文件"检查误报。
  if (name === ".tmp" || name.endsWith(".tmp")) return true;
  if (name.endsWith(".lock")) return true;
  return false;
}

/** 是不是链接（symlink / Windows junction / reparse point）。
 *
 *  **不能用 `isSymbolicLink()`** —— Windows 的 directory junction 在
 *  `dirent` 与 `lstat()` 上都报成普通目录（实测），只有 `readlink()` 能解出目标。 */
async function isLink(p) {
  try {
    await fsp.readlink(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归列文件（返回绝对路径数组），跳过 shouldSkip 的条目。
 *
 * ⚠️ **软链/junction 不跟进**（2026-10-25 实测）：`~/.claude/skills/` 里混着
 * 指向插件目录（`APPDATA/.../plugins/<name>/skill`）与用户自己的 `~/.agents/skills`
 * 的链接。跟进它们会让「技能」这一类从 75 KB 膨胀到 **75 MB / 12970 文件**，
 * 而且带走的是**别处的副本** —— 恢复时那两处本来就会重建。
 *
 * 只带走**实体存放**在 `~/.claude/` 里的技能。
 */
async function walk(root, opts = {}) {
  const out = [];
  const { maxFiles = 200000 } = opts;
  async function rec(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (isNeverExport(full)) continue;
      // ⚠️ **链接判定只能靠 readlink**（2026-10-25 实测）：
      // Windows 的 directory junction 在 `dirent.isSymbolicLink()` 与
      // `lstat().isSymbolicLink()` 上**都是 false**（它报成普通目录），
      // 只有 `fs.readlink()` 能解出目标 —— 用 isSymbolicLink 判会照样跟进
      // 那 12970 个文件（技能类从 75 KB 膨胀到 75 MB）。
      if (await isLink(full)) continue;
      if (e.isDirectory()) {
        if (shouldSkip(e.name)) continue;
        await rec(full);
      } else if (e.isFile()) {
        if (shouldSkip(e.name)) continue;
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

async function statSafe(p) {
  try {
    const s = await fsp.stat(p);
    return s;
  } catch {
    return null;
  }
}

async function sizeOf(paths) {
  let total = 0;
  for (const p of paths) {
    const s = await statSafe(p);
    if (s) total += s.size;
  }
  return total;
}

function tsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ══════════════════════════════════════════════════════════════
// 分类定义
// ══════════════════════════════════════════════════════════════

/**
 * 每个分类：
 *   id / label / group / sensitive / defaultOn
 *   collect() → Promise<{ files: [{abs, rel}], note? }>
 *
 * `rel` 是**包内逻辑路径**（data/ 下），不含本机绝对路径 —— 换机后用户名/盘符不同。
 */
function categoryDefs(workspaces) {
  const defs = [];
  const add = (d) => defs.push(d);

  // ── Claude 侧 ──
  add({
    id: "claude-settings",
    label: "Claude 全局设置",
    group: "claude",
    sensitive: true,
    defaultOn: true,
    async collect() {
      const f = path.join(CLAUDE_DIR, "settings.json");
      const s = await statSafe(f);
      return s ? { files: [{ abs: f, rel: "claude/settings.json" }] } : { files: [] };
    },
  });

  add({
    id: "claude-config",
    label: "Claude 全局配置（MCP 服务器 / 项目列表）",
    group: "claude",
    sensitive: true,
    defaultOn: true,
    async collect() {
      const s = await statSafe(CLAUDE_JSON);
      return s ? { files: [{ abs: CLAUDE_JSON, rel: "claude/claude.json" }] } : { files: [] };
    },
  });

  add({
    id: "claude-md",
    label: "个人指令文档（CLAUDE.md 等）",
    group: "claude",
    sensitive: false,
    defaultOn: true,
    async collect() {
      const files = [];
      for (const name of [
        "CLAUDE.md", "office-bridge.md", "python-env.md",
        "gui-agent-guide.md", "gui-config-files.md", "gui-ref-system.md",
      ]) {
        const abs = path.join(CLAUDE_DIR, name);
        if (await statSafe(abs)) files.push({ abs, rel: `claude/${name}` });
      }
      return { files };
    },
  });

  add({
    id: "claude-skills",
    label: "技能",
    group: "claude",
    sensitive: false,
    defaultOn: true,
    async collect() {
      const root = path.join(CLAUDE_DIR, "skills");
      const abs = await walk(root);
      return { files: abs.map((a) => ({ abs: a, rel: `claude/skills/${path.relative(root, a).replace(/\\/g, "/")}` })) };
    },
  });

  add({
    id: "claude-memory",
    label: "记忆（每项目一份）",
    group: "claude",
    sensitive: false,
    defaultOn: true,
    async collect() {
      const projectsRoot = path.join(CLAUDE_DIR, "projects");
      let slugs = [];
      try {
        slugs = (await fsp.readdir(projectsRoot, { withFileTypes: true }))
          .filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { /* 无 projects 目录 */ }
      const files = [];
      for (const slug of slugs) {
        const memDir = path.join(projectsRoot, slug, "memory");
        const abs = await walk(memDir);
        for (const a of abs) {
          files.push({ abs: a, rel: `claude/projects/${slug}/memory/${path.relative(memDir, a).replace(/\\/g, "/")}` });
        }
      }
      return { files };
    },
  });

  add({
    id: "claude-notes",
    label: "笔记",
    group: "claude",
    sensitive: false,
    defaultOn: true,
    async collect() {
      const root = path.join(CLAUDE_DIR, "notes");
      const abs = await walk(root);
      return { files: abs.map((a) => ({ abs: a, rel: `claude/notes/${path.relative(root, a).replace(/\\/g, "/")}` })) };
    },
  });

  add({
    id: "claude-plans",
    label: "计划",
    group: "claude",
    sensitive: false,
    defaultOn: true,
    async collect() {
      const root = path.join(CLAUDE_DIR, "plans");
      const abs = await walk(root);
      return { files: abs.map((a) => ({ abs: a, rel: `claude/plans/${path.relative(root, a).replace(/\\/g, "/")}` })) };
    },
  });

  add({
    id: "agents-skills",
    label: "个人技能库（~/.agents/skills，技能链接指向这里）",
    group: "claude",
    sensitive: false,
    defaultOn: true,
    async collect() {
      // ⚠️ **必须带上**：`~/.claude/skills/` 里有一批**链接**指向这里
      // （walk 不跟进链接，所以那些技能的内容只存在于这个目录）。
      // 不带 → 新机器上那些技能全变成断链。
      const root = path.join(HOME, ".agents", "skills");
      const abs = await walk(root);
      return { files: abs.map((a) => ({ abs: a, rel: `agents/skills/${path.relative(root, a).replace(/\\/g, "/")}` })) };
    },
  });

  add({
    id: "claude-history",
    label: "输入历史（你打过的 prompt）",
    group: "claude",
    sensitive: false,
    defaultOn: true,
    async collect() {
      const f = path.join(CLAUDE_DIR, "history.jsonl");
      return (await statSafe(f)) ? { files: [{ abs: f, rel: "claude/history.jsonl" }] } : { files: [] };
    },
  });

  add({
    id: "claude-sessions",
    label: "会话历史（体积大，含全部对话内容）",
    group: "claude",
    sensitive: true,
    defaultOn: false, // 默认不勾：几百 MB，且是全部对话明文
    async collect() {
      const projectsRoot = path.join(CLAUDE_DIR, "projects");
      let slugs = [];
      try {
        slugs = (await fsp.readdir(projectsRoot, { withFileTypes: true }))
          .filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { /* empty */ }
      const files = [];
      for (const slug of slugs) {
        const dir = path.join(projectsRoot, slug);
        let names = [];
        try { names = await fsp.readdir(dir); } catch { continue; }
        for (const n of names) {
          if (!n.endsWith(".jsonl")) continue;
          files.push({ abs: path.join(dir, n), rel: `claude/projects/${slug}/${n}` });
        }
      }
      return { files };
    },
  });

  add({
    id: "claude-plugins-data",
    label: "插件数据（~/.claude/plugins）",
    group: "claude",
    sensitive: false,
    defaultOn: false,
    async collect() {
      const root = path.join(CLAUDE_DIR, "plugins");
      const abs = await walk(root);
      return { files: abs.map((a) => ({ abs: a, rel: `claude/plugins/${path.relative(root, a).replace(/\\/g, "/")}` })) };
    },
  });

  // ── GUI 侧 ──
  if (GUI_DIR) {
    add({
      id: "gui-plugin-settings",
      label: "插件设置",
      group: "gui",
      sensitive: false,
      defaultOn: true,
      async collect() {
        const root = path.join(GUI_DIR, "plugins-settings");
        const abs = await walk(root);
        return { files: abs.map((a) => ({ abs: a, rel: `gui/plugins-settings/${path.relative(root, a).replace(/\\/g, "/")}` })) };
      },
    });
  }

  // ── 工作区级（多工作区各一份）──
  for (const ws of workspaces) {
    const wsClaude = path.join(ws.absPath, ".claude");
    const slug = sanitizePath(ws.absPath);
    add({
      id: `workspace-settings:${slug}`,
      label: `工作区设置 — ${ws.name}`,
      group: "workspace",
      sensitive: false,
      defaultOn: true,
      workspaceSlug: slug,
      async collect() {
        const f = path.join(wsClaude, "settings.local.json");
        const s = await statSafe(f);
        return s ? { files: [{ abs: f, rel: `workspaces/${slug}/settings.local.json` }] } : { files: [] };
      },
    });
    add({
      id: `workspace-profile:${slug}`,
      label: `当前 Profile（连哪个 API）— ${ws.name}`,
      group: "workspace",
      sensitive: false,
      defaultOn: true,
      workspaceSlug: slug,
      async collect() {
        // active-profile 只记"用哪个 profile"，不含密钥（密钥在各 profile 的
        // profile.env 里 —— 那个在 NEVER_EXPORT 黑名单）。
        const f = path.join(wsClaude, "active-profile");
        return (await statSafe(f)) ? { files: [{ abs: f, rel: `workspaces/${slug}/active-profile` }] } : { files: [] };
      },
    });

    add({
      id: `workspace-pasted:${slug}`,
      label: `粘贴的附件（图片/文件）— ${ws.name}`,
      group: "workspace",
      sensitive: false,
      defaultOn: false, // 可能是些临时图，默认不勾
      workspaceSlug: slug,
      async collect() {
        const root = path.join(wsClaude, "pasted");
        const abs = await walk(root);
        return { files: abs.map((a) => ({ abs: a, rel: `workspaces/${slug}/pasted/${path.relative(root, a).replace(/\\/g, "/")}` })) };
      },
    });

    add({
      id: `workspace-db:${slug}`,
      label: `工作区数据（超级桌面/计划/笔记）— ${ws.name}`,
      group: "workspace",
      sensitive: false,
      defaultOn: true,
      workspaceSlug: slug,
      async collect() {
        const f = path.join(wsClaude, "data.db");
        const s = await statSafe(f);
        return s ? { files: [{ abs: f, rel: `workspaces/${slug}/data.db` }] } : { files: [] };
      },
    });
  }

  return defs;
}

// ══════════════════════════════════════════════════════════════
// 扫描 / 导出
// ══════════════════════════════════════════════════════════════

function hostname() {
  try { return os.hostname(); } catch { return "unknown"; }
}

/** 读已装插件清单（只读 manifest，不带源码） */
async function installedPlugins() {
  if (!GUI_DIR) return [];
  const root = path.join(GUI_DIR, "plugins");
  let names = [];
  try {
    names = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(root, n, "plugin.json"), "utf8"));
      out.push({ pluginName: m.pluginName || n, version: m.version || "", enabled: true });
    } catch { /* 坏 manifest 跳过 */ }
  }
  return out;
}

/** 已知工作区：当前绑定的 + 从 GUI 设置里读到的列表 */
async function knownWorkspaces() {
  const list = [];
  const push = (abs) => {
    if (!abs) return;
    const norm = path.resolve(abs);
    if (list.some((w) => w.absPath === norm)) return;
    list.push({ absPath: norm, name: path.basename(norm) });
  };
  push(WORKSPACE);
  // GUI 设置里的 workspaces（全局 settings.json 的 workspaces 字段）
  try {
    const s = JSON.parse(await fsp.readFile(path.join(CLAUDE_DIR, "settings.json"), "utf8"));
    if (Array.isArray(s.workspaces)) s.workspaces.forEach(push);
  } catch { /* 读不到就算了 */ }
  return list;
}

/** 扫描：返回分类清单（含大小、文件数、敏感标记）。**只读不写。** */
async function scanAll() {
  const workspaces = await knownWorkspaces();
  const defs = categoryDefs(workspaces);
  const result = [];
  for (const d of defs) {
    let files = [];
    try {
      const r = await d.collect();
      files = r.files || [];
    } catch (e) {
      log("collect failed", d.id, e && e.message);
    }
    result.push({
      id: d.id,
      label: d.label,
      group: d.group,
      sensitive: !!d.sensitive,
      defaultOn: !!d.defaultOn,
      fileCount: files.length,
      size: await sizeOf(files.map((f) => f.abs)),
      workspaceSlug: d.workspaceSlug || null,
    });
  }
  return { categories: result, workspaces };
}

/** 解析要导出的分类（默认 = defaultOn） */
function resolveSelection(all, wanted) {
  const ids = Array.isArray(wanted) && wanted.length
    ? new Set(wanted)
    : new Set(all.filter((c) => c.defaultOn).map((c) => c.id));
  return all.filter((c) => ids.has(c.id));
}

// ── tar 打包 ──

/** 用 tar 打包整个 staging 目录（包内路径 = staging 下的相对路径） */


/**
 * 复制文件并**顺带算出数据的 sha256** —— 只读一遍。
 *
 * 为什么不用 `copyFile()` + `sha256File()` 两步：
 * 那是**把同一个文件读两遍**（13148 个文件 ≈ 两倍 IO）。实测导出 13 类时
 * 光这一步就能吃掉大半时间。
 *
 * @returns {Promise<{size:number, sha256:string}>}
 */
async function copyAndHash(src, dest) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    let size = 0;
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);

    rs.on("data", (c) => { h.update(c); size += c.length; });
    rs.on("error", reject);
    ws.on("error", reject);

    // ⚠️ **用 `close` 而不是 `finish`**（2026-10-26 实测）。
    // `finish` 只表示"数据已交给操作系统"，**不代表文件句柄已关闭/写到盘**。
    // 紧接着 tar 去读这个目录时，可能撞上还没完全落盘的文件
    // → `tar: ...file changed as we read it` / 打包失败。
    // `close` 才是真正的"这个文件写完了"。
    ws.on("close", () => resolve({ size, sha256: h.digest("hex") }));

    rs.pipe(ws);
  });
}

/**
 * 确保输出文件的**父目录**存在。
 *
 * ⚠️ **不能无条件 `mkdir(dir, { recursive: true })`**（2026-10-26 实测）。
 * 用户把包存到盘根（`D:\backup.tar.gz`）时，`dirname` 是 `D:\`，
 * 对**盘符根目录**调 mkdir 在 Windows 上直接 `EPERM: operation not permitted`。
 * 而那个目录本来就存在，压根不需要建。
 *
 * 修法：先判断，存在就不动。只有真的不存在时才建（这时不会是盘符根）。
 */
async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  const st = await statSafe(dir);
  if (st && st.isDirectory()) return; // 已存在（含 `D:\` 这种根目录）→ 什么都不做
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * 执行导出。
 * @returns {{ ok:true, path, manifestSummary }}
 */
async function doExport({ categories, outputPath, customItems } = {}) {
  const { categories: all, workspaces } = await scanAll();
  const picked = resolveSelection(all, categories);
  const customs = (Array.isArray(customItems) ? customItems : [])
    .map(normalizeCustomItem)
    .filter(Boolean);
  // 允许"只导自定义项"（不选任何内置分类）
  if (picked.length === 0 && customs.length === 0) throw new Error("没有选中任何分类");

  // 自定义项文档自检：把体检报告带进 manifest，让恢复端也知道"这份方案本身可能不全"
  const customAudit = customs.length ? await auditCustomItems(customs) : [];

  // 落到临时 staging 目录再打 tar —— 这样包内路径就是 staging 下的相对路径，
  // 不用把本机绝对路径写进 tar header。
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "cfg-export-"));
  const items = [];
  const redactions = [];

  try {
    // ⚠️ **分类定义只建一次**（原来在循环里每次 `categoryDefs(workspaces)` 重建）；
    // `collect()` 的结果**复用**给后面的重叠检测 —— 原来整棵树 walk 了 3 遍
    // （scanAll 一遍 + 这里两遍），技能目录 12970 个文件每遍都要 readdir
    // 整棵树，等于白跑两遍、几万次系统调用。
    const defs = categoryDefs(workspaces);
    const collected = [];       // [{ c, files }] —— 重叠检测直接复用
    const madeDirs = new Set(); // 已建过的目录（原来每个文件都 mkdir 一次）

    for (const c of picked) {
      const def = defs.find((d) => d.id === c.id);
      if (!def) continue;
      const { files } = await def.collect();
      collected.push({ c, files });

      for (const f of files) {
        const dest = path.join(staging, "data", f.rel);

        const dir = path.dirname(dest);
        if (!madeDirs.has(dir)) {
          await fsp.mkdir(dir, { recursive: true });
          madeDirs.add(dir);
        }

        // settings.json 特殊处理：剥 env 段（见文件头「安全模型」）
        let size = 0;
        let sha = "";
        if (f.rel === "claude/settings.json") {
          const raw = await fsp.readFile(f.abs, "utf8");
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
          if (parsed) {
            const { value, stripped } = stripEnv(parsed);
            const out = JSON.stringify(value, null, 2);
            await fsp.writeFile(dest, out, "utf8");
            size = Buffer.byteLength(out);
            sha = crypto.createHash("sha256").update(out).digest("hex");
            if (stripped) {
              redactions.push({
                item: f.rel,
                path: "env",
                reason: "may-contain-credentials",
              });
            }
          } else {
            // 解析失败：宁可原样拷，也别丢文件
            ({ size, sha256: sha } = await copyAndHash(f.abs, dest));
          }
        } else {
          // 🔴 **边复制边算 hash** —— 只读一遍。
          // （旧写法 copyFile + 之后再 sha256File 会把每个文件读两遍）
          ({ size, sha256: sha } = await copyAndHash(f.abs, dest));
        }

        items.push({
          category: c.id,
          relPath: f.rel,
          sourceAbsPath: f.abs,
          size,
          sha256: sha,
          restore: { target: restoreTargetFor(f.rel), mode: restoreModeFor(f.rel) },
        });
      }
    }

    // ── 自定义项：原样打包整个目录（不做任何解析）──
    //
    // ⚠️ 这里**不过 isNeverExport / shouldSkip** —— 用户自己的目录、自己的规则。
    // 用户显式勾选导出即视为知情。我们只守住"内置采集范围"那部分。
    const customMeta = [];
    const customPathSets = [];
    const builtinPathSets = [];
    // ⚠️ **没有自定义项就整段跳过**（2026-10-26）。
    // 重叠检测是"自定义项 ∩ 内置分类"，没有自定义项时结果恒为空，
    // 却要为此把 13 个分类再 collect() 一遍（技能目录 12970 个文件）。
    // 用户不加自定义项是常态，这段白跑最亏。
    if (customs.length) {
      // 复用上面已经 collect() 过的结果，不再重复遍历
      for (const { c, files } of collected) {
        builtinPathSets.push({
          id: c.id,
          label: c.label,
          paths: new Set(files.map((f) => f.abs)),
        });
      }
    }

    for (const cu of customs) {
      const st = await statSafe(cu.path);
      if (!st) { log("custom item missing:", cu.path); continue; }

      const relRoot = `custom/${cu.id}`;
      const destRoot = path.join(staging, relRoot);
      await fsp.mkdir(destRoot, { recursive: true });

      let taken = 0;
      let bytes = 0;
      const paths = new Set();

      // ⚠️ **数据默认不进包**（见文件头「自定义项」的说明）。
      //
      // 用户自己的方案通常已经把数据备份到它自己的地方（如 X 盘），
      // 我们再打一份既浪费，又可能**违反用户文档里定的规则**（哪些该带、
      // 哪些排除、什么顺序）。所以我们的包只带**说明**，数据由用户方案负责。
      //
      // 只有当调用方显式 `includeData: true` 时才真的打包 —— 用于
      // "用户的文档没覆盖到这部分，不带就恢复不了"的情况。
      if (cu.includeData) {
        if (st.isDirectory()) {
          // 自己走一遍（不能复用 walk：它带黑名单与排除规则 ——
          // 用户目录不做凭据过滤，那是他们自己方案的组成部分）
          const all = [];
          async function recCustom(dir) {
            let ents = [];
            try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              const full = path.join(dir, e.name);
              if (await isLink(full)) continue;      // 链接不跟进（同 walk）
              if (e.isDirectory()) { await recCustom(full); }
              else if (e.isFile()) { all.push(full); }
            }
          }
          await recCustom(cu.path);

          for (const abs of all) {
            const rel = path.relative(cu.path, abs).replace(/\\/g, "/");
            const dest = path.join(destRoot, rel);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.copyFile(abs, dest);
            const ds = await statSafe(dest);
            bytes += ds ? ds.size : 0;
            taken++;
            paths.add(abs);
          }
        } else {
          const dest = path.join(destRoot, path.basename(cu.path));
          await fsp.copyFile(cu.path, dest);
          const ds = await statSafe(dest);
          bytes += ds ? ds.size : 0;
          taken++;
          paths.add(cu.path);
        }
      } else {
        // 不带数据：仍统计一下"这份方案涉及多大"，好让导入端知道规模。
        // 但不列入重叠检测（没进包就不存在覆盖冲突）。
        if (st.isDirectory()) {
          async function measure(dir) {
            let ents = [];
            try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              const full = path.join(dir, e.name);
              if (await isLink(full)) continue;
              if (e.isDirectory()) await measure(full);
              else if (e.isFile()) {
                const s = await statSafe(full);
                if (s) { bytes += s.size; taken++; }
              }
            }
          }
          await measure(cu.path);
        } else {
          bytes += st.size; taken = 1;
        }
      }

      if (cu.includeData) customPathSets.push({ id: cu.id, paths });
      customMeta.push({
        id: cu.id,
        label: cu.label,
        kind: "custom",
        sourceAbsPath: cu.path.replace(/\\/g, "/"),
        bundledPath: cu.includeData ? relRoot + "/" : null,
        dataIncluded: cu.includeData,
        // 数据没进包时，这个路径是**唯一线索** —— 导入端 AI 据此去找
        // （或问用户"你那套方案把数据放哪了"）。
        entryDoc: cu.entryDoc || null,
        notes: cu.notes || null,
        importPrompt: cu.importPrompt || null,
        verifyPrompt: cu.verifyPrompt || null,
        fileCount: taken,
        size: bytes,
      });
    }

    // 重叠检测：让导入端 AI 知道"哪些文件内置项也会恢复"
    const overlapReport = detectOverlaps(customPathSets, builtinPathSets);
    for (const cm of customMeta) {
      const rep = overlapReport.find((x) => x.customId === cm.id);
      cm.overlaps = rep ? rep.overlaps : [];
    }

    const manifest = {
      formatVersion: 2, // v2: + customItems（导入端据此判断要不要走自定义流程）
      exportedAt: new Date().toISOString(),
      tool: { plugin: "config-export", version: "0.1.0" },
      source: {
        platform: process.platform === "win32" ? "windows" : process.platform,
        guiVersion: process.env.CLAUDE_PLUGIN_HOST_PID ? "" : "", // 宿主未提供版本号，留空
        hostname: hostname(),
        workspaces: workspaces.map((w) => ({
          slug: sanitizePath(w.absPath),
          name: w.name,
          absPath: w.absPath.replace(/\\/g, "/"),
        })),
      },
      installedPlugins: await installedPlugins(),
      selection: picked.map((c) => c.id),
      items,
      redactions,
      customItems: customMeta,
      // 自定义项的"文档体检"结果（导出时算的，带进包让恢复端也知道）
      customAudit,
    };

    await fsp.writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );

    // 包内自带恢复指南（AI 解开包第一眼看到的就是它）
    await fsp.writeFile(
      path.join(staging, "IMPORT_GUIDE.md"),
      buildImportGuide(manifest),
      "utf8",
    );

    // 恢复推演（备份有效性门控）—— 见 buildRehearsal 的注释
    const autoChecks = runAutoChecks(manifest, staging, redactions);
    await fsp.writeFile(
      path.join(staging, "RESTORE_REHEARSAL.md"),
      buildRehearsal(manifest, autoChecks),
      "utf8",
    );

    // 恢复期工具脚本 —— 随包分发，恢复端 AI 直接调，不必临场写脚本。
    // `tar-writer.cjs` 必须一起带上 —— restore-tools 靠它做纯 Node 解包。
    try {
      await fsp.mkdir(path.join(staging, "tools"), { recursive: true });
      for (const f of ["restore-tools.cjs", "tar-writer.cjs"]) {
        const src = path.join(__dirname, f);
        if (fs.existsSync(src)) {
          await fsp.copyFile(src, path.join(staging, "tools", f));
        }
      }
    } catch (e) {
      log("copy tools failed:", e && e.message);
    }

    const out = outputPath || path.join(os.homedir(), "Downloads", `claude-profile-export-${tsStamp()}.tar.gz`);
    await ensureParentDir(out);

    // 🎯 **先把包打到 staging 里，再复制到目标位置**（2026-10-26 重构）。
    //
    // 之前是 `tar -czf <用户给的绝对路径>` —— 让 tar 直接写目标位置。
    // 这在跨盘符 / 盘根 / 受权限或安全软件限制的目录上问题很多：
    // 面板里实测「D:\xxx.tar.gz」失败，但同样的路径在命令行里能成功，
    // 差别只在「谁的进程在写」。靠猜环境差异没法稳定修。
    //
    // 现在的做法把"写哪里"和"打包"彻底解耦：
    //   · tar 只在 staging（系统临时目录，已知可写）里产出
    //   · 再用 Node 的 copyFile 搬到目标 —— 这一步的失败信息是明确的
    //     （EPERM/EACCES/ENOSPC 都能直接告诉用户）
    // ⚠️ 中间包必须放在 **staging 外面**（同级），不能放在 staging 里面 ——
    // tar 正在打包 staging 里的内容，输出文件若也在里面就会自己卷自己，
    // 结果是 tar 报错或产出 0 字节（实测踩到）。
    const stagedPkg = path.join(staging + "-pkg.tar.gz");
    // 🔴 用**自带的纯 Node 打包器**，不调系统 tar。
    // 原因见 tar-writer.cjs 文件头：Windows 上 PATH 里可能是 bsdtar，
    // 它不支持 `--force-local`（返回码 1），而我们还把 code<2 当成功了。
    await packDirectory(staging, stagedPkg);

    // 打包完了再搬。**先确认 staging 里真的有包** —— 否则后面 copyFile
    // 会报一个含糊的 ENOENT，看不出是"tar 没产出"还是"目标不可写"。
    const stagedSt = await statSafe(stagedPkg);
    if (!stagedSt || stagedSt.size === 0) {
      throw new Error(`打包失败：tar 没有产出有效的压缩包（${stagedPkg}）`);
    }

    try {
      await fsp.copyFile(stagedPkg, out);
    } catch (e) {
      // 这一步失败，原因通常很明确（权限 / 磁盘满 / 目标被占用）。
      // 直接告诉用户，别让他猜。
      throw new Error(
        `包已打好（${(stagedSt.size / 1048576).toFixed(1)} MB），但**无法写入目标位置**：\n` +
        `  ${out}\n` +
        `  原因：${e.code || ""} ${e.message || ""}\n` +
        `  请换一个目录（比如「下载」文件夹）再试，或检查该位置是否被占用/只读。`,
      );
    } finally {
      await fsp.unlink(stagedPkg).catch(() => {});
    }

    // 最后再确认一次产物真的在（防"copy 报告成功但文件不见"这种鬼事）
    const st = await statSafe(out);
    if (!st || !st.isFile()) {
      throw new Error(`压缩包没有落到目标位置：${out}。请换一个目录重试。`);
    }
    if (st.size === 0) {
      throw new Error(`压缩包是空的（0 字节）—— ${out}`);
    }

    return {
      ok: true,
      path: out,
      size: st.size,
      categories: picked.map((c) => ({ id: c.id, fileCount: c.fileCount, size: c.size })),
      itemCount: items.length,
      redactions,
      // ── 备份有效性门控 ──
      // `autoChecks` 是导出端**已经跑完**的确定性检查；
      // `todo` 是必须由 AI/用户补做的推演清单（其余细节在包内 RESTORE_REHEARSAL.md）。
      //
      // ⚠️ 调用方看到这个返回**不该**直接说"备份完成" —— 见 guideHint。
      autoChecks,
      rehearsalRequired: true,
      rehearsalFile: "RESTORE_REHEARSAL.md",
      guideHint:
        "备份文件已生成，但**尚未验证可恢复性**。" +
        "请立刻做一遍恢复推演（见包内 RESTORE_REHEARSAL.md，或读该文件）：" +
        "逐条回答里面的问题，确认这份备份在**一台新机器**上真的能还原。" +
        "推演通过前，不要告诉用户「备份已完成」。",
      // 明确告诉 AI「包里带着工具」—— 否则它会临场写脚本（用户明确不要这个）
      bundledFiles: {
        guide: "IMPORT_GUIDE.md",
        rehearsal: "RESTORE_REHEARSAL.md",
        tools: "tools/restore-tools.cjs",
      },
      toolsHint:
        "包内自带 tools/restore-tools.cjs（list / verify / compare / rate / " +
        "session-diff / session-merge / json-merge）。**恢复时用它，不要临时写脚本**：" +
        "固定套路已经封装好，输出统一 JSON。",
      nextActions: [
        "1. 读包内 RESTORE_REHEARSAL.md，做恢复推演（门控）",
        "2. 把推演结论告诉用户：能不能用 / 有哪些坑 / 建议补什么",
        "3. 用户确认后再告诉他这份备份「可用了」",
      ],
      recommendedImportPrompt:
        "把这句原样转给用户（或贴进输入框），供他日后恢复时使用：\n" +
        `「帮我用 ${path.basename(out)} 恢复配置，按包里的 IMPORT_GUIDE.md 和 ` +
        "RESTORE_REHEARSAL.md 走，用包里的 tools/restore-tools.cjs，不要临时写脚本」",
    };
  } finally {
    // staging 用完即删（可能几十 MB）
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 生成包内的 `IMPORT_GUIDE.md` —— **给导入端的 AI 读的流程框架**。
 *
 * 设计原则：
 *   · 只给**框架与事实**（有哪些条目、各自该怎么恢复、哪里有重叠）
 *   · **不做决策**：遇到冲突怎么办、要不要覆盖，交给 AI 与用户
 *   · 自定义项**只指路**（读哪份文档、跑哪条验证），不复述用户自己的逻辑
 */
/**
 * 生成 `RESTORE_REHEARSAL.md` —— **备份有效性门控**。
 *
 * 用户的原话：**"做完后要自己推演一遍，在新机器上是否能够按照备份文档还原数据。
 * 这是备份有效的门控。"**
 *
 * 核心思路：**能在导出端验证的，绝不留给恢复端发现。**
 *
 *   ┌─ 机器能验的（代码已自动跑，结果写进文档）─────┐
 *   │ · 每个文件的 sha256 是否可读、非空             │
 *   │ · 包内路径是否都在、大小是否符                   │
 *   │ · 自定义项的入口文档**是否真的存在**            │
 *   │ · 凭证剥离是否已记录                            │
 *   └───────────────────────────────────────────────┘
 *   ┌─ 必须靠推演的（AI 在导出后立刻做）──────────────┐
 *   │ · 这份文档描述**怎么恢复**吗？还是只描述了现状？ │
 *   │ · 换个用户名/盘符，文档里的路径还成立吗？        │
 *   │ · 自定义项的**数据**在新机器上从哪来？           │
 *   │ · 有没有文档里没提、但不带就恢复不了的依赖？     │
 *   └───────────────────────────────────────────────┘
 */
function buildRehearsal(manifest, checks) {
  const L = [];
  const customs = manifest.customItems || [];

  L.push("# 恢复推演（备份有效性门控）");
  L.push("");
  L.push("> **这份文件不是给用户看的，是给 AI 的检查单。**");
  L.push("> 导出端已经跑完了机器能验的部分；剩下的**必须由你做一遍推演**，");
  L.push("> 否则这次备份**不算有效**。");
  L.push("");

  // ── 第 1 部分：自动检查结果 ──
  L.push("## 一、自动检查（已由导出端完成）");
  L.push("");
  L.push("| 检查项 | 结果 |");
  L.push("|---|---|");
  for (const c of checks) {
    L.push(`| ${c.name} | ${c.ok ? "✅ " : "❌ "}${c.detail} |`);
  }
  L.push("");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    L.push("> ❌ **有自动检查未通过 —— 这份备份不可靠，先修复再谈恢复。**");
    L.push("");
  }

  // ── 第 2 部分：必须推演的问题 ──
  L.push("## 二、必须推演的问题（逐条回答，不能跳过）");
  L.push("");
  L.push("把答案直接写在下面，或者回答给用户听。**拿不准就问用户。**");
  L.push("");

  let n = 0;
  const q = (title, body) => {
    n++;
    L.push(`### Q${n}. ${title}`);
    L.push("");
    L.push(body);
    L.push("");
    L.push("**你的结论**：<!-- 在这里写 -->");
    L.push("");
  };

  q(
    "这份备份能在一台**全新的**机器上恢复吗？",
    "假设新机器：没有 `~/.claude`、没有装任何插件、用户名不同、盘符可能不同。\n\n" +
    "逐项确认：\n" +
    "- 内置条目：按 `restore.mode` 能落到正确位置吗？\n" +
    "- `manual` 模式的条目（记忆 / 桌面数据库）—— 冲突了怎么办？有明确策略吗？",
  );

  q(
    "路径在新机器上还成立吗？",
    "包里的 `sourceAbsPath` 是本机的（含用户名 / 盘符）。检查：\n" +
    "- 有没有**写死绝对路径**的文件（脚本、配置、插件设置）？\n" +
    "- 恢复后它们指向的位置在新机器上存在吗？\n" +
    "- 若不存在，谁负责改？（用户手动 / 某个脚本 / 你）",
  );

  for (const c of customs) {
    q(
      `自定义项「${c.label}」在新机器上怎么恢复到可用状态？`,
      `- 入口文档：${c.entryDoc ? `\`${c.entryDoc}\`` : "**未指定** —— 需要问用户"}\n` +
      (c.dataIncluded
        ? "- 数据：**已在本包里**（`" + c.bundledPath + "`）\n"
        : "- 数据：**不在包里** —— 新机器上从哪来？用户会带移动硬盘？云端？还是根本没备份过？\n") +
      (c.importPrompt ? `- 该方案的导入指引：${c.importPrompt}\n` : "") +
      "\n**关键**：这份文档是**只描述了现状**，还是**真的写了怎么恢复**？" +
      "如果只写了「我的数据在 X 盘」，那新机器上 X 盘不在时你怎么恢复？",
    );
  }

  q(
    "有没有「文档没提、但不带就恢复不了」的东西？",
    "这是最容易漏的一类。举例：\n" +
    "- 某个技能依赖的 Python 包（`requirements.txt` 在包里吗？）\n" +
    "- 环境变量 / API key（我们故意剥离了，用户知道要重配吗？）\n" +
    "- 插件本身（源码没带，用户知道要去市场重装吗？）\n" +
    "- 外部数据（数据库、模型文件、知识库）",
  );

  q(
    "这次备份**失败**的话，用户会损失什么？",
    "反向验证：如果包损坏 / 丢了一部分，最坏情况是什么？\n" +
    "哪部分**有冗余**（别处也有）、哪部分**是唯一副本**？\n" +
    "唯一副本 + 没做推演 = 高风险。",
  );

  // ── 第 3 部分：结论 ──
  L.push("## 三、结论");
  L.push("");
  L.push("推演完成后，向用户报告三件事：");
  L.push("");
  L.push("1. **这份备份能不能用** —— 能 / 有条件能（列出条件）/ 不能（说明缺什么）");
  L.push("2. **有哪些坑** —— 新机器上需要人工处理的（重配 key、重装插件、改路径…）");
  L.push("3. **建议补什么** —— 比如「某个自定义项建议勾上『带数据』」");
  L.push("");
  L.push("> ⚠️ **不要说「备份已完成」就结束。**");
  L.push("> 用户要的是「这份备份**真的能恢复**」，不是「文件打包完了」。");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## 附：manifest 摘要");
  L.push("");
  L.push(`- 内置条目：${(manifest.items || []).length} 个文件`);
  L.push(`- 自定义项：${customs.length} 个（${customs.filter((c) => c.dataIncluded).length} 个带数据）`);
  if (manifest.redactions && manifest.redactions.length) {
    L.push(`- 已剥离凭据：${manifest.redactions.length} 处`);
  }
  L.push("");
  return L.join("\n");
}

function buildImportGuide(manifest) {
  const L = [];
  const items = manifest.items || [];
  const customs = manifest.customItems || [];
  const byMode = {};
  for (const it of items) {
    const m = (it.restore && it.restore.mode) || "overwrite";
    (byMode[m] = byMode[m] || []).push(it);
  }

  L.push("# 恢复指南");
  L.push("");
  L.push("> 本文件由 `config-export` 插件生成，写给**导入端的 AI**。");
  L.push("> 目标是给你一个**流程框架**，不是替你做决定。遇到冲突时**先问用户**。");
  L.push("");
  L.push("## 这个包是什么");
  L.push("");
  L.push(`- 导出自：\`${manifest.source.hostname}\`（${manifest.source.platform}）`);
  L.push(`- 时间：${manifest.exportedAt}`);
  L.push(`- 格式版本：${manifest.formatVersion}`);
  L.push(`- 内置条目：${items.length} 个文件，分属 ${new Set(items.map((i) => i.category)).size} 个分类`);
  if (customs.length) L.push(`- **自定义项：${customs.length} 个**（详见第 2 步）`);
  L.push("");

  L.push("## 第 0 步：先读 `manifest.json`");
  L.push("");
  L.push("每个文件的完整信息都在里面：`relPath`（包内路径）、`sourceAbsPath`（原来在哪）、");
  L.push("`size`、`sha256`、`restore.target`（该恢复到哪）、`restore.mode`（怎么恢复）。");
  L.push("");

  // ── 恢复前必做：评估新机器现状 ──
  //
  // 🔴 **这不是一个"照着清单拷文件"的任务。**
  // 新机器上可能已经有：装好的插件、跑过几个会话、改过的设置、自己的记忆。
  // 直接按固定模式覆盖 = 毁掉用户在新机器上已有的东西。
  L.push("## ⚠️ 第 0 步：先评估新机器现状（**不能跳过**）");
  L.push("");
  L.push("**恢复不是「解压了就完事」。** 恢复前你必须先摸清这台机器现在是什么状态，");
  L.push("否则你可能会覆盖掉用户在**这台机器上**已经积累的东西。");
  L.push("");
  L.push("### 必须实地检查的（用工具查，别猜）");
  L.push("");
  L.push("| 查什么 | 怎么查 | 为什么重要 |");
  L.push("|---|---|---|");
  L.push("| `~/.claude/` 存在吗？有什么 | 列目录 + 看 `settings.json` | 全新机器 vs 已用过的机器，策略完全不同 |");
  L.push("| 已有哪些会话？ | 看 `~/.claude/projects/<slug>/*.jsonl` | **同一会话在两台机器上进度可能不同** |");
  L.push("| 已装哪些插件？ | 看 `%APPDATA%/com.claudecode.gui/plugins/` | 与包里 `installedPlugins` 比对 |");
  L.push("| 记忆/笔记/桌面有内容吗？ | 看对应目录与 `data.db` | 这些是 `manual` 模式，冲突要问用户 |");
  L.push("| 用户名 / 盘符 / 工作区路径 | `whoami`、看现有配置里的绝对路径 | 决定路径是否需要改写 |");
  L.push("");
  L.push("### 然后给出**恢复方案**，让用户确认");
  L.push("");
  L.push("把评估结果整理成一份方案（不是直接开干）：");
  L.push("");
  L.push("```");
  L.push("这台机器现状：……（全新 / 已有 N 个会话 / 已装 M 个插件 / 记忆存在…）");
  L.push("我打算这样恢复：");
  L.push("  · 全新 → 直接放入（列出将写入的）");
  L.push("  · 已存在且可合并 → 合并（说明合并规则）");
  L.push("  · 已存在且冲突 → **问用户**（给出两个选项与原样对比）");
  L.push("预计影响：……");
  L.push("```");
  L.push("**用户点头后再动手。**");
  L.push("");
  L.push("### 冲突处理：不要自己定，按内容类型判断");
  L.push("");
  L.push("下面这些场景**一定会遇到**，每种的最优解不同 —— **不要用一条规则套全部**：");
  L.push("");
  L.push("| 内容 | 典型冲突 | 建议方向（仍需用户确认） |");
  L.push("|---|---|---|");
  L.push("| **会话 `.jsonl`** | 同一会话两台机器都有、但轮次不同 | **先比较**：谁更长/更新。可能的话**按 uuid 合并**（追加包里多出来的轮次），而不是整份覆盖。合并前备份原文件 |");
  L.push("| **`settings.json`** | 两边都改过不同字段 | **按键合并**：以新机器现有值为主，补上包里缺的键。**不要整份覆盖** |");
  L.push("| **`CLAUDE.md`** | 两边都有内容 | **先看差异**：可能包里的只是旧版本。去重后追加，或让用户挑 |");
  L.push("| **记忆 `memory/`** | 同名条目内容不同 | **必须问用户**。记忆是人工沉淀的，覆盖=丢思考过程 |");
  L.push("| **`data.db`（桌面/计划）** | 新机器已有画布内容 | **必须问用户**。无法自动合并（SQLite 二进制） |");
  L.push("| **技能** | 同名技能版本不同 | 看是否是同一来源；不同来源问用户 |");
  L.push("| **插件** | 版本不同 | 建议**保持新机器版本**（更新的通常是新版），只补缺的 |");
  L.push("");
  L.push("");
  L.push("### 做任何破坏性操作前");
  L.push("");
  L.push("- **先备份现状**：把要动的文件/目录复制一份（或让用户先跑一次本插件导出）");
  L.push("- 逐步执行，**每步可回退**");
  L.push("- 不要一次性 `cp -r` 整个目录");
  L.push("");
  L.push("---");
  L.push("");
  L.push("## 第 1 步：恢复内置条目");
  L.push("");
  L.push("按 `restore.mode` 分组处理（**注意：分组只说明该文件有没有合并语义，不代表可以直接覆盖**）：");
  L.push("");
  // 这条警告**无条件出现** —— 不能只在某个分组里说。用户可能只导了一类文件，
  // 那类恰好是 append，但"别乱覆盖"的原则依然适用。
  L.push("> 🔴 **`overwrite` 不是「闭眼覆盖」的意思** —— 它只说明该文件**没有自动合并的语义**");
  L.push("> （二进制 / 整份替换）。**目标已存在时，先问用户**再决定覆盖还是跳过。");
  L.push("");
  const modeDesc = {
    overwrite: ["无合并语义", "这类文件**没有自动合并的办法**（二进制 / 整份替换）。**目标已存在时先问用户**，别直接覆盖"],
    merge: ["可合并", "目标已存在时**按键/条目合并**，保留新机器上已有的（如 settings.json）"],
    append: ["可追加", "追加到目标文件末尾（如 CLAUDE.md —— **先去重**，别把同一段加两次；内容冲突时问用户）"],
    manual: ["**必须人工/AI 判断**", "这类**没有标准答案**：记忆、桌面/笔记数据库 —— 先给用户看差异，让他决定"],
  };
  for (const [mode, list] of Object.entries(byMode)) {
    const [name, how] = modeDesc[mode] || [mode, ""];
    L.push(`### \`${mode}\`（${name}）— ${list.length} 个文件`);
    L.push("");
    L.push(`> ${how}`);
    L.push("");
    const cats = [...new Set(list.map((i) => i.category))];
    for (const c of cats) {
      const n = list.filter((i) => i.category === c).length;
      L.push(`- \`${c}\`：${n} 个文件 → \`${list.find((i) => i.category === c).restore.target}\` 等`);
    }
    L.push("");
  }

  if (manifest.redactions && manifest.redactions.length) {
    L.push("### ⚠️ 已剥离的内容");
    L.push("");
    L.push("导出时**主动移除**了以下内容（凭据类）。恢复后需要用户自行重配：");
    L.push("");
    for (const r of manifest.redactions) {
      L.push(`- \`${r.item}\` → \`${r.path}\`（原因：${r.reason}）`);
    }
    L.push("");
  }

  if (customs.length) {
    L.push("## 第 2 步：处理自定义项 ⚠️ 重点");
    L.push("");
    L.push("这些是用户**自己的一套方案**（可能是手册 + 脚本 + 私有数据）。");
    L.push("插件**不解析**它们的内容 —— **全部逻辑在用户自己的文档里**。");
    L.push("");
    L.push("🔴 **这一部分完全靠你驱动 —— 没有固定的恢复模式可套。**");
    L.push("");
    L.push("插件只知道「有这么一个方案」，不知道它怎么落地。你必须：");
    L.push("**读用户的文档 → 摸清新机器现状 → 制定方案 → 用户确认 → 执行 → 验证**。");
    L.push("");
    L.push("```");
    L.push("1. **读 entryDoc**（用户自己的手册）—— 那是唯一权威。");
    L.push("   读完你要能回答：这套方案会改哪些目录？有没有前提条件？有顺序要求吗？");
    L.push("");
    L.push("2. **评估新机器现状**（同第 0 步）：这些目录现在是什么状态？");
    L.push("   已经做过一半？还是全新？有没有冲突？");
    L.push("");
    L.push("3. **判断是否重复做过**（看 overlaps）：");
    L.push("   · 若有重叠 → **先问用户**「这套方案之前是不是已经做过？」");
    L.push("     已做过 → 只导入增量，或问用户是否要用包里的版本更新");
    L.push("     没做过 → 按 entryDoc 正常执行");
    L.push("   · **绝不静默覆盖**用户的现有环境");
    L.push("");
    L.push("4. **制定恢复方案给用户看**，包括：");
    L.push("   · 我打算按文档第几节做、做哪些步骤");
    L.push("   · 会动到哪些现有文件、冲突怎么处理");
    L.push("   · 如果文档里有你**看不懂/执行不了**的步骤（比如需要 GUI 操作、需要没装的软件）");
    L.push("     → **如实说**，不要假装能跑");
    L.push("");
    L.push("5. **执行 importPrompt**（若给了）。**顺序照文档来**，别自己重排。");
    L.push("");
    L.push("6. **验证 verifyPrompt**（若给了），把**实际输出**贴给用户看。");
    L.push("```");
    L.push("");
    L.push("### ⚠️ 用户文档 ≠ 一定能执行");
    L.push("");
    L.push("用户写文档时，假设的是**他自己那套环境**。到新机器上很可能不成立：");
    L.push("");
    L.push("- 脚本里的**硬编码路径**（`C:\\Users\\吴亚飞\\...`）→ 新机器用户名不同，跑不了");
    L.push("- 依赖的**软件/驱动/Python 包** → 新机器没装");
    L.push("- 文档里的**步骤顺序** → 「04 拉取 → 06 修复用户名 → 07 验证」，乱序会出错");
    L.push("- **需要 GUI 手动操作**的步骤 → 你不能代替用户点");
    L.push("");
    L.push("**遇到这类情况：如实告诉用户「这一步在新机器上做不到 / 需要你先手动做 X」，");
    L.push("不要绕过、不要自己发明一个替代方案。**");
    L.push("");

    for (const c of customs) {
      L.push(`### 自定义项：${c.label}`);
      L.push("");
      if (c.dataIncluded) {
        L.push(`- **数据在包里**：\`${c.bundledPath}\`（${c.fileCount} 个文件，${(c.size / 1024).toFixed(0)} KB）`);
      } else {
        L.push("> ⚠️ **这份方案的数据不在本包内。**");
        L.push("> 用户自己的方案负责它的备份（可能已经存到移动硬盘 / 云盘 / 别处）。");
        L.push("> **不要**因为包里没有就跳过它 —— 先按下面的方向去找，或直接问用户。");
        L.push("");
        L.push(`- 方案目录（导出时所在位置）：\`${c.sourceAbsPath}\``);
        L.push(`- 该方案涉及约 ${c.fileCount} 个文件 / ${(c.size / 1024 / 1024).toFixed(1)} MB（未打包）`);
      }
      if (c.entryDoc) {
        const base = c.dataIncluded ? c.bundledPath : "";
        L.push(`- **入口文档**：\`${base}${c.entryDoc}\`` +
          (c.dataIncluded ? " ← 从这里读起" : " ← 在方案自己的目录里（见上面的路径）"));
      } else {
        L.push("- ⚠️ 未指定入口文档 —— 需要用户告诉你从哪个文件读起");
      }
      if (c.notes) L.push(`- 用户备注：${c.notes}`);
      if (c.importPrompt) {
        L.push("");
        L.push("**用户给的导入指引：**");
        L.push("");
        L.push("> " + c.importPrompt.split("\n").join("\n> "));
      }
      if (c.verifyPrompt) {
        L.push("");
        L.push("**用户给的验证方式：**");
        L.push("");
        L.push("> " + c.verifyPrompt.split("\n").join("\n> "));
      }

      if (c.overlaps && c.overlaps.length) {
        L.push("");
        L.push(`#### ⚠️ 与内置条目重叠`);
        L.push("");
        L.push("这个自定义项里，**下面这些文件本次导出也作为内置条目带了**");
        L.push("（即：它们会被第 1 步恢复一次，这里可能又恢复一次）：");
        L.push("");
        for (const o of c.overlaps) {
          L.push(`- \`${o.category}\`（${o.label}）— **${o.shared} 个文件重叠**` +
            (o.sample && o.sample.length ? `，如 ${o.sample.map((s) => `\`${s}\``).join("、")}` : ""));
        }
        L.push("");
        L.push("**处理原则**：");
        L.push("");
        L.push("- 这些内容**大概率是同一批** —— 先问用户「之前那套方案是不是已经把这些同步过了」");
        L.push("- 用户的旧方案可能**有额外的处理步骤**（比如路径替换、特定顺序），");
        L.push("  那些是包内内置恢复**不会做**的 —— 别因为「文件已经有了」就跳过整条流程");
        L.push("- 由用户决定：**只导入增量** / **按旧方案完整重跑** / **跳过**");
        L.push("");
      } else {
        L.push("");
        L.push("#### 与内置条目无重叠（自包含）");
        L.push("");
      }

      // 导出时的文档体检结果 —— 让恢复端也知道"这份方案本身可能不全"
      const audit = (manifest.customAudit || []).find((a) => a.id === c.id);
      if (audit && audit.crossCheck && audit.crossCheck.missing.length) {
        L.push("");
        L.push("#### ⚠️ 导出时的文档体检：**文档提到的文件有缺失**");
        L.push("");
        L.push(`导出时核对过：文档提到 **${audit.crossCheck.mentioned}** 个文件，` +
          `目录里只找到 **${audit.crossCheck.present.length}** 个，` +
          `**缺 ${audit.crossCheck.missing.length} 个**：`);
        L.push("");
        for (const m of audit.crossCheck.missing.slice(0, 15)) {
          L.push(`- \`${m}\``);
        }
        if (audit.crossCheck.missing.length > 15) {
          L.push(`- ……还有 ${audit.crossCheck.missing.length - 15} 个`);
        }
        L.push("");
        L.push("**这些文件可能：**");
        L.push("");
        L.push("- 在**别的位置**（用户方案的脚本常散落在多个目录）→ 问用户在哪");
        L.push("- **根本没备份过** → 那这个方案在这一步就断了，如实告诉用户");
        L.push("- 或者只是文档里的**举例/占位**名 → 问用户确认");
        L.push("");
        L.push("> 用户导出时**已经知道**这个缺失（面板弹过确认）；");
        L.push("> 但恢复时仍要提醒他 —— 残缺的文档恢复出来的结果不会完整。");
      }

      // 数据不在包里时的额外指引
      if (!c.dataIncluded) {
        L.push("#### 数据要怎么到位？");
        L.push("");
        L.push("按顺序尝试，**每步都要让用户知情**：");
        L.push("");
        L.push("1. **读入口文档** —— 里面通常写明了数据存在哪（盘符 / 路径 / 同步方式）");
        L.push("2. **去那个位置找** —— 如移动硬盘、云盘目录");
        L.push("3. **问用户**「这套方案的数据现在在哪？需要我帮你恢复到哪个位置？」");
        L.push("4. 若用户说「没有备份过」→ 那这次恢复**用不上它**，但**记下来**告诉用户");
        L.push("   「下次导出时建议勾上『把数据也打进包』」");
        L.push("");
      }
    }

    L.push("## 第 3 步：验证与报告");
    L.push("");
    L.push("- 每个 `verifyPrompt` 跑一遍，把**实际输出**给用户看（别只说「已完成」）");
    L.push("- 第 1 步里 `manual` 模式的条目，逐项确认用户已经决定");
    L.push("- 最后总结：恢复了什么、跳过了什么、哪些需要用户手动接手");
    L.push("");

    // ── 自带的工具脚本 ──
    L.push("### 包内自带工具（`tools/restore-tools.cjs`）");
    L.push("");
    L.push("**不要临场写脚本** —— 下面这些是固定套路，直接用：");
    L.push("");
    L.push("```bash");
    L.push("# 看包里有什么");
    L.push("node tools/restore-tools.cjs list <包>");
    L.push("");
    L.push("# 校验包完整性（sha256 逐个比对）");
    L.push("node tools/restore-tools.cjs verify <包>");
    L.push("");
    L.push("# 对比包内容 vs 新机器现状（哪些缺、哪些不同）");
    L.push("node tools/restore-tools.cjs compare <包> --dest <目标根目录>");
    L.push("");
    L.push("# 恢复完成后算恢复率");
    L.push("node tools/restore-tools.cjs rate <包> --dest <目标根目录>");
    L.push("");
    L.push("# 会话冲突：先看差异，再合并");
    L.push("node tools/restore-tools.cjs session-diff <包里的.jsonl> <新机器上的.jsonl>");
    L.push("node tools/restore-tools.cjs session-merge <base> <other> -o <输出>");
    L.push("```");
    L.push("");
    L.push("全部输出 **JSON**，直接解析即可。出错时 exit code ≠ 0。");
    L.push("");
    L.push("### 🔴 恢复率怎么报（重要）");
    L.push("");
    L.push("`rate` 会返回**两个数**，**不要合成一个**：");
    L.push("");
    L.push("| 指标 | 含义 |");
    L.push("|---|---|");
    L.push("| **自动验证通过率** | 能自动验的里面，验过了多少（overwrite 比 sha256；merge/append 验存在）|");
    L.push("| **整体覆盖率** | 算上**无法自动验证**的（记忆 / 桌面数据库 / 自定义项）后，覆盖了多少 |");
    L.push("");
    L.push("**为什么分开报**：`manual` 类的文件（记忆、`data.db`）**没有客观标准**——");
    L.push("谁也不能自动判断「记忆合并得对不对」。把它们算进百分比就是**假精确**。");
    L.push("");
    L.push("所以报告时要说清楚：");
    L.push("");
    L.push("```");
    L.push("自动验证通过率 85%（17/20）—— 能验的都验过了");
    L.push("整体覆盖率   60%（17/28）—— 另有 8 项需要你确认");
    L.push("  · 记忆 6 项（无法自动比对）");
    L.push("  · 桌面数据库 1 项（二进制）");
    L.push("  · 自定义项 X盘同步（需按你的文档验证）");
    L.push("```");
    L.push("");
    L.push("**别只说「恢复完成」** —— 要说清楚哪部分验过、哪部分没验、为什么。");
    L.push("");
  }

  // ── 会话合并的专项指引（用户特别提到的场景）──
  const hasSessions = items.some((i) => i.category === "claude-sessions");
  if (hasSessions) {
    L.push("## 附录：会话（`.jsonl`）冲突怎么合并");
    L.push("");
    L.push("会话是**最容易「重复但不一致」**的一类：两台机器上可能是同一个会话，");
    L.push("但进度不同（一台多聊了几轮）。**整份覆盖会丢进度。**");
    L.push("");
    L.push("### 先判断是哪个会话");
    L.push("");
    L.push("文件名就是 sessionId（`<uuid>.jsonl`）。同名 = 同一个会话。");
    L.push("");
    L.push("### 三种情况，三种处理");
    L.push("");
    L.push("| 情况 | 怎么判断 | 建议做法 |");
    L.push("|---|---|---|");
    L.push("| 新机器没有 | 目标文件不存在 | 直接放入 |");
    L.push("| 两台完全一样 | 行数相同、内容相同 | 跳过（不必动）|");
    L.push("| **两台不一致** | 行数/末尾不同 | **见下：按 uuid 合并** |");
    L.push("");
    L.push("### 不一致时怎么合并");
    L.push("");
    L.push("`.jsonl` 每行是一个带 `uuid` 的消息。**按 uuid 去重合并**（不是按行号截断）：");
    L.push("");
    L.push("```");
    L.push("1. 读两个文件，各自建 uuid → 行 的映射");
    L.push("2. 找出「只在一方存在」的行（这是真正的增量）");
    L.push("3. ⚠️ 如果两方都有同一个 uuid 但**内容不同** → 这是真冲突");
    L.push("   → **问用户**（哪台机器的版本才是对的？）");
    L.push("4. 按时间顺序合并（`timestamp` 字段），写出新文件");
    L.push("5. **合并前把两个原文件都备份一份**");
    L.push("```");
    L.push("");
    L.push("### 千万不要");
    L.push("");
    L.push("- ❌ 直接覆盖（丢进度）");
    L.push("- ❌ 简单追加（可能重复、顺序错乱）");
    L.push("- ❌ 按行数「取长的那个」（两边可能是**分叉**的对话，不是包含关系）");
    L.push("- ❌ 不备份就改");
    L.push("");
    L.push("> 合并完成后，可用 `manifest.items[].sha256` 校验导出侧的原文件没被改过。");
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("## 给 AI 的提醒");
  L.push("");
  L.push("- **不要自作主张覆盖**用户现有的数据。拿不准就问。");
  L.push("- `restore.mode: manual` 是**真的没有标准答案**，别猜。");
  L.push("- 自定义项的**顺序可能有讲究**（用户在 entryDoc 里写了就照做）。");
  L.push("- 恢复前建议**先备份当前状态**（再导一次，或手动拷贝关键文件）。");
  L.push("");
  return L.join("\n");
}

/**
 * 把包解到 destDir。
 *
 * ⚠️ **不能直接 `tar -C <绝对路径>`**（2026-10-25 实测，与打包同一个坑）：
 * `--force-local` 下 tar 会把 `C:` 当盘符语法转义成 `C\:\\...` → 路径不存在。
 * 解法：把包 copy 到目标目录，用**纯文件名**解（cwd = 目标目录）。
 */
async function extractPkg(pkgAbs, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const resolved = path.resolve(pkgAbs);
  const pkgDir = path.dirname(resolved);
  const base = path.basename(resolved);

  let tmpCopy = null;
  let nameInDest = base;
  if (path.resolve(pkgDir) !== path.resolve(destDir)) {
    tmpCopy = path.join(destDir, `.tmp-${Date.now()}-${base}`);
    await fsp.copyFile(resolved, tmpCopy);
    nameInDest = path.basename(tmpCopy);
  }
  try {
    execFileSync("tar", ["--force-local", "-xzf", nameInDest], {
      cwd: destDir, timeout: 10 * 60 * 1000, stdio: "pipe",
    });
  } finally {
    if (tmpCopy) await fsp.unlink(tmpCopy).catch(() => {});
  }
}

/**
 * 读一个现有备份包的摘要（**不改任何东西**）。
 *
 * 两个用途：
 *   · 面板的"恢复入口"—— 让用户在交给 AI 之前先确认选对了包
 *   · MCP 的 `inspect_package` —— 让 AI 在动手之前知道这个包**自不自描述**
 *     （有没有 IMPORT_GUIDE / RESTORE_REHEARSAL / tools）
 */
async function inspectPackage(pkgPath) {
  const st = await statSafe(pkgPath);
  if (!st || !st.isFile()) throw new Error(`文件不存在：${pkgPath}`);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cfg-inspect-"));
  try {
    await extractPkg(pkgPath, tmp);
    const mfPath = path.join(tmp, "manifest.json");
    if (!fs.existsSync(mfPath)) {
      throw new Error("这个包里没有 manifest.json —— 可能不是本插件导出的备份");
    }
    const mf = JSON.parse(await fsp.readFile(mfPath, "utf8"));
    const hasGuide = fs.existsSync(path.join(tmp, "IMPORT_GUIDE.md"));
    const hasRehearsal = fs.existsSync(path.join(tmp, "RESTORE_REHEARSAL.md"));
    const hasTools = fs.existsSync(path.join(tmp, "tools", "restore-tools.cjs"));

    const byCat = {};
    for (const it of mf.items || []) {
      byCat[it.category] = byCat[it.category] || { files: 0, bytes: 0 };
      byCat[it.category].files++;
      byCat[it.category].bytes += it.size || 0;
    }

    return {
      ok: true,
      path: path.resolve(pkgPath),
      size: st.size,
      exportedAt: mf.exportedAt,
      source: mf.source || {},
      formatVersion: mf.formatVersion,
      totals: {
        files: (mf.items || []).length,
        bytes: (mf.items || []).reduce((a, i) => a + (i.size || 0), 0),
        customItems: (mf.customItems || []).length,
      },
      categories: Object.entries(byCat).map(([id, v]) => ({ id, ...v })),
      customItems: (mf.customItems || []).map((c) => ({
        label: c.label,
        entryDoc: c.entryDoc,
        dataIncluded: !!c.dataIncluded,
        fileCount: c.fileCount,
      })),
      redactions: (mf.redactions || []).length,
      selfDescribing: { hasGuide, hasRehearsal, hasTools },
      ready: hasGuide && hasRehearsal,
      nextStep: hasGuide
        ? "解包后先读 IMPORT_GUIDE.md（第 0 步是「评估新机器现状」，不能跳过）"
        : "这个包没有恢复指南 —— 只能靠 manifest.json 自己判断，且要额外小心",
      toolsHint: hasTools
        ? "包里带 tools/restore-tools.cjs：用 verify / compare / rate / session-diff 等命令，" +
          "**不要临时写脚本**"
        : "包里没有工具脚本，需要自己实现校验与比较",
    };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════
// 自定义项文档自检 —— 导出**前**就该发现"用户的方案本身不完整"
// ══════════════════════════════════════════════════════════════
//
// 用户的场景（真实）：`00_迁移总览.md` 里写了 12 个文件名
// （`01_台式机同步到X.bat`、`06_修复用户名.py` …），但那个目录里**只有这一个 .md**。
// 脚本都在别处。用户如果直接导出这个目录，备份是**残缺的**，而且他不知道 ——
// 要等换机器时才发现"文档说的脚本根本不在"。
//
// 所以要在他导出**之前**做一次交叉核对：
//   文档里提到的文件名  −  目录里实际存在的文件  =  缺失项
//
// 只做**文件名级**的字符串匹配（不做路径推断 —— 那会误报）：
// 能命中就提示，命中不了就交给 AI/用户确认。

/** 从文档里抽出"看起来像文件名"的 token */
function extractFileRefs(text) {
  if (typeof text !== "string" || !text) return [];
  const re = /[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5.\-]*\.(?:bat|cmd|py|ps1|sh|md|txt|json|ya?ml|env|ini|toml|db|sqlite|zip|7z|rar|tar|gz)/gi;
  const out = new Set();
  for (const m of text.matchAll(re)) {
    const t = m[0];
    // 过滤明显的噪音：纯扩展名、过长串
    if (t.length < 4 || t.length > 120) continue;
    out.add(t);
  }
  return [...out];
}

/**
 * 交叉核对：文档提到的文件 vs 目录里实际有的。
 *
 * **纯函数**（不碰文件系统）—— 调用方把 `presentNames` 传进来，便于单测。
 *
 * @param {string[]} mentioned   文档里提到的文件名
 * @param {string[]} presentNames 目录里实际有的文件名（递归收集）
 * @returns {{mentioned:string[], present:string[], missing:string[], coverage:number|null}}
 */
function crossCheckDocRefs(mentioned, presentNames) {
  const present = presentNames.map((n) => n.toLowerCase());
  const presentSet = new Set(present);
  const missing = [];
  const found = [];
  for (const m of mentioned) {
    if (presentSet.has(m.toLowerCase())) found.push(m);
    else missing.push(m);
  }
  return {
    mentioned: mentioned.length,
    present: found,
    missing,
    // 覆盖率：文档提到的文件里，目录中能对上的比例
    coverage: mentioned.length ? found.length / mentioned.length : null,
  };
}

/**
 * 对每个自定义项做文档自检，返回问题清单（导出前的"体检报告"）。
 *
 * @param {Array} customs  normalizeCustomItem 的结果
 * @returns {Promise<Array<{id,label,severity,issues,detail}>>}
 */
async function auditCustomItems(customs) {
  const reports = [];

  for (const cu of customs) {
    const issues = [];

    // ① 入口文档是否存在
    let docText = null;
    if (!cu.entryDoc) {
      issues.push({
        severity: "high",
        kind: "no-entry-doc",
        message: "没有指定入口文档 —— 恢复端 AI 不知道从哪个文件读起",
      });
    } else {
      // ⚠️ 自定义项**可以是单个文件**（面板的「+ 添加文件」）。
      // 那种情况下 `cu.path` 就是入口文档本身，不能再 join 一次
      // —— 否则拼成 `对的.md/对的.md`，永远找不到（实测踩到）。
      const cuStat = await statSafe(cu.path);
      const isFileItem = cuStat && cuStat.isFile();
      const baseName = path.basename(cu.path);
      // 单文件：声明的入口文档必须**就是**这个文件本身
      if (isFileItem && cu.entryDoc.toLowerCase() !== baseName.toLowerCase()) {
        issues.push({
          severity: "high",
          kind: "entry-doc-mismatch",
          message:
            `入口文档写的是 \`${cu.entryDoc}\`，但添加的文件是 \`${baseName}\` —— ` +
            `单文件模式下它俩必须一致`,
        });
      }
      const docPath = isFileItem ? cu.path : path.join(cu.path, cu.entryDoc);
      const st = await statSafe(docPath);
      if (!st) {
        issues.push({
          severity: "high",
          kind: "entry-doc-missing",
          message: `入口文档 \`${cu.entryDoc}\` 在目录里找不到`,
        });
      } else {
        try { docText = await fsp.readFile(docPath, "utf8"); }
        catch { /* 读失败当作没读到 */ }
      }
    }

    // ② 文档提到的文件 vs 目录里实际有的（核心检查）
    let crossCheck = null;
    if (docText) {
      const mentioned = extractFileRefs(docText);
      if (mentioned.length) {
        // 递归收集目录里的文件名（只取 basename，用于匹配）
        const present = [];
        async function collect(dir) {
          let ents = [];
          try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const full = path.join(dir, e.name);
            if (await isLink(full)) { present.push(e.name); continue; }
            if (e.isDirectory()) await collect(full);
            else present.push(e.name);
          }
        }
        const st = await statSafe(cu.path);
        if (st && st.isDirectory()) await collect(cu.path);
        else if (st) present.push(path.basename(cu.path));

        crossCheck = crossCheckDocRefs(mentioned, present);

        if (crossCheck.missing.length) {
          issues.push({
            severity: crossCheck.coverage !== null && crossCheck.coverage < 0.5 ? "high" : "medium",
            kind: "doc-refs-missing",
            message:
              `文档里提到 ${crossCheck.mentioned} 个文件，目录里只找到 ${crossCheck.present.length} 个 —— ` +
              `**${crossCheck.missing.length} 个缺失**`,
            missing: crossCheck.missing,
            coverage: crossCheck.coverage,
          });
        }
      }
    }

    // ③ 没有导入指引
    if (!cu.importPrompt) {
      issues.push({
        severity: "low",
        kind: "no-import-prompt",
        message: "没有给恢复端的导入指引（importPrompt）—— AI 只能自己读文档猜",
      });
    }
    // ④ 没有验证方式
    if (!cu.verifyPrompt) {
      issues.push({
        severity: "low",
        kind: "no-verify-prompt",
        message: "没有给验证方式（verifyPrompt）—— 恢复后无法确认是否成功",
      });
    }
    // ⑤ 数据不在包里
    if (!cu.includeData) {
      issues.push({
        severity: "info",
        kind: "data-not-included",
        message: "数据不在包内（只记说明）—— 恢复时需另找；确认这是有意的",
      });
    }

    reports.push({
      id: cu.id,
      label: cu.label,
      path: cu.path.replace(/\\/g, "/"),
      crossCheck,
      issues,
      ok: !issues.some((i) => i.severity === "high"),
    });
  }

  return reports;
}

/**
 * 自动检查 —— **机器能验的部分，绝不留到恢复端才发现**。
 *
 * 每条返回 `{ name, ok, detail }`，直接进 RESTORE_REHEARSAL.md 的表格。
 * 只做**确定性**检查（存在性 / 大小 / sha 格式），不做任何推测。
 */
function runAutoChecks(manifest, stagingDir, redactions) {
  const checks = [];
  const items = manifest.items || [];
  const customs = manifest.customItems || [];

  // ① 包内文件是否都在
  let missing = [];
  for (const it of items) {
    const p = path.join(stagingDir, "data", it.relPath);
    if (!fs.existsSync(p)) missing.push(it.relPath);
  }
  checks.push({
    name: "内置条目文件齐全",
    ok: missing.length === 0,
    detail: missing.length
      ? `${missing.length} 个文件缺失（如 ${missing.slice(0, 3).join("、")}）`
      : `${items.length} 个文件全部在包内`,
  });

  // ② sha256 是否都算出来了（空串 = 当时读失败）
  const noSha = items.filter((it) => !it.sha256).map((it) => it.relPath);
  checks.push({
    name: "每个文件都有 sha256",
    ok: noSha.length === 0,
    detail: noSha.length
      ? `${noSha.length} 个文件算不出 hash（如 ${noSha.slice(0, 3).join("、")}）`
      : "全部可校验",
  });

  // ③ 空文件 / 零字节（往往意味着源文件当时是空的或读失败）
  const empty = items.filter((it) => it.size === 0).map((it) => it.relPath);
  checks.push({
    name: "没有零字节文件",
    ok: empty.length === 0,
    detail: empty.length
      ? `${empty.length} 个 0 字节文件（如 ${empty.slice(0, 3).join("、")}）—— 确认源文件本来就是这样`
      : "无",
  });

  // ④ 自定义项的入口文档是否真的存在（最常见的一类"备份了但恢复不了"）
  const badEntry = [];
  for (const c of customs) {
    if (!c.entryDoc) {
      badEntry.push(`${c.label}（未指定入口文档）`);
      continue;
    }
    if (c.dataIncluded) {
      // 带数据：包内必须有这个文件
      const p = path.join(stagingDir, c.bundledPath, c.entryDoc);
      if (!fs.existsSync(p)) badEntry.push(`${c.label}（包内找不到 ${c.entryDoc}）`);
    } else {
      // 不带数据：源目录里当时有没有
      const p = path.join(c.sourceAbsPath, c.entryDoc);
      if (!fs.existsSync(p)) badEntry.push(`${c.label}（源目录里找不到 ${c.entryDoc}）`);
    }
  }
  checks.push({
    name: "自定义项入口文档存在",
    ok: badEntry.length === 0,
    detail: badEntry.length ? badEntry.join("；") : customs.length ? "全部可读" : "无自定义项",
  });

  // ④b 文档里提到的文件是否都在（**用户方案自己可能不全**）
  const docGaps = [];
  for (const a of (manifest.customAudit || [])) {
    const cc = a.crossCheck;
    if (cc && cc.missing && cc.missing.length) {
      docGaps.push(
        `${a.label}：文档提到 ${cc.mentioned} 个文件，缺 ${cc.missing.length} 个` +
        `（${cc.missing.slice(0, 4).join("、")}${cc.missing.length > 4 ? "…" : ""}）`,
      );
    }
  }
  checks.push({
    name: "自定义项文档引用的文件都在",
    ok: docGaps.length === 0,
    detail: docGaps.length
      ? docGaps.join("；")
      : (manifest.customAudit || []).length
        ? "文档提到的文件都能对上"
        : "无自定义项",
  });

  // ⑤ 数据不在包里的自定义项 —— **不是错误，但必须让 AI 看见**
  const noData = customs.filter((c) => !c.dataIncluded);
  checks.push({
    name: "自定义项数据是否在包内",
    ok: true, // 不算失败：这是有意的设计
    detail: customs.length === 0
      ? "无自定义项"
      : noData.length === 0
        ? `全部 ${customs.length} 个都带数据`
        : `${noData.length}/${customs.length} 个**只记说明不带数据**（恢复时需另找）`,
  });

  // ⑥ 凭据剥离记录
  checks.push({
    name: "凭据处理已记录",
    ok: true,
    detail: redactions && redactions.length
      ? `${redactions.length} 处已剥离（恢复后需用户重配）`
      : "本包未包含需要剥离的内容",
  });

  return checks;
}

// ══════════════════════════════════════════════════════════════
// 自定义项（custom items）—— 开放世界扩展点
// ══════════════════════════════════════════════════════════════
//
// 有些东西插件无法枚举：用户自己的一套迁移方案（手册 + 脚本 + 知识库）、
// 私有数据库、云服务、加密文件……它们的**逻辑只存在于用户和用户自己的 AI 之间**。
//
// 插件**不解析**这些内容，只做三件事：
//   ① 原样打包目录（`custom/<id>/...`）
//   ② 在 manifest 里记录它是什么、怎么导入、怎么验证
//   ③ **自动算出它与内置分类的重叠**，让导入端 AI 知道"这些文件内置项也会恢复"
//
// 剩下的（要不要覆盖、按什么顺序、能不能跳过）**交给 AI 与用户决策** ——
// 我们只提供框架和事实，不做判断。
//
// ⚠️ 自定义项**不走凭据黑名单**：那是用户自己的目录、自己的规则，
// 用户显式选择导出即视为知情。我们只负责把 `NEVER_EXPORT` 覆盖不到的
// "内置采集范围"守住。

/**
 * 规范化一个自定义项请求（来自面板或 MCP）。
 *
 * @param {unknown} raw
 * @returns {{id,label,path,entryDoc,notes,importPrompt,verifyPrompt}|null}
 */
function normalizeCustomItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const p = typeof r.path === "string" ? r.path.trim() : "";
  if (!p) return null;
  const absPath = path.resolve(p);
  // id：优先用给的；否则**从目录名**派生（不是从 label —— 中文 label 经
  // sanitizePath 会变成一串横杠 `X--------`，在包内路径里毫无辨识度）。
  // 包内目录名必须安全（只含字母数字与 `-_.`）。
  const rawId = typeof r.id === "string" && r.id.trim()
    ? r.id.trim()
    : sanitizePath(path.basename(absPath));
  // 目录名本身若全是横杠（纯中文目录名），退回一个稳定短名
  let id = rawId.replace(/^-+|-+$/g, "").slice(0, 64);
  if (!id) id = `custom-${simpleHash(absPath).slice(0, 6)}`;
  const label = typeof r.label === "string" && r.label.trim()
    ? r.label.trim().slice(0, 200)
    : path.basename(absPath);
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
  return {
    id,
    label,
    path: absPath,
    entryDoc: str(r.entryDoc, 300),
    notes: str(r.notes, 1000),
    importPrompt: str(r.importPrompt, 4000),
    verifyPrompt: str(r.verifyPrompt, 4000),
    // 默认**不带数据** —— 用户方案通常自己备份；我们不重复、也不越权。
    includeData: r.includeData === true,
  };
}

/**
 * 重叠检测（**纯函数**，便于单测）。
 *
 * 拿自定义项收集到的绝对路径集合，与每个内置分类的路径集合求交 ——
 * 让导入端 AI 知道"那些文件内置项也会恢复"，从而**先问用户**再决定覆盖与否。
 *
 * @param {Array<{id:string, paths:Set<string>}>} customPaths  每个自定义项的路径集合
 * @param {Array<{id:string, label:string, paths:Set<string>}>} builtinPaths 内置分类
 * @returns {Array<{customId:string, overlaps:Array<{category,label,shared:number,sample:string[]}>}>}
 */
function detectOverlaps(customPaths, builtinPaths) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const out = [];
  for (const c of customPaths) {
    const cSet = new Set([...c.paths].map(norm));
    const hits = [];
    for (const b of builtinPaths) {
      const shared = [];
      for (const p of b.paths) {
        if (cSet.has(norm(p))) shared.push(p);
      }
      if (shared.length) {
        hits.push({
          category: b.id,
          label: b.label,
          shared: shared.length,
          sample: shared.slice(0, 5).map((p) => path.basename(p)),
        });
      }
    }
    out.push({ customId: c.id, overlaps: hits });
  }
  return out;
}

/**
 * 包内逻辑路径 → 恢复目标（导入端用；这里只写规则，不执行）。
 *
 * ⚠️ `workspaces/<slug>/...` 的 slug **只是包内用来区分工作区的目录名**，
 * 不是恢复目标的一部分 —— 恢复时目标是 `<workspace>/.claude/<相对部分>`，
 * 具体是哪个工作区由导入端根据 `manifest.source.workspaces` 里的
 * `{slug, absPath}` 映射决定。
 */
function restoreTargetFor(rel) {
  if (rel.startsWith("claude/")) return `~/.claude/${rel.slice("claude/".length)}`;
  if (rel.startsWith("agents/")) return `~/.${rel.slice("agents/".length)}`; // ~/.agents/skills/...
  if (rel.startsWith("gui/")) return `%APPDATA%/com.claudecode.gui/${rel.slice("gui/".length)}`;
  if (rel.startsWith("workspaces/")) {
    // 剥掉 "workspaces/<slug>/" 两段
    const parts = rel.split("/");
    return `<workspace>/.claude/${parts.slice(2).join("/")}`;
  }
  return rel;
}

/** 恢复时的建议策略（导入端可覆盖） */
function restoreModeFor(rel) {
  if (rel.endsWith("settings.json")) return "merge";
  if (rel.endsWith("CLAUDE.md")) return "append";
  if (rel.includes("/memory/")) return "manual"; // 记忆冲突需 AI 语义判断
  if (rel.endsWith("data.db")) return "manual";  // 桌面/笔记需人工或 AI 决定
  if (rel.endsWith(".jsonl")) return "overwrite";
  return "overwrite";
}

// ══════════════════════════════════════════════════════════════
// MCP 工具
// ══════════════════════════════════════════════════════════════

async function handleMcpTool(tool, args) {
  if (tool === "list_exportable") {
    const { categories, workspaces } = await scanAll();
    return {
      ok: true,
      categories,
      workspaces: workspaces.map((w) => ({ slug: sanitizePath(w.absPath), name: w.name })),
      totalSize: categories.reduce((a, c) => a + c.size, 0),
    };
  }
  if (tool === "audit_custom_item") {
    const cu = normalizeCustomItem({ path: args.path, entryDoc: args.entryDoc });
    if (!cu) return { ok: false, error: "需要 path" };
    const reports = await auditCustomItems([cu]);
    const rep = reports[0];
    // ⚠️ `ok` 表示"这次调用成功了"，**不是**"这份方案没问题"。
    // 两者混一起会让 AI 以为工具出错（2026-10-25 实测踩到）。
    // 「方案能不能导」看 `clean`。
    return {
      ok: true,
      clean: rep.ok,
      item: rep,
      hint:
        rep.ok
          ? "没有阻断级问题。可以把这份方案作为自定义项传给 export_profile。"
          : "**调用成功，但这份方案有 high 级问题，先别导出。** 把 missing 清单如实告诉用户：" +
            "① 那些文件是不是在别的目录（用户方案的脚本常散落多处）？" +
            "② 还是根本没备份过？③ 或者只是文档里的举例名？" +
            "用户确认「就这些」后再导出（缺失会记进包里，恢复端也能看到）。",
    };
  }

  if (tool === "inspect_package") {
    return inspectPackage(args.path);
  }

  if (tool === "export_profile") {
    return doExport(args);
  }
  return { ok: false, error: `unknown tool: ${tool}` };
}

// ══════════════════════════════════════════════════════════════
// HTTP
// ══════════════════════════════════════════════════════════════

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    // 🔴 **必须带 CORS 头**（2026-10-25 实测："扫描失败: Failed to fetch"）。
    // 面板 iframe 的源是 `plugins.localhost`（或 `plugins://localhost`），
    // 而本进程在 `127.0.0.1:<port>` —— **跨源**。没有这个头，浏览器会拦掉响应，
    // 面板侧只看到 `Failed to fetch`（看不出真正原因）。
    // 同 `git-viewer` 的做法（`Access-Control-Allow-Origin: *`）。
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const u = new URL(req.url, "http://localhost");

  // CORS 预检：面板的 POST（JSON body）会先发一个 OPTIONS。
  // 不处理的话浏览器直接判定跨源失败 → 面板看到 "Failed to fetch"。
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    });
    return res.end();
  }

  switch (u.pathname) {
    case "/__mcp": {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      let body;
      try { body = JSON.parse((await readBody(req)) || "{}"); }
      catch { return json(res, 200, { ok: false, error: "invalid JSON" }); }
      try {
        return json(res, 200, await handleMcpTool(body.tool, body.args || {}));
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    }

    // 面板用：扫描分类
    case "/api/scan": {
      try { return json(res, 200, await scanAll()); }
      catch (e) { return json(res, 500, { ok: false, error: String(e && e.message || e) }); }
    }

    // 面板用：**读一个现有的备份包**（恢复入口的第一步）
    //
    // 用户点「恢复」→ 选一个 .tar.gz → 这里解析出它的 manifest 摘要。
    // 目的是让用户在**交给 AI 之前**先看到"这是什么包、有多老、含什么"，
    // 避免选错包。
    case "/api/inspect-package": {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* 空 */ }
      const pkg = typeof body.path === "string" ? body.path.trim() : "";
      if (!pkg) return json(res, 400, { ok: false, error: "缺少 path" });
      try {
        return json(res, 200, await inspectPackage(pkg));
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }

    // 面板用：**导出前**体检自定义项（body: { customItems: [...] })
    //
    // 目的：用户的方案文档自己就可能不全（提到的脚本不在目录里）。
    // 在打包**之前**把问题摊出来，让他决定"要不要补"，
    // 而不是等换机器时才发现备份残缺。
    case "/api/audit-custom": {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* 空 */ }
      const raw = Array.isArray(body.customItems) ? body.customItems : [];
      const customs = raw.map(normalizeCustomItem).filter(Boolean);
      if (!customs.length) return json(res, 200, { ok: true, reports: [] });
      try {
        const reports = await auditCustomItems(customs);
        return json(res, 200, {
          ok: true,
          reports,
          hasBlocking: reports.some((r) => r.issues.some((i) => i.severity === "high")),
          hint:
            "把 high 级问题如实告诉用户，问他：这份文档提到的东西是不是**真的不在**该目录？" +
            "如果是 → 建议补齐（或勾「带数据」），否则换机器时恢复不了。" +
            "用户确认「就这些」也可以继续导出 —— 但要在报告里记下这个决定。",
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }

    // 面板用：执行导出（body: { categories?: string[], outputPath?: string })
    case "/api/export": {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* 默认全量 */ }
      try { return json(res, 200, await doExport(body)); }
      catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    }

    case "/api/health":
      return json(res, 200, { ok: true, workspace: WORKSPACE });

    default:
      return json(res, 404, { ok: false, error: "not found" });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { json(res, 500, { ok: false, error: String(e && e.message || e) }); } catch { /* sent */ }
  });
});

function listen(port) {
  server.listen(port, "127.0.0.1", () => {
    // ⚠️ 这是**唯一**允许写 stdout 的一行（宿主据此发现端口）
    console.log("PLUGIN_PORT=" + port);
  });
}

// ⚠️ **只在被直接执行时启动服务器**。被 `require()`（单测）时不监听端口 ——
// 否则跑单测会占端口、还会往 stdout 打 PLUGIN_PORT。
if (require.main === module) {
  const envPort = parseInt(process.env.CLAUDE_PLUGIN_PORT || "", 10);
  if (Number.isFinite(envPort) && envPort > 0) {
    listen(envPort);
  } else {
    // 随机端口：让 OS 分配后再回报
    server.listen(0, "127.0.0.1", () => {
      console.log("PLUGIN_PORT=" + server.address().port);
    });
  }
}

// 导出给单测（纯函数 + 分类定义）
module.exports = {
  sanitizePath, simpleHash, stripEnv, isNeverExport, shouldSkip,
  restoreTargetFor, restoreModeFor, resolveSelection, tsStamp,
  categoryDefs, NEVER_EXPORT, doExport, scanAll,
  normalizeCustomItem, detectOverlaps, buildImportGuide,
  extractFileRefs, crossCheckDocRefs, auditCustomItems, inspectPackage,
  runAutoChecks, buildRehearsal,
};
