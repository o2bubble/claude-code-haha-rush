const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cust-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.APPDATA;
process.env.CLAUDE_PLUGIN_WORKSPACE = "";

const m = require("./export-server.cjs");
const CLAUDE = path.join(HOME, ".claude");
const CUSTOM = path.join(HOME, "my-backup-scheme");

function w(p, c) { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p,c,"utf8"); }

test.before(() => {
  w(path.join(CLAUDE, "CLAUDE.md"), "# 指令\n");
  w(path.join(CLAUDE, "skills/s1/SKILL.md"), "s1\n");
  // 自定义目录：自己的方案，其中 copies 了一份 CLAUDE.md（模拟重叠）
  w(path.join(CUSTOM, "00_迁移总览.md"), "# 我的方案\n步骤 1 2 3\n");
  w(path.join(CUSTOM, "run.bat"), "@echo off\n");
  w(path.join(CUSTOM, "copied/CLAUDE.md"), "# 指令\n"); // 内容同内置，但路径不同 → 不算重叠
});
test.after(() => fs.rmSync(HOME, {recursive:true, force:true}));

test("导出带自定义项：目录原样打包 + manifest 记录 + GUIDE 生成", async () => {
  const out = path.join(HOME, "o.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md", "claude-skills"],
    outputPath: out,
    customItems: [{
      path: CUSTOM,
      includeData: true,
      label: "我的迁移方案",
      entryDoc: "00_迁移总览.md",
      notes: "自建",
      importPrompt: "按文档执行",
      verifyPrompt: "检查结果",
    }],
  });
  assert.strictEqual(r.ok, true);

  // ⚠️ 断言必须"解压后看真实文件名"，不能拿 `tar -tzf` 的输出 include 中文：
  // GNU tar 的**列表输出**会把非 ASCII 转义成八进制（`\350\277\201...`），
  // 但**解压出来是对的**。拿列表断言会得到假阴性 —— 我第一次就这么写错了。
  const EX = path.join(HOME, "ex1");
  fs.mkdirSync(EX, { recursive: true });
  execFileSync("tar", ["--force-local", "-xzf", out, "-C", EX]);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(EX, path.join(d, e.name))]);
  const files = walk(EX).map((p) => p.replace(/\\/g, "/"));

  assert.ok(files.some((f) => f.includes("custom/")), "应打包自定义目录");
  assert.ok(files.some((f) => f.endsWith("00_迁移总览.md")), "入口文档在包内（中文名解压后正确）");
  assert.ok(files.some((f) => f.endsWith("run.bat")), "脚本在包内");
  assert.ok(files.some((f) => f.endsWith("IMPORT_GUIDE.md")), "应生成恢复指南");

  const mf = JSON.parse(execFileSync("tar",["--force-local","-xzf",out,"-O","./manifest.json"],{encoding:"utf8"}));
  assert.strictEqual(mf.formatVersion, 2);
  assert.strictEqual(mf.customItems.length, 1);
  const c = mf.customItems[0];
  assert.strictEqual(c.label, "我的迁移方案");
  assert.strictEqual(c.entryDoc, "00_迁移总览.md");
  assert.ok(c.fileCount >= 3);
  assert.strictEqual(c.kind, "custom");
});

test("IMPORT_GUIDE 含自定义项说明与决策框架", async () => {
  const out = path.join(HOME, "g.tar.gz");
  await m.doExport({
    categories: ["claude-md"], outputPath: out,
    customItems: [{ path: CUSTOM, includeData: true, label: "我的迁移方案", entryDoc: "00_迁移总览.md" }],
  });
  const g = execFileSync("tar",["--force-local","-xzf",out,"-O","./IMPORT_GUIDE.md"],{encoding:"utf8"});

  assert.ok(g.includes("自定义项"), "应提到自定义项");
  assert.ok(g.includes("我的迁移方案"), "应列出该项");
  assert.ok(g.includes("00_迁移总览.md"), "应指出入口文档");
  assert.ok(g.includes("先问用户"), "应有『先问用户』的决策框架");
  assert.ok(g.includes("绝不静默覆盖"), "应禁止静默覆盖");
});

test("重叠检测：自定义项包含内置分类的文件时能被识别", async () => {
  // 造一个自定义目录，里面直接是 ~/.claude 的一部分（模拟用户备份整个 .claude）
  const out = path.join(HOME, "ov.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: CLAUDE, includeData: true, label: "整个 .claude" }], // 同一批文件
  });
  assert.strictEqual(r.ok, true);

  const mf = JSON.parse(execFileSync("tar",["--force-local","-xzf",out,"-O","./manifest.json"],{encoding:"utf8"}));
  const c = mf.customItems[0];
  assert.ok(c.overlaps.length > 0, "应检测到与 claude-md 的重叠");
  const hit = c.overlaps.find(o => o.category === "claude-md");
  assert.ok(hit, "应指出重叠的是 claude-md");
  assert.ok(hit.shared >= 1);

  const g = execFileSync("tar",["--force-local","-xzf",out,"-O","./IMPORT_GUIDE.md"],{encoding:"utf8"});
  assert.ok(g.includes("重叠"), "GUIDE 应提示重叠");
  assert.ok(g.includes("之前那套方案"), "GUIDE 应建议问用户之前做过没有");
});

test("自定义项不走黑名单（用户目录里的 profile.env 照样带走）", async () => {
  const custom2 = path.join(HOME, "scheme2");
  w(path.join(custom2, "README.md"), "my scheme\n");
  w(path.join(custom2, "profile.env"), "ANTHROPIC_AUTH_TOKEN=sk-user-own\n");
  const out = path.join(HOME, "bl.tar.gz");
  await m.doExport({ categories: [], outputPath: out, customItems: [{ path: custom2, includeData: true, label: "S2" }] });
  const list = execFileSync("tar",["--force-local","-tzf",out],{encoding:"utf8"});
  assert.ok(list.includes("profile.env"), "用户目录里的 profile.env 应原样带走（用户知情）");
});

test("只导自定义项、不选任何内置分类也能成功", async () => {
  const out = path.join(HOME, "only.tar.gz");
  const r = await m.doExport({ categories: [], outputPath: out, customItems: [{ path: CUSTOM, label: "Only" }] });
  assert.strictEqual(r.ok, true);
  assert.ok(r.size > 0);
});

test("默认不带数据：包里只有说明，没有自定义项的文件", async () => {
  const out = path.join(HOME, "nodata.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md"],
    outputPath: out,
    customItems: [{ path: CUSTOM, label: "我的迁移方案", entryDoc: "00_迁移总览.md" }],
    // 不传 includeData → 默认 false
  });
  assert.strictEqual(r.ok, true);

  const EX = path.join(HOME, "ex-nodata");
  fs.mkdirSync(EX, { recursive: true });
  execFileSync("tar", ["--force-local", "-xzf", out, "-C", EX]);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(EX, path.join(d, e.name))]);
  const files = walk(EX).map((p) => p.split(path.sep).join("/"));

  // 自定义项的原始文件不应在包里
  assert.ok(!files.some((f) => f.includes("run.bat")), "未要求带数据时，方案的文件不该进包");
  assert.ok(!files.some((f) => f.includes("custom/")), "不该有 custom/ 目录");

  const mf = JSON.parse(execFileSync("tar", ["--force-local", "-xzf", out, "-O", "./manifest.json"], { encoding: "utf8" }));
  const c = mf.customItems[0];
  assert.strictEqual(c.dataIncluded, false);
  assert.strictEqual(c.bundledPath, null, "没有打包就不该给包内路径");
  assert.ok(c.sourceAbsPath, "必须留下原路径作为唯一线索");
  assert.ok(c.fileCount > 0, "仍应统计规模（告诉用户多大）");
});

test("数据不在包里时，GUIDE 要告诉 AI 去哪找 / 问用户", async () => {
  const out = path.join(HOME, "nodata2.tar.gz");
  await m.doExport({
    categories: ["claude-md"], outputPath: out,
    customItems: [{ path: CUSTOM, label: "我的迁移方案", entryDoc: "00_迁移总览.md" }],
  });
  const g = execFileSync("tar", ["--force-local", "-xzf", out, "-O", "./IMPORT_GUIDE.md"], { encoding: "utf8" });

  assert.ok(g.includes("数据不在本包内"), "应明确告知数据不在包里");
  assert.ok(g.includes("不要**因为包里没有就跳过"), "应防止 AI 直接跳过");
  assert.ok(g.includes("问用户"), "应引导去问用户");
  assert.ok(g.includes("把数据也打进包"), "应提示下次可以勾选带数据");
});
