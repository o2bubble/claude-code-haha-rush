// ── 恢复推演（备份有效性门控）──
//
// 用户的原话：「做完后要自己推演一遍，在新机器上是否能够按照备份文档还原数据。
// 这是备份有效的门控。」
//
// 所以这里测两类东西：
//   ① 自动检查**真的能抓出问题**（缺文件 / 空文件 / 入口文档不存在）
//   ② 推演文档**真的在问对的问题**（不是走过场）

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-reh-"));
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
  w(path.join(CLAUDE, "skills/s1/SKILL.md"), "s1\n");
  // 自定义方案：有入口文档
  const scheme = path.join(HOME, "scheme");
  w(path.join(scheme, "00_迁移总览.md"), "# 方案\n");
});
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function extract(out, entry) {
  const norm = entry.startsWith("./") ? entry : `./${entry}`;
  return execFileSync("tar", ["--force-local", "-xzf", out, "-O", norm], { encoding: "utf8" });
}

test("导出返回 gate 信息（不能直接说「完成」）", async () => {
  const out = path.join(HOME, "g1.tar.gz");
  const r = await m.doExport({ categories: ["claude-md"], outputPath: out });

  assert.strictEqual(r.rehearsalRequired, true, "必须要求做推演");
  assert.strictEqual(r.rehearsalFile, "RESTORE_REHEARSAL.md");
  assert.ok(Array.isArray(r.autoChecks) && r.autoChecks.length > 0, "应返回自动检查结果");
  assert.ok(
    r.guideHint.includes("尚未验证可恢复性"),
    "必须明确告知还没验证，不能让人以为备份完成了",
  );
  assert.ok(r.guideHint.includes("不要告诉用户「备份已完成」"), "应禁止提前宣布完成");
});

test("自动检查：文件齐全 + 都有 sha256", async () => {
  const out = path.join(HOME, "g2.tar.gz");
  const r = await m.doExport({ categories: ["claude-md", "claude-skills"], outputPath: out });

  const byName = Object.fromEntries(r.autoChecks.map((c) => [c.name, c]));
  assert.strictEqual(byName["内置条目文件齐全"].ok, true);
  assert.strictEqual(byName["每个文件都有 sha256"].ok, true);
  assert.strictEqual(byName["没有零字节文件"].ok, true);
});

test("自动检查：入口文档不存在时能抓出来（最常见的「备份了但恢复不了」）", async () => {
  const badScheme = path.join(HOME, "bad-scheme");
  w(path.join(badScheme, "README.md"), "只有 README\n"); // 没有 00_迁移总览.md

  const out = path.join(HOME, "g3.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{
      path: badScheme,
      label: "坏方案",
      entryDoc: "00_迁移总览.md", // 指向一个不存在的文件
    }],
  });

  const chk = r.autoChecks.find((c) => c.name === "自定义项入口文档存在");
  assert.strictEqual(chk.ok, false, "入口文档不存在必须报错");
  assert.ok(chk.detail.includes("坏方案"));
});

test("自动检查：未指定入口文档也算问题", async () => {
  const out = path.join(HOME, "g4.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: path.join(HOME, "scheme"), label: "无入口" }],
  });
  const chk = r.autoChecks.find((c) => c.name === "自定义项入口文档存在");
  assert.strictEqual(chk.ok, false);
  assert.ok(chk.detail.includes("未指定入口文档"));
});

test("RESTORE_REHEARSAL.md 在包里，且问的是对的问题", async () => {
  const out = path.join(HOME, "g5.tar.gz");
  await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{
      path: path.join(HOME, "scheme"),
      label: "X 盘同步",
      entryDoc: "00_迁移总览.md",
    }],
  });

  const doc = extract(out, "RESTORE_REHEARSAL.md");
  assert.ok(doc.includes("备份有效性门控"), "标题应点明这是门控");
  assert.ok(doc.includes("全新的"), "应问『在全新机器上能否恢复』");
  assert.ok(doc.includes("路径在新机器上还成立吗"), "应问路径问题");
  assert.ok(doc.includes("X 盘同步"), "应针对每个自定义项单独提问");
  assert.ok(doc.includes("有没有「文档没提、但不带就恢复不了」的东西"), "应问遗漏依赖");
  assert.ok(doc.includes("这次备份**失败**的话"), "应做反向验证");
  assert.ok(doc.includes("不要说「备份已完成」就结束"), "应禁止走过场");
});

test("推演文档会指出「数据不在包里」的自定义项", async () => {
  const out = path.join(HOME, "g6.tar.gz");
  await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: path.join(HOME, "scheme"), label: "无数据方案", entryDoc: "00_迁移总览.md" }],
    // 不传 includeData
  });
  const doc = extract(out, "RESTORE_REHEARSAL.md");
  assert.ok(doc.includes("**不在包里**"), "应明确数据不在包里");
  assert.ok(doc.includes("新机器上从哪来"), "应追问数据来源");
});

test("推演文档会指出「带数据」的自定义项", async () => {
  const out = path.join(HOME, "g7.tar.gz");
  await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{
      path: path.join(HOME, "scheme"),
      label: "带数据方案",
      entryDoc: "00_迁移总览.md",
      includeData: true,
    }],
  });
  const doc = extract(out, "RESTORE_REHEARSAL.md");
  assert.ok(doc.includes("**已在本包里**"), "应说明数据在包里");
});
