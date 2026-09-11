import { isDarkTheme, normalizeTheme, DARK_THEMES } from "./themeUtils";

console.log("=== isDarkTheme tests ===\n");
const isDarkCases = [
  { input: "light", expect: false },
  { input: "dark", expect: true },
  { input: "dark-a", expect: true },
  { input: "dark-b", expect: true },
  { input: undefined, expect: false },
  { input: null, expect: false },
  { input: "", expect: false },
  { input: "dark-c", expect: false },
];
let pass = 0, fail = 0;
for (const t of isDarkCases) {
  const ok = isDarkTheme(t.input) === t.expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} isDarkTheme(${JSON.stringify(t.input)}) → ${isDarkTheme(t.input)} (expected ${t.expect})`);
}

console.log("\n=== normalizeTheme tests ===\n");
const normCases = [
  { input: "light", expect: "light" },
  { input: "dark", expect: "dark" },
  { input: "dark-a", expect: "dark-a" },
  { input: "dark-b", expect: "dark-b" },
  { input: undefined, expect: "light" },
  { input: "", expect: "light" },
  { input: "DARK", expect: "light" },
  { input: "dark-c", expect: "light" },
];
for (const t of normCases) {
  const ok = normalizeTheme(t.input) === t.expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} normalizeTheme(${JSON.stringify(t.input)}) → ${normalizeTheme(t.input)} (expected ${t.expect})`);
}

console.log(`\nDARK_THEMES: ${JSON.stringify(DARK_THEMES)}`);
console.log(`\n${pass}/${isDarkCases.length + normCases.length} passed, ${fail} failed`);
