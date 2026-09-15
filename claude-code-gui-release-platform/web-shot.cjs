/**
 * 截图各页面，供人眼确认视觉质量（功能正确性由 web-test.cjs 负责）。
 *
 * 用法：node web-shot.cjs
 *   WEB_BASE（默认 http://127.0.0.1:8799）
 *   WEB_ADMIN（默认 verify-pw）
 *   WEB_SHOT_OUT（默认 .claude/pasted）
 */
const fs = require('fs');

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
const OUT = process.env.WEB_SHOT_OUT || 'C:/Storage/claude-code-haha-dev/.claude/pasted';
const targets = [
  ['login', '/admin', false],
  ['overview', '/admin', true],
  ['packages', '/admin/packages', true],
  ['feedback', '/admin/feedback', true],
  ['updates', '/admin/updates', true],
  ['public', '/feedback', false],
];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
      // 1.0 而非 1.5：1440 宽已是 2 倍于常规阅读尺寸，再放大只会超出图片查看上限
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    for (const [name, path, needAuth] of targets) {
      await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 20000 });
      // 同一 context 内 token 存 localStorage —— 首次登录后后续页面直接进后台，
      // 登录框已不存在，所以要先判断有没有。
      if (needAuth && (await page.locator('input[type="password"]').count()) > 0) {
        await page.fill('input[type="password"]', ADMIN);
        await page.click('button[type="submit"]');
        await page.waitForTimeout(1300);
      }
      await page.waitForTimeout(600);
      const file = `${OUT}/admin-${name}-${scheme}.png`;
      await page.screenshot({ path: file });
      console.log('shot:', file, fs.existsSync(file) ? 'ok' : 'MISSING');
    }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e && e.message); process.exit(1); });
