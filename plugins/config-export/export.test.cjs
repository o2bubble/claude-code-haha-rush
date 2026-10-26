// ── config-export 纯函数单测 ──
//
// 重点是**安全属性**：凭据永不导出、settings 的 env 段必须被剥离。
// 其余（slug、恢复策略、勾选解析）是行为回归。
//
// 跑法：node --test plugins/config-export/export.test.cjs
// （不依赖 vitest —— 插件目录是独立分发的，不该把宿主的测试框架当依赖）

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");

const m = require("./export-server.cjs");

// ── slug：必须与主仓 sanitizePath 一致（否则记忆/会话目录对不上）──

test("sanitizePath: 非字母数字一律替换成 '-'", () => {
  assert.strictEqual(
    m.sanitizePath("C:/Users/MR/claude-code-workspace"),
    "C--Users-MR-claude-code-workspace",
  );
  assert.strictEqual(m.sanitizePath("D:\\Development\\proj"), "D--Development-proj");
  assert.strictEqual(m.sanitizePath("/usr/local/x"), "-usr-local-x");
  assert.strictEqual(m.sanitizePath("plain"), "plain");
});

test("sanitizePath: 中文/空格/下划线都变 '-'", () => {
  // "我的 项目_a" = 我 的 ␣ 项 目 _ a → 前 6 个非字母数字变 '-'，a 保留
  assert.strictEqual(m.sanitizePath("我的 项目_a"), "------a");
});

test("sanitizePath: 超长时截断并追加稳定 hash（同输入同输出）", () => {
  const long = "a".repeat(500);
  const s1 = m.sanitizePath(long);
  const s2 = m.sanitizePath(long);
  assert.strictEqual(s1, s2, "必须稳定");
  assert.ok(s1.length > 200, "应保留截断后的前缀 + hash");
  assert.ok(s1.startsWith("a".repeat(200)));
});

// ── 安全：凭据永不导出 ──

test("isNeverExport: 认得出凭据文件（大小写不敏感）", () => {
  const cred = path.join(os.homedir(), ".claude", ".credentials.json");
  const key = path.join(os.homedir(), ".claude", "plugin-signing.key");
  assert.strictEqual(m.isNeverExport(cred), true);
  assert.strictEqual(m.isNeverExport(key), true);
  assert.strictEqual(m.isNeverExport(cred.toUpperCase()), true, "Windows 路径大小写不敏感");
});

test("isNeverExport: 普通文件不误判", () => {
  const ok = path.join(os.homedir(), ".claude", "settings.json");
  assert.strictEqual(m.isNeverExport(ok), false);
  assert.strictEqual(m.isNeverExport(path.join(os.homedir(), ".claude", "CLAUDE.md")), false);
});

test("isNeverExport: 按**文件名**兜底 —— 任意目录下的凭据名都拦", () => {
  // 这是**有意的过度拦截**：工作区的 profile.env 路径不固定（每个工作区一份），
  // 光靠绝对路径列表会漏。宁可把别处同名的文件也拦掉 —— 漏掉一个密钥的代价
  // 远大于少导出一个同名文件。
  assert.strictEqual(m.isNeverExport(path.join(os.homedir(), "ws1", ".claude", "profile.env")), true);
  assert.strictEqual(m.isNeverExport(path.join(os.homedir(), "ws2", ".claude", "profile.env")), true);
  assert.strictEqual(m.isNeverExport("C:\\any\\where\\.credentials.json"), true);
});

test("NEVER_EXPORT 覆盖三类凭据", () => {
  const all = m.NEVER_EXPORT.map((p) => path.basename(p));
  assert.ok(all.includes(".credentials.json"), "登录凭据");
  assert.ok(all.includes("plugin-signing.key"), "签名私钥");
  assert.ok(all.includes(".env.active"), "激活的 env（可能含 key）");
});

// ── settings.json 的 env 段必须剥离 ──

test("stripEnv: 剥掉 env，其余保留", () => {
  const { value, stripped } = m.stripEnv({
    theme: "dark",
    env: { ANTHROPIC_API_KEY: "sk-secret" },
  });
  assert.strictEqual(stripped, true);
  assert.strictEqual("env" in value, false, "**env 必须消失**");
  assert.strictEqual(value.theme, "dark", "其它字段不能丢");
});

test("stripEnv: 没有 env 时不动、也不报剥离", () => {
  const src = { theme: "light" };
  const { value, stripped } = m.stripEnv(src);
  assert.strictEqual(stripped, false);
  assert.deepStrictEqual(value, src);
});

test("stripEnv: 不改原对象（调用方可能还要用）", () => {
  const src = { env: { A: "1" }, x: 1 };
  m.stripEnv(src);
  assert.ok("env" in src, "原对象必须保持完整");
});

test("stripEnv: 非对象输入原样返回", () => {
  assert.strictEqual(m.stripEnv(null).stripped, false);
  assert.strictEqual(m.stripEnv("x").value, "x");
});

// ── 排除规则 ──

test("shouldSkip: 安装产物/临时物被跳过", () => {
  assert.strictEqual(m.shouldSkip("node_modules"), true);
  assert.strictEqual(m.shouldSkip("runtime"), true, "插件 runtime 可重下");
  assert.strictEqual(m.shouldSkip("a.zip"), true);
  assert.strictEqual(m.shouldSkip("__pycache__"), true);
  assert.strictEqual(m.shouldSkip("gui-instance.lock"), true);
});

test("shouldSkip: 正常文件不跳过", () => {
  assert.strictEqual(m.shouldSkip("MEMORY.md"), false);
  assert.strictEqual(m.shouldSkip("settings.json"), false);
  assert.strictEqual(m.shouldSkip("SKILL.md"), false);
});

// ── 恢复策略 ──

test("restoreTargetFor: 三类路径映射到各自的恢复目标", () => {
  assert.strictEqual(m.restoreTargetFor("claude/settings.json"), "~/.claude/settings.json");
  assert.strictEqual(
    m.restoreTargetFor("gui/plugins-settings/pointer.json"),
    "%APPDATA%/com.claudecode.gui/plugins-settings/pointer.json",
  );
  // slug 只是包内区分工作区的目录名，不是恢复目标的一部分：
  // 目标是"某个工作区的 .claude/data.db"，具体哪个由 manifest 的
  // source.workspaces（slug → absPath）决定。
  assert.strictEqual(
    m.restoreTargetFor("workspaces/C--ws/data.db"),
    "<workspace>/.claude/data.db",
  );
  assert.strictEqual(
    m.restoreTargetFor("workspaces/C--ws/settings.local.json"),
    "<workspace>/.claude/settings.local.json",
  );
});

test("restoreModeFor: settings 合并 / CLAUDE.md 追加 / 记忆与 DB 需人工", () => {
  assert.strictEqual(m.restoreModeFor("claude/settings.json"), "merge");
  assert.strictEqual(m.restoreModeFor("claude/CLAUDE.md"), "append");
  assert.strictEqual(m.restoreModeFor("claude/projects/x/memory/MEMORY.md"), "manual");
  assert.strictEqual(m.restoreModeFor("workspaces/x/data.db"), "manual");
  assert.strictEqual(m.restoreModeFor("claude/projects/x/abc.jsonl"), "overwrite");
});

// ── 勾选解析 ──

test("resolveSelection: 未指定时用 defaultOn", () => {
  const all = [
    { id: "a", defaultOn: true },
    { id: "b", defaultOn: false },
  ];
  const picked = m.resolveSelection(all, undefined);
  assert.deepStrictEqual(picked.map((c) => c.id), ["a"]);
});

test("resolveSelection: 显式指定时以用户为准（可选到默认关闭的项）", () => {
  const all = [
    { id: "a", defaultOn: true },
    { id: "b", defaultOn: false },
  ];
  const picked = m.resolveSelection(all, ["b"]);
  assert.deepStrictEqual(picked.map((c) => c.id), ["b"], "用户勾了默认关闭的也要导出");
});

test("resolveSelection: 空数组 = 用默认（不是'什么都不选'）", () => {
  const all = [{ id: "a", defaultOn: true }];
  assert.deepStrictEqual(m.resolveSelection(all, []).map((c) => c.id), ["a"]);
});

// ── 分类定义的结构约束 ──

test("categoryDefs: 每个分类 id 唯一，且有 collect()", () => {
  const defs = m.categoryDefs([{ absPath: "C:/ws", name: "ws" }]);
  const ids = defs.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length, "id 不能重复");
  for (const d of defs) {
    assert.strictEqual(typeof d.collect, "function", `${d.id} 缺 collect()`);
    assert.ok(d.label, `${d.id} 缺 label`);
  }
});

test("categoryDefs: 会话历史默认关闭且标记敏感", () => {
  const defs = m.categoryDefs([]);
  const sess = defs.find((d) => d.id === "claude-sessions");
  assert.strictEqual(sess.defaultOn, false, "几百 MB + 全部对话明文，默认不勾");
  assert.strictEqual(sess.sensitive, true);
});

test("categoryDefs: 工作区分类按传入的 workspace 生成，slug 用同类算法", () => {
  const defs = m.categoryDefs([{ absPath: "C:/Users/MR/ws", name: "ws" }]);
  const wsDefs = defs.filter((d) => d.group === "workspace");
  assert.ok(wsDefs.length >= 2, "每个工作区应有 settings + db 两类");
  assert.ok(wsDefs.every((d) => d.workspaceSlug === "C--Users-MR-ws"));
});

// ── tsStamp ──

test("tsStamp: 形如 20261025-1930（定长、可排序）", () => {
  const s = m.tsStamp(new Date(2026, 9, 25, 19, 30));
  assert.strictEqual(s, "20261025-1930");
});
