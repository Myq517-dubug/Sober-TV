/**
 * 播放器控制条自动隐藏 —— 端到端测试
 *
 * 用 vite dev server 加载测试夹具页（src/test/auto-hide-fixture.tsx），
 * 夹具挂载**真实的** useAutoHideControls hook，
 * 通过 window.__autoHide 断言行为。
 *
 * 覆盖：
 *  1. 竖屏：控制条常驻，不自动隐藏
 *  2. 横屏：进入延迟后自动隐藏
 *  3. 隐藏后点视频区 → 恢复显示
 *  4. 面板打开（pinned）→ 不自动隐藏
 *  5. CSS 契约：.pbar.is-hidden 断掉 pointer-events
 *  6. 搜索框：单框 + 圆角 + 垂直居中
 *  7. 圆角令牌带 px 单位（全局圆角回归）
 */
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const VITE_PORT = 5290;
let failed = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

// ── 启动 vite dev server（加载真实源码，含未 tree-shake 的 hook）──
const vite = await createServer({
  configFile: 'vite.config.ts',
  server: { host: '127.0.0.1', port: VITE_PORT, strictPort: true },
  logLevel: 'error',
});
await vite.listen();

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({
  viewport: { width: 412, height: 892 },
  hasTouch: true,
});
const page = await ctx.newPage();
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(`http://127.0.0.1:${VITE_PORT}`)) return route.continue();
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"list":[]}' });
});

const st = () => page.evaluate(() => (window).__autoHide.visible);

console.log('\n▶ 1. 竖屏：控制条常驻，不自动隐藏');
await page.goto(`http://127.0.0.1:${VITE_PORT}/test-auto-hide.html`);
await page.waitForTimeout(400);
await page.waitForTimeout(1200); // 远超 idleDelay
check((await st()) === true, '竖屏 1.2s 后仍可见', `visible=${await st()}`);

console.log('\n▶ 2. 横屏：进入延迟后自动隐藏');
await page.evaluate(() => (window).__autoHide.setLandscape(true));
await page.waitForTimeout(300);
const at300 = await st();
await page.waitForTimeout(700);
const at1000 = await st();
check(at300 === true, '刚进横屏 300ms 仍可见（有过渡缓冲）', `visible=${at300}`);
check(at1000 === false, '横屏 1s 后已自动隐藏', `visible=${at1000}`);

console.log('\n▶ 3. 隐藏态 CSS：不可点击 + 完全透明');
const hiddenStyle = await page.evaluate(() => {
  const bar = document.querySelector('.pbar');
  const cs = getComputedStyle(bar);
  return { opacity: cs.opacity, pe: cs.pointerEvents, vis: cs.visibility, cls: bar.className };
});
check(hiddenStyle.cls.includes('is-hidden'), 'pbar 带 is-hidden 类', hiddenStyle.cls);
check(hiddenStyle.opacity === '0', 'opacity=0', hiddenStyle.opacity);
check(hiddenStyle.pe === 'none', 'pointer-events=none（不挡视频手势）', hiddenStyle.pe);
check(hiddenStyle.vis === 'hidden', 'visibility=hidden', hiddenStyle.vis);

console.log('\n▶ 4. 点视频区 → 恢复显示');
await page.evaluate(() => (window).__autoHide.toggle());
await page.waitForTimeout(150);
check((await st()) === true, 'toggle 后恢复可见', `visible=${await st()}`);
// 等淡入过渡（0.22s）真正结束 —— 轮询而非固定等待，避免读到中间态
await page
  .waitForFunction(
    () => parseFloat(getComputedStyle(document.querySelector('.pbar')).opacity) > 0.99,
    { timeout: 3000 },
  )
  .catch(() => {});
const barVisible = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('.pbar'));
  return { opacity: cs.opacity, pe: cs.pointerEvents };
});
check(parseFloat(barVisible.opacity) > 0.99, '恢复后 opacity=1', barVisible.opacity);
check(barVisible.pe !== 'none', '恢复后可点击', barVisible.pe);

console.log('\n▶ 5. pinned（面板打开）→ 不自动隐藏');
await page.evaluate(() => (window).__autoHide.setPinned(true));
await page.evaluate(() => (window).__autoHide.reveal());
await page.waitForTimeout(1400);
check((await st()) === true, 'pinned 期间不隐藏', `visible=${await st()}`);
await page.evaluate(() => (window).__autoHide.setPinned(false));
await page.evaluate(() => (window).__autoHide.reveal());
await page.waitForTimeout(1000);
check((await st()) === false, '解除 pinned 后恢复自动隐藏', `visible=${await st()}`);

console.log('\n▶ 6. 圆角令牌带 px 单位（全局圆角回归）');
const vars = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const k of ['--shape-full', '--shape-sm', '--shape-lg', '--shape-md', '--shape-xl']) {
    out[k] = cs.getPropertyValue(k).trim();
  }
  return out;
});
const shapeOk = Object.values(vars).every((v) => /px$/.test(v));
check(shapeOk, '所有 shape 变量带 px', JSON.stringify(vars));

console.log('\n▶ 7. 搜索框：单框 + 圆角 + 垂直居中');
await page.goto(`http://127.0.0.1:${VITE_PORT}/search`);
await page.waitForTimeout(900);
const sg = await page.evaluate(() => {
  const inp = document.querySelector('.search__input');
  const bar = document.querySelector('.search__bar');
  const ci = getComputedStyle(inp);
  const cb = getComputedStyle(bar);
  const ri = inp.getBoundingClientRect();
  const rb = bar.getBoundingClientRect();
  return {
    outlineStyle: ci.outlineStyle,
    barRadius: cb.borderRadius,
    barY: Math.round(rb.y),
    barH: Math.round(rb.height),
    inside: ri.left >= rb.left - 1 && ri.right <= rb.right + 1,
    inputCount: document.querySelectorAll('.search__input').length,
    vh: window.innerHeight,
  };
});
check(sg.inputCount === 1, '页面只有一个搜索框', `count=${sg.inputCount}`);
check(sg.outlineStyle === 'none', 'input 无 focus 直角描边', sg.outlineStyle);
check(parseFloat(sg.barRadius) > 100, '搜索框是圆角胶囊', sg.barRadius);
check(sg.inside, 'input 落在外层框内（无双框重叠）');
const usableCenter = (sg.vh - 75) / 2;
const barCenter = sg.barY + sg.barH / 2;
check(Math.abs(barCenter - usableCenter) < 140, '搜索框垂直居中', `barCenter=${barCenter} 期望≈${usableCenter}`);

await browser.close();
await vite.close();

console.log(`\n${failed === 0 ? '🎉 全部通过' : `⚠️ ${failed} 项失败`}\n`);
process.exit(failed === 0 ? 0 : 1);
