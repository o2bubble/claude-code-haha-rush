#!/usr/bin/env node
// ── gui-manual 构建脚本 ──
//
// 一份源 → 两种产物（同源，保证用户看到的和 AI 读到的一致）：
//
//   docs/gui/features.md  ─┬─→ skill/chapters/NN-xxx.md   给 AI（按章读取，每次约 1K tokens）
//                          └─→ manual.html                给用户（预渲染 + 搜索 + 目录导航）
//
// 用法：node plugins/gui-manual/build.mjs
// 改动手册后必须重跑（产物是提交进仓库的，用户装插件即用）。

import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const SELF_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SELF_DIR, '../..');
const SRC = path.join(REPO_ROOT, 'docs/gui/features.md');
const SKILL_DIR = path.join(SELF_DIR, 'skill');
const CHAPTER_DIR = path.join(SKILL_DIR, 'chapters');
const TEMPLATE = path.join(SELF_DIR, 'panel.template.html');
const OUT_HTML = path.join(SELF_DIR, 'manual.html');

// ── 解析：切出 章节（##）与 功能点（###）──

function parseManual(md) {
  const lines = md.split('\n');
  const head = [];          // 文档标题 + 引言（构建章节文件时不需要，面板里可当封面）
  const chapters = [];
  let cur = null;
  let item = null;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      cur = { title: line.slice(3).trim(), preamble: [], items: [] };
      chapters.push(cur);
      item = null;
    } else if (line.startsWith('### ')) {
      item = { title: line.slice(4).trim(), body: [] };
      if (cur) cur.items.push(item);
    } else if (item) {
      item.body.push(line);
    } else if (cur) {
      cur.preamble.push(line);
    } else {
      head.push(line);
    }
  }
  return { head, chapters };
}

// ── 文件名：稳定、可读、跨平台安全 ──

function chapterFileName(title, idx) {
  const n = String(idx + 1).padStart(2, '0');
  const clean = title
    .replace(/^\d+\.\s*/, '')              // 去掉 "1. " 前缀
    .replace(/附录\s*([AB])\s*[：:]\s*/, '附录$1-')  // 附录 A：xxx → 附录A-xxx
    .replace(/[\\/:*?"<>|]/g, '-')          // 文件系统非法字符
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${n}-${clean}.md`;
}

/** 纯文本化（用于搜索索引 —— 去掉 markdown 记号） */
function plainText(s) {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[\s>*-]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 主流程 ──

const md = fs.readFileSync(SRC, 'utf8');
// ⚠️ 源文件可能是 CRLF（Windows 上 git 检出常见）—— 按行切之前先统一成 LF，
// 否则每行尾部残留 \r，会捣乱"\n{3,}"这类跨行正则（实测：章节文件标题后多出一个 \r 空行）。
const normalized = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const { chapters } = parseManual(normalized);
if (chapters.length === 0) {
  console.error('✗ 解析失败：没找到任何 ## 章节');
  process.exit(1);
}

// ① 给 AI 的章节文件
fs.mkdirSync(CHAPTER_DIR, { recursive: true });
// 先清掉旧章节（章节改名/删除时不留孤儿文件）
for (const f of fs.readdirSync(CHAPTER_DIR)) {
  if (f.endsWith('.md')) fs.unlinkSync(path.join(CHAPTER_DIR, f));
}

const toc = [];   // [{ n, title, file, items: [title] }]
chapters.forEach((ch, i) => {
  const file = chapterFileName(ch.title, i);
  const body = [
    `# ${ch.title}`,
    '',
    ...ch.preamble,
    ...ch.items.flatMap((it) => [`### ${it.title}`, '', ...it.body]),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  // LF 换行（跨平台一致；Windows 上别写 CRLF）
  fs.writeFileSync(path.join(CHAPTER_DIR, file), body, { encoding: 'utf8' });
  toc.push({ n: i + 1, title: ch.title, file, items: ch.items.map((x) => x.title) });
});

// ② 给用户的面板 HTML
const chaptersHtml = chapters.map((ch, i) => {
  const preamble = ch.preamble.join('\n').trim();
  const items = ch.items.map((it, j) => `
      <article class="item" id="fn-${i}-${j}">
        <h3>${marked.parseInline(it.title)}</h3>
        ${marked.parse(it.body.join('\n'))}
      </article>`).join('');
  return `
    <section class="chapter" id="ch-${i}">
      <h2>${marked.parseInline(ch.title)}</h2>
      ${preamble ? marked.parse(preamble) : ''}${items}
    </section>`;
}).join('');

const searchIndex = chapters.flatMap((ch, i) =>
  ch.items.map((it, j) => ({
    ch: i, id: `fn-${i}-${j}`,
    chapter: ch.title,
    title: plainText(it.title),
    text: plainText(it.body.join(' ')).slice(0, 400),
  })),
);

const navHtml = chapters.map((ch, i) => {
  const items = ch.items.map((it, j) =>
    `<a class="nav-item" href="#fn-${i}-${j}" data-target="fn-${i}-${j}">${plainText(it.title)}</a>`,
  ).join('');
  return `<div class="nav-chapter" data-ch="${i}">
      <a class="nav-ch" href="#ch-${i}" data-target="ch-${i}">${plainText(ch.title)}</a>
      <div class="nav-items">${items}</div>
    </div>`;
}).join('');

const tpl = fs.readFileSync(TEMPLATE, 'utf8');
const out = tpl
  .replace('<!--NAV-->', navHtml)
  .replace('<!--CONTENT-->', chaptersHtml)
  .replace('/*INDEX*/', JSON.stringify(searchIndex))
  .replace('<!--META-->', `共 ${chapters.length} 章 · ${searchIndex.length} 个功能点`);
fs.writeFileSync(OUT_HTML, out, { encoding: 'utf8' });

// ③ 更新 SKILL.md 的章节索引（标记区自动生成，防手写漂移）
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
if (fs.existsSync(SKILL_MD)) {
  const skill = fs.readFileSync(SKILL_MD, 'utf8');
  const table = [
    '| # | 章节 | 文件 |',
    '|---|---|---|',
    ...toc.map((t) => `| ${t.n} | ${t.title} | \`chapters/${t.file}\` |`),
  ].join('\n');
  const next = skill.replace(
    /(<!--INDEX:BEGIN[^>]*-->)[\s\S]*?(<!--INDEX:END-->)/,
    `$1\n${table}\n$2`,
  );
  if (next === skill && !skill.includes('<!--INDEX:BEGIN')) {
    console.warn('⚠️ SKILL.md 里没有 INDEX 标记区，跳过索引更新');
  } else {
    fs.writeFileSync(SKILL_MD, next, { encoding: 'utf8' });
  }
}

// ── 汇报 ──
console.log(`✓ 源: docs/gui/features.md (${md.length} 字符)`);
console.log(`✓ 给 AI : skill/chapters/  ${toc.length} 个章节文件`);
toc.forEach((t) => console.log(`    ${String(t.n).padStart(2)}. ${t.file}  (${t.items.length} 个功能点)`));
console.log(`✓ 给用户: manual.html  ${searchIndex.length} 个功能点已索引，${(out.length / 1024).toFixed(0)}KB`);
