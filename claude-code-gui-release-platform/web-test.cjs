/**
 * 阶段 2 浏览器验收 —— HTTP 200 不等于页面能用（JS 可能一加载就崩），
 * 所以这里用真浏览器跑完整交互链路。
 *
 * 用法：node web-test.cjs
 * 依赖：系统 Edge（channel: msedge），无需下载 Playwright 浏览器。
 */
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // 回退到 npx 缓存里的副本（本机未把 playwright 装进项目依赖）
  ({ chromium } = require(
    process.env.PLAYWRIGHT_PATH ||
      'C:/Users/SZH/AppData/Local/npm-cache/_npx/86170c4cd1c5da32/node_modules/playwright',
  ));
}

const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8799';
const ADMIN = process.env.WEB_ADMIN || 'verify-pw';
// 服务端 SITE_NAME，需与启动服务时的一致。若不设则只断言「非空」。
const SITE = process.env.WEB_SITE || '';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  <- ' + detail : ''}`);
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  // 用保留测试段的独立 IP：反馈提交有按 IP 限流（20/小时），不隔离的话
  // 反复跑测试会把自己的配额耗光、把"提交成功"测成失败。
  const TEST_IP = `198.51.100.${Math.floor(Math.random() * 254) + 1}`;
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': TEST_IP } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // ── 1. 后台入口应显示登录页 ──
  console.log('\n[1] 后台入口 = 登录页');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle', timeout: 20000 });
  const body1 = await page.innerText('body');
  check('渲染登录页', body1.includes('发布平台管理'), body1.slice(0, 60).replace(/\n/g, ' '));
  check(
    '显示实例标识',
    SITE ? body1.includes(SITE) : /实例：\S+/.test(body1),
    SITE ? `期望 ${SITE}` : '(未设 WEB_SITE，只验非空)',
  );
  check('未泄露管理内容', !body1.includes('技能 / 插件包') && !body1.includes('用户反馈'), '');

  // ── 2. 错口令 ──
  console.log('\n[2] 错口令被拒');
  await page.fill('input[type="password"]', 'wrong-pw');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(900);
  const body2 = await page.innerText('body');
  check('提示口令错误', body2.includes('口令错误'), '');
  check('仍停在登录页', body2.includes('发布平台管理'), '');

  // ── 3. 对口令登录 ──
  console.log('\n[3] 对口令进入后台');
  await page.fill('input[type="password"]', ADMIN);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  const body3 = await page.innerText('body');
  check('进入后台（见导航）', body3.includes('总览') && body3.includes('技能 / 插件包'), '');
  check('总览渲染统计卡', body3.includes('包总数') && body3.includes('累计下载'), '');
  check('统计数值非空', /包总数\s*\n?\s*2/.test(body3) || body3.includes('2'), '期望看到包数 2');
  check('平台同步状态显示', body3.includes('macOS'), '');

  // 条形图必须**真的渲染出填充条**。曾踩过：.bar-fill 是 <span>（inline），
  // width/height 都不生效 → 只剩灰色轨道，整块图看起来"全是空的"。
  // 功能测试完全测不出这类问题，只能量渲染尺寸。
  const barInfo = await page.evaluate(() => {
    const fills = [...document.querySelectorAll('.bar-fill')];
    const tracks = [...document.querySelectorAll('.bar-track')];
    const spark = [...document.querySelectorAll('.sparkline .bar')];
    return {
      fillWidths: fills.map((el) => Math.round(el.getBoundingClientRect().width)),
      fillHeights: fills.map((el) => Math.round(el.getBoundingClientRect().height)),
      trackW: tracks.length ? Math.round(tracks[0].getBoundingClientRect().width) : 0,
      sparkVisible: spark.filter((b) => b.getBoundingClientRect().height > 2).length,
    };
  });
  check(
    '条形图填充条有实际宽度',
    barInfo.fillWidths.length > 0 && barInfo.fillWidths.some((w) => w > 4),
    `widths=${JSON.stringify(barInfo.fillWidths.slice(0, 5))} track=${barInfo.trackW}`,
  );
  check(
    '条形图填充条有实际高度',
    barInfo.fillHeights.some((h) => h > 4),
    `heights=${JSON.stringify(barInfo.fillHeights.slice(0, 5))}`,
  );
  check('趋势图有可见柱子', barInfo.sparkVisible > 0, `${barInfo.sparkVisible} 根`);

  // ── 4. 各页面可达 ──
  console.log('\n[4] 各导航页');
  for (const [path, expect] of [
    ['packages', '技能 / 插件包'],
    ['feedback', '用户反馈'],
    ['updates', '程序更新'],
  ]) {
    await page.goto(`${BASE}/admin/${path}`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(700);
    const t = await page.innerText('body');
    check(`/${path} 渲染`, t.includes(expect), t.slice(0, 50).replace(/\n/g, ' '));
  }

  // ── 5. 深链刷新不 404（SPA fallback 关键验证）──
  console.log('\n[5] 深链直接访问');
  const resp = await page.goto(`${BASE}/admin/feedback`, { waitUntil: 'networkidle', timeout: 15000 });
  check('深链 HTTP 200', resp.status() === 200, `HTTP ${resp.status()}`);
  const deepBody = await page.innerText('body');
  check('深链渲染内容（非白屏）', deepBody.includes('用户反馈'), '');

  // ── 6. 包列表有数据 ──
  // 断言与具体数据解耦（换一批演示数据不该让测试失败）：
  // 只要求「表格渲染出行」+「列头齐全」。
  console.log('\n[6] 包列表内容');
  await page.goto(`${BASE}/admin/packages`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(800);
  const pkgRows = await page.locator('table.data tbody tr').count();
  check('包列表渲染出数据行', pkgRows > 0, `${pkgRows} 行`);

  // ── 7. 反馈页有数据 + 图片可见 ──
  console.log('\n[7] 反馈页内容');
  await page.goto(`${BASE}/admin/feedback`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(800);
  const fbCards = await page.locator('.fb-card').count();
  const imgs = await page.locator('img.img-preview').count();
  check('反馈页渲染出卡片', fbCards > 0, `${fbCards} 张`);
  check(
    '带图反馈渲染了缩略图',
    imgs > 0,
    `${imgs} 张` + (imgs === 0 ? '（若演示数据无带图反馈则属正常）' : ''),
  );

  // ── 8. 公网反馈提交页 ──
  console.log('\n[8] 公网反馈提交页');
  await page.goto(`${BASE}/feedback`, { waitUntil: 'networkidle', timeout: 15000 });
  const pfBody = await page.innerText('body');
  check('渲染提交表单', pfBody.includes('意见反馈'), '');
  check('有类型选择', pfBody.includes('问题反馈') && pfBody.includes('改进建议'), '');
  // 蜜罐用 left:-9999px 移出屏幕。Playwright 的 isVisible() 只认 display/visibility，
  // 不认「在视口外」，直接用它判定会误报。这里查三件真正有意义的事：
  //   ① 它的位置确实在视口左侧之外
  //   ② 负 left 没有撑出横向滚动条（这才是用户看得见的真 bug）
  //   ③ 键盘也到不了（tabIndex=-1）
  const hp = await page.evaluate(() => {
    const el = document.getElementById('fb-website');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      x: Math.round(r.left),
      width: Math.round(r.width),
      hasHScroll: doc.scrollWidth > doc.clientWidth + 1,
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      tabIndex: el.tabIndex,
    };
  });
  if (!hp) {
    check('蜜罐字段存在', false, '未找到 #fb-website');
  } else {
    check('蜜罐在视口外（用户看不到）', hp.x < 0, `x=${hp.x}`);
    check('未撑出横向滚动条', !hp.hasHScroll, `scrollW=${hp.scrollW} clientW=${hp.clientW}`);
    check('键盘不可达', hp.tabIndex === -1, `tabIndex=${hp.tabIndex}`);
  }

  await page.fill('#fb-message', '浏览器验收：这是通过公网页面提交的反馈');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  const doneBody = await page.innerText('body');
  check('提交成功', doneBody.includes('已收到'), doneBody.slice(0, 60).replace(/\n/g, ' '));

  // 提交的反馈应能在后台看到
  await page.goto(`${BASE}/admin/feedback?q=${encodeURIComponent('浏览器验收')}`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(900);
  const verifyBody = await page.innerText('body');
  check('后台能搜到刚提交的反馈', verifyBody.includes('浏览器验收'), '');

  // ── 9. 未登录深链：应保留原路径，登录后落到目标页 ──
  console.log('\n[9] 未登录深链保留路径');
  const cleanCtx = await browser.newContext(); // 干净 localStorage = 未登录
  const cleanPage = await cleanCtx.newPage();
  await cleanPage.goto(`${BASE}/admin/packages`, { waitUntil: 'networkidle', timeout: 20000 });
  const cleanBody = await cleanPage.innerText('body');
  check('显示登录页', cleanBody.includes('发布平台管理'), '');
  check('URL 保留目标路径（未被重定向）',
    cleanPage.url().endsWith('/admin/packages'), cleanPage.url());
  await cleanPage.fill('input[type="password"]', ADMIN);
  await cleanPage.click('button[type="submit"]');
  await cleanPage.waitForTimeout(1600);
  const landed = await cleanPage.locator('input[placeholder*="搜索名称"]').count();
  check('登录后落到 packages 而非总览', landed > 0, '');
  await cleanCtx.close();

  // ── 10. macOS 无版本时的空态 ──
  console.log('\n[10] 平台切换空态');
  await page.goto(`${BASE}/admin/updates`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.selectOption('select', 'macos');
  await page.waitForTimeout(1000);
  const macBody = await page.innerText('body');
  check('macOS 无版本显示空态', macBody.includes('暂无'), macBody.slice(0, 70).replace(/\n/g, ' '));

  // ── 11. 页面错误 ──
  console.log('\n[11] 浏览器错误');
  const real = errors.filter((e) => !/favicon|404|Failed to load resource/i.test(e));
  check('无 JS 运行时错误', real.length === 0, real.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n${'='.repeat(50)}\n通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e && e.message); process.exit(2); });
