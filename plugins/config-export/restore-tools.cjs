#!/usr/bin/env node
// ── restore-tools.cjs ──
// 恢复期的常用操作 —— **随包分发**，供恢复端 AI 直接调用，不必临场写脚本。
//
// ## 为什么要有它
//
// 恢复时 AI 会反复写同一类临时脚本：解包、比对、算 hash、比较两个 jsonl 的差异……
// 每次写法还不一样（一次用 `tar -xzf`、一次用 node，路径处理各错各的）。
// 把**固定套路**固化成带参数的命令，AI 只需调用、读 JSON 结果。
//
// ## 用法
//
//   node tools/restore-tools.cjs <command> [args]
//
//   list        <pkg>                       列出包内条目（分类/文件数/大小）
//   verify      <pkg> [--dest <dir>]        校验包完整性；给 --dest 则比对已恢复的文件
//   compare     <pkg> --dest <dir>          对比包内文件与目标位置（存在/缺失/不同）
//   rate        <pkg> --dest <dir>          算恢复率（见下「恢复率怎么算」）
//   session-diff <a.jsonl> <b.jsonl>        比较两个会话文件的差异（按 uuid）
//   session-merge <base> <other> -o <out>   按 uuid 合并两个会话（自动备份原文件）
//   json-merge  <base.json> <other.json>    预览两个 JSON 的按键合并结果（不写盘）
//   extract     <pkg> --dest <dir>          解包到目标目录
//
// ## 恢复率怎么算（**这是本文件最重要的约定**）
//
// **不拍一个数字交差。** 按 `restore.mode` 分成三类，分别统计：
//
//   · **精确验证**（overwrite：整份替换）
//       最硬的标准 —— **sha256 逐字节一致**才算。不一致就是不一致。
//   · **部分验证**（merge / append：合并/追加）
//       合并后内容必然和包里不同，**不能**比 sha256。
//       只能验"目标存在 + 关键标记在" → 记为"部分验证"，不算满分别。
//   · **无法自动验证**（manual：记忆 / 桌面数据库 / 自定义项数据）
//       **没有客观标准** —— 谁也不能自动判断"记忆合并得对不对"。
//       如实列为"需人工确认"，**不计入百分比**（计进去就是假精确）。
//
// 于是输出**两个数**，不要合成一个：
//
//   自动验证通过率 = 通过验证的文件 / 可自动验证的文件
//   整体覆盖率     = (精确验证 + 部分验证) / 全部文件
//
// 前者回答"能验的都验过了吗"，后者回答"还差多少要人看"。
// 合并成一个数会掩盖"55 个记忆文件根本没验"这个事实。
//
// 全部输出 JSON（AI 好解析），人读也看得懂。

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// ══════════════════════════════════════════════════════════════
// 基础
// ══════════════════════════════════════════════════════════════

/**
 * 跑 tar。
 *
 * ⚠️ **Windows 上 `-C` 与 `--force-local` 不能同时用绝对路径**（2026-10-25 实测）：
 *   · 不加 `--force-local` → GNU tar 把 `C:\...` 当远程主机名（`Cannot connect to C:`）
 *   · 加了 `--force-local` → 它又把 `C:` 当**盘符语法**转义成 `C\:\\...` → 路径不存在
 *
 * 解法：**切换到目标目录再执行**，让所有路径参数都变成相对名。
 * 这样两个坑都绕开。
 */
function runTar(args, cwd) {
  return execFileSync("tar", ["--force-local", ...args], {
    encoding: "utf8",
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * 解包到 destDir。
 *
 * 🔴 **纯 Node，不调系统 tar**（2026-10-26）。
 *
 * 之前用 `tar --force-local -xzf`，但 Windows 上 PATH 里可能是
 * `C:\WINDOWS\system32\tar.exe`（bsdtar），它**不支持 `--force-local`**
 * → 直接退出、什么都不解，返回码 1 还被我们当成了"警告"。
 * 导出端已经因此被坑了三次，恢复端没理由再赌一次环境。
 *
 * `tar-writer.cjs` 随包分发（`tools/tar-writer.cjs`），纯 Node 实现。
 */
async function extractTo(pkgAbs, destDir) {
  return require("./tar-writer.cjs").extractArchive(pkgAbs, destDir);
}

/** 报错并退出。**也写 stdout** —— 调用方（AI / 脚本）通常只解析 stdout，
 *  写 stderr 会让它们拿到空输出、误以为"命令没返回"。 */
function die(msg, code = 1) {
  const payload = JSON.stringify({ ok: false, error: msg }, null, 2);
  console.log(payload);
  process.stderr.write(payload + "\n");
  process.exit(code);
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

/** 读包内某个文本文件（纯 Node，不调系统 tar） */
async function readFromPkg(pkg, entry) {
  try {
    return await require("./tar-writer.cjs").readEntry(pkg, entry);
  } catch {
    return null;
  }
}

async function readManifest(pkg) {
  const raw = await readFromPkg(pkg, "manifest.json");
  if (!raw) die(`包里没有 manifest.json（是不是选错文件了？）：${pkg}`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`manifest.json 解析失败：${e.message}`);
  }
}

function argOf(argv, name, def = undefined) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  return argv[i + 1] ?? def;
}

function posArgs(argv) {
  const flags = new Set(["--dest", "-o", "--name"]);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (flags.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith("-")) continue;
    out.push(argv[i]);
  }
  return out;
}

function sha256File(p) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

const expandHome = (p) =>
  p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

// ══════════════════════════════════════════════════════════════
// 恢复率模型（纯函数，可单测）
// ══════════════════════════════════════════════════════════════

/**
 * 一个条目的"可验证级别"。
 *
 * @param {string} mode  restore.mode
 * @returns {"exact"|"partial"|"unverifiable"}
 */
function verifiabilityOf(mode) {
  switch (mode) {
    case "overwrite":
      return "exact";       // 整份替换 → sha256 必须一致
    case "merge":
    case "append":
      return "partial";     // 合并/追加 → 内容会变，只能验"存在 + 标记"
    case "manual":
    default:
      return "unverifiable"; // 记忆/数据库 → 没有客观标准
  }
}

/**
 * 算恢复率 —— **两个数，不合成一个**（见文件头）。
 *
 * @param {Array<{mode:string, verified:"pass"|"fail"|"skipped"}>} results
 * @returns {{exact:{pass,fail,total}, partial:{...}, unverifiable:{total}, autoPassRate:number|null, overallCoverage:number|null, note:string}}
 */
function computeRecoveryRate(results) {
  const bucket = {
    exact: { pass: 0, fail: 0, total: 0 },
    partial: { pass: 0, fail: 0, total: 0 },
    unverifiable: { total: 0 },
  };

  for (const r of results) {
    const level = verifiabilityOf(r.mode);
    if (level === "unverifiable") {
      bucket.unverifiable.total++;
      continue;
    }
    bucket[level].total++;
    if (r.verified === "pass") bucket[level].pass++;
    else if (r.verified === "fail") bucket[level].fail++;
  }

  // 自动验证通过率：只算能自动验的
  const autoTotal = bucket.exact.total + bucket.partial.total;
  const autoPass = bucket.exact.pass + bucket.partial.pass;
  const autoPassRate = autoTotal > 0 ? autoPass / autoTotal : null;

  // 整体覆盖率：算上无法验证的（它们不算"已验证"，拉低覆盖）
  const allTotal = autoTotal + bucket.unverifiable.total;
  const overallCoverage = allTotal > 0 ? autoPass / allTotal : null;

  // 诚实说明：两个数的差别就是"还有多少要人看"
  let note;
  if (allTotal === 0) {
    note = "包里没有可恢复的条目";
  } else if (bucket.unverifiable.total === 0) {
    note = "全部条目都可自动验证";
  } else {
    note = `另有 ${bucket.unverifiable.total} 个条目**无法自动验证**（记忆/数据库/自定义项）` +
      `—— 它们没有客观标准，必须由用户确认后自行判断。` +
      `「自动验证通过率」不含它们；「整体覆盖率」把未确认的算作未覆盖。`;
  }

  return {
    exact: bucket.exact,
    partial: bucket.partial,
    unverifiable: bucket.unverifiable,
    autoPassRate,
    overallCoverage,
    note,
  };
}

// ══════════════════════════════════════════════════════════════
// 命令实现
// ══════════════════════════════════════════════════════════════

async function cmdList(argv) {
  const [pkg] = posArgs(argv);
  if (!pkg) die("用法：list <包路径>");
  const mf = await readManifest(pkg);

  const byCat = {};
  for (const it of mf.items || []) {
    byCat[it.category] = byCat[it.category] || { files: 0, bytes: 0 };
    byCat[it.category].files++;
    byCat[it.category].bytes += it.size || 0;
  }

  out({
    ok: true,
    package: path.resolve(pkg),
    version: mf.formatVersion,
    exportedAt: mf.exportedAt,
    from: mf.source && mf.source.hostname,
    formatVersion: mf.formatVersion,
    totals: {
      files: (mf.items || []).length,
      bytes: (mf.items || []).reduce((a, i) => a + (i.size || 0), 0),
      customItems: (mf.customItems || []).length,
    },
    categories: Object.entries(byCat).map(([id, v]) => ({ id, ...v })),
    customItems: (mf.customItems || []).map((c) => ({
      id: c.id,
      label: c.label,
      entryDoc: c.entryDoc,
      dataIncluded: !!c.dataIncluded,
      fileCount: c.fileCount,
      overlaps: (c.overlaps || []).map((o) => `${o.category}(${o.shared})`),
    })),
    redactions: mf.redactions || [],
    // 把"该怎么恢复"的指引直接带出来，省得 AI 再翻 manifest
    nextSteps: [
      "1. 先跑 verify 看包是否完整",
      "2. 恢复前**评估新机器现状**（见包内 IMPORT_GUIDE.md 第 0 步）",
      "3. 逐个恢复，冲突按内容类型分别处理",
      "4. 恢复后跑 rate 算恢复率，出报告",
    ],
  });
}

async function cmdVerify(argv) {
  const [pkg] = posArgs(argv);
  const dest = argOf(argv, "--dest");
  if (!pkg) die("用法：verify <包路径> [--dest <已恢复目录>]");
  const mf = await readManifest(pkg);

  // 解到临时目录校验（不碰 dest）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-verify-"));
  try {
    await extractTo(path.resolve(pkg), tmp);

    const results = [];
    for (const it of mf.items || []) {
      const inPkg = path.join(tmp, "data", it.relPath);
      const exists = fs.existsSync(inPkg);
      const actual = exists ? sha256File(inPkg) : null;
      const ok = exists && (!it.sha256 || actual === it.sha256);
      results.push({
        relPath: it.relPath,
        category: it.category,
        mode: it.restore && it.restore.mode,
        target: it.restore && it.restore.target,
        packageSha: it.sha256,
        packageOk: ok,
        // 若给了 dest，顺带比对目标位置
        dest: dest ? checkDest(it, dest) : undefined,
      });
    }

    const bad = results.filter((r) => !r.packageOk);
    out({
      ok: bad.length === 0,
      packageIntact: bad.length === 0,
      checked: results.length,
      failed: bad.length,
      failures: bad.slice(0, 20),
      failuresTruncated: bad.length > 20 ? bad.length - 20 : 0,
      note: bad.length
        ? "包本身损坏或不完整 —— 重新导出，别拿这个包恢复"
        : "包完整，每个文件的 sha256 与 manifest 一致",
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 检查某个条目在 dest 下的状态（用于 --dest 模式） */
function checkDest(it, destRoot) {
  const target = it.restore && it.restore.target;
  if (!target) return { status: "unknown" };
  const level = verifiabilityOf(it.restore.mode);

  // 把 restore.target 的占位符换成实际路径
  const real = resolveTarget(target, destRoot);
  if (!real) return { status: "unresolvable", target };

  const exists = fs.existsSync(real);
  if (!exists) return { status: "missing", path: real };

  const actual = sha256File(real);
  if (level === "exact") {
    return {
      status: actual === it.sha256 ? "identical" : "different",
      path: real,
      actualSha: actual,
      expectedSha: it.sha256,
    };
  }
  // 合并/追加型：内容必然不同，只能验存在
  return { status: "exists", path: real, note: "合并型，内容预期不同（无法用 sha 比对）" };
}

/** 把 `~/.claude/x` / `<workspace>/.claude/x` / `%APPDATA%/...` 解析成真实路径 */
function resolveTarget(target, destRoot) {
  let t = target;
  if (t.startsWith("~/.claude/")) {
    return path.join(destRoot, ".claude", t.slice("~/.claude/".length));
  }
  if (t.startsWith("~/.agents/")) {
    return path.join(destRoot, ".agents", t.slice("~/.agents/".length));
  }
  if (t.startsWith("%APPDATA%/com.claudecode.gui/")) {
    return path.join(destRoot, "AppData", "Roaming", "com.claudecode.gui",
      t.slice("%APPDATA%/com.claudecode.gui/".length));
  }
  if (t.startsWith("<workspace>/.claude/")) {
    return path.join(destRoot, "workspace", ".claude", t.slice("<workspace>/.claude/".length));
  }
  return null;
}

async function cmdCompare(argv) {
  const [pkg] = posArgs(argv);
  const dest = argOf(argv, "--dest");
  if (!pkg || !dest) die("用法：compare <包路径> --dest <目标根目录>");
  const mf = await readManifest(pkg);

  const rows = (mf.items || []).map((it) => {
    const d = checkDest(it, dest);
    return {
      relPath: it.relPath,
      category: it.category,
      mode: it.restore && it.restore.mode,
      ...d,
    };
  });

  const count = (s) => rows.filter((r) => r.status === s).length;
  out({
    ok: true,
    target: path.resolve(dest),
    summary: {
      missing: count("missing"),
      identical: count("identical"),
      different: count("different"),
      exists: count("exists"),
      unresolvable: count("unresolvable"),
    },
    // 分组给处理建议 —— 这是 AI 下一步要用的
    actions: {
      missing: rows.filter((r) => r.status === "missing").map((r) => r.relPath),
      different: rows.filter((r) => r.status === "different").map((r) => r.relPath),
      unresolvable: rows.filter((r) => r.status === "unresolvable").map((r) => r.relPath),
    },
    hint:
      "missing = 新机器没有，可直接放入；" +
      "different = 两边都有但内容不同，**先问用户**；" +
      "exists = 合并型，需按类型判断（见 IMPORT_GUIDE 冲突表）；" +
      "unresolvable = 路径占位符没识别，需要你手动确定目标位置",
  });
}

async function cmdRate(argv) {
  const [pkg] = posArgs(argv);
  const dest = argOf(argv, "--dest");
  if (!pkg || !dest) die("用法：rate <包路径> --dest <目标根目录>");
  const mf = await readManifest(pkg);

  const results = [];
  const detail = [];
  for (const it of mf.items || []) {
    const mode = (it.restore && it.restore.mode) || "overwrite";
    const level = verifiabilityOf(mode);
    const d = checkDest(it, dest);

    let verified;
    if (level === "unverifiable") {
      verified = "skipped"; // 无法自动验证
    } else if (d.status === "identical" || d.status === "exists") {
      verified = "pass";
    } else {
      verified = "fail";
    }
    results.push({ mode, verified });
    detail.push({
      relPath: it.relPath,
      mode,
      level,
      status: d.status,
      verified,
    });
  }

  const rate = computeRecoveryRate(results);

  // 自定义项单独列（它们的"恢复"靠 AI 判断，不能算进百分比）
  const customs = (mf.customItems || []).map((c) => ({
    label: c.label,
    dataIncluded: !!c.dataIncluded,
    status: "需人工确认",
    entryDoc: c.entryDoc,
  }));

  out({
    ok: true,
    target: path.resolve(dest),
    recovery: {
      // 两个数，别合成
      autoPassRate: rate.autoPassRate,
      autoPassPercent: rate.autoPassRate == null ? null : Math.round(rate.autoPassRate * 1000) / 10,
      overallCoverage: rate.overallCoverage,
      overallPercent: rate.overallCoverage == null ? null : Math.round(rate.overallCoverage * 1000) / 10,
      breakdown: {
        exact: rate.exact,        // 精确验证（sha256 一致）
        partial: rate.partial,    // 部分验证（合并型，只能验存在）
        unverifiable: rate.unverifiable, // 需人工确认
      },
      note: rate.note,
    },
    customItems: customs,
    failures: detail.filter((d) => d.verified === "fail"),
    hint:
      "**报告时两个数都要说，不要只报一个。**" +
      "「自动验证通过率」回答『能验的都验过了吗』；" +
      "「整体覆盖率」回答『还有多少要人看』。" +
      "合并成一个数会掩盖『记忆文件根本没验』这个事实。",
  });
}

async function cmdExtract(argv) {
  const [pkg] = posArgs(argv);
  const dest = argOf(argv, "--dest");
  if (!pkg || !dest) die("用法：extract <包路径> --dest <目录>");
  const r = await extractTo(path.resolve(pkg), path.resolve(dest));
  out({
    ok: true,
    extractedTo: path.resolve(dest),
    files: r.files,
    dirs: r.dirs,
    note: "解包完成，但**没有**放到任何目标位置 —— 恢复要按 IMPORT_GUIDE 走",
  });
}

// ── 会话相关 ──

function readJsonl(p) {
  const lines = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  return lines.map((l, i) => {
    let o = null;
    try { o = JSON.parse(l); } catch { /* 保留原文 */ }
    return { line: l, obj: o, index: i };
  });
}

function cmdSessionDiff(argv) {
  const [a, b] = posArgs(argv);
  if (!a || !b) die("用法：session-diff <a.jsonl> <b.jsonl>");
  const A = readJsonl(a);
  const B = readJsonl(b);

  const uuidOf = (e) => (e.obj && e.obj.uuid) || null;
  const mapA = new Map();
  const mapB = new Map();
  for (const e of A) { const u = uuidOf(e); if (u) mapA.set(u, e.line); }
  for (const e of B) { const u = uuidOf(e); if (u) mapB.set(u, e.line); }

  const onlyA = [...mapA.keys()].filter((u) => !mapB.has(u));
  const onlyB = [...mapB.keys()].filter((u) => !mapA.has(u));
  // 同 uuid 但内容不同 = 真冲突
  const conflicting = [...mapA.keys()].filter((u) => mapB.has(u) && mapA.get(u) !== mapB.get(u));

  out({
    ok: true,
    a: { path: a, lines: A.length, uuids: mapA.size },
    b: { path: b, lines: B.length, uuids: mapB.size },
    onlyInA: { count: onlyA.length, sample: onlyA.slice(0, 5) },
    onlyInB: { count: onlyB.length, sample: onlyB.slice(0, 5) },
    conflicting: {
      count: conflicting.length,
      sample: conflicting.slice(0, 5),
      note: conflicting.length
        ? "⚠️ 同一 uuid 但内容不同 —— **这是真冲突，必须问用户哪边是对的**"
        : "无同 uuid 内容冲突",
    },
    hint:
      onlyA.length || onlyB.length
        ? "两边有对方没有的轮次 → 可以按 uuid 合并（见 session-merge）"
        : "两边 uuid 集合一致",
  });
}

function cmdSessionMerge(argv) {
  const pos = posArgs(argv);
  const [base, other] = pos;
  const outPath = argOf(argv, "-o");
  if (!base || !other || !outPath) die("用法：session-merge <base> <other> -o <输出>");

  const A = readJsonl(base);
  const B = readJsonl(other);
  const uuidOf = (e) => (e.obj && e.obj.uuid) || null;

  const seen = new Map(); // uuid → line
  const order = [];       // 保持出现顺序
  const conflicts = [];

  for (const e of A) {
    const u = uuidOf(e);
    if (u && seen.has(u)) continue;
    if (u) seen.set(u, e.line);
    order.push({ key: u || `idx:${e.index}`, line: e.line, obj: e.obj });
  }
  for (const e of B) {
    const u = uuidOf(e);
    if (u && seen.has(u)) {
      if (seen.get(u) !== e.line) conflicts.push(u);
      continue;
    }
    if (u) seen.set(u, e.line);
    order.push({ key: u || `idx:${e.index}`, line: e.line, obj: e.obj });
  }

  if (conflicts.length) {
    out({
      ok: false,
      error: "存在同 uuid 但内容不同的消息，**不能自动合并**",
      conflicts: { count: conflicts.length, sample: conflicts.slice(0, 10) },
      hint: "先跑 session-diff 看清楚，然后问用户哪边是对的",
    });
    process.exit(2);
  }

  // 按 timestamp 排序（没有就保持原序）
  const ts = (o) => (o && (o.timestamp || o.createdAt)) || null;
  const hasTs = order.every((x) => ts(x.obj));
  if (hasTs) {
    order.sort((x, y) => String(ts(x.obj)).localeCompare(String(ts(y.obj))));
  }

  // 备份现有输出文件
  const backups = [];
  if (fs.existsSync(outPath)) {
    const bak = `${outPath}.bak-${Date.now()}`;
    fs.copyFileSync(outPath, bak);
    backups.push(bak);
  }

  fs.writeFileSync(outPath, order.map((x) => x.line).join("\n") + "\n", "utf8");

  out({
    ok: true,
    output: path.resolve(outPath),
    merged: order.length,
    fromA: A.length,
    fromB: B.length,
    sortedByTimestamp: hasTs,
    backups,
    hint: hasTs ? "已按 timestamp 排序" : "缺 timestamp 字段，保持原顺序（可能需要人工检查顺序）",
  });
}

function cmdJsonMerge(argv) {
  const [a, b] = posArgs(argv);
  if (!a || !b) die("用法：json-merge <base.json> <other.json>");
  const A = JSON.parse(fs.readFileSync(a, "utf8"));
  const B = JSON.parse(fs.readFileSync(b, "utf8"));

  const added = [];
  const changed = [];
  const same = [];

  function walk(o, n, prefix) {
    for (const k of Object.keys(n)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (!(k in o)) { added.push({ key, value: n[k] }); continue; }
      const ov = o[k], nv = n[k];
      const bothObj = ov && typeof ov === "object" && !Array.isArray(ov) &&
        nv && typeof nv === "object" && !Array.isArray(nv);
      if (bothObj) { walk(ov, nv, key); continue; }
      if (JSON.stringify(ov) === JSON.stringify(nv)) { same.push(key); continue; }
      changed.push({ key, base: ov, other: nv });
    }
  }
  walk(A, B, "");

  out({
    ok: true,
    onlyInBase: Object.keys(A).filter((k) => !(k in B)),
    addedFromOther: added,
    changed: changed,
    unchanged: same.length,
    hint:
      "**这只是预览，没写盘。** " +
      "默认建议：以 base（新机器现有）为准，只补 addedFromOther 里缺的键；" +
      "changed 的项**问用户**。" +
      "注意 `env` 段永远不要从包里带过来（里面有凭据）。",
  });
}

// ══════════════════════════════════════════════════════════════
// 入口
// ══════════════════════════════════════════════════════════════

const COMMANDS = {
  list: cmdList,
  verify: cmdVerify,
  compare: cmdCompare,
  rate: cmdRate,
  extract: cmdExtract,
  "session-diff": cmdSessionDiff,
  "session-merge": cmdSessionMerge,
  "json-merge": cmdJsonMerge,
};

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    out({
      ok: true,
      usage: "node tools/restore-tools.cjs <command> [args]",
      commands: Object.keys(COMMANDS),
      note: "全部命令输出 JSON；出错时 exit code != 0 且 stdout 有 {ok:false,error}",
    });
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) die(`未知命令：${cmd}。可用：${Object.keys(COMMANDS).join(", ")}`);
  // 命令可能返回 Promise（extract / list / verify / compare / rate 都是 async）
  Promise.resolve()
    .then(() => fn(argv.slice(1)))
    .catch((e) => die(String((e && e.message) || e)));
}

if (require.main === module) main();

module.exports = {
  verifiabilityOf, computeRecoveryRate, resolveTarget, readFromPkg,
};
