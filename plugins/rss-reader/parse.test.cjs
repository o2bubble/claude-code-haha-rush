// ── rss-server 纯函数单测 ──
// 运行: node parse.test.cjs（node:test, 无外部依赖——插件包独立, 不挂 vitest）。
// 测解析器（RSS 2.0 / Atom）、实体解码、URL 安全校验、区间收敛 —— 锁回归。
//
// ⚠️ 断言里的中文是 feed 真实形态（DeepSeek 状态页就是中英混排的 title）。

const test = require("node:test");
const assert = require("node:assert");
const server = require("./rss-server.cjs");

// ── 实体解码 ──

test("decodeEntities — 基本实体与数字实体", () => {
  assert.strictEqual(server.decodeEntities("&lt;p&gt;hi&lt;/p&gt;"), "<p>hi</p>");
  assert.strictEqual(server.decodeEntities("&#65;&#x42;"), "AB");
  assert.strictEqual(server.decodeEntities("a &amp; b"), "a & b");
  assert.strictEqual(server.decodeEntities("&#x4F60;&#22909;"), "你好");
});

test("decodeEntities — &amp; 最后替换（防止二次解码）", () => {
  // `&amp;lt;` 应得到字面 "&lt;"，而不是 "<" —— 这是顺序错误的经典 bug
  assert.strictEqual(server.decodeEntities("&amp;lt;"), "&lt;");
  assert.strictEqual(server.decodeEntities("&amp;amp;"), "&amp;");
});

test("decodeEntities — 越界码点不抛异常", () => {
  assert.strictEqual(server.decodeEntities("&#x110000;"), "");
  assert.strictEqual(server.decodeEntities("&#999999999;"), "");
});

// ── RSS 2.0 解析 ──

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>DeepSeek</title>
  <link>https://status.deepseek.com</link>
  <description>Status updates for DeepSeek</description>
  <item>
    <title>服务降级（Degraded Service）</title>
    <link>https://status.deepseek.com/incidents/123</link>
    <description>&lt;p&gt;&lt;strong&gt;Status:&lt;/strong&gt; resolved&lt;/p&gt;</description>
    <guid>urn:flashduty:change:123</guid>
    <pubDate>Sun, 20 Sep 2026 16:45:32 +0800</pubDate>
  </item>
  <item>
    <title><![CDATA[带 CDATA 的 <标题>]]></title>
    <link>https://status.deepseek.com/incidents/456</link>
    <guid>urn:flashduty:change:456</guid>
    <pubDate>Sat, 19 Sep 2026 08:00:00 +0800</pubDate>
  </item>
</channel></rss>`;

test("parseFeed — RSS 2.0 头部与条目", () => {
  const f = server.parseFeed(RSS_SAMPLE);
  assert.strictEqual(f.title, "DeepSeek");
  assert.strictEqual(f.link, "https://status.deepseek.com");
  assert.strictEqual(f.description, "Status updates for DeepSeek");
  assert.strictEqual(f.items.length, 2);

  const a = f.items[0];
  assert.strictEqual(a.title, "服务降级（Degraded Service）");
  assert.strictEqual(a.link, "https://status.deepseek.com/incidents/123");
  assert.strictEqual(a.guid, "urn:flashduty:change:123");
  assert.strictEqual(a.description, "<p><strong>Status:</strong> resolved</p>"); // 实体已解
  assert.ok(a.pubDate > 0, "RFC822 日期应解析成时间戳");
});

test("parseFeed — CDATA 标题原样取出（不被实体解码破坏）", () => {
  const f = server.parseFeed(RSS_SAMPLE);
  assert.strictEqual(f.items[1].title, "带 CDATA 的 <标题>");
  assert.strictEqual(f.items[1].description, ""); // 无 description → 空串不报错
});

test("parseFeed — 空块/无条目不崩", () => {
  const f = server.parseFeed("<rss><channel><title>x</title></channel></rss>");
  assert.strictEqual(f.title, "x");
  assert.deepStrictEqual(f.items, []);
});

test("parseFeed — 非 feed 文本（HTML 错误页）返回空结构，不抛", () => {
  const f = server.parseFeed("<html><body>404 Not Found</body></html>");
  assert.strictEqual(f.items.length, 0);
});

// ── Atom 解析 ──

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>示例博客</title>
  <link href="https://example.com/" rel="alternate"/>
  <subtitle>一个 Atom 源</subtitle>
  <entry>
    <title>第一篇文章</title>
    <link href="https://example.com/post-1" rel="alternate"/>
    <id>tag:example.com,2026:post-1</id>
    <published>2026-09-19T10:00:00Z</published>
    <summary type="html">&lt;p&gt;摘要&lt;/p&gt;</summary>
  </entry>
</feed>`;

test("parseFeed — Atom 的 link href / published / summary", () => {
  const f = server.parseFeed(ATOM_SAMPLE);
  assert.strictEqual(f.title, "示例博客");
  assert.strictEqual(f.link, "https://example.com/");
  assert.strictEqual(f.description, "一个 Atom 源");
  assert.strictEqual(f.items.length, 1);
  const e = f.items[0];
  assert.strictEqual(e.title, "第一篇文章");
  assert.strictEqual(e.link, "https://example.com/post-1");
  assert.strictEqual(e.guid, "tag:example.com,2026:post-1");
  assert.strictEqual(e.description, "<p>摘要</p>");
  assert.ok(e.pubDate > 0);
});

// ── 字段提取工具 ──

test("extractTag — 大小写不敏感 + 属性忽略", () => {
  assert.strictEqual(server.extractTag("<TITLE>x</TITLE>", "title"), "x");
  assert.strictEqual(server.extractTag('<title lang="zh">y</title>', "title"), "y");
  assert.strictEqual(server.extractTag("<a>1</a>", "b"), "");
});

test("extractAttr — 单双引号都支持", () => {
  assert.strictEqual(server.extractAttr('<link href="http://a.com"/>', "link", "href"), "http://a.com");
  assert.strictEqual(server.extractAttr("<link href='http://b.com'/>", "link", "href"), "http://b.com");
  assert.strictEqual(server.extractAttr("<link/>", "link", "href"), "");
});

test("extractFirst — 取第一个非空候选", () => {
  assert.strictEqual(server.extractFirst("<a></a><b>2</b>", ["a", "b"]), "2");
  assert.strictEqual(server.extractFirst("<a>1</a><b>2</b>", ["a", "b"]), "1");
  assert.strictEqual(server.extractFirst("<x></x>", ["a", "b"]), "");
});

test("parseDate — RFC822 / ISO8601 / 非法", () => {
  assert.ok(server.parseDate("Sun, 20 Sep 2026 16:45:32 +0800") > 0);
  assert.ok(server.parseDate("2026-09-19T10:00:00Z") > 0);
  assert.strictEqual(server.parseDate("not a date"), null);
  assert.strictEqual(server.parseDate(""), null);
  assert.strictEqual(server.parseDate(null), null);
});

// ── URL 安全校验（订阅源唯一的外部输入口）──

test("sanitizeFeedUrl — 只放行 http/https", () => {
  assert.ok(server.sanitizeFeedUrl("https://a.com/f.rss"));
  assert.ok(server.sanitizeFeedUrl("http://a.com/f"));
  assert.strictEqual(server.sanitizeFeedUrl("file:///etc/passwd"), null);
  assert.strictEqual(server.sanitizeFeedUrl("ftp://a.com/x"), null);
  assert.strictEqual(server.sanitizeFeedUrl("javascript:alert(1)"), null);
  assert.strictEqual(server.sanitizeFeedUrl("data:text/xml,<x/>"), null);
});

test("sanitizeFeedUrl — 拒绝非法输入", () => {
  assert.strictEqual(server.sanitizeFeedUrl(""), null);
  assert.strictEqual(server.sanitizeFeedUrl("   "), null);
  assert.strictEqual(server.sanitizeFeedUrl("not a url"), null);
  assert.strictEqual(server.sanitizeFeedUrl(null), null);
  assert.strictEqual(server.sanitizeFeedUrl(123), null);
  assert.strictEqual(server.sanitizeFeedUrl("https://a.com/" + "x".repeat(3000)), null);
});

// ── 其它 ──

test("clampRefreshMinutes — 默认与边界", () => {
  assert.strictEqual(server.clampRefreshMinutes(10), 10);
  assert.strictEqual(server.clampRefreshMinutes(0), 1);
  assert.strictEqual(server.clampRefreshMinutes(99999), 1440);
  assert.strictEqual(server.clampRefreshMinutes(NaN), 10);
  assert.strictEqual(server.clampRefreshMinutes("abc"), 10);
  assert.strictEqual(server.clampRefreshMinutes("7"), 7);
});

test("trimSet — 超限时保最近插入的键", () => {
  const obj = { a: 1, b: 1, c: 1, d: 1 };
  const out = server.trimSet(obj, 2);
  assert.deepStrictEqual(Object.keys(out), ["c", "d"]);
  assert.strictEqual(server.trimSet(obj, 10), obj); // 未超限原样返回
});

test("sanitizeWidgetPos — 只有合法坐标才接受", () => {
  assert.deepStrictEqual(server.sanitizeWidgetPos({ x: 100, y: 200 }), { x: 100, y: 200 });
  assert.deepStrictEqual(server.sanitizeWidgetPos({ x: 10.6, y: -20.2 }), { x: 11, y: -20 }); // 取整
  assert.deepStrictEqual(server.sanitizeWidgetPos({ x: -3000, y: -1500 }), { x: -3000, y: -1500 }); // 副屏负坐标
  // 非法 → null（宿主回退默认位置）
  assert.strictEqual(server.sanitizeWidgetPos(null), null);
  assert.strictEqual(server.sanitizeWidgetPos({ x: 1 }), null);
  assert.strictEqual(server.sanitizeWidgetPos({ x: NaN, y: 0 }), null);
  assert.strictEqual(server.sanitizeWidgetPos({ x: "a", y: "b" }), null);
  assert.strictEqual(server.sanitizeWidgetPos({ x: 99999, y: 0 }), null); // 超界（与宿主 ±32000 一致）
  assert.strictEqual(server.sanitizeWidgetPos("nope"), null);
});

test("decodeBody — charset 检测（GBK）", () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // "你好"
  assert.strictEqual(server.decodeBody(gbk, "text/xml; charset=gbk"), "你好");
  assert.strictEqual(server.decodeBody(Buffer.from("hi", "utf8"), "text/xml"), "hi");
});
