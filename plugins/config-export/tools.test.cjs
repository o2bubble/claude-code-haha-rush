// ── restore-tools：恢复率模型 + 各命令 ──
//
// 重点是**恢复率的算法**（纯函数，可精确断言）。
// 命令层只做冒烟（确认能跑、输出结构对），不重复测 tar 本身。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { verifiabilityOf, computeRecoveryRate } = require("./restore-tools.cjs");

// ── 恢复率的可验证级别 ──

test("verifiabilityOf: overwrite 可精确验证（sha256 一致）", () => {
  assert.strictEqual(verifiabilityOf("overwrite"), "exact");
});

test("verifiabilityOf: merge / append 只能部分验证", () => {
  assert.strictEqual(verifiabilityOf("merge"), "partial");
  assert.strictEqual(verifiabilityOf("append"), "partial");
});

test("verifiabilityOf: manual 无法自动验证", () => {
  assert.strictEqual(verifiabilityOf("manual"), "unverifiable");
  assert.strictEqual(verifiabilityOf("unknown-mode"), "unverifiable", "未知模式也归为不可验证");
});

// ── 恢复率：两个数，不合成 ──

test("computeRecoveryRate: 全部可验证且全过 → 两个数都是 100%", () => {
  const r = computeRecoveryRate([
    { mode: "overwrite", verified: "pass" },
    { mode: "merge", verified: "pass" },
  ]);
  assert.strictEqual(r.autoPassRate, 1);
  assert.strictEqual(r.overallCoverage, 1);
  assert.strictEqual(r.unverifiable.total, 0);
  assert.ok(r.note.includes("全部条目都可自动验证"));
});

test("computeRecoveryRate: 有无法验证的项 → 覆盖率**低于**自动验证率", () => {
  const r = computeRecoveryRate([
    { mode: "overwrite", verified: "pass" },  // 可验，过
    { mode: "overwrite", verified: "pass" },  // 可验，过
    { mode: "manual", verified: "skipped" },  // 不可验
    { mode: "manual", verified: "skipped" },  // 不可验
  ]);
  // 自动验证：2/2 = 100%
  assert.strictEqual(r.autoPassRate, 1);
  // 整体覆盖：2/4 = 50%
  assert.strictEqual(r.overallCoverage, 0.5);
  assert.strictEqual(r.unverifiable.total, 2);
  assert.ok(r.note.includes("无法自动验证"), "必须如实说明有几个验不了");
});

test("computeRecoveryRate: 部分失败时两个数一起降", () => {
  const r = computeRecoveryRate([
    { mode: "overwrite", verified: "pass" },
    { mode: "overwrite", verified: "fail" },
    { mode: "manual", verified: "skipped" },
  ]);
  assert.strictEqual(r.autoPassRate, 0.5);      // 1/2
  assert.strictEqual(r.overallCoverage, 1 / 3); // 1/3
  assert.strictEqual(r.exact.fail, 1);
});

test("computeRecoveryRate: 全是 manual → 自动验证率为 null（不是 0 也不是 100）", () => {
  const r = computeRecoveryRate([
    { mode: "manual", verified: "skipped" },
    { mode: "manual", verified: "skipped" },
  ]);
  assert.strictEqual(r.autoPassRate, null, "没有可验证项时不能编一个数");
  assert.strictEqual(r.overallCoverage, 0);
  assert.strictEqual(r.unverifiable.total, 2);
});

test("computeRecoveryRate: 空包 → 都是 null", () => {
  const r = computeRecoveryRate([]);
  assert.strictEqual(r.autoPassRate, null);
  assert.strictEqual(r.overallCoverage, null);
  assert.ok(r.note.includes("没有可恢复的条目"));
});

test("computeRecoveryRate: 分类计数正确", () => {
  const r = computeRecoveryRate([
    { mode: "overwrite", verified: "pass" },
    { mode: "overwrite", verified: "pass" },
    { mode: "merge", verified: "pass" },
    { mode: "append", verified: "fail" },
    { mode: "manual", verified: "skipped" },
  ]);
  assert.deepStrictEqual(r.exact, { pass: 2, fail: 0, total: 2 });
  assert.deepStrictEqual(r.partial, { pass: 1, fail: 1, total: 2 });
  assert.deepStrictEqual(r.unverifiable, { total: 1 });
});

// ── 命令冒烟测试 ──

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rt-test-"));
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

let PKG;
test.before(async () => {
  w(path.join(CLAUDE, "CLAUDE.md"), "# 指令\n");
  w(path.join(CLAUDE, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
  w(path.join(CLAUDE, "projects/x/memory/MEMORY.md"), "- 记忆\n");
  PKG = path.join(HOME, "pkg.tar.gz");
  await m.doExport({ categories: ["claude-md", "claude-settings", "claude-memory"], outputPath: PKG });
});
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function run(args) {
  try {
    return JSON.parse(execFileSync(
      "node", [path.join(__dirname, "restore-tools.cjs"), ...args],
      { encoding: "utf8", timeout: 120000 },
    ));
  } catch (e) {
    if (e.stdout) { try { return JSON.parse(e.stdout); } catch { /* fallthrough */ } }
    throw e;
  }
}

test("list: 返回分类与总量", () => {
  const r = run(["list", PKG]);
  assert.strictEqual(r.ok, true);
  assert.ok(r.totals.files >= 3);
  assert.ok(r.categories.some((c) => c.id === "claude-md"));
});

test("verify: 完好的包校验通过", () => {
  const r = run(["verify", PKG]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.packageIntact, true);
  assert.strictEqual(r.failed, 0);
});

test("verify: 损坏的包必须报错（不能假装完整）", () => {
  const broken = path.join(HOME, "broken.tar.gz");
  fs.writeFileSync(broken, Buffer.from("1f8b08000000000000", "hex"));
  const r = run(["verify", broken]);
  assert.strictEqual(r.ok, false, "截断的包绝不能校验通过");
});

test("compare: 空目标 → 全部 missing", () => {
  const dest = path.join(HOME, "empty-dest");
  const r = run(["compare", PKG, "--dest", dest]);
  assert.strictEqual(r.summary.missing, r.summary.missing + r.summary.identical + r.summary.different + r.summary.exists + r.summary.unresolvable);
  assert.ok(r.summary.missing >= 3);
});

test("compare + rate: 恢复一半后能算出**两个**不同的比例", () => {
  const dest = path.join(HOME, "half-dest");
  fs.mkdirSync(path.join(dest, ".claude"), { recursive: true });
  fs.copyFileSync(path.join(CLAUDE, "CLAUDE.md"), path.join(dest, ".claude", "CLAUDE.md"));

  const r = run(["rate", PKG, "--dest", dest]);
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.recovery.autoPassPercent === "number");
  assert.ok(typeof r.recovery.overallPercent === "number");
  assert.ok(
    r.recovery.overallPercent <= r.recovery.autoPassPercent,
    "覆盖率不应高于自动验证率（它把不可验的算作未覆盖）",
  );
  assert.ok(r.recovery.breakdown.unverifiable.total >= 1, "记忆文件应归入不可验证");
  assert.ok(r.customItems.length === 0, "这个包没有自定义项");
});

test("session-diff: 能看出多出来的轮次", () => {
  const a = path.join(HOME, "a.jsonl");
  const b = path.join(HOME, "b.jsonl");
  fs.writeFileSync(a, '{"uuid":"u1","timestamp":1}\n');
  fs.writeFileSync(b, '{"uuid":"u1","timestamp":1}\n{"uuid":"u2","timestamp":2}\n');
  const r = run(["session-diff", a, b]);
  assert.strictEqual(r.onlyInB.count, 1);
  assert.strictEqual(r.conflicting.count, 0);
  assert.ok(r.hint.includes("合并"));
});

test("session-diff: 同 uuid 内容不同 → 报真冲突", () => {
  const a = path.join(HOME, "c.jsonl");
  const b = path.join(HOME, "d.jsonl");
  fs.writeFileSync(a, '{"uuid":"u1","timestamp":1,"x":1}\n');
  fs.writeFileSync(b, '{"uuid":"u1","timestamp":1,"x":2}\n');
  const r = run(["session-diff", a, b]);
  assert.strictEqual(r.conflicting.count, 1);
  assert.ok(r.conflicting.note.includes("必须问用户"));
});

test("session-merge: 正常合并并保持 uuid 唯一", () => {
  const a = path.join(HOME, "m1.jsonl");
  const b = path.join(HOME, "m2.jsonl");
  const o = path.join(HOME, "mo.jsonl");
  fs.writeFileSync(a, '{"uuid":"u1","timestamp":1}\n{"uuid":"u2","timestamp":2}\n');
  fs.writeFileSync(b, '{"uuid":"u1","timestamp":1}\n{"uuid":"u3","timestamp":3}\n');
  const r = run(["session-merge", a, b, "-o", o]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.merged, 3, "u1 只出现一次");
  const lines = fs.readFileSync(o, "utf8").trim().split("\n");
  assert.strictEqual(lines.length, 3);
});

test("session-merge: 有真冲突时**拒绝合并**（不能猜）", () => {
  const a = path.join(HOME, "x1.jsonl");
  const b = path.join(HOME, "x2.jsonl");
  const o = path.join(HOME, "xo.jsonl");
  fs.writeFileSync(a, '{"uuid":"u1","v":1}\n');
  fs.writeFileSync(b, '{"uuid":"u1","v":2}\n');
  const r = run(["session-merge", a, b, "-o", o]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes("不能自动合并"));
  assert.ok(!fs.existsSync(o), "拒绝时不该产生输出文件");
});

test("session-merge: 覆盖已有文件前自动备份", () => {
  const a = path.join(HOME, "y1.jsonl");
  const b = path.join(HOME, "y2.jsonl");
  const o = path.join(HOME, "yo.jsonl");
  fs.writeFileSync(a, '{"uuid":"u1","timestamp":1}\n');
  fs.writeFileSync(b, '{"uuid":"u2","timestamp":2}\n');
  fs.writeFileSync(o, '{"uuid":"old"}\n');
  const r = run(["session-merge", a, b, "-o", o]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.backups.length, 1, "必须留下备份");
  assert.ok(fs.existsSync(r.backups[0]));
});

test("json-merge: 只预览不写盘，分开 added / changed", () => {
  const a = path.join(HOME, "ja.json");
  const b = path.join(HOME, "jb.json");
  fs.writeFileSync(a, JSON.stringify({ theme: "dark", keep: 1 }));
  fs.writeFileSync(b, JSON.stringify({ theme: "light", added: 2 }));
  const before = fs.statSync(a).mtimeMs;
  const r = run(["json-merge", a, b]);
  assert.deepStrictEqual(r.addedFromOther.map((x) => x.key), ["added"]);
  assert.deepStrictEqual(r.changed.map((x) => x.key), ["theme"]);
  assert.strictEqual(fs.statSync(a).mtimeMs, before, "预览不能改文件");
  assert.ok(r.hint.includes("问用户"));
  assert.ok(r.hint.includes("env"), "必须提醒 env 段不能带过来");
});

test("未知命令 → 报错而不是静默", () => {
  const r = run(["no-such-cmd"]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes("未知命令"));
});
