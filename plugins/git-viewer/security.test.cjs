// ── git-viewer-server 安全裁剪函数单测 ──
// 运行: node security.test.cjs（node:test, 无外部依赖——插件包独立, 不挂 vitest）。
// 只测纯函数（sanitizeRepoPath/sanitizeRef/clampInt）——安全白名单核心, 锁定回归。

const test = require("node:test");
const assert = require("node:assert");

// 从 server 文件导出测试接口: server 模块 require 时不该启动监听——用环境变量
// GIT_VIEWER_TEST=1 跳过 listen（server 文件底部守卫）。
const server = require("./git-viewer-server.cjs");

test("sanitizeRepoPath — 合法相对路径", () => {
  assert.strictEqual(server.sanitizeRepoPath("gui/src/App.tsx"), "./gui/src/App.tsx");
  assert.strictEqual(server.sanitizeRepoPath("a/b/c.txt"), "./a/b/c.txt");
});

test("sanitizeRepoPath — 拒绝路径穿越", () => {
  assert.strictEqual(server.sanitizeRepoPath("../etc/passwd"), null);
  assert.strictEqual(server.sanitizeRepoPath("a/../../b"), null);
  assert.strictEqual(server.sanitizeRepoPath(".."), null);
});

test("sanitizeRepoPath — 拒绝绝对/盘符/反斜杠", () => {
  assert.strictEqual(server.sanitizeRepoPath("/etc/passwd"), null);
  assert.strictEqual(server.sanitizeRepoPath("C:/Windows/win.ini"), null);
  assert.strictEqual(server.sanitizeRepoPath("a\\b"), null);
});

test("sanitizeRepoPath — 拒绝空/NUL/超长", () => {
  assert.strictEqual(server.sanitizeRepoPath(""), null);
  assert.strictEqual(server.sanitizeRepoPath(null), null);
  assert.strictEqual(server.sanitizeRepoPath("a\0b"), null);
  assert.strictEqual(server.sanitizeRepoPath("x".repeat(600)), null);
});

test("sanitizeRef — 合法 ref", () => {
  assert.strictEqual(server.sanitizeRef("abc1234"), "abc1234");
  assert.strictEqual(server.sanitizeRef("HEAD"), "HEAD");
  assert.strictEqual(server.sanitizeRef("main"), "main");
  assert.strictEqual(server.sanitizeRef("v1.0.0"), "v1.0.0");
});

test("sanitizeRef — 拒绝 - 前缀(防 flag 注入)", () => {
  assert.strictEqual(server.sanitizeRef("-c"), null);
  assert.strictEqual(server.sanitizeRef("--bare"), null);
  assert.strictEqual(server.sanitizeRef("-o"), null);
});

test("sanitizeRef — 拒绝非法字符/空", () => {
  assert.strictEqual(server.sanitizeRef(""), null);
  assert.strictEqual(server.sanitizeRef(null), null);
  assert.strictEqual(server.sanitizeRef("a b"), null); // 空格
  assert.strictEqual(server.sanitizeRef("a\0b"), null);
  assert.strictEqual(server.sanitizeRef("HEAD;" + "x".repeat(300)), null); // 超长
});

test("clampInt — 默认/clamp/非数字", () => {
  assert.strictEqual(server.clampInt("10", 3, 0, 50), 10);
  assert.strictEqual(server.clampInt("", 3, 0, 50), 3);
  assert.strictEqual(server.clampInt("abc", 3, 0, 50), 3);
  assert.strictEqual(server.clampInt("-5", 0, 0, 50), 0);
  assert.strictEqual(server.clampInt("100", 20, 1, 200), 100);
  assert.strictEqual(server.clampInt("999", 20, 1, 200), 200); // clamp 上限
});
