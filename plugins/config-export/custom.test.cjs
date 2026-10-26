// ── 自定义项：规范化 + 重叠检测 ──
//
// ⚠️ Windows 路径在 JS 字符串里必须写双反斜杠 —— 用 String.raw 更省事。
// （第一次写这些测试时用 heredoc 生成，反斜杠被 bash 吃掉，整段语法错误。）

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");

const m = require("./export-server.cjs");

const W = String.raw; // W`C:\a\b` → "C:\\a\\b" 的字面值

test("normalizeCustomItem: 只有 path 时用目录名当 label/id", () => {
  const c = m.normalizeCustomItem({ path: W`C:\backup\my-scheme` });
  assert.strictEqual(c.label, "my-scheme");
  assert.strictEqual(c.id, "my-scheme");
  assert.ok(!c.entryDoc, "未指定时为假值（空串）");
});

test("normalizeCustomItem: 保留用户给的元信息", () => {
  const c = m.normalizeCustomItem({
    path: W`C:\backup\x`,
    label: "X 盘两机同步",
    entryDoc: "00_迁移总览.md",
    notes: "自建方案",
    importPrompt: "先跑 04 再跑 06",
    verifyPrompt: "跑 07 验证",
  });
  assert.strictEqual(c.label, "X 盘两机同步");
  assert.strictEqual(c.entryDoc, "00_迁移总览.md");
  assert.ok(c.importPrompt.includes("04"));
  assert.ok(c.verifyPrompt.includes("07"));
});

test("normalizeCustomItem: 无 path → null", () => {
  assert.strictEqual(m.normalizeCustomItem({}), null);
  assert.strictEqual(m.normalizeCustomItem({ path: "  " }), null);
  assert.strictEqual(m.normalizeCustomItem(null), null);
});

test("normalizeCustomItem: id 被 slug 化（包内目录名必须安全）", () => {
  const c = m.normalizeCustomItem({ path: W`C:\x`, label: "我的 方案/带斜杠" });
  assert.ok(!/[^a-zA-Z0-9_-]/.test(c.id), `id 含非法字符: ${c.id}`);
  assert.strictEqual(c.label, "我的 方案/带斜杠", "label 保持原样（给人看）");
});

// ── 重叠检测 ──

test("detectOverlaps: 找出自定义项与内置分类的公共文件", () => {
  const custom = [{ id: "mine", paths: new Set([W`C:\a\1.md`, W`C:\a\2.md`, W`C:\a\uniq.md`]) }];
  const builtin = [{ id: "claude-md", label: "个人指令", paths: new Set([W`C:\a\1.md`, W`C:\a\2.md`]) }];
  const out = m.detectOverlaps(custom, builtin);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].customId, "mine");
  assert.strictEqual(out[0].overlaps.length, 1);
  assert.strictEqual(out[0].overlaps[0].shared, 2, "应有 2 个重叠");
  assert.strictEqual(out[0].overlaps[0].category, "claude-md");
});

test("detectOverlaps: 无重叠 → overlaps 为空数组", () => {
  const custom = [{ id: "mine", paths: new Set([W`C:\zzz\x.md`]) }];
  const builtin = [{ id: "claude-md", label: "L", paths: new Set([W`C:\a\1.md`]) }];
  const out = m.detectOverlaps(custom, builtin);
  assert.deepStrictEqual(out[0].overlaps, []);
});

test("detectOverlaps: 路径大小写不敏感（Windows）", () => {
  const custom = [{ id: "m", paths: new Set([W`C:\A\File.MD`]) }];
  const builtin = [{ id: "b", label: "L", paths: new Set([W`c:\a\file.md`]) }];
  assert.strictEqual(m.detectOverlaps(custom, builtin)[0].overlaps[0].shared, 1);
});

test("detectOverlaps: 多个内置分类各算各的", () => {
  const custom = [{ id: "m", paths: new Set([W`C:\a\1`, W`C:\a\2`]) }];
  const builtin = [
    { id: "b1", label: "一", paths: new Set([W`C:\a\1`]) },
    { id: "b2", label: "二", paths: new Set([W`C:\a\2`]) },
  ];
  const o = m.detectOverlaps(custom, builtin)[0].overlaps;
  assert.strictEqual(o.length, 2);
  assert.strictEqual(o.find((x) => x.category === "b1").shared, 1);
  assert.strictEqual(o.find((x) => x.category === "b2").shared, 1);
});

// ── 自定义项与黑名单的关系 ──

test("黑名单只作用于内置采集，不作用于用户自定义目录", () => {
  // **有意的**：用户自己备份目录里的 profile.env 是他们方案的组成部分，
  // 插件无权替他们删。但内置的 profile.env 仍被拦。
  const inner = path.join(os.homedir(), ".claude", "profile.env");
  assert.strictEqual(m.isNeverExport(inner), true, "内置的照样拦");
  // 自定义项的采集不调用 isNeverExport —— 由 doExport 的实现保证（见 e2e）
});

// ── 单文件自定义项（面板之前只让选目录，但后端一直支持文件）──

test("normalizeCustomItem: 接受单个文件路径", () => {
  const c = m.normalizeCustomItem({ path: W`C:\docs\我的方案.md`, entryDoc: "我的方案.md" });
  assert.ok(c, "单文件也要能规范化");
  assert.strictEqual(c.label, "我的方案.md", "label 默认用文件名");
  assert.strictEqual(c.entryDoc, "我的方案.md");
});

test("normalizeCustomItem: 单文件的 id 从文件名派生（不含扩展名噪音）", () => {
  const c = m.normalizeCustomItem({ path: W`C:\docs\run.bat` });
  assert.ok(!/[^a-zA-Z0-9_-]/.test(c.id), `id 含非法字符: ${c.id}`);
  assert.ok(c.id.length > 0);
});
