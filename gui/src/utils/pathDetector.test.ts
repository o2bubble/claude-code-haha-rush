import { findPathsInText, findCodeBlockRanges, findPathsWithWorkspace } from "./pathDetector";

const tests = [
  // Should match (path with separator)
  { input: "src/components/Foo.tsx", expect: 1 },
  { input: "我在 src/utils/pathDetector.ts 中修改了代码", expect: 1 },
  { input: "C:\\Users\\foo\\file.ts", expect: 1 },
  { input: "/home/user/project/index.ts", expect: 1 },
  { input: "我提到了 src/components 目录和 ../bar/baz.ts 文件", expect: 2 },
  { input: "修改了 src/Foo.tsx 和 gui/src-tauri/src/lib.rs", expect: 2 },
  { input: "a/b", expect: 1 },
  { input: "./relative/path/file.ts", expect: 1 },
  // Should NOT match (bare filenames, no separator)
  { input: "Foo.tsx", expect: 0 },
  { input: "components", expect: 0 },
  { input: "README", expect: 0 },
  { input: "纯单词", expect: 0 },
];

console.log("=== Path matching tests ===\n");
let pass = 0, fail = 0;
for (const t of tests) {
  const matches = findPathsInText(t.input);
  const ok = matches.length === t.expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} "${t.input}" → ${matches.length} (expected ${t.expect})${!ok ? ` matches: ${JSON.stringify(matches.map(m => m.path))}` : ""}`);
}
console.log(`\n${pass}/${tests.length} passed, ${fail} failed`);

// Code block exclusion test
console.log("\n=== Code block exclusion ===\n");
const codeBlockTest = "外面的路径 src/Foo.tsx\n```\n里面的路径 src/Bar.tsx\n```\n外面的 again src/Baz.tsx";
const codeRanges = findCodeBlockRanges(codeBlockTest);
console.log("Code block ranges:", JSON.stringify(codeRanges));
const filtered = findPathsInText(codeBlockTest, codeRanges);
console.log("Paths outside code blocks:", filtered.map(m => m.path));
console.log(`Expect 2 (src/Foo.tsx, src/Baz.tsx), got ${filtered.length}`);
console.log(filtered.length === 2 ? "PASS" : "FAIL");

// Offset verification
console.log("\n=== Offset verification ===\n");
const sample = "prefix src/Foo.tsx suffix";
findPathsInText(sample).forEach(m => {
  const slice = sample.slice(m.start, m.end);
  console.log(`path="${m.path}" start=${m.start} end=${m.end} slice="${slice}"`);
  console.log(slice === "src/Foo.tsx" ? "PASS" : "FAIL");
});

// Workspace-with-spaces path matching
console.log("\n=== Workspace path with spaces ===\n");
const ws = "C:\\Users\\张三\\我的工作 空间";
const wsCases: [string, string, number][] = [
  // 绝对路径含工作区空格 → 应匹配为 1 条完整路径
  ["请打开 C:\\Users\\张三\\我的工作 空间\\src\\app.tsx 查看", "C:\\Users\\张三\\我的工作 空间\\src\\app.tsx", 1],
  // 相对路径出现工作区最后一段(含空格) → 也合并为 1 条
  ["修改了 我的工作 空间\\src\\app.tsx 文件", "我的工作 空间\\src\\app.tsx", 1],
  // 工作区无空格 → 行为不变
  ["打开 C:\\Work\\a.ts", "C:\\Work\\a.ts", 1],
];
for (const [input, expected, n] of wsCases) {
  const got = findPathsWithWorkspace(input, ws);
  const ok = got.length === n && got.includes(expected);
  console.log(`${ok ? "PASS" : "FAIL"} "${input}" → ${JSON.stringify(got)}`);
  if (!ok) {
    console.log(`   expected ${n} path(s) including "${expected}"`);
  }
}