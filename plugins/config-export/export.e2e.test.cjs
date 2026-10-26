// ── config-export 端到端测试 ──
//
// 真实文件系统：造一个假的 HOME → 跑导出 → 解开 tar.gz → 断言包内容。
//
// **重点是安全属性**：凭据与 settings.env 绝不能出现在包里。这类断言必须
// 走真实打包流程（纯函数测试证明不了"最终产物里没有"）。
//
// 跑法：node --test plugins/config-export/export.e2e.test.cjs

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// ⚠️ 必须在 require 之前改 HOME —— export-server 在模块顶层就解析了路径。
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-e2e-home-"));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME; // Windows 用 USERPROFILE
delete process.env.APPDATA;          // 不测 GUI 侧（那需要真实 appdata）
process.env.CLAUDE_PLUGIN_WORKSPACE = "";

const m = require("./export-server.cjs");

const CLAUDE = path.join(FAKE_HOME, ".claude");

function write(rel, content) {
  const p = path.join(CLAUDE, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function listTar(tarPath) {
  const out = // --force-local：Windows 路径含 `C:` 会被 GNU tar 当成远程主机
  execFileSync("tar", ["--force-local", "-tzf", tarPath], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function readFromTar(tarPath, entry) {
  // 包内条目带 `./` 前缀（因为打包时用 `-C <staging> .`）→ 读取时补上
  const normalized = entry.startsWith("./") ? entry : `./${entry}`;
  return execFileSync(
    "tar",
    ["--force-local", "-xzf", tarPath, "-O", normalized],
    { encoding: "utf8" },
  );
}

// ── 造场景 ──

test.before(() => {
  write("CLAUDE.md", "# 我的个人指令\n");
  write("settings.json", JSON.stringify({
    theme: "dark",
    uiFontSize: 100,
    env: { ANTHROPIC_API_KEY: "sk-LEAK-ME-PLEASE", OTHER: "x" },
  }, null, 2));
  write("skills/my-skill/SKILL.md", "---\nname: my-skill\n---\n内容\n");
  write("projects/C--ws/memory/MEMORY.md", "- [偏好](pref.md)\n");
  write("projects/C--ws/memory/pref.md", "喜欢简短回答\n");
  write("projects/C--ws/abc.jsonl", '{"type":"user"}\n');
  // 🔴 凭据：放进 `~/.claude` 里，验证它们不会被打包
  write(".credentials.json", '{"token":"SECRET-TOKEN"}');
  write("plugin-signing.key", "deadbeef");
  write(".env.active", "ANTHROPIC_API_KEY=sk-active-leak");
});

test.after(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

// ── 测试 ──

test("扫描：分类清单含文件数与大小，凭据不会被列出", async () => {
  const { categories } = await m.scanAll();
  const byId = Object.fromEntries(categories.map((c) => [c.id, c]));

  assert.ok(byId["claude-md"].fileCount >= 1, "CLAUDE.md 应被发现");
  assert.ok(byId["claude-skills"].fileCount >= 1, "技能应被发现");
  assert.ok(byId["claude-memory"].fileCount >= 2, "记忆应有 2 个文件");
  assert.ok(byId["claude-sessions"].fileCount >= 1, "会话应被发现");

  // 敏感标记：含凭据风险的分类要标出来
  assert.strictEqual(byId["claude-settings"].sensitive, true);
  assert.strictEqual(byId["claude-sessions"].sensitive, true);
  assert.strictEqual(byId["claude-md"].sensitive, false);
});

test("导出：包内结构正确、manifest 与文件一致", async () => {
  const out = path.join(FAKE_HOME, "out1.tar.gz");
  const r = await m.doExport({
    categories: ["claude-md", "claude-skills", "claude-memory"],
    outputPath: out,
  });

  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(out), "包应存在");

  const entries = listTar(out);
  assert.ok(entries.some((e) => e.includes("manifest.json")), "应有 manifest");
  assert.ok(entries.some((e) => e.includes("data/claude/CLAUDE.md")), "应有 CLAUDE.md");
  assert.ok(entries.some((e) => e.includes("data/claude/skills/my-skill/SKILL.md")));
  assert.ok(entries.some((e) => e.includes("data/claude/projects/C--ws/memory/MEMORY.md")));

  // manifest 自洽
  const manifest = JSON.parse(readFromTar(out, "manifest.json"));
  // v2 起增加 customItems（导入端据此判断要不要走自定义流程）
  assert.strictEqual(manifest.formatVersion, 2);
  assert.ok(Array.isArray(manifest.items) && manifest.items.length > 0);
  for (const it of manifest.items) {
    assert.ok(it.relPath && it.sha256, "每项都要有 relPath + sha256");
    assert.ok(it.restore && it.restore.target, "每项都要有恢复目标");
    assert.ok(
      entries.some((e) => e.includes(`data/${it.relPath}`)),
      `manifest 里的 ${it.relPath} 必须真在包里`,
    );
  }
});

// 🔴 安全属性 —— 这是本插件存在的第一理由
test("安全：凭据文件绝不出现在包里（即使导出全部分类）", async () => {
  const out = path.join(FAKE_HOME, "out-all.tar.gz");
  const { categories } = await m.scanAll();
  const allIds = categories.map((c) => c.id);

  await m.doExport({ categories: allIds, outputPath: out });
  const entries = listTar(out);

  const forbidden = [".credentials.json", "plugin-signing.key", ".env.active"];
  for (const f of forbidden) {
    assert.ok(
      !entries.some((e) => e.toLowerCase().endsWith(f.toLowerCase())),
      `凭据文件 ${f} 绝不能进包（实际 entries 里出现了）`,
    );
  }
});

// 🔴 安全属性 —— settings.json 的 env 段必须被剥离
test("安全：settings.json 的 env 段被剥离，并在 manifest 留痕", async () => {
  const out = path.join(FAKE_HOME, "out-settings.tar.gz");
  const r = await m.doExport({
    categories: ["claude-settings"],
    outputPath: out,
  });

  const settingsTxt = readFromTar(out, "data/claude/settings.json");
  assert.ok(
    !settingsTxt.includes("sk-LEAK-ME-PLEASE"),
    "API key 绝不能出现在包内的 settings.json 里",
  );
  assert.ok(!settingsTxt.includes('"env"'), "env 段应整段消失");

  const parsed = JSON.parse(settingsTxt);
  assert.strictEqual(parsed.theme, "dark", "其它设置必须保留");
  assert.strictEqual(parsed.uiFontSize, 100);

  // 留痕：恢复端能看出少了什么
  assert.ok(
    r.redactions.some((x) => x.path === "env"),
    "manifest.redactions 应记录 env 被剥离",
  );
  const manifest = JSON.parse(readFromTar(out, "manifest.json"));
  assert.ok(manifest.redactions.some((x) => x.path === "env"));
});

test("导出：默认选择不含会话历史（体积大）", async () => {
  const out = path.join(FAKE_HOME, "out-default.tar.gz");
  const r = await m.doExport({ outputPath: out }); // 不传 categories
  const entries = listTar(out);

  assert.ok(!entries.some((e) => e.endsWith(".jsonl")), "默认不导会话历史");
  assert.ok(entries.some((e) => e.includes("CLAUDE.md")), "默认包含个人指令");
  assert.ok(r.categories.length > 0);
});

test("导出：显式指定时才导会话历史", async () => {
  const out = path.join(FAKE_HOME, "out-sessions.tar.gz");
  await m.doExport({ categories: ["claude-sessions"], outputPath: out });
  const entries = listTar(out);
  assert.ok(
    entries.some((e) => e.endsWith(".jsonl")),
    "显式勾选后会话历史应进包",
  );
});

test("导出：空选择报错（而不是静默产生空包）", async () => {
  await assert.rejects(
    () => m.doExport({ categories: ["不存在的分类"], outputPath: path.join(FAKE_HOME, "x.tar.gz") }),
    /没有选中任何分类/,
  );
});
