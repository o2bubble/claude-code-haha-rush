// ── 自带 tar 打包器 ──
//
// 🔴 为什么要自己写（2026-10-26 被坑三轮）：
// Windows 上 PATH 里可能有两个 tar：
//   · `C:\Program Files\Git\usr\bin\tar.exe` —— GNU tar 1.35，支持 `--force-local`
//   · `C:\WINDOWS\system32\tar.exe`        —— bsdtar 3.8.9，**不支持**
// 命令行（Git Bash）解析到 GNU tar 一切正常；**GUI 插件进程落到 bsdtar** →
// `Option --force-local is not supported`，返回码 1，什么都没产出。
// 而我们为了避开 `C:` 被当主机名，`--force-local` 是必需的。
//
// 所以改成纯 Node 实现（tar 格式 + zlib），不依赖 PATH 里有哪个 tar。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const {
  packDirectory,
  listArchive,
  extractArchive,
  readEntry,
} = require("./tar-writer.cjs");

const GNU = "C:\\Program Files\\Git\\usr\\bin\\tar.exe";
const hasGnu = process.platform === "win32" && fs.existsSync(GNU);

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tw-${tag}-`));
}
function w(p, c) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
}
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

test("打包 → 自解析：条目与内容都对", async () => {
  const src = tmp("basic");
  w(path.join(src, "root.txt"), "root");
  w(path.join(src, "a", "one.txt"), "one");
  w(path.join(src, "a", "b", "two.txt"), "two");
  w(path.join(src, "中文名.md"), "# 中文");
  w(path.join(src, "empty.txt"), "");
  fs.writeFileSync(path.join(src, "big.bin"), Buffer.alloc(100000, 7));

  const gz = path.join(os.tmpdir(), `tw-${Date.now()}.tar.gz`);
  const r = await packDirectory(src, gz);
  assert.ok(r.entries >= 6, `条目数应 ≥6，实际 ${r.entries}`);
  assert.ok(fs.statSync(gz).size > 0);

  const names = await listArchive(gz);
  for (const want of ["root.txt", "a/one.txt", "a/b/two.txt", "中文名.md", "empty.txt", "big.bin"]) {
    assert.ok(names.some((n) => n.endsWith(want)), `包内应有 ${want}`);
  }

  const ex = tmp("ex");
  const st = await extractArchive(gz, ex);
  assert.ok(st.files >= 6);
  assert.strictEqual(fs.readFileSync(path.join(ex, "root.txt"), "utf8"), "root");
  assert.strictEqual(fs.readFileSync(path.join(ex, "中文名.md"), "utf8"), "# 中文");
  assert.strictEqual(fs.statSync(path.join(ex, "big.bin")).size, 100000);
  assert.strictEqual(fs.statSync(path.join(ex, "empty.txt")).size, 0);

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(ex, { recursive: true, force: true });
  fs.unlinkSync(gz);
});

test("超长路径（>100 字节）用 GNU LongLink，解包后名字完整", async () => {
  const src = tmp("long");
  const deep = path.join(src, "a".repeat(60), "b".repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  const longName = "device-ipad-horizontal-exclamation.svg";
  fs.writeFileSync(path.join(deep, longName), "<svg/>");

  const rel = path.relative(src, path.join(deep, longName));
  assert.ok(Buffer.byteLength(rel, "utf8") > 100, "测试前提：路径必须超过 100 字节");

  const gz = path.join(os.tmpdir(), `twl-${Date.now()}.tar.gz`);
  await packDirectory(src, gz);

  // listArchive 必须报完整名（不是截断名）
  const names = await listArchive(gz);
  assert.ok(
    names.some((n) => n.endsWith(`${"b".repeat(60)}/${longName}`)),
    `listArchive 应返回完整长名，实际: ${names.map((n) => n.slice(-40)).join(" | ")}`,
  );

  // 解包后文件必须真实存在且内容正确
  const ex = tmp("lex");
  await extractArchive(gz, ex);
  const back = path.join(ex, rel);
  assert.ok(fs.existsSync(back), "超长路径的文件必须能解出来");
  assert.strictEqual(fs.readFileSync(back, "utf8"), "<svg/>");

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(ex, { recursive: true, force: true });
  fs.unlinkSync(gz);
});

test("长目录名 + 长文件名不会互相截断撞车", async () => {
  // 这是之前踩的坑：header 的截断逻辑和判断逻辑不一致，
  // 长目录和长文件截断后同名 → 解包 EISDIR。
  const src = tmp("collide");
  const d1 = path.join(src, "x".repeat(90));
  const d2 = path.join(src, "x".repeat(90) + "different");
  fs.mkdirSync(d1, { recursive: true });
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d1, "f.txt"), "one");
  fs.writeFileSync(path.join(d2, "f.txt"), "two");

  const gz = path.join(os.tmpdir(), `twc-${Date.now()}.tar.gz`);
  await packDirectory(src, gz);
  const ex = tmp("cex");
  await extractArchive(gz, ex);

  assert.strictEqual(fs.readFileSync(path.join(ex, "x".repeat(90), "f.txt"), "utf8"), "one");
  assert.strictEqual(
    fs.readFileSync(path.join(ex, "x".repeat(90) + "different", "f.txt"), "utf8"),
    "two",
  );

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(ex, { recursive: true, force: true });
  fs.unlinkSync(gz);
});

test("readEntry 能按名字取内容（含中文名）", async () => {
  const src = tmp("re");
  w(path.join(src, "a.txt"), "AAA");
  w(path.join(src, "中文.md"), "中文内容");
  const gz = path.join(os.tmpdir(), `twr-${Date.now()}.tar.gz`);
  await packDirectory(src, gz);

  assert.strictEqual(await readEntry(gz, "a.txt"), "AAA");
  assert.strictEqual(await readEntry(gz, "./a.txt"), "AAA", "带 ./ 前缀也要能找到");
  assert.strictEqual(await readEntry(gz, "中文.md"), "中文内容");
  assert.strictEqual(await readEntry(gz, "nope.txt"), null);

  fs.rmSync(src, { recursive: true, force: true });
  fs.unlinkSync(gz);
});

test("安全：包内 `../` 路径逃逸必须被拒绝", async () => {
  // 手工造一个含 ../ 的恶意包
  const mkHeader = (name, size, type = 0x30) => {
    const h = Buffer.alloc(512, 0);
    Buffer.from(name).copy(h, 0, 0, Math.min(Buffer.byteLength(name), 100));
    h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
    h.write("0000000\0", 136, 8);
    h.write("        ", 148, 8);
    h[156] = type;
    Buffer.from("ustar\0").copy(h, 257);
    Buffer.from("00").copy(h, 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    return h;
  };
  const body = Buffer.from("PWNED");
  const pad = (512 - (body.length % 512)) % 512;
  const tar = Buffer.concat([
    mkHeader("../pwned.txt", body.length),
    body,
    Buffer.alloc(pad, 0),
    Buffer.alloc(1024, 0),
  ]);
  const evil = path.join(os.tmpdir(), `evil-${Date.now()}.tar.gz`);
  fs.writeFileSync(evil, zlib.gzipSync(tar));

  const ex = tmp("evil");
  await assert.rejects(
    () => extractArchive(evil, ex),
    /拒绝解压/,
    "路径逃逸的包必须被拒绝，不能写到目标目录之外",
  );
  assert.ok(!fs.existsSync(path.join(path.dirname(ex), "pwned.txt")), "绝不能真的写出去");

  fs.rmSync(ex, { recursive: true, force: true });
  fs.unlinkSync(evil);
});

test("产出的包是标准 tar.gz（GNU tar 能读）", { skip: !hasGnu && "本机没有 GNU tar" }, async () => {
  const src = tmp("std");
  w(path.join(src, "a.txt"), "x");
  w(path.join(src, "d", "b.txt"), "y");
  const gz = path.join(os.tmpdir(), `tws-${Date.now()}.tar.gz`);
  await packDirectory(src, gz);

  const list = execFileSync(GNU, ["--force-local", "-tzf", gz], {
    encoding: "utf8", stdio: "pipe",
  });
  const names = list.split("\n").filter(Boolean);
  assert.ok(names.some((n) => n.endsWith("a.txt")));
  assert.ok(names.some((n) => n.endsWith("b.txt")));

  // 真解一遍，内容对得上。
  // ⚠️ 不用 `-C <绝对路径>` —— 加 `--force-local` 后 tar 会把 `C:` 转义坏
  // （这正是我们当初自己写打包器的原因之一）。改成 cwd + 相对包名。
  const ex = tmp("sex");
  fs.copyFileSync(gz, path.join(ex, "pkg.tgz"));
  execFileSync(GNU, ["--force-local", "-xzf", "pkg.tgz"], { cwd: ex, stdio: "pipe" });
  fs.unlinkSync(path.join(ex, "pkg.tgz"));
  assert.strictEqual(fs.readFileSync(path.join(ex, "a.txt"), "utf8"), "x");
  assert.strictEqual(fs.readFileSync(path.join(ex, "d", "b.txt"), "utf8"), "y");

  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(ex, { recursive: true, force: true });
  fs.unlinkSync(gz);
});

test("打包不依赖 PATH 里的 tar（纯 Node）", async () => {
  const src = readFileSyncSafe(path.join(__dirname, "tar-writer.cjs"));
  assert.ok(
    !/execFile|spawn|execSync/.test(src),
    "tar-writer 不能调用外部进程 —— 那正是 bsdtar 坑的根源",
  );
  assert.ok(src.includes('require("zlib")'), "应使用 Node 内置 zlib 做 gzip");
});

function readFileSyncSafe(p) {
  return fs.readFileSync(p, "utf8");
}
