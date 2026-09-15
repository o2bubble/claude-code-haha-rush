/**
 * 线上后台真浏览器验证 —— curl 拿到 200 不代表 JS 能跑起来（资源路径错、
 * 接口 401、运行时异常都会表现为"白屏但 HTTP 200"）。
 *
 * 用法：node web-live.cjs <baseUrl> [期望的 SITE_NAME]
 *   WEB_ADMIN 指定口令（默认读环境变量）
 */
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(
    process.env.PLAYWRIGHT_PATH ||
      'C:/Users/SZH/AppData/Local/npm-cache/_npx/86170c4cd1c5da32/node_modules/playwright',
  ));
}

const BASE = process.argv[2];
const EXPECT_SITE = process.argv[3] || '';
const ADMIN = process.env.WEB_ADMIN;

if (!BASE || !ADMIN) {
  console.error('用法：WEB_ADMIN=<口令> node web-live.cjs <baseUrl> [SITE_NAME]');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  <- ' + d : ''}`); };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

  console.log(`\n[${BASE}]`);

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle', timeout: 30000 });
  const b1 = await page.innerText('body');
  check('渲染登录页（非白屏）', b1.includes('发布平台管理'), b1.slice(0, 40).replace(/\n/g, ' '));
  if (EXPECT_SITE) check(`实例标识 = ${EXPECT_SITE}`, b1.includes(EXPECT_SITE), '');

  // 错口令
  await page.fill('input[type="password"]', 'definitely-wrong');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  check('错口令被拒', (await page.innerText('body')).includes('口令错误'), '');

  // 正口令
  await page.fill('input[type="password"]', ADMIN);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  const b2 = await page.innerText('body');
  check('登录进入后台', b2.includes('总览') && b2.includes('包总数'), '');
  check('统计已加载（非加载中）', !b2.includes('加载中…'), '');

  // 各页可达
  for (const [path, kw] of [['packages', ''], ['feedback', ''], ['updates', '']]) {
    await page.goto(`${BASE}/admin/${path}`, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(1200);
    const t = await page.innerText('body');
    check(`/${path} 可用`, !t.includes('加载中…') && !t.includes('加载失败'), t.slice(0, 40).replace(/\n/g, ' '));
  }

  // 深链刷新
  const resp = await page.goto(`${BASE}/admin/feedback`, { waitUntil: 'networkidle', timeout: 25000 });
  check('深链刷新不 404', resp.status() === 200, `HTTP ${resp.status()}`);

  // 公网反馈页
  await page.goto(`${BASE}/feedback`, { waitUntil: 'networkidle', timeout: 25000 });
  const pf = await page.innerText('body');
  check('公网反馈页可用', pf.includes('意见反馈') && pf.includes('问题反馈'), '');

  // 旧后台应急入口。标题「反馈管理」在 <title> 里，body 里是「用户反馈」——
  // 断言要针对 body 实际内容。
  await page.goto(`${BASE}/admin-legacy`, { waitUntil: 'networkidle', timeout: 25000 });
  const legacyBody = await page.innerText('body');
  check(
    '/admin-legacy 应急入口可用',
    legacyBody.includes('用户反馈') && !legacyBody.includes('发布平台管理'),
    legacyBody.slice(0, 30).replace(/\n/g, ' '),
  );

  const real = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('无 JS 运行时错误', real.length === 0, real.slice(0, 2).join(' | '));

  // 过滤掉**故意触发**的 401（上面"错口令被拒"那一测必然产生一个）
  const realFailed = failed.filter(
    (u) => !/favicon/.test(u) && !/401 .*\/api\/admin\/login/.test(u),
  );
  check('无意外失败请求', realFailed.length === 0, realFailed.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e && e.message); process.exit(2); });
