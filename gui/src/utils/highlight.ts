// ── 代码高亮 — 纯函数，消息区与编辑器 md 预览共用 ──
// 单一实现防分叉：任何高亮修复只改这一处。

import hljs from "highlight.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 高亮结果缓存 —— 同一段代码只算一次。
 *
 * 为什么必须缓存：消息区是**虚拟列表 + 频繁重渲染**（流式输出、任意设置变更都会
 * 重渲已挂载项），而 `highlightCode` 是逐块在渲染路径上调用的 —— 同一段 diff 在
 * 一次会话里会被重复计算很多次（实测每渲染一次约 11ms/块，135 块就是 1.5s 起步）。
 * 高亮是**纯函数**（同 code+lang 必得同结果），缓存零风险。
 *
 * FIFO 淘汰上限 500 条：覆盖"来回滚动看同一批消息"，又不会让长会话把内存吃光。 */
const HL_CACHE = new Map<string, string>();
const HL_CACHE_MAX = 500;

/**
 * 语法高亮代码；**语言缺失/不认识时只做 HTML 转义，不做自动检测**（防注入）。
 *
 * 🔴 为什么删掉 `hljs.highlightAuto()` 回退（2026-09-21 性能事故）：
 * auto 要对**全部 192 个已注册语言**各试一遍，是 highlight.js 最慢的路径。
 * 实测同一段 1026 字符的代码：
 *   指定语言 typescript → **11ms**；highlightAuto → **322ms**（慢 29 倍）。
 * 而消息区的调用是**逐块、在渲染路径上**的：一个大会话里 135 个 Edit/Write 块，
 * 只要有 22 个因扩展名没映射到语言而落进 auto，就要多花约 **7 秒** —— 用户感知就是
 * "切换会话要等好几秒，以前很快"。
 *
 * 取舍：**宁可不高亮，也不要卡**。漏掉的扩展名请补进调用方的映射表
 * （见 MessageItem 的 EXT_TO_LANG），而不是在这里加回 auto。
 */
export function highlightCode(code: string, lang: string): string {
  if (!code) return "";
  const key = lang + "\u0000" + code;
  const hit = HL_CACHE.get(key);
  if (hit !== undefined) return hit;

  let out: string;
  try {
    if (lang && hljs.getLanguage(lang)) {
      out = hljs.highlight(code, { language: lang }).value || escapeHtml(code);
    } else {
      out = escapeHtml(code);
    }
  } catch {
    out = escapeHtml(code);
  }

  if (HL_CACHE.size >= HL_CACHE_MAX) {
    // FIFO：Map 保持插入顺序，删最老的
    const oldest = HL_CACHE.keys().next().value;
    if (oldest !== undefined) HL_CACHE.delete(oldest);
  }
  HL_CACHE.set(key, out);
  return out;
}
