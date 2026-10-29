/**
 * 侧边手势滑动返回首页 —— 端到端测试
 *
 * 用页面内合成 TouchEvent 模拟左边缘右滑（不触发浏览器原生点击合成，
 * 保证测试只考察手势逻辑本身），验证：
 *  1. 指示器出现且进度随位移增长
 *  2. 超过阈值 → 跳转首页
 *  3. 未达阈值 → 回弹（仍留在原页面）
 *  4. 起点不在左边缘 → 不触发
 *  5. 首页自身不响应手势
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const PORT = 4188;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(DIST, normalize(p).replace(/^([/\\])+/, ''));
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    const buf = await readFile(join(DIST, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buf);
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--no-sandbox'],
});

let failed = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

/** 在页面内合成一次滑动 */
async function swipe(page, { fromX, toX, y = 400, steps = 14 }) {
  await page.evaluate(
    ({ fromX, toX, y, steps }) => {
      const el = document.body;
      const mk = (type, x) => {
        const t = new Touch({
          identifier: 1,
          target: el,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
        });
        return new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [t],
          targetTouches: type === 'touchend' ? [] : [t],
          changedTouches: [t],
          bubbles: true,
          cancelable: true,
          view: window,
        });
      };
      el.dispatchEvent(mk('touchstart', fromX));
      for (let i = 1; i <= steps; i++) {
        el.dispatchEvent(mk('touchmove', fromX + ((toX - fromX) * i) / steps));
      }
      el.dispatchEvent(mk('touchend', toX));
    },
    { fromX, toX, y, steps },
  );
  await page.waitForTimeout(500);
}

const ctx = await browser.newContext({
  viewport: { width: 412, height: 892 },
  hasTouch: true,
});
const page = await ctx.newPage();
// 外部请求拦截，避免真实网络
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue();
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"list":[]}' });
});
await page.goto(`http://127.0.0.1:${PORT}/settings`);
await page.waitForTimeout(900);

console.log('\n▶ 1. 左边缘右滑 → 应返回首页');
await swipe(page, { fromX: 6, toX: 300 });
await page.waitForTimeout(400);
let path = await page.evaluate(() => location.pathname);
check(path === '/', '滑动完成跳转首页', `path=${path}`);

console.log('\n▶ 2. 未达阈值 → 应回弹留在原页');
await page.goto(`http://127.0.0.1:${PORT}/settings`);
await page.waitForTimeout(700);
await swipe(page, { fromX: 6, toX: 60, steps: 6 });
await page.waitForTimeout(400);
path = await page.evaluate(() => location.pathname);
check(path === '/settings', '未达阈值不跳转', `path=${path}`);

console.log('\n▶ 3. 非边缘起点滑动 → 不触发');
await swipe(page, { fromX: 200, toX: 400, steps: 12 });
await page.waitForTimeout(400);
path = await page.evaluate(() => location.pathname);
check(path === '/settings', '非边缘起点不触发', `path=${path}`);

console.log('\n▶ 4. 首页上滑 → 不应跳转（已在首页）');
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(800);
await swipe(page, { fromX: 6, toX: 320 });
await page.waitForTimeout(400);
path = await page.evaluate(() => location.pathname);
const homeInd = await page.evaluate(() => !!document.querySelector('.edge-ind'));
check(path === '/', '首页不响应手势', `path=${path}`);
check(homeInd === false, '首页不出现指示器', `ind=${homeInd}`);

console.log('\n▶ 5. 滑动中途：指示器 + 进度 + 页面位移');
await page.goto(`http://127.0.0.1:${PORT}/settings`);
await page.waitForTimeout(700);
// 分步派发，中途采样（不结束手势）
await page.evaluate(() => {
  const el = document.body;
  const mk = (type, x) => {
    const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
    return new TouchEvent(type, {
      touches: type === 'touchend' ? [] : [t],
      targetTouches: type === 'touchend' ? [] : [t],
      changedTouches: [t],
      bubbles: true,
      cancelable: true,
    });
  };
  window.__mk = mk;
  el.dispatchEvent(mk('touchstart', 6));
  el.dispatchEvent(mk('touchmove', 30));
  el.dispatchEvent(mk('touchmove', 55));
  el.dispatchEvent(mk('touchmove', 80));
});
const ind = await page.evaluate(() => {
  const el = document.querySelector('.edge-ind');
  if (!el) return null;
  const r = el.querySelector('.edge-ind__ring');
  return {
    label: el.querySelector('.edge-ind__label')?.textContent || '',
    p: r ? getComputedStyle(r).getPropertyValue('--p').trim() : '',
    shift: getComputedStyle(document.querySelector('.app__main')).transform,
  };
});
check(!!ind, '指示器已渲染', JSON.stringify(ind));
check(ind && parseFloat(ind.p) > 0 && parseFloat(ind.p) < 1, '进度在 0~1 之间', ind ? `p=${ind.p}` : '');
check(ind && ind.shift && ind.shift !== 'none', '页面跟随位移', ind ? ind.shift : '');
check(ind && ind.label === '返回首页', '文案正确', ind ? ind.label : '');
// 结束手势 → 应回弹
await page.evaluate(() => document.body.dispatchEvent(window.__mk('touchend', 80)));
await page.waitForTimeout(500);
path = await page.evaluate(() => location.pathname);
check(path === '/settings', '未完成手势回弹', `path=${path}`);

await browser.close();
server.close();

console.log(`\n${failed === 0 ? '🎉 全部通过' : `⚠️ ${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);
