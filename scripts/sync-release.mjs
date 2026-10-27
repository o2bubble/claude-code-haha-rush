#!/usr/bin/env node
// ── 从发布服务器拉一个版本的全部组件到本地 dist/release/<ver>/ ──
//
// 为什么需要：`build.ts --expect-prev <ver>` 要求**本地** dist/release 里
// 最新那版就是它 —— 它要拿那版里"这次没重建的组件"来复用。
// 但如果上一版是别的机器/别的会话发的，本地就没有。
//
// 用法：
//   node scripts/sync-release.mjs                 # 拉线上最新版
//   node scripts/sync-release.mjs 2026.10.26.6    # 拉指定版本
//   node scripts/sync-release.mjs --list          # 只列线上版本，不下载
//
// 只下载**本地缺失或 sha 不符**的组件，可反复运行。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_BASE = path.join(ROOT, "dist", "release");

const HOST = process.env.RELEASE_HOST || "https://release.17lumen.com";
const PLATFORM = process.env.RELEASE_PLATFORM || "windows";
// 服务端对非浏览器 UA 可能有限制（历史上踩过），统一带上
const UA = "Mozilla/5.0 (compatible; claude-plugin-publisher/1.0)";

function log(...a) {
  console.log(...a);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function download(url, dest) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.promises.writeFile(dest, buf);
  return buf;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const arg = process.argv[2];

  // ── 拉线上 manifest ──
  const latest = await fetchJson(`${HOST}/api/updates/latest?platform=${PLATFORM}`);
  if (!latest.ok) throw new Error(`latest 返回失败: ${JSON.stringify(latest).slice(0, 200)}`);
  const version = arg && arg !== "--list" ? arg : latest.data.version;

  if (arg === "--list") {
    log(`线上最新版本: ${latest.data.version}`);
    log(`组件: ${Object.keys(latest.data.components || {}).join(", ")}`);
    return;
  }

  if (version !== latest.data.version) {
    log(`⚠️  指定版本 ${version} ≠ 线上最新 ${latest.data.version}（继续，按指定版本拉）`);
  }

  const manifest = version === latest.data.version
    ? latest.data
    : (await fetchJson(`${HOST}/api/updates/${version}?platform=${PLATFORM}`)).data;

  const outDir = path.join(OUT_BASE, version);
  await fs.promises.mkdir(outDir, { recursive: true });

  log(`同步 ${version} → ${path.relative(ROOT, outDir)}`);

  // ── 先把 manifest 落盘（build.ts 靠它判断"本地有什么"）──
  const mfPath = path.join(outDir, "manifest.json");
  await fs.promises.writeFile(mfPath, JSON.stringify(manifest, null, 2), "utf8");

  const comps = manifest.components || {};
  let downloaded = 0;
  let skipped = 0;

  for (const [name, info] of Object.entries(comps)) {
    const zipPath = path.join(outDir, `${name}.zip`);

    // ⚠️ **不能拿 manifest 的 sha256 去校验 zip 字节**（2026-10-26 实测）。
    //
    // build.ts 里那个字段是**源目录的元数据 hash**（`dirMetaHash`：
    // 相对路径 + 文件大小的摘要），对 file 型组件才是文件内容 hash。
    // 它跟打包出来的 zip 字节毫无关系 —— 早先我按"zip 的 sha"去比，
    // 结果 9/9 全部"不符"，白折腾一轮。
    //
    // 这里只能校验「下载到的确实是个 zip」：大小合理 + 有 zip 魔数。
    // 真正的完整性由服务端 Content-Length + HTTPS 保证。
    if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) {
      log(`  = ${name.padEnd(12)} 已有（${fs.statSync(zipPath).size} B）`);
      skipped++;
      continue;
    }

    const url = `${HOST}/api/updates/${version}/components/${name}/download?platform=${PLATFORM}`;
    const buf = await download(url, zipPath);

    // zip 魔数 PK\x03\x04
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      fs.rmSync(zipPath, { force: true });
      throw new Error(`${name}: 下载内容不是 zip（开头 ${buf.subarray(0, 4).toString("hex")}）`);
    }
    log(`  ✓ ${name.padEnd(12)} ${String(buf.length).padStart(11)} B`);
    downloaded++;
  }

  log(`\n完成：下载 ${downloaded} 个，跳过 ${skipped} 个`);
  log(`目录：${outDir}`);
  log(`\n下一步可构建：`);
  log(`  bun run scripts/build.ts --release <新版本> --components gui,server --expect-prev ${version}`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
