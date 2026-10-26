// ── 自定义项：单个文件（不只是目录）──
//
// 用户反馈：「我以为只是添加一些文件就行，没想到需要添加的必须是一个目录」。
// 后端其实一直支持单文件（`normalizeCustomItem` 的 else 分支），
// 只是面板按钮写死了"添加目录"。这个文件锁住单文件的完整链路。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-sf-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.APPDATA;
process.env.CLAUDE_PLUGIN_WORKSPACE = "";

const m = require("./export-server.cjs");
const CLAUDE = path.join(HOME, ".claude");

function w(p, c) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c, "utf8");
}

test.before(() => w(path.join(CLAUDE, "CLAUDE.md"), "# 指令\n"));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function extract(out, entry) {
  const norm = entry.startsWith("./") ? entry : `./${entry}`;
  return execFileSync("tar", ["--force-local", "-xzf", out, "-O", norm], { encoding: "utf8" });
}

function listFiles(out, dir) {
  const EX = path.join(HOME, dir);
  fs.mkdirSync(EX, { recursive: true });
  execFileSync("tar", ["--force-local", "-xzf", out, "-C", EX]);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(EX, path.join(d, e.name))]);
  return walk(EX).map((p) => p.split(path.sep).join("/"));
}

test("单文件 + includeData：文件原样进包", async () => {
  const doc = path.join(HOME, "我的迁移说明.md");
  w(doc, "# 我的方案\n跑 backup.bat\n");

  const out = path.join(HOME, "a.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: doc, label: "我的迁移说明", entryDoc: "我的迁移说明.md", includeData: true }],
  });
  assert.strictEqual(r.ok, true);

  const files = listFiles(out, "ex-a");
  assert.ok(
    files.some((f) => f.includes("我的迁移说明")),
    `单文件应进包，实际包内容: ${files.filter((f) => f.includes("custom")).join(", ")}`,
  );

  const mf = JSON.parse(extract(out, "manifest.json"));
  assert.strictEqual(mf.customItems.length, 1);
  assert.strictEqual(mf.customItems[0].dataIncluded, true);
  assert.strictEqual(mf.customItems[0].fileCount, 1, "单文件就是 1 个文件");
});

test("单文件 + 不带数据：只记说明，文件本身不进包", async () => {
  const doc = path.join(HOME, "方案说明.md");
  w(doc, "# 说明\n");

  const out = path.join(HOME, "b.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: doc, label: "方案说明", entryDoc: "方案说明.md" }],
  });

  const files = listFiles(out, "ex-b");
  assert.ok(!files.some((f) => f.includes("方案说明")), "未要求带数据时不该进包");

  const mf = JSON.parse(extract(out, "manifest.json"));
  assert.strictEqual(mf.customItems[0].dataIncluded, false);
  assert.ok(mf.customItems[0].sourceAbsPath, "仍要留下原路径作为线索");
  assert.strictEqual(mf.customItems[0].fileCount, 1, "仍应统计规模");
});

test("纯自定义项导出（不选任何内置分类）也支持单文件", async () => {
  const doc = path.join(HOME, "only-file.md");
  w(doc, "x");
  const out = path.join(HOME, "c.tar.gz");
  const r = await m.doExport({
    categories: [],
    outputPath: out,
    customItems: [{ path: doc, label: "只有这个文件" }],
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.size > 0);
});

test("单文件的文档自检：入口文档名与实际文件名对不上 → 报 mismatch", async () => {
  const doc = path.join(HOME, "真名.md");
  w(doc, "x");
  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: doc, label: "T", entryDoc: "假名.md" }),
  ]);
  const bad = reports[0].issues.find((i) => i.kind === "entry-doc-mismatch");
  assert.ok(bad, "单文件模式下两者不一致应被抓出来（不是 missing，是 mismatch）");
  assert.strictEqual(bad.severity, "high");
  assert.ok(bad.message.includes("真名.md") && bad.message.includes("假名.md"),
    "消息里要同时点名两个名字，否则用户不知道怎么改");
});

test("单文件 + 正确的入口文档名 → 无缺失问题", async () => {
  const doc = path.join(HOME, "对的.md");
  w(doc, "见 run.bat");
  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: doc, label: "T", entryDoc: "对的.md" }),
  ]);
  const bad = reports[0].issues.find((i) => i.kind === "entry-doc-missing");
  assert.strictEqual(bad, undefined);
});

// ── 大量小文件：包必须完整（防 timeout 单位写错）──
//
// 🔴 2026-10-26 真实故障：13 类导出一直卡住。根因是
// `execFile({ timeout: 30 * 60 })` —— 单位是**毫秒**，实际 1.8 秒，
// tar 打到一半被 SIGTERM 杀掉，留下半截包。
//
// 症状极误导：code=null / signal=SIGTERM / stderr 空 / 产物却有 40MB。
// 这里用大量小文件验证「完整导出」，但**诚实说明它能抓到什么**：
//   ✓ 能抓：条目数不齐 / 关键文档后写丢 / 包被截断
//   ✗ 抓不到：timeout 单位写错 —— 本机 SSD 上 12000 个文件 1.8 秒内就打完了
//     （实测把 timeout 改回 1.8s 后本测试仍然通过）
//
// 所以这条测试是**回归哨兵**，不是那个 bug 的证明。真正的教训写在了
// export-server.cjs 的 timeout 注释里（signal=SIGTERM + code=null 先查 timeout）。

test("大量小文件（12000 个）导出：条目数必须完整，不能是半截包", async () => {
  // 造一个 12000 小文件的技能目录
  const skillRoot = path.join(HOME, ".claude", "skills", "bulk");
  fs.mkdirSync(skillRoot, { recursive: true });
  for (let i = 0; i < 12000; i++) {
    fs.writeFileSync(path.join(skillRoot, `f${i}.txt`), `content-${i}\n`, "utf8");
  }

  const out = path.join(HOME, "bulk.tar.gz");
  const t0 = Date.now();
  const r = await m.doExport({ categories: ["claude-skills"], outputPath: out });
  const elapsed = (Date.now() - t0) / 1000;

  assert.strictEqual(r.ok, true, "导出必须成功");
  assert.ok(elapsed < 120, `12000 个文件不该超过 2 分钟，实际 ${elapsed}s`);

  // ① 条目数：3000 个数据文件 + 目录项 + 3 个包内文档
  const entries = execFileSync("tar", ["--force-local", "-tzf", out], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }).split("\n").filter(Boolean);

  const dataFiles = entries.filter((e) => e.includes("/f") && e.endsWith(".txt"));
  assert.ok(
    dataFiles.length >= 12000,
    `包内应有 12000 个数据文件，实际只有 ${dataFiles.length} —— 典型半截包（tar 被超时杀掉）`,
  );

  // ② 关键文档必须在（半截包往往先丢这些后写的条目）
  for (const doc of ["manifest.json", "IMPORT_GUIDE.md", "RESTORE_REHEARSAL.md"]) {
    assert.ok(
      entries.some((e) => e.endsWith(doc)),
      `包内缺 ${doc} —— tar 很可能中途被杀`,
    );
  }

  // ③ 能完整解压（不是 EOF 截断）
  assert.doesNotThrow(() => {
    execFileSync("tar", ["--force-local", "-tzf", out], {
      stdio: "pipe", maxBuffer: 64 * 1024 * 1024,
    });
  }, "包必须能完整列出（Unexpected EOF = 半截包）");

  fs.rmSync(skillRoot, { recursive: true, force: true });
});

// ── 输出到盘符根目录（D:\xxx.tar.gz）──
//
// 🔴 2026-10-26 真实故障：用户把包存到 `D:\`，报
// `EPERM: operation not permitted, mkdir 'D:\'`。
//
// 根因：无条件 `fsp.mkdir(path.dirname(out), {recursive:true})`。
// 盘符根的 dirname 就是 `D:\` 本身，对**已存在的盘符根**调 mkdir 在 Windows
// 上是 EPERM。而这个目录压根不需要建。

test("输出到已存在的目录（含盘符根）：不该因 mkdir 失败", async () => {
  // 用 HOME 模拟"已存在的目录"，不真往 D:\ 写（CI 上可能没有 D 盘）
  const out = path.join(HOME, "at-root.tar.gz");
  const r = await m.doExport({ categories: ["claude-md"], outputPath: out });
  assert.strictEqual(r.ok, true);

  // 关键：不是靠"这个目录存在"碰巧成功，而是 ensureParentDir 先判断了
  const src = fs.readFileSync(path.join(__dirname, "export-server.cjs"), "utf8");
  assert.ok(
    src.includes("function ensureParentDir"),
    "必须有 ensureParentDir —— 无条件 mkdir(dirname) 会在盘符根上 EPERM",
  );
  assert.ok(
    /const st = await statSafe\(dir\);\s*\n\s*if \(st && st\.isDirectory\(\)\) return;/.test(src),
    "ensureParentDir 必须先 stat 判断，存在就直接返回（盘符根就是这种情况）",
  );
});

test("多层级不存在的父目录仍能自动创建", async () => {
  const out = path.join(HOME, "deep", "nested", "dirs", "x.tar.gz");
  const r = await m.doExport({ categories: ["claude-md"], outputPath: out });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(out), "应真的建出多层目录并写入");
});

// ── 导出成功必须意味着「文件真的存在」──
//
// 🔴 2026-10-26 真实故障：面板显示
//    「✓ 文件已生成 · 13148 个文件 · 0 B」
// 但 D:\ 上**根本没有那个文件**。
//
// 根因：返回 `size: st ? st.size : 0` —— 文件不存在时静默给 0，
// 面板把它当成功渲染。而 autoChecks 全绿，因为它们查的是 **staging**，
// 从没碰最终产物。"检查通过"和"文件不存在"同时成立。

test("文件没写出来时，必须抛错而不是返回 ok:true + 0B", async () => {
  // 指向一个**不可能写成功**的位置（用一个不存在的盘符 / 不可写路径）
  const bogus = process.platform === "win32"
    ? path.join("Z" + ":", "nope", "x.tar.gz") // 不存在的盘符
    : "/proc/nonexistent/x.tar.gz"; // 不可写的虚拟文件系统

  let threw = false;
  let result = null;
  try {
    result = await m.doExport({ categories: ["claude-md"], outputPath: bogus });
  } catch (e) {
    // 抛错就对了 —— 至于是 mkdir 那步还是"产物检查"那步，无所谓：
    // **只要不静默返回成功**就行。（不可写路径可能在建目录时就失败）
    threw = true;
    assert.ok(e.message.length > 0, "错误信息不能是空的");
  }

  if (!threw) {
    // 万一那个路径居然可写，至少不能是 ok:true + 0B
    assert.ok(
      !(result.ok === true && result.size === 0),
      "绝不能返回「成功但 0 字节」—— 这正是当初误导用户的形态",
    );
  }
});

test("成功的导出：返回的 size 必须 > 0 且文件真实存在", async () => {
  const out = path.join(HOME, "real-size.tar.gz");
  const r = await m.doExport({ categories: ["claude-md"], outputPath: out });
  assert.strictEqual(r.ok, true);
  assert.ok(r.size > 0, "成功的导出不该报 0 字节");
  assert.ok(fs.existsSync(out), "返回的 path 必须真实存在");
  assert.strictEqual(fs.statSync(out).size, r.size, "返回的 size 要和磁盘一致");
});
