// ── 自定义项「文档自检」──
//
// 用户要求的场景：他自己的方案文档里提到 12 个文件，但目录里只有那个 .md。
// 导出前就该发现"这份备份本身是残缺的"，而不是等换机器时才撞墙。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-aud-"));
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

// ── 纯函数：从文档里抽文件名 ──

test("extractFileRefs: 抽出文档里提到的文件名", () => {
  const doc = `
| \`01_台式机同步到X.bat\` | 台式机 |
| \`06_修复用户名.py\` | 笔记本 |
` + "跑 `07_迁移验证.py` 验证，参考 requirements.txt";
  const refs = m.extractFileRefs(doc);
  assert.ok(refs.includes("01_台式机同步到X.bat"));
  assert.ok(refs.includes("06_修复用户名.py"));
  assert.ok(refs.includes("07_迁移验证.py"));
  assert.ok(refs.includes("requirements.txt"));
});

test("extractFileRefs: 忽略纯扩展名与超长串", () => {
  const refs = m.extractFileRefs("用 .py 写、看 .md、a".repeat(200) + ".py");
  assert.ok(!refs.includes(".py"), "纯扩展名不算文件");
  assert.ok(refs.every((r) => r.length <= 120), "超长串被过滤");
});

test("extractFileRefs: 空/非字符串 → 空数组", () => {
  assert.deepStrictEqual(m.extractFileRefs(""), []);
  assert.deepStrictEqual(m.extractFileRefs(null), []);
  assert.deepStrictEqual(m.extractFileRefs(undefined), []);
});

// ── 纯函数：交叉核对 ──

test("crossCheckDocRefs: 找出文档提到但目录里没有的文件", () => {
  const r = m.crossCheckDocRefs(
    ["00_迁移总览.md", "01_a.bat", "02_b.py"],
    ["00_迁移总览.md"],
  );
  assert.strictEqual(r.mentioned, 3);
  assert.deepStrictEqual(r.present, ["00_迁移总览.md"]);
  assert.deepStrictEqual(r.missing, ["01_a.bat", "02_b.py"]);
  assert.ok(Math.abs(r.coverage - 1 / 3) < 1e-9);
});

test("crossCheckDocRefs: 大小写不敏感（Windows）", () => {
  const r = m.crossCheckDocRefs(["README.MD", "Run.BAT"], ["readme.md", "run.bat"]);
  assert.strictEqual(r.missing.length, 0);
  assert.strictEqual(r.coverage, 1);
});

test("crossCheckDocRefs: 文档没提任何文件 → coverage 为 null（不是 100%）", () => {
  const r = m.crossCheckDocRefs([], ["a.txt"]);
  assert.strictEqual(r.coverage, null, "没提文件时不能报 100% 覆盖");
  assert.strictEqual(r.missing.length, 0);
});

// ── 端到端：真实场景 ──

test("端到端：文档提到 12 个文件但目录只有 1 个 → 高风险 + 列缺失", async () => {
  const scheme = path.join(HOME, "broken-scheme");
  // 造一份"像用户那样"的文档：提到 12 个文件，实际只有它自己
  const doc = [
    "# 迁移方案",
    "",
    "| 文件 | 作用 |",
    "|---|---|",
    "| `00_迁移总览.md` | 本手册 |",
    "| `01_台式机同步.bat` | 同步 |",
    "| `02_回台式机.bat` | 回程 |",
    "| `03_盘符映射.bat` | 映射 |",
    "| `04_拉配置.bat` | 拉取 |",
    "| `05_回传配置.bat` | 回传 |",
    "| `06_修复用户名.py` | 修复 |",
    "| `07_迁移验证.py` | 验证 |",
    "| `08_同步FG.bat` | FG |",
    "| `09_回拉EFG.bat` | 回拉 |",
    "| `requirements.txt` | 依赖 |",
    "| `maintain.py` | 维护 |",
  ].join("\n");
  w(path.join(scheme, "00_迁移总览.md"), doc);

  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: scheme, label: "我的方案", entryDoc: "00_迁移总览.md" }),
  ]);

  assert.strictEqual(reports.length, 1);
  const r = reports[0];
  assert.strictEqual(r.ok, false, "有 high 级问题 → ok 为 false");
  const gap = r.issues.find((i) => i.kind === "doc-refs-missing");
  assert.ok(gap, "必须报出「文档引用的文件缺失」");
  assert.strictEqual(gap.severity, "high", "覆盖率 <50% 应为 high");
  assert.ok(gap.missing.length >= 10, `应列出缺失清单，实际 ${gap.missing.length}`);
  assert.ok(gap.missing.includes("06_修复用户名.py"));
});

test("端到端：文档提到的都在 → 无 doc-refs-missing 问题", async () => {
  const ok = path.join(HOME, "good-scheme");
  w(path.join(ok, "00_手册.md"), "见 `run.bat` 和 `verify.py`");
  w(path.join(ok, "run.bat"), "@echo off\n");
  w(path.join(ok, "verify.py"), "print('ok')\n");

  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: ok, label: "完整方案", entryDoc: "00_手册.md" }),
  ]);
  const gap = reports[0].issues.find((i) => i.kind === "doc-refs-missing");
  assert.strictEqual(gap, undefined, "文件都在就不该报缺失");
});

test("端到端：入口文档不存在 → high", async () => {
  const noDoc = path.join(HOME, "no-doc");
  w(path.join(noDoc, "readme.txt"), "x");
  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: noDoc, label: "没入口", entryDoc: "不存在.md" }),
  ]);
  const iss = reports[0].issues.find((i) => i.kind === "entry-doc-missing");
  assert.ok(iss);
  assert.strictEqual(iss.severity, "high");
});

test("端到端：缺 importPrompt / verifyPrompt → low（不阻断）", async () => {
  const s = path.join(HOME, "minimal");
  w(path.join(s, "00_a.md"), "没提别的文件");
  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: s, label: "最小方案", entryDoc: "00_a.md" }),
  ]);
  const kinds = reports[0].issues.map((i) => i.kind);
  assert.ok(kinds.includes("no-import-prompt"));
  assert.ok(kinds.includes("no-verify-prompt"));
  assert.strictEqual(reports[0].ok, true, "low 级不应阻断");
});

test("导出时把体检结果写进 manifest，并进自动检查", async () => {
  const scheme = path.join(HOME, "gap-scheme");
  w(path.join(scheme, "00_手册.md"), "需要 `missing.bat` 这个脚本");
  const out = path.join(HOME, "p.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: scheme, label: "缺文件方案", entryDoc: "00_手册.md" }],
  });

  // manifest 里带 customAudit
  const mf = JSON.parse(execFileSync("tar", ["--force-local", "-xzf", out, "-O", "./manifest.json"], { encoding: "utf8" }));
  assert.ok(Array.isArray(mf.customAudit) && mf.customAudit.length === 1);
  assert.ok(mf.customAudit[0].crossCheck.missing.includes("missing.bat"));

  // 自动检查里体现
  const chk = r.autoChecks.find((c) => c.name === "自定义项文档引用的文件都在");
  assert.ok(chk, "应有这项检查");
  assert.strictEqual(chk.ok, false, "缺文件时该项应失败");
});

test("IMPORT_GUIDE 里会提醒恢复端：这份文档本身有缺失", async () => {
  const scheme = path.join(HOME, "guide-gap");
  w(path.join(scheme, "00_手册.md"), "跑 `missing1.bat` 和 `missing2.py`");
  const out = path.join(HOME, "g.tar.gz");
  await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: scheme, label: "缺文件方案", entryDoc: "00_手册.md" }],
  });
  const g = execFileSync("tar", ["--force-local", "-xzf", out, "-O", "./IMPORT_GUIDE.md"], { encoding: "utf8" });
  assert.ok(g.includes("文档提到的文件有缺失"), "GUIDE 应提示文档缺失");
  assert.ok(g.includes("missing1.bat"), "应列出缺失的文件");
  assert.ok(g.includes("残缺的文档恢复出来的结果不会完整"), "应说明后果");
});
