/**
 * 窄屏适配验证 —— 响应式断点是否真的生效，并检查窄屏下有没有横向溢出
 * （横向滚动条是窄屏最常见的可见 bug）。
 *
 * 用法：node web-responsive.cjs
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

const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8799';
const ADMIN = process.env.WEB_ADMIN || 'verify-pw';
const OUT = process.env.WEB_SHOT_OUT || 'C:/Storage/claude-code-haha-dev/.claude/pasted';

const SIZES = [
  ['tablet', 1024, 800],
  ['narrow', 760, 900],
  ['mobile', 420, 900],
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  <- ' + detail : ''}`);
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  for (const [label, w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));

    console.log(`\n[${label}] ${w}x${h}`);
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.fill('input[type="password"]', ADMIN);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1500);

    for (const [name, path] of [
      ['总览', '/admin'],
      ['包列表', '/admin/packages'],
      ['反馈', '/admin/feedback'],
      ['更新', '/admin/updates'],
      ['公网页', '/feedback'],
    ]) {
      await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(700);
      const m = await page.evaluate(() => ({
        docW: document.documentElement.scrollWidth,
        cliW: document.documentElement.clientWidth,
      }));
      const overflow = m.docW > m.cliW + 1;
      check(`${name} 无横向溢出`, !overflow, overflow ? `doc=${m.docW} cli=${m.cliW}` : '');
    }

    // 侧边栏布局随断点变化。
    // 注意：上面循环最后停在 /feedback（公网页，没有侧边栏）——必须先回到后台页再查，
    // 否则选择器查不到元素、断言拿到空字符串而误报失败。
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(600);
    const nav = await page.evaluate(() => {
      const nav = document.querySelector('.sidebar-nav');
      const app = document.querySelector('.app');
      return {
        navDir: nav ? getComputedStyle(nav).flexDirection : '',
        appDir: app ? getComputedStyle(app).flexDirection : '',
      };
    });
    if (w <= 720) {
      check('侧边栏转顶部横排', nav.appDir === 'column' && nav.navDir === 'row',
        `app=${nav.appDir} nav=${nav.navDir}`);
    } else {
      check('保持左右分栏', nav.appDir === 'row', `app=${nav.appDir}`);
    }

    check('无 JS 错误', errors.length === 0, errors.slice(0, 1).join(''));
    await page.screenshot({ path: `${OUT}/responsive-${label}.png` });
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${'='.repeat(50)}\n通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e && e.message); process.exit(2); });
