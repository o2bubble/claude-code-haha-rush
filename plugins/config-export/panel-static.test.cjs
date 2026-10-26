// ── 面板静态检查：别让「变量漏声明」再次静默卡死 ──
//
// 🔴 2026-10-25 真实故障：面板一直显示「正在扫描…」，永远出不来。
//
// 根因：拆「添加文件 / 添加目录」两个按钮时，给 `$addCustomDirBtn`
// 挂了 addEventListener，**却忘了 `var $addCustomDirBtn = ...`**。
// 脚本执行到那行抛 `ReferenceError` → **整个 <script> 中止**
// → 末尾的 `scan()` 永远不执行 → 页面停在初始 HTML 的占位文案。
//
// 这类 bug 的特征：**没有报错、没有提示、就是不动**。
// 光看代码很难发现（缺一行 var），所以用静态检查锁死。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const HTML = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");
const SCRIPT = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

/** 抽出的 `$xxx` 形式变量（排除模板字符串里的 shell/nginx 变量） */
function dollarVars(code) {
  const used = new Set();
  for (const m of code.matchAll(/(^|[^a-zA-Z0-9_$])(\$[a-zA-Z][a-zA-Z0-9_]*)/g)) {
    used.add(m[2]);
  }
  const declared = new Set();
  for (const m of code.matchAll(/(?:var|let|const)\s+(\$[a-zA-Z][a-zA-Z0-9_]*)/g)) {
    declared.add(m[1]);
  }
  return { used, declared };
}

test("脚本语法正确", () => {
  assert.doesNotThrow(() => new Function(SCRIPT), "面板 <script> 必须能解析");
});

test("所有 $ 变量都已声明（漏声明会让整个脚本中止）", () => {
  const { used, declared } = dollarVars(SCRIPT);
  const missing = [...used].filter((v) => !declared.has(v));
  assert.deepStrictEqual(
    missing,
    [],
    `未声明的变量会让脚本在第 N 行抛 ReferenceError、后续全部不执行：${missing.join(", ")}`,
  );
});

test("脚本末尾有 initStep 包裹（初始化失败要能看见，不能静默卡死）", () => {
  assert.ok(SCRIPT.includes("function initStep"), "应有 initStep");
  assert.ok(
    /initStep\(\s*["']scan["']/.test(SCRIPT),
    "scan 必须被 initStep 包裹 —— 否则前面的错会让它不执行，页面永远停在「正在扫描…」",
  );
});

test("scan() 里的 fetch 有 .catch 并会写错误到界面", () => {
  const seg = SCRIPT.slice(SCRIPT.indexOf("function scan()"));
  const body = seg.slice(0, seg.indexOf("\n}") + 2);
  assert.ok(body.includes(".catch"), "fetch 必须有 catch");
  assert.ok(
    body.includes("扫描失败"),
    "失败时要显示「扫描失败」而不是停在上一个状态",
  );
});

test("所有按钮 id 都有对应的 getElementById 引用", () => {
  const ids = [...HTML.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  const read = new Set([...SCRIPT.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]));
  const unused = ids.filter((id) => !read.has(id));
  assert.deepStrictEqual(unused, [], `按钮存在但脚本没取引用：${unused.join(", ")}`);
});
