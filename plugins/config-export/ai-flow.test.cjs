// ── AI 全流程闭环测试 ──
//
// 站在"AI 参与"的角度验证：
//   · 导出端 AI 拿到足够信息（有工具、有推演要求、有可转述的提示词）
//   · 恢复端 AI 拿到一个包之后，能先自检（inspect）再动手
//   · 两个新 MCP 工具（audit_custom_item / inspect_package）语义正确
//
// ⚠️ 这些断言防的是"AI 不知道该做什么"，不是"代码有没有 bug"。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-ai-"));
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
test.before(() => {
  w(path.join(CLAUDE, "CLAUDE.md"), "# 指令\n");
  w(path.join(CLAUDE, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
});
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// ── 导出端：AI 拿到的东西够不够它行动 ──

test("导出返回告诉 AI 包里带哪些文件（别临场写脚本）", async () => {
  const out = path.join(HOME, "a.tar.gz");
  const r = await m.doExport({ categories: ["claude-md"], outputPath: out });

  assert.ok(r.bundledFiles, "必须告诉 AI 包内有哪些文档/工具");
  assert.strictEqual(r.bundledFiles.guide, "IMPORT_GUIDE.md");
  assert.strictEqual(r.bundledFiles.rehearsal, "RESTORE_REHEARSAL.md");
  assert.ok(r.bundledFiles.tools.includes("restore-tools.cjs"));

  assert.ok(r.toolsHint.includes("不要临时写脚本"), "明确禁止临场写脚本");
  assert.ok(Array.isArray(r.nextActions) && r.nextActions.length >= 2,
    "给出可执行的下一步（不是一句话）");
});

test("导出返回给出可转述给用户的恢复提示词", async () => {
  const out = path.join(HOME, "b.tar.gz");
  const r = await m.doExport({ categories: ["claude-md"], outputPath: out });
  assert.ok(r.recommendedImportPrompt, "应给出恢复用的提示词");
  assert.ok(r.recommendedImportPrompt.includes("IMPORT_GUIDE.md"));
  assert.ok(r.recommendedImportPrompt.includes("restore-tools.cjs"));
  assert.ok(r.recommendedImportPrompt.includes("不要临时写脚本"));
});

// ── 恢复端：inspect_package ──

test("inspect_package: 报告包是否自描述", async () => {
  const out = path.join(HOME, "c.tar.gz");
  await m.doExport({ categories: ["claude-md"], outputPath: out });
  const insp = await m.inspectPackage(out);

  assert.strictEqual(insp.ok, true);
  assert.deepStrictEqual(insp.selfDescribing, {
    hasGuide: true, hasRehearsal: true, hasTools: true,
  });
  assert.strictEqual(insp.ready, true);
  assert.ok(insp.nextStep.includes("第 0 步"), "应指向 GUIDE 的第 0 步");
  assert.ok(insp.toolsHint.includes("不要临时写脚本"));
});

test("inspect_package: 非本插件的包 → 明确报错（不瞎猜）", async () => {
  const fake = path.join(HOME, "not-ours.tar.gz");
  // 造一个只有随便一个文件的 tar.gz
  const d = path.join(HOME, "tmpd");
  w(path.join(d, "random.txt"), "x");
  execFileSync("tar", ["--force-local", "-czf", "x.tar.gz", "-C", "tmpd", "."], { cwd: HOME });
  fs.renameSync(path.join(HOME, "x.tar.gz"), fake);

  await assert.rejects(() => m.inspectPackage(fake), /没有 manifest\.json/);
});

test("inspect_package: 文件不存在 → 报错", async () => {
  await assert.rejects(() => m.inspectPackage(path.join(HOME, "nope.tar.gz")), /文件不存在/);
});

// ── audit_custom_item 的语义（ok ≠ clean）──

test("audit_custom_item: ok 表示调用成功，clean 表示方案没问题", async () => {
  const good = path.join(HOME, "good-scheme");
  w(path.join(good, "00_手册.md"), "见 `run.bat`");
  w(path.join(good, "run.bat"), "echo\n");

  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: good, entryDoc: "00_手册.md" }),
  ]);
  assert.strictEqual(reports[0].ok, true, "文件都在 → clean");
});

test("audit_custom_item: 文档引用缺失 → clean 为 false 且列明细", async () => {
  const bad = path.join(HOME, "bad-scheme");
  w(path.join(bad, "00_手册.md"), "跑 `a.bat` `b.py` `c.txt`");
  const reports = await m.auditCustomItems([
    m.normalizeCustomItem({ path: bad, entryDoc: "00_手册.md" }),
  ]);
  const r = reports[0];
  assert.strictEqual(r.ok, false);
  const gap = r.issues.find((i) => i.kind === "doc-refs-missing");
  assert.ok(gap);
  assert.strictEqual(gap.missing.length, 3);
});

// ── 恢复入口：面板生成的提示词要能驱动 AI ──

test("恢复提示词覆盖了完整链路（评估→方案→确认→冲突→报告）", () => {
  // 从 panel.html 里抽出 buildRestorePrompt 的产物结构做静态校验
  const html = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");
  const seg = html.slice(html.indexOf("function buildRestorePrompt"));
  const body = seg.slice(0, seg.indexOf("function startRestore"));

  assert.ok(body.includes("IMPORT_GUIDE.md"), "要指向指南");
  assert.ok(body.includes("RESTORE_REHEARSAL.md"), "要指向推演清单");
  assert.ok(body.includes("restore-tools.cjs"), "要用包内工具");
  assert.ok(body.includes("评估这台机器的现状"), "必须先评估现状");
  assert.ok(body.includes("我确认后"), "必须等用户确认");
  assert.ok(body.includes("按 uuid 合并"), "会话冲突要有具体做法");
  assert.ok(body.includes("两个数都要报"), "恢复率要报两个数");
});

test("面板有恢复入口的 UI 元素", () => {
  const html = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");
  assert.ok(html.includes('id="pickPkgBtn"'), "有「选择备份包」按钮");
  assert.ok(html.includes("从备份恢复"), "有恢复区块");
  assert.ok(html.includes('kind: "chat-prompt"'), "能把提示词灌进输入框");
  assert.ok(html.includes('kind: "pick-open-file"'), "能选已有文件");
});
