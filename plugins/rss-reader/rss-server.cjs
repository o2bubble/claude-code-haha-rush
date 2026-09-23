// ── rss-server.cjs ──
// RSS 订阅插件的后台进程：抓取 / 解析（RSS 2.0 + Atom）/ 存储 / 定时刷新 / HTTP API。
//
// 设计要点
//   * **零依赖**：只用 node 内置模块。解析器自己实现（RSS 结构扁平，不需要完整
//     XML 引擎；条目块内不会嵌套同名标签）。
//   * **必须由本进程抓取**：面板 iframe 直接 fetch 外部源会被 CORS 挡（源站不会给
//     跨域头）。进程是 node，没有 CORS 限制。实测也确认：同机 curl/Python 对
//     status.deepseek.com 的 TLS 握手会失败，**node 的 TLS 栈能正常连上** —— 抓取
//     放在 node 进程里不仅绕 CORS，还绕过了系统 TLS 栈的兼容问题。
//   * **数据目录**：`<app_data>/plugins-data/rss-reader/`（宿主管理，卸载时自动清）。
//     路径由 `__dirname`（= 插件目录）推出：`<app_data>/plugins/<name>/` → `../../plugins-data/rss-reader`。
//   * **只绑 127.0.0.1**，不发任何遥测。
//
// 启动：stdout 打 `PLUGIN_PORT=<n>`（宿主据此发现端口）。

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── 常量 ──

const DATA_DIR = path.resolve(__dirname, "..", "..", "plugins-data", "rss-reader");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 5_000_000;        // 单个 feed 上限 5MB
const MAX_ITEMS_PER_FEED = 50;           // 每源缓存条目数
const MAX_SEEN_PER_FEED = 500;           // 每源"已见过"的 guid 上限（FIFO 裁剪）
const MAX_READ = 3000;                   // 已读集合上限
const MAX_TITLE_LEN = 200;
const MAX_DESC_LEN = 20_000;
const DEFAULT_REFRESH_MINUTES = 10;
const MIN_REFRESH_MINUTES = 1;
const MAX_REFRESH_MINUTES = 1440;
const UA = "Mozilla/5.0 (compatible; ClaudeCodeHaha-RSS/1.0)";

// ── 纯函数区（导出供单测；无 IO）──

/** XML 实体解码。⚠️ `&amp;` 必须最后替换 —— 否则 `&amp;lt;` 会被二次解码成 `<`。 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePointStr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePointStr(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function codePointStr(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try { return String.fromCodePoint(n); } catch { return ""; }
}

/** 提取 `<tag ...>content</tag>`（忽略大小写；支持 CDATA；属性被忽略）。 */
function extractTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  let v = m[1];
  const cd = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cd) return cd[1].trim();
  return decodeEntities(v).trim();
}

/** 提取 `<tag ... attr="value">` 的属性值（Atom 的 `<link href=...>` 用）。 */
function extractAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = block.match(re);
  if (!m) return "";
  return decodeEntities(m[2] !== undefined ? m[2] : m[3] || "").trim();
}

/** 取第一个非空的候选标签（如 description | summary | content）。 */
function extractFirst(block, tags) {
  for (const t of tags) {
    const v = extractTag(block, t);
    if (v) return v;
  }
  return "";
}

/** 日期字符串 → 毫秒时间戳（RFC822 / ISO8601 都交给 Date 解析）；失败返回 null。 */
function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * 解析 RSS 2.0 / Atom feed。
 * 返回 `{ title, link, description, items: [{guid, title, link, pubDate, description}] }`。
 * 条目取的是**扁平切块**：RSS 的 `<item>` / Atom 的 `<entry>` 内部不会嵌套同名标签。
 */
function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml);
  const out = { title: "", link: "", description: "", items: [] };

  // channel/feed 级头部（取第一个 item/entry 之前的部分）
  const firstItemIdx = (() => {
    const re = isAtom ? /<entry[\s>]/i : /<item[\s>]/i;
    const m = re.exec(xml);
    return m ? m.index : xml.length;
  })();
  const head = xml.slice(0, firstItemIdx);

  out.title = extractTag(head, "title");
  out.link = isAtom ? extractAttr(head, "link", "href") : extractTag(head, "link");
  out.description = extractFirst(head, ["subtitle", "description", "tagline"]);

  const itemRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = xml.match(itemRe) || [];
  for (const b of blocks) {
    const title = extractTag(b, "title").slice(0, MAX_TITLE_LEN);
    let link = isAtom
      ? (extractAttr(b, "link", "href") || extractTag(b, "link"))
      : extractTag(b, "link");
    const guid = (isAtom ? extractTag(b, "id") : extractTag(b, "guid")) || link || title;
    const pubDate =
      parseDate(extractFirst(b, ["pubDate", "published", "updated", "date"])) ?? null;
    const description = extractFirst(b, ["description", "content", "summary", "content:encoded"])
      .slice(0, MAX_DESC_LEN);
    if (!title && !link) continue; // 空块丢弃
    out.items.push({ guid: String(guid).slice(0, 500), title, link, pubDate, description });
  }
  return out;
}

/** Buffer → 字符串。charset 从 Content-Type 或 XML 声明里取（中文源常是 GBK）。 */
function decodeBody(buf, contentType) {
  let charset = "";
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || "");
  if (m) charset = m[1].toLowerCase();
  if (!charset) {
    const head = buf.slice(0, 300).toString("latin1");
    const x = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
    if (x) charset = x[1].toLowerCase();
  }
  if (!charset || charset === "utf-8" || charset === "utf8") return buf.toString("utf8");
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString("utf8"); // 不认识的编码 → 按 utf8（可能乱码但不崩）
  }
}

/** 校验用户输入的订阅 URL：只允许 http/https，长度受限。返回规范化 URL 或 null。 */
function sanitizeFeedUrl(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2000) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u.toString();
}

/** refreshMinutes 收敛到 [MIN, MAX]（非数字 → 默认）。 */
function clampRefreshMinutes(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_REFRESH_MINUTES;
  return Math.max(MIN_REFRESH_MINUTES, Math.min(MAX_REFRESH_MINUTES, Math.round(n)));
}

/** 给未读/已读集合做容量裁剪（保最近插入的）。 */
function trimSet(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const drop = keys.length - max;
  const next = {};
  for (let i = drop; i < keys.length; i++) next[keys[i]] = 1;
  return next;
}

/** 挂件位置：{x,y} 整数且非离谱值才接受；否则 null（宿主回退默认位置）。
 *  范围与宿主 sanitizeIndicatorMove 一致（±32000）。 */
function sanitizeWidgetPos(v) {
  if (!v || typeof v !== "object") return null;
  const x = Number(v.x);
  const y = Number(v.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > 32000 || Math.abs(y) > 32000) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 用系统默认浏览器打开链接。
 *
 * **为什么由进程做**：插件面板是 `sandbox="allow-scripts allow-same-origin"` 的
 * iframe（**没有 allow-popups**），`<a target="_blank">` 被沙箱拦、原位导航会把
 * 面板本身替换成外网站点；宿主的上行 kind 白名单里也没有 open-url。进程是普通
 * 操作系统进程，调系统命令打开是唯一不依赖宿主改动的路径。
 *
 * 安全：只放行 http/https（sanitizeFeedUrl 同款校验）；URL 以**参数数组**传给
 * 平台命令，不经 shell 解析 —— 不存在命令注入面。
 */
function openInBrowser(rawUrl) {
  const url = sanitizeFeedUrl(rawUrl);
  if (!url) return { ok: false, error: "URL 非法（只支持 http/https）" };
  const { spawn } = require("child_process");
  try {
    if (process.platform === "win32") {
      // `start` 是 cmd 内建命令；空标题参数 "" 防止 URL 被当窗口标题
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── 抓取（跟随重定向 / 超时 / 大小上限）──

function fetchOnce(urlStr, bufChain) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error("URL 非法")); }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!mod) return reject(new Error("只支持 http/https"));

    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        timeout: FETCH_TIMEOUT_MS,
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      },
      (res) => resolve({ res, u }),
    );
    req.on("timeout", () => { req.destroy(new Error("抓取超时")); });
    req.on("error", (e) => reject(e));
    void bufChain;
  });
}

/** 抓取 URL 并返回解码后的文本（跟随最多 MAX_REDIRECTS 次重定向）。 */
async function fetchText(urlStr, redirectsLeft = MAX_REDIRECTS) {
  const { res, u } = await fetchOnce(urlStr);
  const status = res.statusCode || 0;

  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume(); // 丢弃 body
    if (redirectsLeft <= 0) throw new Error("重定向次数过多");
    const next = new URL(res.headers.location, u).toString();
    return fetchText(next, redirectsLeft - 1);
  }
  if (status !== 200) {
    res.resume();
    throw new Error(`HTTP ${status}`);
  }

  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    res.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        res.destroy();
        reject(new Error(`响应过大（>${Math.round(MAX_BODY_BYTES / 1e6)}MB）`));
        return;
      }
      chunks.push(c);
    });
    res.on("end", resolve);
    res.on("error", reject);
  });
  return decodeBody(Buffer.concat(chunks), res.headers["content-type"]);
}

// ── 配置与状态（原子写）──

// widgetPos: 桌面挂件上次被拖到的位置（屏幕物理像素）—— null = 用宿主默认（主屏右下角）
let config = { feeds: [], refreshMinutes: DEFAULT_REFRESH_MINUTES, widgetPos: null };
let state = { seen: {}, read: {}, cache: {}, lastNew: null };

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); return true; } catch { return false; }
}

function readJsonFile(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 原子写：先写 .tmp 再 rename —— 进程被杀时不会留下半截 JSON。 */
function writeJsonFile(file, obj) {
  try {
    ensureDataDir();
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error("write failed:", file, e && e.message);
    return false;
  }
}

function loadAll() {
  const c = readJsonFile(CONFIG_FILE, null);
  if (c) {
    config = {
      feeds: Array.isArray(c.feeds) ? c.feeds.filter((f) => f && f.id && f.url) : [],
      refreshMinutes: clampRefreshMinutes(c.refreshMinutes),
      widgetPos: sanitizeWidgetPos(c.widgetPos),
    };
  }
  const s = readJsonFile(STATE_FILE, null);
  if (s) {
    state = {
      seen: s.seen && typeof s.seen === "object" ? s.seen : {},
      read: s.read && typeof s.read === "object" ? s.read : {},
      cache: s.cache && typeof s.cache === "object" ? s.cache : {},
      lastNew: s.lastNew && typeof s.lastNew === "object" ? s.lastNew : null,
    };
  }
}

const saveConfig = () => writeJsonFile(CONFIG_FILE, config);

/**
 * 把磁盘上的 config 同步进内存（**以磁盘为准**）。
 *
 * 为什么：每个 GUI 实例各跑一个进程，各自启动时读一次 config。A 实例加了源，
 * B 实例的进程内存里没有 → B 的面板看不到。刷新前/取状态前重读一次即可。
 *
 * 为什么"以磁盘为准"而不是合并：删除的语义是**只减**的，若保留"内存有、磁盘没有"
 * 的源，A 删掉的源会被 B 的合并**复活**。以磁盘为准则两个方向都正确。
 * 代价：本进程刚加、还没写盘的源（毫秒级窗口）理论上可能被覆盖 —— addFeed 里
 * push 后**立即** saveConfig，窗口极小，可接受。
 */
function syncConfigFromDisk() {
  const disk = readJsonFile(CONFIG_FILE, null);
  if (!disk || !Array.isArray(disk.feeds)) return;
  const feeds = disk.feeds.filter((f) => f && f.id && f.url);
  // 无变化 → 不改内存（避免仪表盘轮询引发的无谓重新渲染）
  if (JSON.stringify(feeds) === JSON.stringify(config.feeds)) return;
  config.feeds = feeds;
  if (disk.refreshMinutes !== undefined) {
    config.refreshMinutes = clampRefreshMinutes(disk.refreshMinutes);
  }
}

/**
 * 保存状态 —— **先重读磁盘并把"只增不减"的集合并回来，再写**。
 *
 * 为什么（2026-09-20，用户开着两个 GUI 实例时发现）：插件进程是**每个 GUI 实例
 * 一个**，两个进程共用同一个 `state.json`，各自内存里都有一份 `read`。若直接
 * 覆盖写，B 进程会用自己内存里的旧 `read` 抹掉 A 刚标记的已读 ——
 * 用户看到的是「**已读的条目过一会儿又变回未读**」（B 的下一次刷新/保存时）。
 * 同理 `seen` 被抹会让旧条目**再报一次**"新条目"。
 *
 * 修法：`read` / `seen` 都取**并集**后再写。两个集合的语义都是单调的
 * （已读不会变未读、见过不会变没见过），并集是安全方向 —— 并发窗口缩到毫秒级，
 * 即使真撞上也不丢数据。
 *
 * 注意 `seen` 只合并**内存里存在的源**：`removeFeed` 删掉的源不会因此复活。
 */
function saveState() {
  const disk = readJsonFile(STATE_FILE, null);
  if (disk) {
    if (disk.read && typeof disk.read === "object") {
      state.read = { ...disk.read, ...state.read };
    }
    if (disk.seen && typeof disk.seen === "object") {
      for (const k of Object.keys(state.seen)) {
        const other = disk.seen[k];
        if (!Array.isArray(other)) continue;
        state.seen[k] = [...new Set([...(state.seen[k] || []), ...other])]
          .slice(-MAX_SEEN_PER_FEED);
      }
    }
  }
  writeJsonFile(STATE_FILE, state);
}

// ── 刷新逻辑 ──

let refreshing = null; // 进行中的刷新 Promise（并发去重）

/**
 * 刷新单个 feed。
 * ⚠️ **首次抓取不产生"新条目"**：刚加源时历史条目全部记入已见集合——否则一装上
 * 就弹一堆提醒（那些是历史，不是新闻）。
 */
async function refreshFeed(feed) {
  try {
    const xml = await fetchText(feed.url);
    const parsed = parseFeed(xml);
    if (!parsed.items.length && !parsed.title) {
      throw new Error("不是可识别的 RSS/Atom（没有条目）");
    }
    const items = parsed.items.slice(0, MAX_ITEMS_PER_FEED);

    const seenList = Array.isArray(state.seen[feed.id]) ? state.seen[feed.id] : null;
    let newItems = [];
    if (seenList === null) {
      state.seen[feed.id] = items.map((i) => i.guid).slice(-MAX_SEEN_PER_FEED);
    } else {
      const seenSet = new Set(seenList);
      newItems = items.filter((i) => !seenSet.has(i.guid));
      const merged = [...new Set([...seenList, ...items.map((i) => i.guid)])];
      state.seen[feed.id] = merged.slice(-MAX_SEEN_PER_FEED);
    }

    state.cache[feed.id] = {
      fetchedAt: Date.now(),
      feedTitle: parsed.title || feed.title || "",
      items,
      error: null,
    };

    // feed 显示名：用户没起名时用源自己的标题
    if (!feed.title && parsed.title) {
      feed.title = parsed.title.slice(0, MAX_TITLE_LEN);
      saveConfig();
    }

    if (newItems.length > 0 && seenList !== null) {
      state.lastNew = {
        ts: Date.now(),
        feedId: feed.id,
        feedTitle: feed.title || parsed.title || feed.url,
        items: newItems.slice(0, 10).map((i) => ({ guid: i.guid, title: i.title, link: i.link })),
      };
    }
    return { id: feed.id, ok: true, newCount: newItems.length, count: items.length };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    const prev = state.cache[feed.id] || {};
    state.cache[feed.id] = { ...prev, fetchedAt: Date.now(), error: msg };
    return { id: feed.id, ok: false, error: msg };
  }
}

/** 刷新全部（并发去重：同时来多次请求只跑一轮）。 */
function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    syncConfigFromDisk(); // 别的实例可能刚加了源（见 syncConfigFromDisk 注释）
    const feeds = [...config.feeds];
    const results = await Promise.all(feeds.map((f) => refreshFeed(f)));
    saveState();
    return results;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** 加源：先抓一次验证（拿到标题、填缓存），成功才落盘。 */
async function addFeed(rawUrl) {
  const url = sanitizeFeedUrl(rawUrl);
  if (!url) return { ok: false, error: "URL 非法（只支持 http/https）" };
  if (config.feeds.some((f) => f.url === url)) {
    return { ok: false, error: "这个源已经订阅过了" };
  }
  const feed = {
    id: crypto.randomBytes(6).toString("hex"),
    url,
    title: "",
    addedAt: Date.now(),
  };
  const r = await refreshFeed(feed);
  if (!r.ok) return { ok: false, error: "抓取失败：" + r.error };
  config.feeds.push(feed);
  saveConfig();
  saveState();
  return { ok: true, feed: publicFeed(feed), count: r.count };
}

function removeFeed(id) {
  const idx = config.feeds.findIndex((f) => f.id === id);
  if (idx < 0) return { ok: false, error: "没有这个订阅" };
  config.feeds.splice(idx, 1);
  delete state.cache[id];
  delete state.seen[id];
  saveConfig();
  saveState();
  return { ok: true };
}

function markRead(guid) {
  if (typeof guid !== "string" || !guid) return { ok: false, error: "guid 非法" };
  state.read[guid] = 1;
  state.read = trimSet(state.read, MAX_READ);
  saveState();
  return { ok: true };
}

function markAllRead(feedId) {
  const feeds = feedId ? config.feeds.filter((f) => f.id === feedId) : config.feeds;
  for (const f of feeds) {
    const c = state.cache[f.id];
    if (!c || !Array.isArray(c.items)) continue;
    for (const it of c.items) state.read[it.guid] = 1;
  }
  state.read = trimSet(state.read, MAX_READ);
  saveState();
  return { ok: true };
}

/** 对外暴露的 feed 视图（含未读数与条目）。 */
function publicFeed(feed) {
  const c = state.cache[feed.id] || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const unread = items.filter((i) => !state.read[i.guid]).length;
  return {
    id: feed.id,
    url: feed.url,
    title: feed.title || c.feedTitle || feed.url,
    error: c.error || null,
    fetchedAt: c.fetchedAt || null,
    unread,
    items: items.map((i) => ({
      guid: i.guid,
      title: i.title,
      link: i.link,
      pubDate: i.pubDate,
      description: i.description,
      read: !!state.read[i.guid],
    })),
  };
}

function publicState() {
  const feeds = config.feeds.map(publicFeed);
  return {
    feeds,
    unreadTotal: feeds.reduce((n, f) => n + f.unread, 0),
    lastNew: state.lastNew,
    refreshMinutes: config.refreshMinutes,
    widgetPos: config.widgetPos, // 面板开挂件时把它传给宿主（位置记忆）
    dataDir: DATA_DIR,
  };
}

// ── HTTP ──

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    // 面板 iframe（plugins://）跨源 fetch 需要
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function jsonErr(res, status, msg) {
  json(res, status, { ok: false, error: msg });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 200_000) { req.destroy(); reject(new Error("请求体过大")); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const u = new URL(req.url, "http://localhost");
  const route = u.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  try {
    switch (route) {
      case "/api/health":
        return json(res, 200, { ok: true, feeds: config.feeds.length });

      // 全量状态（面板/挂件主数据源）
      case "/api/state":
        syncConfigFromDisk(); // 别的实例刚加的源要能看见（面板每次轮询都走到这里）
        return json(res, 200, { ok: true, ...publicState() });

      case "/api/add": {
        if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await addFeed(body.url);
        return json(res, r.ok ? 200 : 400, r);
      }

      case "/api/remove": {
        if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = removeFeed(String(body.id || ""));
        return json(res, r.ok ? 200 : 400, r);
      }

      case "/api/refresh": {
        if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* 空体 OK */ }
        const results = body.id
          ? [await refreshFeed(config.feeds.find((f) => f.id === body.id) || { id: body.id, url: "" })]
          : await refreshAll();
        saveState();
        return json(res, 200, { ok: true, results });
      }

      case "/api/read": {
        if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
        const body = JSON.parse((await readBody(req)) || "{}");
        if (body.all) return json(res, 200, markAllRead(body.feedId));
        return json(res, 200, markRead(body.guid));
      }

      // 在系统浏览器打开原文链接（面板 iframe 被沙箱禁弹窗，只能经进程）
      case "/api/open": {
        if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = openInBrowser(body.url);
        return json(res, r.ok ? 200 : 400, r);
      }

      case "/api/config": {
        if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
        const body = JSON.parse((await readBody(req)) || "{}");
        if (body.refreshMinutes !== undefined) {
          config.refreshMinutes = clampRefreshMinutes(body.refreshMinutes);
          saveConfig();
          scheduleRefresh();
        }
        // 挂件被拖动后上报新位置（面板下次开挂件时带上，实现"位置记忆"）
        if (body.widgetPos !== undefined) {
          config.widgetPos = sanitizeWidgetPos(body.widgetPos);
          saveConfig();
        }
        return json(res, 200, {
          ok: true,
          refreshMinutes: config.refreshMinutes,
          widgetPos: config.widgetPos,
        });
      }

      // 宿主命令转发（插件命令 / 快捷键触发）—— 契约见 pluginCommandBridge
      case "/__command": {
        if (req.method !== "POST") return jsonErr(res, 405, "仅支持 POST");
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* 空体 OK */ }
        const host = [];
        if (body.onInvoke === "refresh") {
          await refreshAll();
        } else if (body.onInvoke === "show-indicator") {
          host.push({
            kind: "open-indicator",
            payload: {
              src: "indicator.html",
              params: `port=${actualPort()}`,
              width: 340,
              height: 92,
            },
          });
        }
        return json(res, 200, { ok: true, host });
      }

      default:
        return jsonErr(res, 404, "未知端点: " + route);
    }
  } catch (e) {
    return jsonErr(res, 500, String((e && e.message) || e));
  }
}

// ── 定时刷新 ──

let timer = null;
function scheduleRefresh() {
  if (timer) clearInterval(timer);
  const ms = clampRefreshMinutes(config.refreshMinutes) * 60_000;
  timer = setInterval(() => { refreshAll().catch(() => {}); }, ms);
}

// ── 启动 ──

let actualPort = () => null;

module.exports = {
  decodeEntities,
  extractTag,
  extractAttr,
  extractFirst,
  parseDate,
  parseFeed,
  decodeBody,
  sanitizeFeedUrl,
  sanitizeWidgetPos,
  clampRefreshMinutes,
  trimSet,
  openInBrowser,
};

if (require.main === module) {
  loadAll();
  const server = http.createServer(handle);

  function listen(port) {
    server.listen(port, "127.0.0.1", () => {
      actualPort = () => port;
      console.log("PLUGIN_PORT=" + port); // ← 宿主端口发现协议
      // 启动后延迟抓一次（等宿主/网络稳定）；此后按 refreshMinutes 定时
      if (config.feeds.length > 0) {
        setTimeout(() => { refreshAll().catch(() => {}); }, 2500);
      }
      scheduleRefresh();
    });
  }

  const envPort = parseInt(process.env.CLAUDE_PLUGIN_PORT || "", 10);
  if (!Number.isNaN(envPort)) {
    listen(envPort);
  } else {
    let n = 8300;
    const tryPick = (port) => {
      if (port > 8699) {
        console.error("No free port in range 8300-8699");
        process.exit(1);
      }
      const probe = http.createServer();
      probe.once("error", () => tryPick(port + 1));
      probe.once("listening", () => probe.close(() => listen(port)));
      probe.listen(port, "127.0.0.1");
    };
    tryPick(n);
  }
}
